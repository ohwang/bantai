/**
 * chat.postMessage — post a message as the authed principal.
 *
 * Phase 1: plaintext + thread_ts + blocks/attachments passthrough. Phase 4
 * adds thread parent bookkeeping (reply_count/latest_reply). Phase 5 adds
 * chat.update / chat.delete.
 */

import {
  appendStream,
  deleteMessage,
  editMessage,
  postMessageDetailed,
  startStream,
  stopStream,
} from "../../core/messages"
import { nextTs } from "../../core/ts"
import { MinislackError } from "../../core/channels"
import { channelTypeOf, messageToMessageEvent } from "../../core/event-mappers"
import type { EventBus } from "../../core/events"
import type { Channel, Message, Workspace } from "../../types/slack"
import type {
  EphemeralMessageEvent,
  MessageChangedEvent,
  MessageDeletedEvent,
} from "../../types/events"
import type { AuthContext } from "../auth"
import type { AnyChunk, KnownBlock, Block } from "@slack/types"
import type { MessageAttachment } from "@slack/types"
import { log } from "../../../utils/logger"

export interface ChatPostMessageArgs {
  channel: string
  text?: string
  /**
   * Slack's native GFM body (tables, fenced code, headers, task lists).
   * Mutually exclusive with `text` on real Slack (returns
   * `markdown_text_conflict`); minislack mirrors the accept-path but
   * stores the body as plain `text` on the Message record — tests that
   * introspect the message see the raw markdown.
   */
  markdown_text?: string
  thread_ts?: string
  /** When true on a thread reply, also surface the message in the channel. */
  reply_broadcast?: boolean
  blocks?: (KnownBlock | Block)[]
  attachments?: MessageAttachment[]
  client_msg_id?: string
  /** Posted as this user_id (overrides the token's user for user-token callers only). */
  as_user?: string
}

export interface ChatPostMessageResponse {
  ok: true
  channel: string
  ts: string
  message: Message
}

export function chatPostMessage(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: ChatPostMessageArgs,
): ChatPostMessageResponse {
  const ch = resolve(ws, args.channel)
  if (ctx.kind === "app") {
    throw new MinislackError("not_authed", "chat.postMessage requires a user or bot token")
  }
  if (args.text !== undefined && args.markdown_text !== undefined) {
    throw new MinislackError(
      "markdown_text_conflict",
      "chat.postMessage accepts either text or markdown_text, not both",
    )
  }
  const userId = ctx.userId
  if (!userId) throw new MinislackError("not_authed")
  const { message: msg, threadParent } = postMessageDetailed(ws, {
    channelId: ch.id,
    userId,
    text: args.markdown_text ?? args.text ?? "",
    blocks: args.blocks,
    attachments: args.attachments,
    thread_ts: args.thread_ts,
    client_msg_id: args.client_msg_id,
    ...(ctx.kind === "bot"
      ? { bot_id: ctx.botId, app_id: ctx.appId }
      : {}),
  })
  // reply_broadcast on a thread reply: Slack stamps the message with
  // subtype "thread_broadcast" so the channel feed renders a copy.
  if (args.reply_broadcast && msg.thread_ts && msg.thread_ts !== msg.ts) {
    msg.subtype = "thread_broadcast"
  }
  bus.publish(messageToMessageEvent(msg, ch))
  if (threadParent) {
    bus.publish(buildThreadParentChanged(threadParent, ch))
  }
  return { ok: true, channel: ch.id, ts: msg.ts, message: msg }
}

/**
 * Emit a message_changed event for the thread parent when reply count updates.
 * Slack does this so clients can refresh their "N replies" badge without
 * refetching the whole channel.
 */
function buildThreadParentChanged(parent: Message, ch: Channel): MessageChangedEvent {
  return {
    type: "message",
    subtype: "message_changed",
    event_ts: parent.latest_reply ?? parent.ts,
    ts: parent.latest_reply ?? parent.ts,
    channel: parent.channel,
    channel_type: channelTypeOf(ch),
    message: {
      type: "message",
      user: parent.user,
      text: parent.text,
      ts: parent.ts,
      ...(parent.edited ? { edited: parent.edited } : {}),
      ...(parent.blocks ? { blocks: parent.blocks } : {}),
      ...(parent.attachments ? { attachments: parent.attachments } : {}),
      ...(parent.thread_ts ? { thread_ts: parent.thread_ts } : {}),
      ...(parent.reply_count !== undefined ? { reply_count: parent.reply_count } : {}),
      ...(parent.reply_users ? { reply_users: parent.reply_users } : {}),
      ...(parent.reply_users_count !== undefined ? { reply_users_count: parent.reply_users_count } : {}),
      ...(parent.latest_reply ? { latest_reply: parent.latest_reply } : {}),
    },
    previous_message: {
      type: "message",
      user: parent.user,
      text: parent.text,
      ts: parent.ts,
    },
    hidden: true,
  }
}

