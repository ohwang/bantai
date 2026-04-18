/**
 * Messages — post, list, thread replies.
 *
 * Phase 4 adds thread bookkeeping: when a reply arrives (thread_ts set),
 * the parent's reply_count / reply_users / latest_reply are maintained.
 * Edit / delete / reactions land in Phase 5.
 */

import { assertMember, MinislackError } from "./channels"
import { nextTs, compareTs } from "./ts"
import type {
  Channel,
  File,
  Message,
  Workspace,
} from "../types/slack"
import type { Block, KnownBlock } from "@slack/types"
import type { MessageAttachment } from "@slack/types"

export interface PostMessageOpts {
  channelId: string
  userId: string
  text: string
  /** Bot context — set when posting via an app's bot token. */
  bot_id?: string
  app_id?: string
  blocks?: (KnownBlock | Block)[]
  attachments?: MessageAttachment[]
  thread_ts?: string
  client_msg_id?: string
  /** Injectable clock for deterministic tests. */
  now?: () => number
  /** Files attached to this message (Phase 7). */
  files?: File[]
}

export interface PostMessageResult {
  message: Message
  /**
   * When the post is a thread reply, the parent Message AFTER bookkeeping
   * (reply_count etc. already incremented). Callers emit a message_changed
   * event for this so clients update their counters.
   */
  threadParent?: Message
}

export function postMessage(ws: Workspace, opts: PostMessageOpts): Message {
  return postMessageDetailed(ws, opts).message
}

/** Like postMessage but also returns the updated thread parent (if any). */
export function postMessageDetailed(ws: Workspace, opts: PostMessageOpts): PostMessageResult {
  const ch = ws.channels.get(opts.channelId)
  if (!ch) throw new MinislackError("channel_not_found", opts.channelId)
  assertMember(ch, opts.userId)

  if (
    opts.text.trim().length === 0 &&
    !opts.blocks &&
    !opts.attachments &&
    !(opts.files && opts.files.length > 0)
  ) {
    throw new MinislackError("no_text", "message must have text, blocks, attachments, or files")
  }

  // Resolve the thread parent before minting a ts so we can reject broken
  // references up front. `thread_ts === ts` is allowed and no-ops below.
  let parent: Message | undefined
  if (opts.thread_ts) {
    const candidate = ch.messages.get(opts.thread_ts)
    if (!candidate || candidate.tombstone) {
      throw new MinislackError("message_not_found", `parent message ${opts.thread_ts} missing`)
    }
    // If someone replies to a reply, hoist to the top-level parent — Slack
    // flattens threads to one level.
    parent = candidate.thread_ts && candidate.thread_ts !== candidate.ts
      ? ch.messages.get(candidate.thread_ts)
      : candidate
    if (!parent) {
      throw new MinislackError("message_not_found", `root of ${opts.thread_ts} missing`)
    }
  }

  const ts = nextTs(ws, ch.id, opts.now)
  const isReply = !!parent && parent.ts !== ts
  const effectiveThreadTs = parent ? parent.ts : undefined

  // Real Slack stamps a client_msg_id server-side when the caller didn't
  // supply one. bolt-js warns on its absence.
  const clientMsgId = opts.client_msg_id ?? (opts.bot_id ? undefined : crypto.randomUUID())

  const msg: Message = {
    type: "message",
    ts,
    channel: ch.id,
    user: opts.userId,
    text: opts.text,
    team: ws.team.id,
    ...(opts.bot_id ? { bot_id: opts.bot_id, subtype: "bot_message" } : {}),
    ...(opts.app_id ? { app_id: opts.app_id } : {}),
    ...(opts.blocks ? { blocks: opts.blocks } : {}),
    ...(opts.attachments ? { attachments: opts.attachments } : {}),
    ...(effectiveThreadTs ? { thread_ts: effectiveThreadTs } : {}),
    ...(clientMsgId ? { client_msg_id: clientMsgId } : {}),
    ...(opts.files && opts.files.length > 0 ? { files: [...opts.files] } : {}),
    ...(isReply && parent ? { parent_user_id: parent.user } : {}),
  }
  ch.messages.set(ts, msg)

  let threadParent: Message | undefined
  if (isReply && parent) {
    parent.is_thread_parent = true
    parent.reply_count = (parent.reply_count ?? 0) + 1
    const users = parent.reply_users ?? []
    if (!users.includes(opts.userId)) users.push(opts.userId)
    parent.reply_users = users
    parent.reply_users_count = users.length
    parent.latest_reply = ts
    threadParent = parent
  }

  return { message: msg, threadParent }
}

export interface HistoryOpts {
  /** Return messages strictly older than this ts. */
  latest?: string
  /** Return messages strictly newer than this ts. */
  oldest?: string
  /** Inclusive on the bounds. Default false (Slack default). */
  inclusive?: boolean
  /** Max messages to return. Default 100. */
  limit?: number
}

/**
 * Return channel history in Slack's default order: newest-first, capped.
 * Hides tombstoned messages but keeps their slots reserved.
 */
