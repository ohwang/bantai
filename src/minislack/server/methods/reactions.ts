/**
 * reactions.add / reactions.remove / reactions.get / reactions.list.
 *
 * Each add/remove also publishes a `reaction_added` / `reaction_removed`
 * event on the bus so subscribers (web SPA, Socket Mode apps) see the
 * change live.
 */

import {
  addReaction,
  getReactions,
  removeReaction,
} from "../../core/reactions"
import { getMessage } from "../../core/messages"
import { MinislackError } from "../../core/channels"
import type { EventBus } from "../../core/events"
import type { Channel, Message, Reaction, Workspace } from "../../types/slack"
import type { ReactionAddedEvent, ReactionRemovedEvent } from "../../types/events"
import type { AuthContext } from "../auth"
import { paginate } from "../pagination"

export interface ReactionArgs {
  /** Channel id OR name (with or without `#`). */
  channel: string
  /** ts of the target message. */
  timestamp: string
  /** Emoji name, without surrounding colons. */
  name: string
}

export interface ReactionAddResponse {
  ok: true
}

export function reactionsAdd(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: ReactionArgs,
): ReactionAddResponse {
  const ch = resolve(ws, args.channel)
  const userId = ctx.userId
  if (!userId) throw new MinislackError("not_authed")
  const { message, changed } = addReaction(ws, {
    channelId: ch.id,
    ts: args.timestamp,
    userId,
    name: stripColons(args.name),
  })
  if (changed) {
    const evt: ReactionAddedEvent = {
      type: "reaction_added",
      event_ts: timeNow(),
      user: userId,
      reaction: stripColons(args.name),
      item_user: message.user,
      item: { type: "message", channel: ch.id, ts: message.ts },
    }
    bus.publish(evt)
  }
  return { ok: true }
}

export function reactionsRemove(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: ReactionArgs,
): ReactionAddResponse {
  const ch = resolve(ws, args.channel)
  const userId = ctx.userId
  if (!userId) throw new MinislackError("not_authed")
  const { message, changed } = removeReaction(ws, {
    channelId: ch.id,
    ts: args.timestamp,
    userId,
    name: stripColons(args.name),
  })
  if (changed) {
    const evt: ReactionRemovedEvent = {
      type: "reaction_removed",
      event_ts: timeNow(),
      user: userId,
      reaction: stripColons(args.name),
      item_user: message.user,
      item: { type: "message", channel: ch.id, ts: message.ts },
    }
    bus.publish(evt)
  }
  return { ok: true }
}

export interface ReactionGetArgs {
  channel: string
  timestamp: string
  full?: boolean
}

export interface ReactionGetResponse {
  ok: true
  type: "message"
  channel: string
  /**
   * With `full: true` we return the complete Message (Slack's shape).
   * With `full: false` (or omitted) we still return a Message but only the
   * reactions + ts fields are guaranteed — clients that read .text should
   * pass `full: true` so the type-narrow is unambiguous.
   */
  message: (Message & { reactions: Reaction[] }) | { ts: string; reactions: Reaction[] }
}

export function reactionsGet(
  ws: Workspace,
  args: ReactionGetArgs,
): ReactionGetResponse {
  const ch = resolve(ws, args.channel)
  const reactions = getReactions(ws, {
    channelId: ch.id,
    ts: args.timestamp,
    full: args.full,
  })
  if (args.full) {
    const msg = getMessage(ch, args.timestamp)
    if (!msg) throw new MinislackError("message_not_found", args.timestamp)
    return {
      ok: true,
      type: "message",
      channel: ch.id,
      message: { ...msg, reactions },
    }
  }
  return {
    ok: true,
    type: "message",
    channel: ch.id,
    message: { ts: args.timestamp, reactions },
  }
}

// ---------------------------------------------------------------------------
// reactions.list — items the caller (or a specified user) has reacted to.
// ---------------------------------------------------------------------------

export interface ReactionListArgs {
  /** User whose reacted items to return. Defaults to the caller. */
  user?: string
  limit?: number
  cursor?: string
  /** Slack's `full` flag — when true, include the full message body. */
  full?: boolean
}

export interface ReactionListItem {
  type: "message"
  channel: string
  message: Message & { reactions: Reaction[] }
}

export interface ReactionListResponse {
  ok: true
  items: ReactionListItem[]
  response_metadata: { next_cursor: string }
}

/**
 * reactions.list — walk every channel the caller can see and collect
 * messages the target user has reacted to. Minislack stores only message
 * reactions (no file_comment reactions), so items are always
 * `type: "message"`.
 *
 * When `user` is omitted we default to the caller's own reactions,
 * matching Slack's real behaviour.
 */
export function reactionsList(
  ws: Workspace,
  ctx: AuthContext,
  args: ReactionListArgs,
): ReactionListResponse {
  const targetUser = args.user?.trim() || ctx.userId
  if (!targetUser) throw new MinislackError("not_authed")

  const items: ReactionListItem[] = []
  for (const ch of ws.channels.values()) {
    if (!channelVisibleTo(ch, ctx)) continue
    for (const msg of ch.messages.values()) {
      if (msg.tombstone) continue
      const reactions = msg.reactions ?? []
      if (!reactions.some((r) => r.users.includes(targetUser))) continue
      items.push({
        type: "message",
        channel: ch.id,
        message: { ...msg, reactions },
      })
    }
  }
  // Newest first, mirroring real Slack.
  items.sort((a, b) => Number(b.message.ts) - Number(a.message.ts))

  const page = paginate(items, { limit: args.limit, cursor: args.cursor })
  return {
    ok: true,
    items: page.items,
    response_metadata: { next_cursor: page.next_cursor },
  }
}

/**
 * Cheap visibility filter. Bot tokens see every channel they're a member
 * of; user tokens see every channel they're listed in. Anything tagged as
 * public is always visible so the probe sweep (which fires before a bot
 * joins anywhere) still returns `ok: true` on a fresh workspace.
 */
function channelVisibleTo(ch: Channel, ctx: AuthContext): boolean {
  if ("is_channel" in ch && ch.is_channel) return true
  if (!ctx.userId) return false
  return "members" in ch && ch.members.includes(ctx.userId)
}

// ---------------------------------------------------------------------------

function resolve(ws: Workspace, idOrName: string): Channel {
  const direct = ws.channels.get(idOrName)
  if (direct) return direct
  const handle = idOrName.startsWith("#") ? idOrName.slice(1) : idOrName
  for (const ch of ws.channels.values()) {
    if ("name" in ch && ch.name === handle) return ch
  }
  throw new MinislackError("channel_not_found", idOrName)
}

function stripColons(name: string): string {
  return name.replace(/^:/, "").replace(/:$/, "")
}

function timeNow(): string {
  return `${Math.floor(Date.now() / 1000)}.000000`
}
