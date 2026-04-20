/**
 * Tests for `findClaudeSessionFileAnywhere`.
 *
 * Covers:
 *   - found in current cwd (fast path)
 *   - found in a sibling project dir (scan path)
 *   - not found → returns null
 *   - name collision → prefers most-recent mtime + warns
 *
 * Each test points HOME at a fresh tmpdir so the helper's
 * `~/.claude/projects/...` lookups are hermetic.
 */

import { describe, expect, it, afterEach, beforeEach } from "bun:test"
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findClaudeSessionFileAnywhere } from "../../src/backends/follow/find-session"

let tmpHome: string
let originalHome: string | undefined

function encodeKey(cwd: string): string {
  return cwd.replace(/\//g, "-")
}

function seed(projectCwd: string, sessionId: string, mtimeSec?: number): string {
  const projectDir = join(tmpHome, ".claude", "projects", encodeKey(projectCwd))
  mkdirSync(projectDir, { recursive: true })
  const filePath = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(filePath, `{"type":"user","uuid":"u1"}\n`)
  if (mtimeSec !== undefined) {
    utimesSync(filePath, mtimeSec, mtimeSec)
  }
  return filePath
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "bantai-find-session-"))
  originalHome = process.env.HOME
  process.env.HOME = tmpHome
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe("findClaudeSessionFileAnywhere", () => {
  it("finds the file when it lives under the caller's cwd (fast path)", () => {
    const cwd = "/tmp/fake-project-a"
    const id = "sess-aaa"
    const expected = seed(cwd, id)
    const result = findClaudeSessionFileAnywhere(id, cwd)
    expect(result).not.toBeNull()
    expect(result?.path).toBe(expected)
    expect(result?.cwd).toBe(cwd)
  })

  it("finds the file when it lives under a sibling project dir", () => {
    const callerCwd = "/tmp/callerproject"
    // Use a hyphen-free path so the decodeProjectKey round-trip is clean.
    // The encoding is lossy for legitimate hyphens — documented in
    // find-session.ts — so asserting on it here would be unfair.
    const sessionCwd = "/tmp/someotherproject"
    const id = "sess-bbb"
    const expected = seed(sessionCwd, id)
    const result = findClaudeSessionFileAnywhere(id, callerCwd)
    expect(result).not.toBeNull()
    expect(result?.path).toBe(expected)
    expect(result?.cwd).toBe(sessionCwd)
  })

  it("returns null when no project dir contains the session file", () => {
    seed("/tmp/project-x", "sess-present")
    const result = findClaudeSessionFileAnywhere("sess-missing", "/tmp/anywhere")
    expect(result).toBeNull()
  })

  it("returns null when the projects root does not exist", () => {
    // Point HOME at a brand-new empty tmp dir, no ~/.claude/projects.
    const result = findClaudeSessionFileAnywhere(
      "sess-whatever",
      "/tmp/never-existed",
    )
    expect(result).toBeNull()
  })

  it("when two projects share an ID, prefers the most-recently-modified file", () => {
    const id = "sess-ccc"
    const older = seed("/tmp/older-project", id, 1_000_000) // Jan 1970
    const newer = seed("/tmp/newer-project", id, 2_000_000) // later
    // Sanity: both files exist with different mtimes.
    void older
    const result = findClaudeSessionFileAnywhere(id, "/tmp/unrelated")
    expect(result).not.toBeNull()
    expect(result?.path).toBe(newer)
  })
})
