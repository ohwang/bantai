/**
 * users.* — list / info / conversations / profile.get (phase 3).
 *
 * https://api.slack.com/methods/users.list
 * https://api.slack.com/methods/users.info
 * https://api.slack.com/methods/users.conversations
 * https://api.slack.com/methods/users.profile.get
 */

import { MinislackError } from "../../core/channels"
import { listUsers } from "../../core/users"
import { paginate } from "../pagination"
import type {
  Channel,
  User,
  UserProfile,
  Workspace,
} from "../../types/slack"
import type { AuthContext } from "../auth"

// ---------------------------------------------------------------------------
// users.list
// ---------------------------------------------------------------------------

export interface UsersListArgs {
  include_deleted?: boolean
  limit?: number
  cursor?: string
}

export interface UsersListResponse {
  ok: true
  members: User[]
  response_metadata: { next_cursor: string }
}

export function usersList(
  ws: Workspace,
  args: UsersListArgs = {},
): UsersListResponse {
  const members = listUsers(ws, { include_deleted: !!args.include_deleted })
  const page = paginate(members, { limit: args.limit, cursor: args.cursor })
  return {
    ok: true,
    members: page.items,
    response_metadata: { next_cursor: page.next_cursor },
  }
}

// ---------------------------------------------------------------------------
// users.info
// ---------------------------------------------------------------------------

export interface UsersInfoArgs {
  user: string
}

export interface UsersInfoResponse {
  ok: true
  user: User
}

export function usersInfo(ws: Workspace, args: UsersInfoArgs): UsersInfoResponse {
  if (!args.user) throw new MinislackError("user_not_found", "missing user id")
  const user = ws.users.get(args.user)
  if (!user) throw new MinislackError("user_not_found", args.user)
  return { ok: true, user }
}

// ---------------------------------------------------------------------------
// users.lookupByEmail
// ---------------------------------------------------------------------------

export interface UsersLookupByEmailArgs {
  email?: string
}

export function usersLookupByEmail(
  ws: Workspace,
  args: UsersLookupByEmailArgs,
): UsersInfoResponse {
  if (!args.email) throw new MinislackError("users_not_found", "missing email")
  const needle = args.email.trim().toLowerCase()
  for (const u of ws.users.values()) {
    if (u.profile.email?.toLowerCase() === needle) return { ok: true, user: u }
  }
  throw new MinislackError("users_not_found", args.email)
}

// ---------------------------------------------------------------------------
// users.conversations
// ---------------------------------------------------------------------------

export interface UsersConversationsArgs {
  user?: string
  types?: string
  exclude_archived?: boolean
  limit?: number
  cursor?: string
}

export interface UsersConversationsResponse {
  ok: true
  channels: Channel[]
  response_metadata: { next_cursor: string }
}

export function usersConversations(
  ws: Workspace,
  ctx: AuthContext,
  args: UsersConversationsArgs = {},
): UsersConversationsResponse {
  // Default to the authed principal when the caller doesn't specify.
  const userId = args.user ?? ctx.userId
  if (!userId) throw new MinislackError("user_not_found", "missing user id")
  const user = ws.users.get(userId)
  if (!user) throw new MinislackError("user_not_found", userId)

  const requested = parseTypeFilter(args.types ?? "public_channel")
  const out: Channel[] = []
  for (const ch of ws.channels.values()) {
    if (!ch.members.includes(user.id)) continue
    if (args.exclude_archived) {
      if ("is_archived" in ch && ch.is_archived) continue
    }
    if (!matchesTypeFilter(ch, requested)) continue
    out.push(ch)
  }
  const page = paginate(out, { limit: args.limit, cursor: args.cursor })
  return {
    ok: true,
    channels: page.items,
    response_metadata: { next_cursor: page.next_cursor },
  }
}

// ---------------------------------------------------------------------------
// users.profile.get
// ---------------------------------------------------------------------------

export interface UsersProfileGetArgs {
  /** When absent, defaults to the caller. */
  user?: string
}

export interface UsersProfileGetResponse {
  ok: true
  profile: UserProfile
}

export function usersProfileGet(
  ws: Workspace,
  ctx: AuthContext,
  args: UsersProfileGetArgs = {},
): UsersProfileGetResponse {
  const userId = args.user ?? ctx.userId
  if (!userId) throw new MinislackError("user_not_found", "missing user id")
  const user = ws.users.get(userId)
  if (!user) throw new MinislackError("user_not_found", userId)
  return { ok: true, profile: user.profile }
}

// ---------------------------------------------------------------------------
// Helpers — mirrored from conversations.ts to avoid cross-file coupling.
// ---------------------------------------------------------------------------

function parseTypeFilter(types: string): Set<string> {
  return new Set(
    types
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  )
}

function matchesTypeFilter(ch: Channel, types: Set<string>): boolean {
  if (types.has("public_channel") && ch.is_channel && !ch.is_private) return true
  if (
    types.has("private_channel") &&
    "is_private" in ch &&
    ch.is_private &&
    !ch.is_im &&
    !ch.is_mpim
  )
    return true
  if (types.has("mpim") && ch.is_mpim) return true
  if (types.has("im") && ch.is_im) return true
  return false
}
