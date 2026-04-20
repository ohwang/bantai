/**
 * findClaudeSessionFileAnywhere — locate a Claude session JSONL on disk.
 *
 * Why not just `getSessionFilePath(sessionId, cwd)`? That helper resolves
 * the file under `~/.claude/projects/<encodedCwd>/<sessionId>.jsonl`, which
 * only works when the follower's cwd matches the cwd of the process that
 * owns the session. In the most useful case — follow a Slack-driven session
 * from a different shell — those cwds will not match; the Slack server runs
 * wherever it was launched.
 *
 * Strategy:
 *   1. Fast path: look under the caller's cwd project directory first.
 *   2. Fallback: enumerate every project directory under
 *      `~/.claude/projects/` and check each for `<sessionId>.jsonl`.
 *   3. If two project dirs contain a file with the same ID (possible after
 *      cross-worktree moves), prefer the most-recently-modified file and
 *      `log.warn` the collision so the user sees which one we picked.
 *
 * The returned `cwd` is the decoded project-key, i.e. what Claude Code
 * recorded as the original session's working directory. Consumers use it to
 * feed back into `getSessionFilePath` or for header/display purposes.
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { getSessionFilePath } from "../claude/session-reader"
import { log } from "../../utils/logger"

/** Successful lookup result. */
export interface FoundClaudeSession {
  /** Absolute path to the JSONL file. */
  path: string
  /**
   * Decoded cwd inferred from the project directory key. This may be an
   * educated guess — Claude Code's project-key encoding is lossy (all `/`
   * become `-`), so paths with legitimate hyphens can't be perfectly
   * recovered. Callers should treat this as a display hint, not a source
   * of truth.
   */
  cwd: string
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "~"
}

function claudeProjectsDir(): string {
  return join(homeDir(), ".claude", "projects")
}

/** Decode a project-directory key back to an approximate cwd.
 *  Claude Code's encoding replaces every `/` with `-`, so decoding restores
 *  slashes greedily. Paths with actual hyphens can't round-trip cleanly; the
 *  result is a best-effort display value. */
function decodeProjectKey(key: string): string {
  // Keys start with a leading `-` representing the leading `/` of an absolute
  // path. Replace every `-` with `/` — callers that care about legitimate
  // hyphens should compare against the original key instead.
  return key.replace(/-/g, "/")
}

/**
 * Locate a Claude session JSONL file anywhere under `~/.claude/projects/`.
 *
 * @param sessionId - Claude session UUID (filename without `.jsonl`).
 * @param cwdHint   - Caller's cwd. Used as a fast-path lookup; the scan
 *                    still fires if the file isn't present under that key.
 * @returns `{ path, cwd }` on success, `null` if no matching file exists.
 */
export function findClaudeSessionFileAnywhere(
  sessionId: string,
  cwdHint?: string,
): FoundClaudeSession | null {
  // Fast path: caller's cwd matches the session's project.
  if (cwdHint) {
    const guess = getSessionFilePath(sessionId, cwdHint)
    if (existsSync(guess)) {
      return { path: guess, cwd: cwdHint }
    }
  }

  // Fallback: scan every project directory under ~/.claude/projects/.
  const projectsRoot = claudeProjectsDir()
  let entries: string[]
  try {
    entries = readdirSync(projectsRoot)
  } catch (err) {
    // Projects dir doesn't exist (e.g. Claude Code never ran on this host).
    log.debug("Claude projects dir not readable", {
      projectsRoot,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  const matches: Array<FoundClaudeSession & { mtimeMs: number }> = []
  for (const entry of entries) {
    const projectDir = join(projectsRoot, entry)
    const candidate = join(projectDir, `${sessionId}.jsonl`)
    try {
      const stats = statSync(candidate)
      if (stats.isFile()) {
        matches.push({
          path: candidate,
          cwd: decodeProjectKey(entry),
          mtimeMs: stats.mtimeMs,
        })
      }
    } catch {
      // Not a match — most entries won't have this session ID.
    }
  }

  if (matches.length === 0) return null
  if (matches.length === 1) {
    const match = matches[0]!
    return { path: match.path, cwd: match.cwd }
  }

  // Collision: multiple project dirs contain a file with this ID. Prefer
  // the most recent and log a warning — the user should know we made a
  // choice for them.
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const picked = matches[0]!
  log.warn(
    "Multiple Claude sessions share the same ID — picking most recent by mtime",
    {
      sessionId,
      picked: picked.path,
      alternatives: matches.slice(1).map((m) => m.path),
    },
  )
  return { path: picked.path, cwd: picked.cwd }
}
