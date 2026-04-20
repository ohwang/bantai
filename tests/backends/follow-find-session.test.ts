/**
 * Tests for `findClaudeSessionFileAnywhere` and `readClaudeSessionCwd`.
 *
 * Covers:
 *   - found in current cwd (fast path)
 *   - found in a sibling project dir (scan path)
 *   - not found → returns null
 *   - name collision → prefers most-recent mtime + warns
 *   - readClaudeSessionCwd: pulls authoritative cwd from JSONL,
 *     skips leading entries without cwd, handles hyphenated paths
 *     that the project-key decoder can't round-trip.
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
import {
  findClaudeSessionFileAnywhere,
  readClaudeSessionCwd,
} from "../../src/backends/follow/find-session"

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

describe("readClaudeSessionCwd", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bantai-read-cwd-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeJsonl(lines: unknown[]): string {
    const file = join(dir, "session.jsonl")
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    return file
  }

  it("returns the cwd from the first entry that carries one", () => {
    const file = writeJsonl([
      { type: "permission-mode", permissionMode: "default" },
      { type: "file-history-snapshot", snapshot: {} },
      {
        type: "user",
        cwd: "/Users/odin/dev/repos/bantai-slack-monitor",
        message: { role: "user", content: "hi" },
      },
      {
        type: "assistant",
        cwd: "/Users/odin/dev/repos/bantai-slack-monitor",
        message: { role: "assistant", content: "hello" },
      },
    ])
    expect(readClaudeSessionCwd(file)).toBe(
      "/Users/odin/dev/repos/bantai-slack-monitor",
    )
  })

  it("recovers hyphenated paths that the project-key decoder mangles", () => {
    // The project-key encoding `/` → `-` is lossy: decoding gives back
    // `/Users/odin/dev/repos/bantai/slack/monitor`, which is wrong. The
    // JSONL-embedded cwd is the source of truth.
    const file = writeJsonl([
      {
        type: "user",
        cwd: "/Users/odin/dev/repos/bantai-slack-monitor",
        message: { role: "user", content: "hi" },
      },
    ])
    expect(readClaudeSessionCwd(file)).toBe(
      "/Users/odin/dev/repos/bantai-slack-monitor",
    )
  })

  it("returns null when no entry has a cwd field", () => {
    const file = writeJsonl([
      { type: "permission-mode", permissionMode: "default" },
      { type: "system", text: "nothing here" },
    ])
    expect(readClaudeSessionCwd(file)).toBeNull()
  })

  it("returns null for a non-existent file", () => {
    expect(readClaudeSessionCwd(join(dir, "missing.jsonl"))).toBeNull()
  })

  it("ignores unparseable lines and keeps scanning", () => {
    const file = join(dir, "mixed.jsonl")
    writeFileSync(
      file,
      [
        "not json at all",
        JSON.stringify({ type: "user", cwd: "/opt/project", message: {} }),
      ].join("\n") + "\n",
    )
    expect(readClaudeSessionCwd(file)).toBe("/opt/project")
  })
})
