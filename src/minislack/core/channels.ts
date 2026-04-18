/**
 * Channel CRUD + membership.
 *
 * Covers: public channel, private group, DM (1:1), multi-party IM (mpim).
 * Each variant carries the Slack-shape `is_channel | is_group | is_im | is_mpim`
 * discriminators so serialized responses match real Slack exactly.
 */

import { nextId } from "./ids"
import type {
  Channel,
  DirectMessage,
  MultiPartyIm,
  PrivateChannel,
  PublicChannel,
  Workspace,
} from "../types/slack"

/**
 * Fields shared by every Channel variant that the store populates identically.
 * Keeps create sites focused on per-variant bookkeeping.
 */
function baseChannelFields(ws: Workspace, created: number, members: string[]) {
  return {
    updated: created * 1000,
    is_shared: false,
    is_org_shared: false,
    is_ext_shared: false,
    is_pending_ext_shared: false,
    pending_shared: [] as string[],
    shared_team_ids: [ws.team.id],
    is_member: true,
    num_members: members.length,
    context_team_id: ws.team.id,
    previous_names: [] as string[],
    unlinked: 0,
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreatePublicChannelOpts {
  name: string
  creator: string
  is_general?: boolean
  topic?: string
  purpose?: string
  members?: string[]
}

export function createPublicChannel(
  ws: Workspace,
  opts: CreatePublicChannelOpts,
): PublicChannel {
  if (findChannelByName(ws, opts.name)) {
    throw new MinislackError("name_taken", `channel name "${opts.name}" already exists`)
  }
  const id = nextId(ws, "C")
  const created = Math.floor(Date.now() / 1000)
  const members = opts.members ? [...opts.members] : [opts.creator]
  if (!members.includes(opts.creator)) members.unshift(opts.creator)

  const ch: PublicChannel = {
    id,
    is_channel: true,
    is_group: false,
    is_im: false,
    is_mpim: false,
    is_private: false,
    is_general: !!opts.is_general,
    is_archived: false,
    name: opts.name,
    name_normalized: opts.name.toLowerCase(),
    created,
    creator: opts.creator,
    members,
    messages: new Map(),
    ...baseChannelFields(ws, created, members),
    topic: {
      value: opts.topic ?? "",
      creator: opts.creator,
      last_set: opts.topic ? created : 0,
    },
    purpose: {
      value: opts.purpose ?? "",
      creator: opts.creator,
      last_set: opts.purpose ? created : 0,
    },
  }
  ws.channels.set(id, ch)
  return ch
}

export interface CreatePrivateGroupOpts {
  name: string
  creator: string
  members?: string[]
  topic?: string
  purpose?: string
}

export function createPrivateGroup(
  ws: Workspace,
  opts: CreatePrivateGroupOpts,
): PrivateChannel {
  if (findChannelByName(ws, opts.name)) {
    throw new MinislackError("name_taken", `group name "${opts.name}" already exists`)
  }
  const id = nextId(ws, "G")
  const created = Math.floor(Date.now() / 1000)
  const members = opts.members ? [...opts.members] : [opts.creator]
  if (!members.includes(opts.creator)) members.unshift(opts.creator)

  const ch: PrivateChannel = {
    id,
    is_channel: false,
    is_group: true,
    is_im: false,
    is_mpim: false,
    is_private: true,
    is_archived: false,
    name: opts.name,
    name_normalized: opts.name.toLowerCase(),
    created,
    creator: opts.creator,
    members,
    messages: new Map(),
    ...baseChannelFields(ws, created, members),
    topic: {
      value: opts.topic ?? "",
      creator: opts.creator,
      last_set: opts.topic ? created : 0,
    },
    purpose: {
      value: opts.purpose ?? "",
      creator: opts.creator,
      last_set: opts.purpose ? created : 0,
    },
  }
  ws.channels.set(id, ch)
  return ch
}

/** Open or return a 1:1 DM between two users. Idempotent. */
export function openDirectMessage(
  ws: Workspace,
  userIdA: string,
  userIdB: string,
): DirectMessage {
  const existing = findDmBetween(ws, userIdA, userIdB)
  if (existing) {
    existing.is_open = true
    return existing
  }
  const id = nextId(ws, "D")
  const created = Math.floor(Date.now() / 1000)
  const other = userIdA === userIdB ? userIdA : userIdB
  const dmMembers = userIdA === userIdB ? [userIdA] : [userIdA, userIdB]
  const dm: DirectMessage = {
    id,
    is_channel: false,
    is_group: false,
    is_im: true,
    is_mpim: false,
    is_private: true,
    user: other,
    is_user_deleted: false,
    is_open: true,
    created,
    creator: userIdA,
    members: dmMembers,
    messages: new Map(),
    ...baseChannelFields(ws, created, dmMembers),
  }
  ws.channels.set(id, dm)
  return dm
}

export function createMpim(
  ws: Workspace,
  creator: string,
  memberIds: string[],
): MultiPartyIm {
  const members = Array.from(new Set([creator, ...memberIds]))
  const existing = findMpimBetween(ws, members)
  if (existing) {
    existing.is_open = true
    return existing
  }
  const id = nextId(ws, "M")
  const created = Math.floor(Date.now() / 1000)
  const handle = members
    .map((uid) => ws.users.get(uid)?.name ?? uid)
    .sort()
    .join("--")
  const mpim: MultiPartyIm = {
    id,
    is_channel: false,
    is_group: false,
    is_im: false,
    is_mpim: true,
    is_private: true,
    name: `mpdm-${handle}-1`,
    name_normalized: `mpdm-${handle}-1`,
    is_open: true,
    created,
    creator,
    members,
    messages: new Map(),
    ...baseChannelFields(ws, created, members),
  }
  ws.channels.set(id, mpim)
  return mpim
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findChannelByName(
  ws: Workspace,
  name: string,
): Channel | undefined {
  const handle = name.startsWith("#") ? name.slice(1) : name
  for (const ch of ws.channels.values()) {
    if ("name" in ch && ch.name === handle) return ch
  }
  return undefined
}

export function resolveChannel(
  ws: Workspace,
  idOrName: string,
): Channel | undefined {
  return ws.channels.get(idOrName) ?? findChannelByName(ws, idOrName)
}

export function findDmBetween(
  ws: Workspace,
  userIdA: string,
  userIdB: string,
): DirectMessage | undefined {
  for (const ch of ws.channels.values()) {
    if (!ch.is_im) continue
    const [m0, m1] = ch.members
    if (userIdA === userIdB) {
      if (ch.members.length === 1 && m0 === userIdA) return ch
    } else if (
      (m0 === userIdA && m1 === userIdB) ||
      (m0 === userIdB && m1 === userIdA)
    ) {
      return ch
    }
  }
  return undefined
}

export function findMpimBetween(
  ws: Workspace,
  memberIds: string[],
): MultiPartyIm | undefined {
  const set = new Set(memberIds)
  for (const ch of ws.channels.values()) {
    if (!ch.is_mpim) continue
    if (ch.members.length !== set.size) continue
    if (ch.members.every((m) => set.has(m))) return ch
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export function joinChannel(
  ws: Workspace,
  channelId: string,
  userId: string,
): void {
  const ch = ws.channels.get(channelId)
  if (!ch) throw new MinislackError("channel_not_found", channelId)
  if (ch.members.includes(userId)) return
  ch.members.push(userId)
  ch.num_members = ch.members.length
  ch.updated = Date.now()
}

export function leaveChannel(
  ws: Workspace,
  channelId: string,
  userId: string,
): void {
  const ch = ws.channels.get(channelId)
  if (!ch) throw new MinislackError("channel_not_found", channelId)
  ch.members = ch.members.filter((m) => m !== userId)
  ch.num_members = ch.members.length
  ch.updated = Date.now()
}

export function assertMember(ch: Channel, userId: string): void {
  if (!ch.members.includes(userId)) {
    throw new MinislackError("not_in_channel", `user ${userId} is not in ${ch.id}`)
  }
}

/**
 * API-safe view of a Channel: drops the internal `messages` Map and `last_read`
 * (which Slack returns only when scoped). Use this whenever a Channel ships over
 * the wire as a JSON response.
 */
export type ChannelView = Omit<Channel, "messages" | "last_read">

export function channelView(ch: Channel): ChannelView {
  const { messages: _m, last_read: _lr, ...rest } = ch
  return rest as ChannelView
}

// ---------------------------------------------------------------------------
// Error type — core functions throw this; the HTTP layer maps to `ok:false`.
// ---------------------------------------------------------------------------

export class MinislackError extends Error {
  readonly code: string
  constructor(code: string, message?: string) {
    super(message ?? code)
    this.code = code
    this.name = "MinislackError"
  }
}
