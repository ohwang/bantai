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

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs"
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

/**
 * Read the authoritative `cwd` recorded in a Claude session JSONL.
 *
 * The `cwd` returned by `findClaudeSessionFileAnywhere` is derived from the
 * project directory key, whose encoding (`/` → `-`) is lossy for paths that
 * contain legitimate hyphens. Claude Code writes an explicit `cwd` field on
 * user/assistant entries; that's the source of truth whenever we need an
 * actual filesystem path (e.g. `process.chdir()` for `bantai follow`).
 *
 * Streams the file in 64 KiB chunks so a large session log doesn't force a
 * full read — we only need the first entry that carries a `cwd` field,
 * which is typically within the first few lines.
 *
 * @returns the first non-empty `cwd` string, or `null` if none is found.
 */
export function readClaudeSessionCwd(filePath: string): string | null {
  let fd: number
  try {
    fd = openSync(filePath, "r")
  } catch (err) {
    log.debug("readClaudeSessionCwd: could not open session file", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  try {
    const buf = Buffer.alloc(64 * 1024)
    let offset = 0
    let remainder = ""
    // Cap total bytes examined so a pathological file (no cwd anywhere)
    // can't read indefinitely. 4 MiB is far more than any reasonable
    // session's header.
    const hardLimit = 4 * 1024 * 1024
    while (offset < hardLimit) {
      const bytesRead = readSync(fd, buf, 0, buf.length, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      const chunk = remainder + buf.subarray(0, bytesRead).toString("utf-8")
      const lines = chunk.split("\n")
      remainder = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let entry: unknown
        try {
          entry = JSON.parse(trimmed)
        } catch {
          continue
        }
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as { cwd?: unknown }).cwd === "string" &&
          (entry as { cwd: string }).cwd.length > 0
        ) {
          return (entry as { cwd: string }).cwd
        }
      }
    }
    // Try the trailing remainder too, in case the file doesn't end with \n.
    const trimmed = remainder.trim()
    if (trimmed) {
      try {
        const entry = JSON.parse(trimmed)
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as { cwd?: unknown }).cwd === "string" &&
          (entry as { cwd: string }).cwd.length > 0
        ) {
          return (entry as { cwd: string }).cwd
        }
      } catch {
        // fall through
      }
    }
    return null
  } catch (err) {
    log.warn("readClaudeSessionCwd: error while scanning session file", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* best-effort */
    }
  }
}
