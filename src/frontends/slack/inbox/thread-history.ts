/**
 * Thread-history prefetch — populates a new session with the existing
 * Slack thread's prior context on first @-mention.
 *
 * Context: bantai spins up one SessionHost per (workspace, channel,
 * threadTs). When the user drags the bot into an ongoing thread mid-
 * conversation — @mention lands with `thread_ts` set but no session yet
 * exists for that thread — the agent would otherwise see only the
 * triggering message and miss everything said above it. This module
 * fetches the thread via `conversations.replies`, renders each prior
 * message with author + role + timestamp, and returns a preamble string
 * the router prepends to the first turn.
 *
 * Gated behaviour (see `routing.ts::dispatchMessageBatch`):
 *   - Only runs on fresh sessions (not rehydrated from the persistence
 *     store — resumed sessions already have prior context in the backend
 *     session state, adding the history again would double-count).
 *   - Only runs when the trigger event carries a `thread_ts` — a top-
 *     level @mention that *starts* a new thread has nothing to prefetch.
 *   - Only runs when `project.threadHistoryLimit > 0`.
 *
 * Fetch failures are non-fatal: we log a warning and return `undefined`
 * so the agent still gets the current message. Per AGENTS.md, every
 * branch that drops data logs; the "empty thread" case returns
 * `undefined` silently because a thread with only the trigger message
 * is a normal, expected shape.
 *
 * Ported (with adjustments) from openclaw's
 * `extensions/slack/src/monitor/message-handler/prepare-thread-context.ts`
 * + `monitor/media.ts::resolveSlackThreadHistory` (MIT).
 */

import type { App } from "@slack/bolt"
import { log } from "../../../utils/logger"
import type { UserCache } from "../view/user-cache"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThreadHistoryMessage {
  /** Message text. Trimmed; file-only messages render as `[attached: name, …]`. */
  text: string
  /** Slack user id for human messages; undefined for bot messages. */
  userId?: string
  /** Slack bot id for bot messages (including the current bantai bot). */
  botId?: string
  /** Slack ts of the message (also serves as timestamp). */
  ts: string
  /** Names of attached files, if any. Rendered inline in the preamble. */
  filenames?: string[]
}

