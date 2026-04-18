/**
 * Users, bots, and apps — user CRUD + app registration + bot-user minting.
 *
 * Extracted from core/workspace.ts in Phase 3. All user + app state still
 * lives on the Workspace; this module just owns the helpers.
 *
 *   createUser / findUser / updateUser / deactivateUser / listUsers
 *   registerApp (mints A…, B…, and a backing bot User)
 *   tokenForUser / slugifyBotName
 */

import { nextId } from "./ids"
import type {
  App,
  Bot,
  User,
  UserProfile,
  Workspace,
} from "../types/slack"
import {
  appTokenForApp,
  botTokenForApp,
  userTokenForUser,
} from "../server/auth"

// ---------------------------------------------------------------------------
// User CRUD
// ---------------------------------------------------------------------------

export interface CreateUserOpts {
  name: string
  real_name?: string
  email?: string
  is_bot?: boolean
  app_id?: string
  bot_id?: string
}

/** Add a user to the workspace. Returns the created User. */
export function createUser(ws: Workspace, opts: CreateUserOpts): User {
  // Bot users still use U… for their user record; the Bot record uses B….
  const prefix = "U"
  const id = nextId(ws, prefix)
  const real_name = opts.real_name ?? opts.name
  const now = Math.floor(Date.now() / 1000)
  const profile: UserProfile = {
    real_name,
    display_name: opts.name,
    real_name_normalized: normalizeName(real_name),
    display_name_normalized: normalizeName(opts.name),
    email: opts.email,
    avatar_hash: "g" + id.slice(1, 13).toLowerCase(),
    status_text: "",
    status_emoji: "",
    status_expiration: 0,
    team: ws.team.id,
  }
  const user: User = {
    id,
    team_id: ws.team.id,
    name: opts.name,
    real_name,
    is_bot: !!opts.is_bot,
    app_id: opts.app_id,
    bot_id: opts.bot_id,
    deleted: false,
    profile,
    updated: now,
    color: pickUserColor(id),
    tz: "America/Los_Angeles",
    tz_label: "Pacific Daylight Time",
    tz_offset: -25200,
    is_admin: false,
    is_owner: false,
    is_primary_owner: false,
    is_restricted: false,
    is_ultra_restricted: false,
    is_app_user: !!opts.is_bot,
    has_2fa: false,
  }
  ws.users.set(id, user)
  return user
}

/** Slack normalizes names by lowering + stripping non-[a-z0-9_-] chars. */
function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "")
}

/** Deterministic color picker — cycles through Slack's classic palette. */
const USER_COLORS = [
  "9f69e7", "4bbe2e", "e7392d", "3c989f", "674b1b",
  "8f4a2b", "4cc091", "e96699", "5870dd", "9b3b45",
]
function pickUserColor(userId: string): string {
  const n = Number(userId.slice(1)) || 0
  return USER_COLORS[n % USER_COLORS.length]!
}

/** Resolve a user by id OR by handle (@name). Returns undefined if missing. */
export function findUser(ws: Workspace, nameOrId: string): User | undefined {
  if (ws.users.has(nameOrId)) return ws.users.get(nameOrId)
  const handle = nameOrId.startsWith("@") ? nameOrId.slice(1) : nameOrId
  for (const user of ws.users.values()) {
    if (user.name === handle) return user
  }
  return undefined
}

export interface UpdateUserPatch {
  name?: string
  real_name?: string
  email?: string
  profile?: Partial<UserProfile>
}

/**
 * Partial update of a user record. Mutates in place and returns the same
 * User reference. Returns undefined if the id doesn't exist.
 *
 * `name`/`real_name` on the root user shadow the profile's `display_name`
 * and `real_name` in Slack's response shape, so we keep them in sync when
 * the caller updates either.
 */
export function updateUser(
  ws: Workspace,
  id: string,
  patch: UpdateUserPatch,
): User | undefined {
  const user = ws.users.get(id)
  if (!user) return undefined
  if (patch.name !== undefined) {
    user.name = patch.name
    user.profile.display_name = patch.name
    user.profile.display_name_normalized = normalizeName(patch.name)
  }
  if (patch.real_name !== undefined) {
    user.real_name = patch.real_name
    user.profile.real_name = patch.real_name
    user.profile.real_name_normalized = normalizeName(patch.real_name)
  }
  if (patch.email !== undefined) {
    user.profile.email = patch.email
  }
  if (patch.profile) {
    user.profile = { ...user.profile, ...patch.profile }
    if (patch.profile.real_name !== undefined) {
      user.real_name = patch.profile.real_name
      user.profile.real_name_normalized = normalizeName(patch.profile.real_name)
    }
    if (patch.profile.display_name !== undefined) {
      user.name = patch.profile.display_name
      user.profile.display_name_normalized = normalizeName(patch.profile.display_name)
    }
  }
  user.updated = Math.floor(Date.now() / 1000)
  return user
}

/**
 * Soft-delete a user. Sets `deleted: true` — same shape Slack uses for
 * deactivated accounts. Returns the User (or undefined if missing).
 */
export function deactivateUser(ws: Workspace, id: string): User | undefined {
  const user = ws.users.get(id)
  if (!user) return undefined
  user.deleted = true
  return user
}

export interface ListUsersOpts {
  /** Include soft-deleted users. Default false. */
  include_deleted?: boolean
  /** Filter by bot-ness. Undefined returns both. */
  is_bot?: boolean
}

/** Return all users matching the filter, in insertion order. */
export function listUsers(ws: Workspace, opts: ListUsersOpts = {}): User[] {
  const out: User[] = []
  for (const u of ws.users.values()) {
    if (!opts.include_deleted && u.deleted) continue
    if (opts.is_bot !== undefined && u.is_bot !== opts.is_bot) continue
    out.push(u)
  }
  return out
}

// ---------------------------------------------------------------------------
// Apps / Bots
// ---------------------------------------------------------------------------

export interface RegisterAppOpts {
  name: string
  scopes?: string[]
  subscribed_events?: string[]
}

export interface RegisteredApp {
  app: App
  bot: Bot
  botUser: User
  /** xoxb-… token for Web API calls. */
  botToken: string
  /** xapp-… token for apps.connections.open. */
  appToken: string
}

/** Register an app, mint its Bot + bot user, and return credentials. */
export function registerApp(
  ws: Workspace,
  opts: RegisterAppOpts,
): RegisteredApp {
  const appId = nextId(ws, "A")
  const botId = nextId(ws, "B")

  const botUser = createUser(ws, {
    name: slugifyBotName(opts.name),
    real_name: opts.name,
    is_bot: true,
    app_id: appId,
    bot_id: botId,
  })

  const bot: Bot = {
    id: botId,
    app_id: appId,
    user_id: botUser.id,
    name: opts.name,
    deleted: false,
  }

  const botToken = botTokenForApp(appId)
  const appToken = appTokenForApp(appId)

  const app: App = {
    id: appId,
    name: opts.name,
    scopes: opts.scopes ?? [],
    subscribed_events: opts.subscribed_events ?? [],
    bot_id: bot.id,
    bot_user_id: botUser.id,
    tokens: { bot: botToken, app: appToken },
  }
  ws.apps.set(app.id, app)

  return { app, bot, botUser, botToken, appToken }
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/** Mint the user token for an existing user. */
export function tokenForUser(user: User): string {
  return userTokenForUser(user.id)
}

export function slugifyBotName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_") || "bot"
  )
}
