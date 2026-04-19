/**
 * Workspace aggregate — the top-level mutable state for a running minislack.
 *
 * A Workspace owns its users, channels, files, id counters and ts state.
 * Every mutation in core/ goes through functions that take a Workspace as
 * the first argument. No module-level singletons.
 *
 * User / app / token helpers live in core/users.ts. They're re-exported
 * here for backwards compatibility with callers that used to import them
 * from this module.
 */

import { nextId } from "./ids"
import type { Workspace } from "../types/slack"

export interface CreateWorkspaceOpts {
  teamName?: string
  teamDomain?: string
}

/** Create an empty workspace with a fresh team record. */
export function createWorkspace(opts: CreateWorkspaceOpts = {}): Workspace {
  const ws: Workspace = {
    team: {
      // Placeholder — we mint the real id after the counters map exists.
      id: "",
      name: opts.teamName ?? "Minislack",
      domain: opts.teamDomain ?? "minislack",
      url: `https://${opts.teamDomain ?? "minislack"}.slack.com/`,
    },
    users: new Map(),
    apps: new Map(),
    channels: new Map(),
    files: new Map(),
    tsState: new Map(),
    idCounters: new Map(),
    ephemerals: [],
  }
  ws.team.id = nextId(ws, "T")
  return ws
}

// Re-export user/app helpers so existing `from "../core/workspace"` imports
// continue to resolve. New code should import from `./users` directly.
export {
  createUser,
  findUser,
  updateUser,
  deactivateUser,
  listUsers,
  registerApp,
  tokenForUser,
  slugifyBotName,
} from "./users"
export type {
  CreateUserOpts,
  UpdateUserPatch,
  ListUsersOpts,
  RegisterAppOpts,
  RegisteredApp,
} from "./users"
