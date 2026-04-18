/**
 * conversations.* — list / info / history (phase 1).
 *
 * Phase 4 adds `replies`. Phase 3 adds `create`, `join`, `members`, `open`.
 */

import { listHistory, listReplies, postMessage } from "../../core/messages"
import {
  createPublicChannel,
  createPrivateGroup,
  joinChannel,
  leaveChannel,
  MinislackError,
  channelView,
  type ChannelView,
} from "../../core/channels"
import { channelTypeOf, messageToMessageEvent } from "../../core/event-mappers"
import type { EventBus } from "../../core/events"
import { paginate } from "../pagination"
import type { Channel, Message, Workspace } from "../../types/slack"

export interface ListArgs {
  types?: string       // "public_channel,private_channel,mpim,im" — comma separated
  exclude_archived?: boolean
  limit?: number
  cursor?: string      // unused — Phase 9 if we need pagination
}

export interface ListResponse {
  ok: true
  channels: ChannelView[]
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
  const page = paginate(out, { limit: args.limit, cursor: args.cursor })
  return {
    ok: true,
    channels: page.items.map(channelView),
    response_metadata: { next_cursor: page.next_cursor },
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
  channel: ChannelView
}

export function conversationsInfo(ws: Workspace, args: InfoArgs): InfoResponse {
  const ch = resolveChannel(ws, args.channel)
  return { ok: true, channel: channelView(ch) }
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
  channel: ChannelView
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
    return { ok: true, no_op: already_open, already_open, channel: channelView(ch) }
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
    const before = ws.channels.size
    const ch = openDirectMessage(ws, callerUserId, others[0]!)
    const already_open = ws.channels.size === before
    return { ok: true, no_op: already_open, already_open, channel: channelView(ch) }
  }
  const members = Array.from(new Set([callerUserId, ...others]))
  const before = ws.channels.size
  const ch = createMpim(ws, callerUserId, members)
  const already_open = ws.channels.size === before
  return { ok: true, no_op: already_open, already_open, channel: channelView(ch) }
}

// Bring channel helpers in for the new method.
import { createMpim, openDirectMessage } from "../../core/channels"

// ---------------------------------------------------------------------------
// conversations.members — paginated roster of a channel
// ---------------------------------------------------------------------------

export interface MembersArgs {
  channel: string
  limit?: number
  cursor?: string
}

export interface MembersResponse {
  ok: true
  members: string[]
  response_metadata: { next_cursor: string }
}

export function conversationsMembers(ws: Workspace, args: MembersArgs): MembersResponse {
  const ch = resolveChannel(ws, args.channel)
  const page = paginate([...ch.members], { limit: args.limit, cursor: args.cursor })
  return {
    ok: true,
    members: page.items,
    response_metadata: { next_cursor: page.next_cursor },
  }
}

// ---------------------------------------------------------------------------
// conversations.join / .leave
// ---------------------------------------------------------------------------

export interface JoinArgs {
  channel: string
}

export interface JoinResponse {
  ok: true
  channel: ChannelView
  already_in_channel?: boolean
}

/**
 * Real Slack's conversations.join supports public channels only; private
 * channels throw `method_not_supported_for_channel_type`. We mirror that.
 *
 * On a new join, we publish both `member_joined_channel` and a message
 * event with `subtype: "channel_join"` — bolt apps filter on either.
 */
export function conversationsJoin(
  ws: Workspace,
  bus: EventBus,
  callerUserId: string,
  args: JoinArgs,
): JoinResponse {
  const ch = resolveChannel(ws, args.channel)
  if (!ch.is_channel) {
    throw new MinislackError("method_not_supported_for_channel_type", ch.id)
  }
  const already = ch.members.includes(callerUserId)
  joinChannel(ws, ch.id, callerUserId)
  if (!already) {
    bus.publish({
      type: "member_joined_channel",
      event_ts: new Date().toISOString(),
      user: callerUserId,
      channel: ch.id,
      channel_type: channelTypeOf(ch),
      team: ws.team.id,
    })
    // Slack also synthesises a message with subtype "channel_join".
    const user = ws.users.get(callerUserId)
    const joinText = `<@${callerUserId}> has joined the channel`
    const synthetic = postMessage(ws, {
      channelId: ch.id,
      userId: callerUserId,
      text: joinText,
    })
    synthetic.subtype = "channel_join"
    bus.publish({ ...messageToMessageEvent(synthetic, ch), subtype: "channel_join" })
    void user
  }
  return { ok: true, channel: channelView(ch), already_in_channel: already }
}

export interface LeaveArgs {
  channel: string
}

export interface LeaveResponse {
  ok: true
  not_in_channel?: boolean
}

export function conversationsLeave(
  ws: Workspace,
  bus: EventBus,
  callerUserId: string,
  args: LeaveArgs,
): LeaveResponse {
  const ch = resolveChannel(ws, args.channel)
  const wasMember = ch.members.includes(callerUserId)
  if (!wasMember) return { ok: true, not_in_channel: true }
  // Synthesize the "has left the channel" message BEFORE removing the user —
  // postMessage asserts membership, and Slack's wire order attributes the
  // message to the leaver on their way out.
  const leaveText = `<@${callerUserId}> has left the channel`
  const synthetic = postMessage(ws, {
    channelId: ch.id,
    userId: callerUserId,
    text: leaveText,
  })
  synthetic.subtype = "channel_leave"
  leaveChannel(ws, ch.id, callerUserId)
  bus.publish({
    type: "member_left_channel",
    event_ts: new Date().toISOString(),
    user: callerUserId,
    channel: ch.id,
    channel_type: channelTypeOf(ch),
    team: ws.team.id,
  })
  bus.publish({ ...messageToMessageEvent(synthetic, ch), subtype: "channel_leave" })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// conversations.create
// ---------------------------------------------------------------------------

export interface CreateArgs {
  name: string
  is_private?: boolean
  team_id?: string
}

export interface CreateResponse {
  ok: true
  channel: ChannelView
}

export function conversationsCreate(
  ws: Workspace,
  bus: EventBus,
  callerUserId: string,
  args: CreateArgs,
): CreateResponse {
  if (!args.name) throw new MinislackError("invalid_name", "missing name")
  const ch = args.is_private
    ? createPrivateGroup(ws, { name: args.name, creator: callerUserId })
    : createPublicChannel(ws, { name: args.name, creator: callerUserId })
  bus.publish({
    type: "channel_created",
    event_ts: new Date().toISOString(),
    channel: {
      id: ch.id,
      is_channel: ch.is_channel,
      name: ch.name,
      name_normalized: ch.name_normalized,
      created: ch.created,
      creator: ch.creator,
    },
  })
  return { ok: true, channel: channelView(ch) }
}

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