export interface FetchThreadHistoryOpts {
  app: App
  channelId: string
  /** The parent ts of the thread — same value Slack's event supplies as `thread_ts`. */
  threadTs: string
  /**
   * ts of the triggering @mention message. Excluded from the returned
   * history so the agent doesn't see the current turn twice (once in
   * history, once as the live message).
   */
  currentMessageTs?: string
  /** Maximum prior messages to retain; must be > 0. */
  limit: number
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Paginate `conversations.replies` and keep the latest `limit` messages.
 * Filters out tombstoned / empty / current-trigger messages. Returns
 * oldest-first so callers can render in conversation order.
 *
 * On API errors, logs a warning and returns an empty array — the
 * caller treats empty-history the same as "no thread context to
 * provide", which is the safe fallback.
 */
export async function fetchThreadHistory(
  opts: FetchThreadHistoryOpts,
): Promise<ThreadHistoryMessage[]> {
  if (!Number.isFinite(opts.limit) || opts.limit <= 0) return []

  // Slack caps `conversations.replies` at 1000/page; 200 is the recommended
  // practical page size and matches openclaw's default.
  const pageSize = 200
  const retained: RepliesMessage[] = []
  let cursor: string | undefined

  try {
    do {
      const res = (await opts.app.client.conversations.replies({
        channel: opts.channelId,
        ts: opts.threadTs,
        limit: pageSize,
        inclusive: true,
        ...(cursor ? { cursor } : {}),
      })) as {
        ok?: boolean
        error?: string
        messages?: RepliesMessage[]
        response_metadata?: { next_cursor?: string }
      }
      if (!res.ok) {
        log.warn(
          `slack thread-history: conversations.replies failed ` +
            `(channel=${opts.channelId} thread=${opts.threadTs} error=${res.error ?? "unknown"})`,
        )
        return []
      }
      for (const msg of res.messages ?? []) {
        const hasText = typeof msg.text === "string" && msg.text.trim().length > 0
        const hasFiles = Array.isArray(msg.files) && msg.files.length > 0
        if (!hasText && !hasFiles) continue
        if (opts.currentMessageTs && msg.ts === opts.currentMessageTs) continue
        retained.push(msg)
        if (retained.length > opts.limit) {
          retained.shift()
        }
      }
      const next = res.response_metadata?.next_cursor
      cursor = typeof next === "string" && next.trim().length > 0 ? next.trim() : undefined
    } while (cursor)
  } catch (err) {
    log.warn(
      `slack thread-history: conversations.replies threw ` +
        `(channel=${opts.channelId} thread=${opts.threadTs}): ${String(err)}`,
    )
    return []
  }

  return retained.map(normalise)
}

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

export interface FormatThreadHistoryOpts {
  /** Messages in chronological (oldest-first) order. */
  messages: ThreadHistoryMessage[]
  /**
   * Bot user id (from `auth.test`). Messages authored by the bot are
   * labelled "assistant"; everyone else is "user". We intentionally
   * treat *all* bot_id-bearing messages as assistant — if another bot
   * posted in the thread, its output is still assistant-like context
   * the agent should read as not-coming-from-a-human.
   */
  botUserId: string
  userCache: UserCache
}

/**
 * Render the fetched thread history as a single string suitable for
 * prepending to the user's first turn. The preamble uses an XML-ish
 * `<slack_thread_history>` wrapper so the agent can scan for it.
 *
 * Each line has the form:
 *   [YYYY-MM-DD HH:MM UTC] <name> (user|assistant): <text>
 *
 * File attachments are appended as `[attached: name1, name2]` after
 * the text — openclaw's approach. Image content itself is NOT fetched
 * here; the agent just learns that a file existed. That keeps fetch
 * latency bounded to a single API call and the payload size well under
 * the context window even for long threads.
 *
 * Returns `undefined` when `messages` is empty so the caller can skip
 * the prefix entirely.
 */
export async function formatThreadHistory(
  opts: FormatThreadHistoryOpts,
): Promise<string | undefined> {
  if (opts.messages.length === 0) return undefined

  // Resolve user display names in parallel. Bot messages don't need a
  // users.info lookup — we label them "bantai" (or "bot") directly.
  const uniqueUserIds = Array.from(
    new Set(
      opts.messages
        .map((m) => m.userId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  )
  const nameMap = new Map<string, string>()
  await Promise.all(
    uniqueUserIds.map(async (id) => {
      const name = await opts.userCache.displayName(id)
      if (name) nameMap.set(id, name)
    }),
  )

  const lines: string[] = []
  for (const msg of opts.messages) {
    const isBotAuthored =
      !!msg.botId || (msg.userId !== undefined && msg.userId === opts.botUserId)
    const role = isBotAuthored ? "assistant" : "user"
    const nameFromCache = msg.userId ? nameMap.get(msg.userId) : undefined
    const author = isBotAuthored
      ? nameFromCache ?? "bantai"
      : nameFromCache ?? msg.userId ?? "unknown"
    const attachedSuffix =
      msg.filenames && msg.filenames.length > 0
        ? ` [attached: ${msg.filenames.join(", ")}]`
        : ""
    const stamp = formatTimestamp(msg.ts)
    // Collapse repeated whitespace/newlines to a single space inside the
    // line so each history entry stays on one line. Preserves readability
    // for the agent without turning the preamble into a multi-page wall.
    const body = msg.text.replace(/\s+/g, " ").trim()
    lines.push(`[${stamp}] ${author} (${role}): ${body}${attachedSuffix}`)
  }

  const header =
    "Prior messages in this Slack thread (provided as context; Slack will not re-send them):"
  return `<slack_thread_history>\n${header}\n\n${lines.join("\n")}\n</slack_thread_history>`
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface RepliesFile {
  id?: string
  name?: string
}

interface RepliesMessage {
  text?: string
  user?: string
  bot_id?: string
  ts?: string
  files?: RepliesFile[]
}

function normalise(msg: RepliesMessage): ThreadHistoryMessage {
  const trimmedText = msg.text?.trim() ?? ""
  const filenames =
    msg.files && msg.files.length > 0
      ? msg.files.map((f) => f.name ?? "file")
      : undefined
  return {
    text:
      trimmedText.length > 0
        ? trimmedText
        : `[attached: ${filenames?.join(", ") ?? "file"}]`,
    ...(msg.user ? { userId: msg.user } : {}),
    ...(msg.bot_id ? { botId: msg.bot_id } : {}),
    ts: msg.ts ?? "",
    ...(filenames ? { filenames } : {}),
  }
}

/**
 * Render a Slack ts (`"1713484800.000100"`) as `YYYY-MM-DD HH:MM UTC`.
 * Falls back to the raw ts when the value is malformed — better to show
 * _something_ than to drop the timestamp silently.
 */
function formatTimestamp(ts: string): string {
  const asNumber = Number.parseFloat(ts)
  if (!Number.isFinite(asNumber) || asNumber <= 0) return ts
  const d = new Date(asNumber * 1000)
  if (Number.isNaN(d.getTime())) return ts
  const pad = (n: number): string => n.toString().padStart(2, "0")
  const y = d.getUTCFullYear()
  const mo = pad(d.getUTCMonth() + 1)
  const da = pad(d.getUTCDate())
  const h = pad(d.getUTCHours())
  const mi = pad(d.getUTCMinutes())
  return `${y}-${mo}-${da} ${h}:${mi} UTC`
}
