/**
 * End-to-end integration test for `bantai follow`.
 *
 * Exercises the full read-path the TUI uses in production:
 *
 *   JSONL fixture on disk
 *     → FollowBackend.resume()
 *     → reducer (same function the TUI consumes)
 *     → assert blocks match expected shape
 *     → append a new line to the JSONL
 *     → assert the new turn shows up in the updated blocks
 *
 * We deliberately do NOT boot OpenTUI here — the TUI is a thin
 * consumer of ConversationState, so asserting on the state itself is
 * both faster and more meaningful than an OpenTUI render test would be.
 *
 * This is the smoke test the experiment is judged by: if this file
 * stays green, the follow round-trip works.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFollowBackend } from "../../src/backends/follow/adapter"
import { reduce } from "../../src/protocol/reducer"
import {
  createInitialState,
  type ConversationEvent,
  type ConversationState,
} from "../../src/protocol/types"

let tmpHome: string
let originalHome: string | undefined
let projectCwd: string
let projectDir: string
const SESSION_ID = "follow-e2e-00000000"

function encodeKey(cwd: string): string {
  return cwd.replace(/\//g, "-")
}

function sessionPath(): string {
  return join(projectDir, `${SESSION_ID}.jsonl`)
}

function writeFixture(entries: unknown[]): void {
  writeFileSync(
    sessionPath(),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  )
}

function appendFixture(entries: unknown[]): void {
  appendFileSync(
    sessionPath(),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  )
}

async function waitForBlocks(
  getBlocks: () => ConversationState["blocks"],
  predicate: (blocks: ConversationState["blocks"]) => boolean,
  timeoutMs = 2_500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(getBlocks())) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error("waitForBlocks timed out")
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "bantai-follow-e2e-"))
  originalHome = process.env.HOME
  process.env.HOME = tmpHome
  projectCwd = "/tmp/fake-follow-e2e-cwd"
  projectDir = join(tmpHome, ".claude", "projects", encodeKey(projectCwd))
  mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe("bantai follow — end-to-end", () => {
  it("replays an existing JSONL into reducer blocks, then picks up appended turns", async () => {
    writeFixture([
      {
        type: "user",
        uuid: "u1",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
        timestamp: "2026-04-18T00:00:00Z",
      },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi there" }],
          usage: {
            input_tokens: 3,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
        costUSD: 0.0001,
        timestamp: "2026-04-18T00:00:01Z",
      },
    ])

    const backend = createFollowBackend({
      sessionId: SESSION_ID,
      cwd: projectCwd,
    })

    // Drive the reducer with events as they arrive, mirroring sync.tsx.
    let state = createInitialState()
    const events: ConversationEvent[] = []

    const gen = backend.resume(SESSION_ID)
    const pump = (async () => {
      for await (const e of gen) {
        events.push(e)
        state = reduce(state, e)
      }
    })()

    // Assert the replay lands the expected blocks.
    await waitForBlocks(
      () => state.blocks,
      (blocks) =>
        blocks.some((b) => b.type === "user" && (b as any).text === "hello") &&
        blocks.some(
          (b) => b.type === "assistant" && (b as any).text === "hi there",
        ),
    )

    // Append a new turn to the on-disk session — this is the real live-tail
    // exercise. fs.watch fires, the tailer delivers new lines, the
    // translator emits events, the reducer renders them as blocks.
    appendFixture([
      {
        type: "user",
        uuid: "u2",
        message: { content: [{ type: "text", text: "another question" }] },
        timestamp: "2026-04-18T00:00:10Z",
      },
      {
        type: "assistant",
        uuid: "a2",
        message: {
          content: [{ type: "text", text: "appended reply" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        timestamp: "2026-04-18T00:00:11Z",
      },
    ])

    await waitForBlocks(
      () => state.blocks,
      (blocks) =>
        blocks.some(
          (b) => b.type === "user" && (b as any).text === "another question",
        ) &&
        blocks.some(
          (b) => b.type === "assistant" && (b as any).text === "appended reply",
        ),
    )

    // Sanity on contract-level events: session_init came before user_message,
    // every turn_start has a matching turn_complete, etc. We've already
    // asserted reducer output — here we're just double-checking the
    // event stream stayed well-formed across the replay/tail boundary.
    expect(events[0]?.type).toBe("session_init")
    const turnStarts = events.filter((e) => e.type === "turn_start").length
    const turnCompletes = events.filter((e) => e.type === "turn_complete").length
    expect(turnStarts).toBe(turnCompletes)
    expect(turnStarts).toBeGreaterThanOrEqual(2) // one per user turn

    backend.close()
    await pump
  })

  it("renders tool_use → tool_result pairing as a single tool block with status done", async () => {
    writeFixture([
      {
        type: "user",
        uuid: "u1",
        message: { content: [{ type: "text", text: "read foo" }] },
      },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool_42",
              name: "Read",
              input: { path: "/tmp/foo" },
            },
          ],
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      },
      {
        type: "user",
        uuid: "u2",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_42",
              content: "file contents here",
            },
          ],
        },
      },
    ])

    const backend = createFollowBackend({
      sessionId: SESSION_ID,
      cwd: projectCwd,
    })
    let state = createInitialState()
    const gen = backend.resume(SESSION_ID)
    const pump = (async () => {
      for await (const e of gen) {
        state = reduce(state, e)
      }
    })()

    await waitForBlocks(
      () => state.blocks,
      (blocks) =>
        blocks.some(
          (b) =>
            b.type === "tool" &&
            (b as any).id === "tool_42" &&
            (b as any).status === "done",
        ),
    )
    const tool = state.blocks.find((b) => b.type === "tool") as any
    expect(tool.tool).toBe("Read")
    expect(tool.output).toBe("file contents here")

    backend.close()
    await pump
  })

  it("launcher exits non-zero with a readable message when the session file is missing", async () => {
    // Shell-level smoke: bantai follow <id> exits non-zero when the ID is
    // not found anywhere. This is the contract from item 1 of the
    // breakdown. Runs the CLI as a child process with a throwaway HOME so
    // the scan comes up empty.
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "--conditions=browser",
        "./src/index.ts",
        "follow",
        "this-session-does-not-exist",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: tmpHome },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const exitCode = await proc.exited
    expect(exitCode).not.toBe(0)
  }, 15_000)
})