export function listHistory(
  ch: Channel,
  opts: HistoryOpts = {},
): { messages: Message[]; has_more: boolean } {
  const limit = opts.limit ?? 100
  const inclusive = !!opts.inclusive
  const all: Message[] = []
  for (const m of ch.messages.values()) {
    if (m.tombstone) continue
    if (m.thread_ts && m.thread_ts !== m.ts) {
      // Thread replies are only returned in conversations.replies.
      continue
    }
    if (opts.latest !== undefined) {
      const cmp = compareTs(m.ts, opts.latest)
      if (inclusive ? cmp > 0 : cmp >= 0) continue
    }
    if (opts.oldest !== undefined) {
      const cmp = compareTs(m.ts, opts.oldest)
      if (inclusive ? cmp < 0 : cmp <= 0) continue
    }
    all.push(m)
  }
  all.sort((a, b) => compareTs(b.ts, a.ts)) // newest first
  const sliced = all.slice(0, limit)
  return { messages: sliced, has_more: all.length > sliced.length }
}

/** Fetch a message by ts within a channel, or undefined if missing/tombstoned. */
export function getMessage(ch: Channel, ts: string): Message | undefined {
  const m = ch.messages.get(ts)
  if (!m || m.tombstone) return undefined
  return m
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export interface RepliesOpts {
  /** Return messages strictly older than this ts. */
  latest?: string
  /** Return messages strictly newer than this ts. */
  oldest?: string
  inclusive?: boolean
  /** Max replies to return. Default 1000 (Slack's max). */
  limit?: number
}

/**
 * Return a thread: the parent message first, then its replies oldest-first.
 * Mirrors Slack's `conversations.replies` ordering.
 */
export function listReplies(
  ch: Channel,
  threadTs: string,
  opts: RepliesOpts = {},
): { messages: Message[]; has_more: boolean } {
  const parent = ch.messages.get(threadTs)
  if (!parent || parent.tombstone) {
    throw new MinislackError("message_not_found", threadTs)
  }
  const inclusive = !!opts.inclusive
  const out: Message[] = [parent]
  const replies: Message[] = []
  for (const m of ch.messages.values()) {
    if (m.tombstone) continue
    if (m.thread_ts !== threadTs || m.ts === threadTs) continue
    if (opts.latest !== undefined) {
      const cmp = compareTs(m.ts, opts.latest)
      if (inclusive ? cmp > 0 : cmp >= 0) continue
    }
    if (opts.oldest !== undefined) {
      const cmp = compareTs(m.ts, opts.oldest)
      if (inclusive ? cmp < 0 : cmp <= 0) continue
    }
    replies.push(m)
  }
  replies.sort((a, b) => compareTs(a.ts, b.ts))
  const limit = opts.limit ?? 1000
  const sliced = replies.slice(0, limit)
  out.push(...sliced)
  return { messages: out, has_more: replies.length > sliced.length }
}

// ---------------------------------------------------------------------------
// Edit / delete
// ---------------------------------------------------------------------------

export interface EditMessageOpts {
  channelId: string
  ts: string
  userId: string
  text: string
  blocks?: (KnownBlock | Block)[]
  attachments?: MessageAttachment[]
  /** Injectable clock. */
  now?: () => number
}

export interface EditMessageResult {
  message: Message
  previous: Message
}

/**
 * Edit a message in place. Mutates the stored Message so downstream state
 * stays consistent. Records `edited: { user, ts }` per Slack's shape.
 * Returns a snapshot of the previous state for `message_changed` events.
 */
export function editMessage(ws: Workspace, opts: EditMessageOpts): EditMessageResult {
  const ch = ws.channels.get(opts.channelId)
  if (!ch) throw new MinislackError("channel_not_found", opts.channelId)
  const msg = ch.messages.get(opts.ts)
  if (!msg || msg.tombstone) throw new MinislackError("message_not_found", opts.ts)
  if (msg.user !== opts.userId) {
    throw new MinislackError("cant_update_message", "only the author can edit")
  }
  if (opts.text.trim().length === 0 && !opts.blocks && !opts.attachments) {
    throw new MinislackError("no_text")
  }
  const previous: Message = { ...msg }
  msg.text = opts.text
  if (opts.blocks !== undefined) msg.blocks = opts.blocks
  if (opts.attachments !== undefined) msg.attachments = opts.attachments
  const editTs = nextTs(ws, ch.id, opts.now)
  msg.edited = { user: opts.userId, ts: editTs }
  return { message: msg, previous }
}

export interface DeleteMessageOpts {
  channelId: string
  ts: string
  userId: string
}

export interface DeleteMessageResult {
  previous: Message
}

/**
 * Tombstone a message. The slot stays so `ts` doesn't collide; the record
 * becomes invisible to history / replies / getMessage.
 */
export function deleteMessage(ws: Workspace, opts: DeleteMessageOpts): DeleteMessageResult {
  const ch = ws.channels.get(opts.channelId)
  if (!ch) throw new MinislackError("channel_not_found", opts.channelId)
  const msg = ch.messages.get(opts.ts)
  if (!msg || msg.tombstone) throw new MinislackError("message_not_found", opts.ts)
  if (msg.user !== opts.userId) {
    throw new MinislackError("cant_delete_message", "only the author can delete")
  }
  const previous: Message = { ...msg }
  msg.tombstone = true
  return { previous }
}
