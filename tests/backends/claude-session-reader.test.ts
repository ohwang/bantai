/**
 * Regression tests for the Claude session JSONL reader.
 *
 * Motivated by a resume regression where user messages failed to render at all
 * on Claude -> Claude resume. Root cause: `message.content` is typed by the
 * SDK as `string | Array<ContentBlockParam>`, and the reader was silently
 * dropping the string form. The Anthropic SDK has always allowed both shapes;
 * we just never exercised the string path.
 *
 * These tests exercise every shape we've seen in real JSONL files so the
 * "silently drop unknown shape" class of bug stays caught.
 */

import { describe, expect, it, afterEach, beforeEach } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { readSessionHistory } from "../../src/backends/claude/session-reader"

// ---------------------------------------------------------------------------
// Harness: spin up a fake ~/.claude/projects/<project>/<sessionId>.jsonl
// rooted at a temp HOME so the reader can find it.
// ---------------------------------------------------------------------------

let tmpHome: string
let originalHome: string | undefined
let projectCwd: string
let projectDir: string
const SESSION_ID = "test-session-00000000"

function encodeProjectKey(cwd: string): string {
  return cwd.replace(/\//g, "-")
}

function writeJsonl(entries: unknown[]): void {
  const path = join(projectDir, `${SESSION_ID}.jsonl`)
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n")
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "bantai-session-reader-"))
  originalHome = process.env.HOME
  process.env.HOME = tmpHome
  // Use a fixed cwd so every test writes to the same project key.
  projectCwd = "/fake/project"
  projectDir = join(tmpHome, ".claude", "projects", encodeProjectKey(projectCwd))
  mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(tmpHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readSessionHistory — user content shapes", () => {
  it("renders array-form user text (the common case)", () => {
    writeJsonl([
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hello there" }] },
        uuid: "u1",
        timestamp: "2026-04-18T00:00:00Z",
      },
    ])
    const { blocks, summary } = readSessionHistory(SESSION_ID, projectCwd)
    const userBlocks = blocks.filter(b => b.type === "user")
    expect(userBlocks).toHaveLength(1)
    expect(userBlocks[0]).toMatchObject({ type: "user", text: "hello there" })
    expect(summary.turnCount).toBe(1)
  })

  it("renders string-form user text (previously silently dropped)", () => {
    // Before the fix this entry produced zero user blocks because the reader
    // required `Array.isArray(content)` and bailed out when it wasn't.
    writeJsonl([
      {
        type: "user",
        message: { role: "user", content: "plain string prompt" },
        uuid: "u-string",
        timestamp: "2026-04-18T00:00:00Z",
      },
    ])
    const { blocks, summary } = readSessionHistory(SESSION_ID, projectCwd)
    const userBlocks = blocks.filter(b => b.type === "user")
    expect(userBlocks).toHaveLength(1)
    expect(userBlocks[0]).toMatchObject({ type: "user", text: "plain string prompt" })
    expect(summary.turnCount).toBe(1)
  })

  it("skips tool-result-only user entries without producing a block", () => {
    writeJsonl([
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "output" },
          ],
        },
        uuid: "u-tool",
        timestamp: "2026-04-18T00:00:00Z",
      },
    ])
    const { blocks } = readSessionHistory(SESSION_ID, projectCwd)
    expect(blocks.filter(b => b.type === "user")).toHaveLength(0)
  })

  it("suppresses compaction-summary synthetic turns (string form)", () => {
    writeJsonl([
      {
        type: "user",
        message: {
          role: "user",
          content:
            "This session is being continued from a previous conversation that ran out of context.\n\nSummary: blah",
        },
        uuid: "u-compact",
        timestamp: "2026-04-18T00:00:00Z",
      },
    ])
    const { blocks } = readSessionHistory(SESSION_ID, projectCwd)
    expect(blocks.filter(b => b.type === "user")).toHaveLength(0)
  })

  it("suppresses slash-command marker turns", () => {
    writeJsonl([
      {
        type: "user",
        message: {
          role: "user",
          content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>",
        },
        uuid: "u-cmd",
        timestamp: "2026-04-18T00:00:00Z",
      },
    ])
    const { blocks } = readSessionHistory(SESSION_ID, projectCwd)
    expect(blocks.filter(b => b.type === "user")).toHaveLength(0)
  })

  it("suppresses local-command caveat turns tagged with isMeta", () => {
    writeJsonl([
      {
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: "<local-command-caveat>caveat text</local-command-caveat>",
        },
        uuid: "u-meta",
        timestamp: "2026-04-18T00:00:00Z",
      },
    ])
    const { blocks } = readSessionHistory(SESSION_ID, projectCwd)
    expect(blocks.filter(b => b.type === "user")).toHaveLength(0)
  })

  it("handles a mix of string and array user turns in one session", () => {
    writeJsonl([
      {
        type: "user",
        message: { role: "user", content: "first prompt as a string" },
        uuid: "u1",
        timestamp: "2026-04-18T00:00:00Z",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "response" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        uuid: "a1",
        timestamp: "2026-04-18T00:00:01Z",
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "second prompt as an array" }] },
        uuid: "u2",
        timestamp: "2026-04-18T00:00:02Z",
      },
    ])
    const { blocks, summary } = readSessionHistory(SESSION_ID, projectCwd)
    const userTexts = blocks.filter(b => b.type === "user").map(b => (b as any).text)
    expect(userTexts).toEqual(["first prompt as a string", "second prompt as an array"])
    expect(summary.turnCount).toBe(2)
  })
})

