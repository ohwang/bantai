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

/**
 * Body Bolt expects back from an `app.command(...)` ack. The `text` path
 * renders via Slack mrkdwn (short banners / errors) and the `blocks`
 * path opens the door to rich in-channel responses — we only use `text`
 * today.
 *
 * `response_type: "ephemeral"` (default) scopes the ack to the invoker.
 * `"in_channel"` posts it as a regular channel message everybody sees —
 * used for state-changing commands (`new`, `stop`, `model <id>`,
 * `verbosity`) where the thread should reflect what happened.
 */
export interface SlashCommandAckBody {
  text?: string
  response_type?: "ephemeral" | "in_channel"
  blocks?: KnownBlock[]
}

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
  | {
      kind: "slash_command"
      /**
       * Full command token including the leading slash, e.g. "/bantai".
       * The router branches on the literal value so extra commands
       * (`/bantai-review`, `/bantai-pair`, …) can coexist later without
       * a wire-format change.
       */
      command: string
      /** Everything the user typed after the command. May be empty. */
      text: string
      /** Channel the command was invoked from. */
      channel: string
      /** Channel's display name (from Slack's payload). May be "directmessage" for DMs. */
      channelName?: string
      /** Slack user who invoked the command. */
      user: string
      /**
       * `thread_ts` from Slack's payload when the command was invoked
       * from inside a thread. Slash commands fired from the channel
       * composer arrive without it; thread-scoped commands (`new`,
       * `stop`, …) refuse to run and prompt the user to invoke inside
       * a thread.
       */
      threadTs?: string
      /**
       * 30-minute delayed-response URL. Up to 5 posts; used for the
       * in_channel acks that should land as real channel messages
       * instead of ephemerals.
       */
      responseUrl: string
      /** Trigger id — lets future commands open a modal in response. */
      triggerId: string
      /**
       * Ack callback — Bolt requires it be called within 3s with a
       * response body. The router invokes this exactly once per event
       * with the ephemeral/in-channel text the command produced.
       */
      ack: (body: SlashCommandAckBody) => Promise<void>
    }
  | {
      kind: "block_action"
      channel?: string
      user: string
      actionId: string
      /**
       * Clicked value for buttons (`action.value`) or selects
       * (`action.selected_option.value`). Undefined when the action
       * carries no value (e.g. overflow menus we don't use yet).
       */
      value?: string
      triggerId: string
      /** ts of the message the user clicked on. */
      messageTs?: string
      /**
       * thread_ts of the message the user clicked on. Needed to route
       * an interactive-reply click back into the thread's session.
       */
      messageThreadTs?: string
      payload: unknown
    }
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
  // slash_commands — `/bantai <subcommand>` global slash command.
  //
  // Bolt demands the handler ack within 3s; we DON'T ack here (the
  // command dispatcher posts the response via `ack({ text, ... })` so the
  // ack body carries the actual reply). If the handler throws before the
  // router calls ack, Bolt's own timeout fires and Slack renders an
  // "operation_timeout" to the user.
  // -------------------------------------------------------------------------
  app.command(/.*/, async ({ command, ack }) => {
    const c = command as SlashCommandLike
    if (!c.command || !c.channel_id || !c.user_id) {
      await ack()
      log.warn(
        `slack: slash command with missing fields: ${JSON.stringify({
          command: c.command,
          channel: c.channel_id,
          user: c.user_id,
        })}`,
      )
      return
    }
    // Guard against double-ack — the router calls `ack` with a body and
    // nothing else should. Bolt tolerates `ack()` never firing within 3s
    // (it auto-acks with an empty body), but firing it twice throws a
    // "multiple_acknowledgments" error, which we've seen eat the actual
    // response payload on Slack's side.
    let acked = false
    const safeAck = async (body: SlashCommandAckBody): Promise<void> => {
      if (acked) return
      acked = true
      await ack(body)
    }
    await safeInvoke(onInbound, {
      kind: "slash_command",
      command: c.command,
      text: c.text ?? "",
      channel: c.channel_id,
      ...(c.channel_name ? { channelName: c.channel_name } : {}),
      user: c.user_id,
      ...(c.thread_ts ? { threadTs: c.thread_ts } : {}),
      responseUrl: c.response_url ?? "",
      triggerId: c.trigger_id ?? "",
      ack: safeAck,
    })
    // Fallback: if the router never called `ack`, fire the default empty
    // ack so Slack doesn't render a 3-second timeout. `safeAck` is
    // idempotent, so this is a no-op when the router acked first.
    await safeAck({})
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
    const value = extractActionValue(action)
    await safeInvoke(onInbound, {
      kind: "block_action",
      channel: b.channel?.id,
      user: b.user?.id ?? "<unknown>",
      actionId,
      ...(value !== undefined ? { value } : {}),
      triggerId: b.trigger_id ?? "",
      ...(b.message?.ts ? { messageTs: b.message.ts } : {}),
      ...(b.message?.thread_ts ? { messageThreadTs: b.message.thread_ts } : {}),
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

  log.info("slack: registered event handlers (message, app_mention, member_joined, file_shared, reaction_added, slash_command, block_actions, view_submission)")
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

interface SlashCommandLike {
  command?: string
  text?: string
  channel_id?: string
  channel_name?: string
  user_id?: string
  /**
   * Slack sends `thread_ts` when the command is invoked from inside a
   * thread (the Side Panel / thread composer). Absent when invoked at
   * channel root.
   */
  thread_ts?: string
  response_url?: string
  trigger_id?: string
}

interface BlockActionBodyLike {
  user?: { id?: string }
  channel?: { id?: string }
  trigger_id?: string
  message?: { ts?: string; thread_ts?: string }
}

/**
 * Extract the `value` payload from a Slack action. Buttons expose it
 * directly at `action.value`; static selects put it at
 * `action.selected_option.value`; multi-selects return an array at
 * `action.selected_options` which we join with newlines. Returns
 * undefined when the action has no value the agent should react to.
 */
function extractActionValue(action: unknown): string | undefined {
  if (typeof action !== "object" || action === null) return undefined
  const a = action as {
    value?: string
    selected_option?: { value?: string }
    selected_options?: Array<{ value?: string }>
  }
  if (typeof a.value === "string") return a.value
  if (a.selected_option && typeof a.selected_option.value === "string") {
    return a.selected_option.value
  }
  if (Array.isArray(a.selected_options)) {
    const values = a.selected_options
      .map((o) => o.value)
      .filter((v): v is string => typeof v === "string")
    if (values.length > 0) return values.join("\n")
  }
  return undefined
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
