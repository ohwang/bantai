/**
 * Bolt event registration.
 *
 * Subscribes to every Slack event kind the frontend consumes and routes
 * them through a single `onInbound` callback as `InboundSlackEvent`
 * values. Unhandled events surface as a `log.debug` so drift is visible
 * rather than silent — per the AGENTS.md rule against silently dropping
 * external data.
 */

import type { App } from "@slack/bolt"
import type { KnownBlock } from "@slack/types"
import { log } from "../../../utils/logger"

// ---------------------------------------------------------------------------
// Normalised inbound event shape
// ---------------------------------------------------------------------------

/** Minimal slice of Slack's FileObject carried on message events. */
export interface InboundFileMetadata {
  id: string
  name?: string
  mimetype?: string
  filetype?: string
  url_private?: string
  url_private_download?: string
}

export type InboundSlackEvent =
  | {
      kind: "message"
      channel: string
      user: string
      text: string
      ts: string
      threadTs?: string
      rawType: string
      files?: InboundFileMetadata[]
    }
  | {
      kind: "app_mention"
      channel: string
      user: string
      text: string
      ts: string
      threadTs?: string
      files?: InboundFileMetadata[]
    }
  | { kind: "member_joined"; channel: string; user: string }
  | { kind: "file_shared"; channel?: string; user: string; fileId: string }
  | { kind: "reaction_added"; channel?: string; user: string; reaction: string; itemTs?: string; itemChannel?: string }
  | { kind: "block_action"; channel?: string; user: string; actionId: string; value?: string; triggerId: string; messageTs?: string; payload: unknown }
  | { kind: "view_submission"; user: string; viewId: string; callbackId: string; values: Record<string, unknown>; triggerId: string }

export type InboundHandler = (event: InboundSlackEvent) => void | Promise<void>

export interface RegisterEventsOpts {
  app: App
  onInbound: InboundHandler
  /** Bot's own user ID, from auth.test. We skip our own messages. */
  botUserId: string
}

export function registerEvents({ app, onInbound, botUserId }: RegisterEventsOpts): void {
  // -------------------------------------------------------------------------
  // message.* — default and most important source of turns
  // -------------------------------------------------------------------------
  app.message(async ({ event }) => {
    const msg = event as MessageEventLike
    if (msg.subtype === "bot_message" || msg.bot_id) return
    if (msg.user === botUserId) return
    if (!msg.text || !msg.channel || !msg.ts || !msg.user) {
      log.debug(
        `slack: dropping message w/ missing fields: user=${msg.user} channel=${msg.channel} ts=${msg.ts} text=${!!msg.text}`,
      )
      return
    }
    await safeInvoke(onInbound, {
      kind: "message",
      channel: msg.channel,
      user: msg.user,
      text: msg.text,
      ts: msg.ts,
      threadTs: msg.thread_ts,
      rawType: msg.subtype ?? "message",
      ...(msg.files && msg.files.length > 0
        ? { files: msg.files.map(normaliseFile) }
        : {}),
    })
  })

  // -------------------------------------------------------------------------
  // app_mention — @bantai in a channel
  // -------------------------------------------------------------------------
  app.event("app_mention", async ({ event }) => {
    const m = event as AppMentionLike
    if (!m.text || !m.channel || !m.ts || !m.user) {
      log.warn(
        `slack: app_mention with missing fields: ${JSON.stringify({
          channel: m.channel,
          ts: m.ts,
          user: m.user,
        })}`,
      )
      return
    }
    await safeInvoke(onInbound, {
      kind: "app_mention",
      channel: m.channel,
      user: m.user,
      text: m.text,
      ts: m.ts,
      threadTs: m.thread_ts,
      ...(m.files && m.files.length > 0
        ? { files: m.files.map(normaliseFile) }
        : {}),
    })
  })

  // -------------------------------------------------------------------------
  // member_joined_channel — see Slack invite us to a new channel
  // -------------------------------------------------------------------------
  app.event("member_joined_channel", async ({ event }) => {
    const m = event as { user?: string; channel?: string }
    if (!m.user || !m.channel) {
      log.warn("slack: member_joined_channel missing user or channel")
      return
    }
    await safeInvoke(onInbound, {
      kind: "member_joined",
      channel: m.channel,
      user: m.user,
    })
  })

  // -------------------------------------------------------------------------
  // file_shared — inbound screenshots / logs / attachments
  // -------------------------------------------------------------------------
  app.event("file_shared", async ({ event }) => {
    const m = event as { user_id?: string; channel_id?: string; file_id?: string }
    if (!m.user_id || !m.file_id) {
      log.warn("slack: file_shared missing user_id or file_id")
      return
    }
    await safeInvoke(onInbound, {
      kind: "file_shared",
      channel: m.channel_id,
      user: m.user_id,
      fileId: m.file_id,
    })
  })

  // -------------------------------------------------------------------------
  // reaction_added — emoji-as-command surface (§7.3) + triggers later
  // -------------------------------------------------------------------------
  app.event("reaction_added", async ({ event }) => {
    const m = event as ReactionAddedLike
    if (!m.user || !m.reaction) {
      log.warn("slack: reaction_added missing user or reaction")
      return
    }
    if (m.user === botUserId) return
    await safeInvoke(onInbound, {
      kind: "reaction_added",
      user: m.user,
      reaction: m.reaction,
      itemTs: m.item?.ts,
      itemChannel: m.item?.channel,
    })
  })

  // -------------------------------------------------------------------------
  // block_actions — Block Kit button presses (§8)
  // -------------------------------------------------------------------------
  app.action(/.*/, async ({ action, body, ack }) => {
    await ack()
    const b = body as BlockActionBodyLike
    const actionId = typeof action === "object" && action && "action_id" in action
      ? String((action as { action_id: string }).action_id)
      : "<unknown>"
    const value = typeof action === "object" && action && "value" in action
      ? (action as { value?: string }).value
      : undefined
    await safeInvoke(onInbound, {
      kind: "block_action",
      channel: b.channel?.id,
      user: b.user?.id ?? "<unknown>",
      actionId,
      value,
      triggerId: b.trigger_id ?? "",
      messageTs: b.message?.ts,
      payload: body,
    })
  })

  // -------------------------------------------------------------------------
  // view_submission — modal submits (elicitation etc.)
  // -------------------------------------------------------------------------
  app.view(/.*/, async ({ view, body, ack }) => {
    await ack()
    const b = body as ViewSubmissionBodyLike
    await safeInvoke(onInbound, {
      kind: "view_submission",
      user: b.user?.id ?? "<unknown>",
      viewId: view.id,
      callbackId: view.callback_id,
      values: view.state?.values ?? {},
      triggerId: b.trigger_id ?? "",
    })
  })

  log.info("slack: registered event handlers (message, app_mention, member_joined, file_shared, reaction_added, block_actions, view_submission)")
}

