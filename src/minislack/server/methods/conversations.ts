/**
 * conversations.* — list / info / history (phase 1).
 *
 * Phase 4 adds `replies`. Phase 3 adds `create`, `join`, `members`, `open`.
 */

import { listHistory, listReplies } from "../../core/messages"
import { MinislackError } from "../../core/channels"
import type { Channel, Message, Workspace } from "../../types/slack"

export interface ListArgs {
  types?: string       // "public_channel,private_channel,mpim,im" — comma separated
  exclude_archived?: boolean
  limit?: number
  cursor?: string      // unused — Phase 9 if we need pagination
}

export interface ListResponse {
  ok: true
  channels: Channel[]
  response_metadata: { next_cursor: string }
}

export function conversationsList(ws: Workspace, args: ListArgs = {}): ListResponse {
  const requested = parseTypeFilter(args.types ?? "public_channel")
  const out: Channel[] = []
  for (const ch of ws.channels.values()) {
    if (args.exclude_archived) {
      if ("is_archived" in ch && ch.is_archived) continue
    }
    if (!matchesTypeFilter(ch, requested)) continue
    out.push(ch)
  }
  const limit = args.limit ?? 1000
  return {
    ok: true,
    channels: out.slice(0, limit),
    response_metadata: { next_cursor: "" },
  }
}

export interface HistoryArgs {
  channel: string
  latest?: string
  oldest?: string
  inclusive?: boolean
  limit?: number
}

export interface HistoryResponse {
  ok: true
  channel: string
  messages: Message[]
  has_more: boolean
  pin_count: number
}

export function conversationsHistory(ws: Workspace, args: HistoryArgs): HistoryResponse {
  const ch = resolveChannel(ws, args.channel)
  const { messages, has_more } = listHistory(ch, args)
  return {
    ok: true,
    channel: ch.id,
    messages,
    has_more,
    pin_count: 0,
  }
}

export interface InfoArgs {
  channel: string
}

export interface InfoResponse {
  ok: true
  channel: Channel
}

export function conversationsInfo(ws: Workspace, args: InfoArgs): InfoResponse {
  const ch = resolveChannel(ws, args.channel)
  return { ok: true, channel: ch }
}

export interface RepliesArgs {
  channel: string
  ts: string
  latest?: string
  oldest?: string
  inclusive?: boolean
  limit?: number
}

export interface RepliesResponse {
  ok: true
  messages: Message[]
  has_more: boolean
}

export function conversationsReplies(ws: Workspace, args: RepliesArgs): RepliesResponse {
  const ch = resolveChannel(ws, args.channel)
  const { messages, has_more } = listReplies(ch, args.ts, args)
  return { ok: true, messages, has_more }
}

// ---------------------------------------------------------------------------
// conversations.open — open or reopen a DM / mpim
// ---------------------------------------------------------------------------

export interface OpenArgs {
  /** Comma-separated list of user ids. One = DM, two+ = mpim. */
  users?: string
  /** Existing channel id (D… or M…) to reopen. */
  channel?: string
  /** If true, return channel info even on reopen. */
  return_im?: boolean
}

export interface OpenResponse {
  ok: true
  no_op?: boolean
  already_open?: boolean
  channel: Channel
}

export function conversationsOpen(
  ws: Workspace,
  callerUserId: string,
  args: OpenArgs,
): OpenResponse {
  if (args.channel) {
    const ch = ws.channels.get(args.channel)
    if (!ch) throw new MinislackError("channel_not_found", args.channel)
    let already_open = true
    if (ch.is_im && !ch.is_open) {
      ch.is_open = true
      already_open = false
    } else if (ch.is_mpim && !ch.is_open) {
      ch.is_open = true
      already_open = false
    }
    return { ok: true, no_op: already_open, already_open, channel: ch }
  }

  const others = (args.users ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (others.length === 0) {
    throw new MinislackError("users_list_not_supplied")
  }
  for (const uid of others) {
    if (!ws.users.has(uid)) throw new MinislackError("user_not_found", uid)
  }

  // Single user (or self) → DM. Multiple → mpim including the caller.
  if (others.length === 1) {
    const ch = openDirectMessage(ws, callerUserId, others[0]!)
    return { ok: true, channel: ch }
  }
  const members = Array.from(new Set([callerUserId, ...others]))
  const ch = createMpim(ws, callerUserId, members)
  return { ok: true, channel: ch }
}

// Bring channel helpers in for the new method.
import { createMpim, openDirectMessage } from "../../core/channels"

// ---------------------------------------------------------------------------

function parseTypeFilter(types: string): Set<string> {
  return new Set(types.split(",").map((t) => t.trim()).filter(Boolean))
}

function matchesTypeFilter(ch: Channel, types: Set<string>): boolean {
  if (types.has("public_channel") && ch.is_channel && !ch.is_private) return true
  if (types.has("private_channel") && "is_private" in ch && ch.is_private && !ch.is_im && !ch.is_mpim) return true
  if (types.has("mpim") && ch.is_mpim) return true
  if (types.has("im") && ch.is_im) return true
  return false
}

function resolveChannel(ws: Workspace, idOrName: string): Channel {
  const direct = ws.channels.get(idOrName)
  if (direct) return direct
  const handle = idOrName.startsWith("#") ? idOrName.slice(1) : idOrName
  for (const ch of ws.channels.values()) {
    if ("name" in ch && ch.name === handle) return ch
  }
  throw new MinislackError("channel_not_found", idOrName)
}
