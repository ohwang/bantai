/**
 * Assistant-thread status banner (plan §S8, OpenClaw gap 8).
 *
 * In a Slack Assistant app thread (`IM` / `assistant_thread`), the client
 * renders a live "is typing…" / "running tool…" banner under the bot's
 * avatar when the app calls `assistant.threads.setStatus`. It's the
 * closest thing Slack offers to OpenAI's streaming status — different
 * from the reaction state machine (which lives on the triggering
 * message) in that it's a server-side property of the thread itself.
 *
 * This module:
 *   - Maps agent events to human-readable status strings.
 *   - Debounces transitions so a burst of tool starts doesn't thrash
 *     the API (matching the reactions controller's minTransitionMs).
 *   - Gracefully degrades for non-assistant channels (regular public
 *     / private channels, DMs without the assistant capability): on
 *     the first API error that looks like "this channel doesn't
 *     support status," disables itself for the session and logs once.
 *   - Always clears the banner on turn_complete / interrupt / error.
 *
 * Requires `assistant:write` on the bot token. Bantai's launcher wires
 * this unconditionally — the self-disable path handles workspaces
 * without the scope or channels that aren't assistant threads.
 *
 * Ported from openclaw/extensions/slack/src/dispatch.ts:341-369 (MIT).
 */

import type { ConversationEvent } from "../../../protocol/types"
import { log } from "../../../utils/logger"

// ---------------------------------------------------------------------------
// Adapter — narrow surface for assistant.threads.setStatus.
// ---------------------------------------------------------------------------

export interface ThreadStatusAdapter {
  setStatus(args: { channel: string; threadTs: string; status: string }): Promise<void>
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

/**
 * Map an agent event to a short status string. Empty string clears the
 * banner; `undefined` means "no change." We return short lowercase
 * phrases that read naturally next to Slack's "{bot} is " prefix.
 */
export function nextThreadStatus(event: ConversationEvent): string | undefined {
  switch (event.type) {
    case "turn_start":
      return "thinking…"
    case "thinking_delta":
      return "thinking…"
    case "text_delta":
    case "text_complete":
      return "replying…"
    case "tool_use_start":
      return `running ${event.tool}…`
    case "permission_request":
      return "waiting for approval…"
    case "elicitation_request":
      return "waiting for your answer…"
    case "compact":
      return "compacting history…"
    case "turn_complete":
    case "interrupt":
      return ""
    case "error":
      if (event.severity === "fatal") return ""
      return undefined
    case "rate_limit_update":
      if ("blocked" in event && event.blocked === true) return "rate-limited…"
      return undefined
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface ThreadStatusOpts {
  adapter: ThreadStatusAdapter
  channel: string
  threadTs: string
  /** Minimum ms between status API calls. Default 250. */
  minTransitionMs?: number
  /** Test hook. */
  now?: () => number
}

export interface ThreadStatusController {
  apply(event: ConversationEvent): void
  /** Terminal clear + flush. Safe to call repeatedly. */
  terminate(): Promise<void>
}

/**
 * Error codes that mean "this channel doesn't support status / we
 * don't have the scope" — we self-disable on the first one so we
 * don't repeat the API call for every event in the session.
 */
const DISABLE_ERROR_SUBSTRINGS = [
  "method_not_supported_for_channel_type",
  "channel_not_found", // non-IM channels hit this sometimes
  "missing_scope",
  "not_allowed_token_type",
  "invalid_arguments", // minislack + old workspaces
]

export function createThreadStatusController(
  opts: ThreadStatusOpts,
): ThreadStatusController {
  let applied = ""
  let disabled = false
  let inflight: Promise<void> = Promise.resolve()
  const minMs = opts.minTransitionMs ?? 250
  const now = opts.now ?? Date.now
  let lastAt = 0

  async function sync(target: string): Promise<void> {
    if (disabled) return
    if (target === applied) return
    const elapsed = now() - lastAt
    if (elapsed < minMs) {
      await new Promise((r) => setTimeout(r, minMs - elapsed))
    }
    try {
      await opts.adapter.setStatus({
        channel: opts.channel,
        threadTs: opts.threadTs,
        status: target,
      })
      applied = target
      lastAt = now()
    } catch (err) {
      const msg = String(err)
      if (DISABLE_ERROR_SUBSTRINGS.some((s) => msg.includes(s))) {
        disabled = true
        log.info(
          `slack thread-status: disabled for ${opts.channel}/${opts.threadTs} — ${msg}. ` +
            `Channel doesn't support assistant status; skipping for the rest of the session.`,
        )
        return
      }
      log.warn(`slack thread-status: setStatus failed: ${msg}`)
    }
  }

  return {
    apply(event) {
      const next = nextThreadStatus(event)
      if (next === undefined) return
      inflight = inflight.then(() => sync(next))
    },
    async terminate() {
      // Clear the banner — important so a timed-out / crashed turn
      // doesn't leave a lingering "thinking…" status on the thread.
      inflight = inflight.then(() => sync(""))
      await inflight
    },
  }
}