// ---------------------------------------------------------------------------
// Small outbound helpers — everything Bolt exposes via app.client.chat.*,
// typed the way the rest of the codebase expects it.
// ---------------------------------------------------------------------------

export interface PostMessageInput {
  channel: string
  text?: string
  threadTs?: string
  blocks?: KnownBlock[]
}

export async function postMessage(
  app: App,
  input: PostMessageInput,
): Promise<{ ts: string; channel: string }> {
  const res = await app.client.chat.postMessage({
    channel: input.channel,
    text: input.text ?? "",
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    ...(input.blocks ? { blocks: input.blocks } : {}),
  })
  if (!res.ok || !res.ts || !res.channel) {
    throw new Error(`chat.postMessage failed: ${res.error ?? "unknown"}`)
  }
  return { ts: String(res.ts), channel: String(res.channel) }
}

// ---------------------------------------------------------------------------
// Internal guards — Bolt's event payload types are loose unions; we narrow
// just enough to access the fields we care about, without casting to `any`.
// ---------------------------------------------------------------------------

interface MessageEventLike {
  subtype?: string
  bot_id?: string
  user?: string
  channel?: string
  text?: string
  ts?: string
  thread_ts?: string
  files?: Array<{
    id?: string
    name?: string
    mimetype?: string
    filetype?: string
    url_private?: string
    url_private_download?: string
  }>
}

interface AppMentionLike {
  user?: string
  channel?: string
  text?: string
  ts?: string
  thread_ts?: string
  files?: MessageEventLike["files"]
}

interface ReactionAddedLike {
  user?: string
  reaction?: string
  item?: { ts?: string; channel?: string }
}

interface BlockActionBodyLike {
  user?: { id?: string }
  channel?: { id?: string }
  trigger_id?: string
  message?: { ts?: string }
}

interface ViewSubmissionBodyLike {
  user?: { id?: string }
  trigger_id?: string
}

async function safeInvoke(handler: InboundHandler, event: InboundSlackEvent): Promise<void> {
  try {
    await handler(event)
  } catch (err) {
    log.error(`slack inbound handler threw for ${event.kind}: ${String(err)}`)
  }
}

function normaliseFile(
  f: NonNullable<MessageEventLike["files"]>[number],
): InboundFileMetadata {
  return {
    id: f.id ?? "",
    ...(f.name ? { name: f.name } : {}),
    ...(f.mimetype ? { mimetype: f.mimetype } : {}),
    ...(f.filetype ? { filetype: f.filetype } : {}),
    ...(f.url_private ? { url_private: f.url_private } : {}),
    ...(f.url_private_download ? { url_private_download: f.url_private_download } : {}),
  }
}