function resolve(ws: Workspace, idOrName: string): Channel {
  const direct = ws.channels.get(idOrName)
  if (direct) return direct
  const handle = idOrName.startsWith("#") ? idOrName.slice(1) : idOrName
  for (const ch of ws.channels.values()) {
    if ("name" in ch && ch.name === handle) return ch
  }
  throw new MinislackError("channel_not_found", idOrName)
}

// ---------------------------------------------------------------------------
// chat.update / chat.delete
// ---------------------------------------------------------------------------

export interface ChatUpdateArgs {
  channel: string
  ts: string
  text?: string
  /** See ChatPostMessageArgs.markdown_text — same semantics on update. */
  markdown_text?: string
  blocks?: (KnownBlock | Block)[]
  attachments?: MessageAttachment[]
}

export interface ChatUpdateResponse {
  ok: true
  channel: string
  ts: string
  text: string
  message: Message
}

export function chatUpdate(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: ChatUpdateArgs,
): ChatUpdateResponse {
  const ch = resolve(ws, args.channel)
  const userId = ctx.userId
  if (!userId) throw new MinislackError("not_authed")
  if (args.text !== undefined && args.markdown_text !== undefined) {
    throw new MinislackError(
      "markdown_text_conflict",
      "chat.update accepts either text or markdown_text, not both",
    )
  }
  const { message, previous } = editMessage(ws, {
    channelId: ch.id,
    ts: args.ts,
    userId,
    text: args.markdown_text ?? args.text ?? "",
    blocks: args.blocks,
    attachments: args.attachments,
  })
  bus.publish(buildMessageChanged(message, previous, ch))
  return { ok: true, channel: ch.id, ts: message.ts, text: message.text, message }
}

export interface ChatDeleteArgs {
  channel: string
  ts: string
}

export interface ChatDeleteResponse {
  ok: true
  channel: string
  ts: string
}

export function chatDelete(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: ChatDeleteArgs,
): ChatDeleteResponse {
  const ch = resolve(ws, args.channel)
  const userId = ctx.userId
  if (!userId) throw new MinislackError("not_authed")
  const { previous } = deleteMessage(ws, {
    channelId: ch.id,
    ts: args.ts,
    userId,
  })
  // event_ts is the wall-clock of the delete, not the original post.
  const deleteEventTs = nextTs(ws, ch.id)
  const evt: MessageDeletedEvent = {
    type: "message",
    subtype: "message_deleted",
    event_ts: deleteEventTs,
    ts: deleteEventTs,
    deleted_ts: args.ts,
    channel: ch.id,
    channel_type: channelTypeOf(ch),
    previous_message: {
      type: "message",
      user: previous.user,
      text: previous.text,
      ts: previous.ts,
    },
    hidden: true,
  }
  bus.publish(evt)
  return { ok: true, channel: ch.id, ts: args.ts }
}

// ---------------------------------------------------------------------------
// chat.postEphemeral — visible only to one user; nothing stored in the channel.
// ---------------------------------------------------------------------------

export interface ChatPostEphemeralArgs {
  channel: string
  user: string
  text?: string
  blocks?: (KnownBlock | Block)[]
  attachments?: MessageAttachment[]
  thread_ts?: string
}

export interface ChatPostEphemeralResponse {
  ok: true
  message_ts: string
}