describe("readSessionHistory — robustness", () => {
  it("does not crash on unknown content shapes (objects, numbers)", () => {
    writeJsonl([
      {
        type: "user",
        message: { role: "user", content: { weird: "shape" } },
        uuid: "u-obj",
        timestamp: "2026-04-18T00:00:00Z",
      },
      {
        type: "user",
        message: { role: "user", content: 42 },
        uuid: "u-num",
        timestamp: "2026-04-18T00:00:00Z",
      },
      // A normal entry so we can confirm the loop kept going.
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "survivor" }] },
        uuid: "u-ok",
        timestamp: "2026-04-18T00:00:00Z",
      },
    ])
    const { blocks } = readSessionHistory(SESSION_ID, projectCwd)
    const userTexts = blocks.filter(b => b.type === "user").map(b => (b as any).text)
    // Unknown shapes produce no block but must not poison the rest of the file.
    expect(userTexts).toEqual(["survivor"])
  })

  it("renders string-form assistant content (previously dropped)", () => {
    writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: "bare string reply",
          usage: { input_tokens: 1, output_tokens: 3 },
        },
        uuid: "a1",
        timestamp: "2026-04-18T00:00:00Z",
      },
    ])
    const { blocks } = readSessionHistory(SESSION_ID, projectCwd)
    const assistantBlocks = blocks.filter(b => b.type === "assistant")
    expect(assistantBlocks).toHaveLength(1)
    expect(assistantBlocks[0]).toMatchObject({ type: "assistant", text: "bare string reply" })
  })

  it("returns empty result when the session file is missing", () => {
    // Note: no writeJsonl call — the file doesn't exist.
    const { blocks, summary } = readSessionHistory(SESSION_ID, projectCwd)
    expect(blocks).toEqual([])
    expect(summary.messageCount).toBe(0)
    expect(summary.turnCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TodoWrite reconstruction on resume
//
// Motivation: when a session is resumed, the UI rebuilds ConversationState by
// reading JSONL directly — it never replays the live reducer path. That meant
// `ConversationState.todos` was never populated from history, so any active
// TodoWrite checklist silently vanished on resume. The reader now tracks the
// LAST TodoWrite tool_use in the transcript (reducer semantics: full-list
// replacement, so earlier calls are superseded) and returns its todos via the
// extended ParsedSession shape.
// ---------------------------------------------------------------------------

describe("readSessionHistory — TodoWrite reconstruction", () => {
  it("returns empty todos when the session has no TodoWrite calls", () => {
    writeJsonl([
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
        uuid: "u1",
        timestamp: "2026-04-18T00:00:00Z",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi back" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        uuid: "a1",
        timestamp: "2026-04-18T00:00:01Z",
      },
    ])
    const { todos } = readSessionHistory(SESSION_ID, projectCwd)
    expect(todos).toEqual([])
  })

  it("reconstructs todos from a single TodoWrite call", () => {
    const items = [
      { content: "Write tests", activeForm: "Writing tests", status: "pending" as const },
      { content: "Fix bug", activeForm: "Fixing bug", status: "in_progress" as const },
      { content: "Ship it", activeForm: "Shipping it", status: "completed" as const },
    ]
    writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll track this." },
            {
              type: "tool_use",
              id: "toolu_todo_1",
              name: "TodoWrite",
              input: { todos: items },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        uuid: "a1",
        timestamp: "2026-04-18T00:00:00Z",
      },
    ])
    const { todos } = readSessionHistory(SESSION_ID, projectCwd)
    expect(todos).toEqual(items)
  })

  it("only returns the LAST TodoWrite call when there are several", () => {
    // Earlier calls are superseded by later ones — matches the reducer's
    // full-list replacement semantics. If the reader kept the first call by
    // mistake, the resumed checklist would show a stale, already-worked list.
    const first = [
      { content: "Draft design", activeForm: "Drafting design", status: "completed" as const },
      { content: "Review with team", activeForm: "Reviewing with team", status: "pending" as const },
    ]
    const second = [
      { content: "Implement feature", activeForm: "Implementing feature", status: "in_progress" as const },
      { content: "Add tests", activeForm: "Adding tests", status: "pending" as const },
      { content: "Update docs", activeForm: "Updating docs", status: "pending" as const },
    ]
    writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_todo_1",
              name: "TodoWrite",
              input: { todos: first },
            },
          ],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
        uuid: "a1",
        timestamp: "2026-04-18T00:00:00Z",
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_todo_1", content: "ok" }],
        },
        uuid: "u1",
        timestamp: "2026-04-18T00:00:01Z",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_todo_2",
              name: "TodoWrite",
              input: { todos: second },
            },
          ],
          usage: { input_tokens: 6, output_tokens: 3 },
        },
        uuid: "a2",
        timestamp: "2026-04-18T00:00:02Z",
      },
    ])
    const { todos } = readSessionHistory(SESSION_ID, projectCwd)
    expect(todos).toEqual(second)
  })

  it("drops malformed todo items but keeps the valid ones", () => {
    // The helper's defensive filtering is the single source of truth for
    // validation — we inherit it here so protocol drift (e.g. a renamed
    // status) surfaces as a log.warn from one place, not two.
    writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_todo_mixed",
              name: "TodoWrite",
              input: {
                todos: [
                  // Valid.
                  { content: "Valid task", activeForm: "Doing valid task", status: "pending" },
                  // Malformed — unknown status.
                  { content: "Bad status", activeForm: "Breaking", status: "frobnicated" },
                  // Malformed — missing activeForm.
                  { content: "No active form", status: "pending" },
                  // Another valid one after a malformed one, to ensure the
                  // filter doesn't short-circuit on the first bad entry.
                  { content: "Another valid", activeForm: "Doing another", status: "completed" },
                ],
              },
            },
          ],
          usage: { input_tokens: 2, output_tokens: 1 },
        },
        uuid: "a1",
        timestamp: "2026-04-18T00:00:00Z",
      },
    ])
    const { todos } = readSessionHistory(SESSION_ID, projectCwd)
    expect(todos).toEqual([
      { content: "Valid task", activeForm: "Doing valid task", status: "pending" },
      { content: "Another valid", activeForm: "Doing another", status: "completed" },
    ])
  })
})