export function chatPostEphemeral(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: ChatPostEphemeralArgs,
): ChatPostEphemeralResponse {
  const ch = resolve(ws, args.channel)
  if (!ctx.userId) throw new MinislackError("not_authed")
  if (!ws.users.has(args.user)) {
    throw new MinislackError("user_not_in_channel", args.user)
  }
  if (
    (args.text ?? "").trim().length === 0 &&
    !args.blocks &&
    !args.attachments
  ) {
    throw new MinislackError("no_text", "ephemeral must have text, blocks, or attachments")
  }
  // Ephemerals don't persist into channel.messages; they live in a parallel
  // per-workspace log so the SPA + tests can observe them.
  const ts = nextTs(ws, ch.id)
  ws.ephemerals.push({
    ts,
    channel: ch.id,
    user: args.user,
    posted_by: ctx.userId,
    ...(ctx.kind === "bot" && ctx.botId ? { bot_id: ctx.botId } : {}),
    ...(ctx.kind === "bot" && ctx.appId ? { app_id: ctx.appId } : {}),
    text: args.text ?? "",
    ...(args.blocks ? { blocks: args.blocks } : {}),
    ...(args.attachments ? { attachments: args.attachments } : {}),
    ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
  })
  const evt: EphemeralMessageEvent = {
    type: "ephemeral_message",
    event_ts: ts,
    ts,
    channel: ch.id,
    user: args.user,
    posted_by: ctx.userId,
    ...(ctx.kind === "bot" && ctx.botId ? { bot_id: ctx.botId } : {}),
    ...(ctx.kind === "bot" && ctx.appId ? { app_id: ctx.appId } : {}),
    text: args.text ?? "",
    ...(args.blocks ? { blocks: args.blocks } : {}),
    ...(args.attachments ? { attachments: args.attachments } : {}),
    ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
  }
  bus.publish(evt)
  return { ok: true, message_ts: ts }
}

// ---------------------------------------------------------------------------
// chat.startStream / chat.appendStream / chat.stopStream — Assistant API
// streaming surface. A streaming message is an ordinary Message flagged
// `streaming: true`; appends mutate in place and publish message_changed
// so any client that already handles edits renders the stream naturally.
// ---------------------------------------------------------------------------

export interface ChatStartStreamArgs {
  channel: string
  thread_ts?: string
  recipient_team_id?: string
  recipient_user_id?: string
  /** Slack's Assistant API accepts EITHER markdown_text OR chunks. Optional. */
  markdown_text?: string
  chunks?: AnyChunk[]
}

export interface ChatStartStreamResponse {
  ok: true
  channel: string
  ts: string
  message: Message
}

export function chatStartStream(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: ChatStartStreamArgs,
): ChatStartStreamResponse {
  const ch = resolve(ws, args.channel)
  if (ctx.kind === "app") {
    throw new MinislackError("not_authed", "chat.startStream requires a user or bot token")
  }
  const userId = ctx.userId
  if (!userId) throw new MinislackError("not_authed")
  const initialText = extractStreamText(args)
  const { message: msg, threadParent } = startStream(ws, {
    channelId: ch.id,
    userId,
    thread_ts: args.thread_ts,
    ...(ctx.kind === "bot"
      ? { bot_id: ctx.botId, app_id: ctx.appId }
      : {}),
    ...(args.recipient_team_id ? { recipient_team_id: args.recipient_team_id } : {}),
    ...(args.recipient_user_id ? { recipient_user_id: args.recipient_user_id } : {}),
    ...(initialText ? { initialText } : {}),
  })
  bus.publish(messageToMessageEvent(msg, ch))
  if (threadParent) {
    bus.publish(buildThreadParentChanged(threadParent, ch))
  }
  return { ok: true, channel: ch.id, ts: msg.ts, message: msg }
}

export interface ChatAppendStreamArgs {
  channel: string
  ts: string
  /** Slack accepts EITHER markdown_text OR chunks. One must yield non-empty text. */
  markdown_text?: string
  chunks?: AnyChunk[]
}

export interface ChatAppendStreamResponse {
  ok: true
  channel: string
  ts: string
}

export function chatAppendStream(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: ChatAppendStreamArgs,
): ChatAppendStreamResponse {
  const ch = resolve(ws, args.channel)
  const userId = ctx.userId
  if (!userId) throw new MinislackError("not_authed")
  const text = extractStreamText(args)
  if (text.length === 0) {
    throw new MinislackError(
      "invalid_arguments",
      "chat.appendStream requires non-empty markdown_text or chunks",
    )
  }
  const { message, previous } = appendStream(ws, {
    channelId: ch.id,
    ts: args.ts,
    userId,
    markdown_text: text,
  })
  bus.publish(buildMessageChanged(message, previous, ch))
  return { ok: true, channel: ch.id, ts: message.ts }
}

export interface ChatStopStreamArgs {
  channel: string
  ts: string
  /** Overwrites the accumulator. Slack accepts text, markdown_text, or chunks. */
  text?: string
  markdown_text?: string
  chunks?: AnyChunk[]
  blocks?: (KnownBlock | Block)[]
  attachments?: MessageAttachment[]
}

export interface ChatStopStreamResponse {
  ok: true
  channel: string
  ts: string
  message: Message
}

export function chatStopStream(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: ChatStopStreamArgs,
): ChatStopStreamResponse {
  const ch = resolve(ws, args.channel)
  const userId = ctx.userId
  if (!userId) throw new MinislackError("not_authed")
  // Final text precedence: explicit `text` wins (it's what the existing
  // server-method surface accepted); otherwise pull from markdown_text /
  // chunks, which is what Bolt's ChatStreamer emits.
  const finalText = args.text !== undefined ? args.text : extractStreamText(args)
  const { message, previous } = stopStream(ws, {
    channelId: ch.id,
    ts: args.ts,
    userId,
    ...(args.text !== undefined || finalText.length > 0 ? { text: finalText } : {}),
    ...(args.blocks !== undefined ? { blocks: args.blocks } : {}),
    ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
  })
  bus.publish(buildMessageChanged(message, previous, ch))
  return { ok: true, channel: ch.id, ts: message.ts, message }
}

/**
 * Extract the text payload from Bolt-shaped streaming args. Slack's
 * Assistant API accepts either a single `markdown_text` string or an
 * array of typed `chunks`; the SDK's ChatStreamer always uses `chunks`.
 *
 * Only `markdown_text` chunks contribute to the visible body. Plan +
 * task chunks carry UI chrome (plan title, task cards) that minislack
 * doesn't render — we log the first instance per process and carry on
 * so a caller can't silently "lose" intent.
 */
let planChunkWarned = false
let taskChunkWarned = false
function extractStreamText(args: {
  markdown_text?: string
  chunks?: AnyChunk[]
}): string {
  const parts: string[] = []
  if (args.markdown_text) parts.push(args.markdown_text)
  if (Array.isArray(args.chunks)) {
    for (const raw of args.chunks) {
      // Incoming JSON may carry chunk types we don't know about — cast to a
      // broad shape so the `else` branch isn't narrowed to `never` by the
      // AnyChunk discriminant check.
      const chunk = raw as unknown as { type?: string; text?: string }
      if (!chunk || typeof chunk !== "object" || typeof chunk.type !== "string") {
        log.warn("chat stream chunks: skipping malformed entry")
        continue
      }
      if (chunk.type === "markdown_text") {
        parts.push(chunk.text ?? "")
      } else if (chunk.type === "plan_update") {
        if (!planChunkWarned) {
          planChunkWarned = true
          log.warn("chat stream chunks: plan_update not rendered by minislack (logged once per process)")
        }
      } else if (chunk.type === "task_update") {
        if (!taskChunkWarned) {
          taskChunkWarned = true
          log.warn("chat stream chunks: task_update not rendered by minislack (logged once per process)")
        }
      } else {
        log.warn(`chat stream chunks: unknown type "${chunk.type}" — ignoring`)
      }
    }
  }
  return parts.join("")
}

// ---------------------------------------------------------------------------
// chat.meMessage — "/me shrugs" style. Routes through postMessage with subtype.
// ---------------------------------------------------------------------------

export interface ChatMeMessageArgs {
  channel: string
  text: string
}

export function chatMeMessage(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: ChatMeMessageArgs,
): ChatPostMessageResponse {
  const res = chatPostMessage(ws, bus, ctx, { channel: args.channel, text: args.text })
  res.message.subtype = "me_message"
  return res
}

function buildMessageChanged(
  message: Message,
  previous: Message,
  ch: Channel,
): MessageChangedEvent {
  return {
    type: "message",
    subtype: "message_changed",
    event_ts: message.edited?.ts ?? message.ts,
    ts: message.edited?.ts ?? message.ts,
    channel: message.channel,
    channel_type: channelTypeOf(ch),
    message: {
      type: "message",
      user: message.user,
      text: message.text,
      ts: message.ts,
      ...(message.edited ? { edited: message.edited } : {}),
      ...(message.blocks ? { blocks: message.blocks } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
      ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
      ...(message.reply_count !== undefined ? { reply_count: message.reply_count } : {}),
      ...(message.reply_users ? { reply_users: message.reply_users } : {}),
      ...(message.reply_users_count !== undefined ? { reply_users_count: message.reply_users_count } : {}),
      ...(message.latest_reply ? { latest_reply: message.latest_reply } : {}),
    },
    previous_message: {
      type: "message",
      user: previous.user,
      text: previous.text,
      ts: previous.ts,
    },
  }
}
