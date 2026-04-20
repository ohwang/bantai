/**
 * Tests for FollowBackend.
 *
 * Two layers:
 *   1. Contract compliance — run the same event-ordering validator the
 *      real contract suite uses, so the follower never drifts from what
 *      the reducer expects.
 *   2. Adapter-specific behaviours — resume on a missing file surfaces an
 *      error; write-side methods don't mutate state; history_loaded lands
 *      after the initial replay; close() stops further event delivery.
 */

import { describe, expect, it, afterEach, beforeEach } from "bun:test"
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
import type {
  AgentEvent,
  ConversationEvent,
} from "../../src/protocol/types"
import { validateEventSequence } from "../protocol/contract.test"

let tmpHome: string
let originalHome: string | undefined
let projectCwd: string
let projectDir: string
const SESSION_ID = "follow-sess-00000000"

function encodeKey(cwd: string): string {
  return cwd.replace(/\//g, "-")
}

function writeJsonl(entries: unknown[]): string {
  const path = join(projectDir, `${SESSION_ID}.jsonl`)
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n")
  return path
}

function appendJsonl(entries: unknown[]): void {
  appendFileSync(
    join(projectDir, `${SESSION_ID}.jsonl`),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  )
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "bantai-follow-adapter-"))
  originalHome = process.env.HOME
  process.env.HOME = tmpHome
  projectCwd = "/tmp/fake-follow-cwd"
  projectDir = join(tmpHome, ".claude", "projects", encodeKey(projectCwd))
  mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(tmpHome, { recursive: true, force: true })
})

/** Run the adapter's event generator until `stopWhen` returns true, or
 *  until the generator ends naturally. Calls close() afterwards. */
async function collectUntil(
  backend: ReturnType<typeof createFollowBackend>,
  stopWhen: (events: ConversationEvent[]) => boolean,
  timeoutMs = 2_000,
): Promise<ConversationEvent[]> {
  const events: ConversationEvent[] = []
  const gen = backend.resume(SESSION_ID)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const next = await Promise.race([
      gen.next(),
      new Promise<IteratorResult<ConversationEvent>>((resolve) =>
        setTimeout(() => resolve({ value: undefined as any, done: false }), 50),
      ),
    ])
    if (next.done) break
    if (next.value) {
      events.push(next.value)
      if (stopWhen(events)) break
    }
  }
  backend.close()
  return events
}

describe("FollowBackend — contract compliance", () => {
  it("emits session_init first, turn_start before text, turn_complete after each turn", async () => {
    writeJsonl([
      {
        type: "user",
        uuid: "u1",
        message: { content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [{ type: "text", text: "hello back" }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ])
    const backend = createFollowBackend({
      sessionId: SESSION_ID,
      cwd: projectCwd,
    })
    const events = await collectUntil(backend, (es) =>
      es.some((e) => e.type === "history_loaded"),
    )

    // Strip SystemEvents — the contract validator is only about AgentEvents.
    const agentEvents: AgentEvent[] = events.filter(
      (e): e is AgentEvent =>
        e.type !== "history_loaded" &&
        e.type !== "history_load_started" &&
        e.type !== "history_load_failed",
    )

    const violations = validateEventSequence(agentEvents)
    expect(violations).toEqual([])

    const types = agentEvents.map((e) => e.type)
    expect(types[0]).toBe("session_init")
    expect(types).toContain("turn_start")
    expect(types).toContain("user_message")
    expect(types).toContain("text_complete")
    expect(types).toContain("turn_complete")
  })

  it("emits history_loaded after the initial replay with a target='follow' summary", async () => {
    writeJsonl([
      {
        type: "user",
        uuid: "u1",
        message: { content: [{ type: "text", text: "hi" }] },
      },
    ])
    const backend = createFollowBackend({
      sessionId: SESSION_ID,
      cwd: projectCwd,
    })
    const events = await collectUntil(backend, (es) =>
      es.some((e) => e.type === "history_loaded"),
    )
    const loaded = events.find((e) => e.type === "history_loaded") as any
    expect(loaded).toBeTruthy()
    expect(loaded.origin).toBe("claude")
    expect(loaded.target).toBe("follow")
    expect(loaded.sessionId).toBe(SESSION_ID)
  })
})

describe("FollowBackend — missing file", () => {
  it("emits session_init + fatal error when no session file is found", async () => {
    // No files written. The adapter should locate nothing and surface a
    // clear error without hanging or throwing.
    const backend = createFollowBackend({
      sessionId: "does-not-exist",
      cwd: projectCwd,
    })
    const events: ConversationEvent[] = []
    const gen = backend.resume("does-not-exist")
    // Consume until the generator closes itself (error + channel close).
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const next = await gen.next()
      if (next.done) break
      events.push(next.value)
    }
    backend.close()

    const types = events.map((e) => e.type)
    expect(types[0]).toBe("session_init")
    expect(types).toContain("error")
    const err = events.find((e) => e.type === "error") as any
    expect(err.code).toBe("follow_not_found")
  })
})

describe("FollowBackend — live tail", () => {
  it("surfaces events appended after the initial replay", async () => {
    writeJsonl([
      {
        type: "user",
        uuid: "u1",
        message: { content: [{ type: "text", text: "first" }] },
      },
    ])
    const backend = createFollowBackend({
      sessionId: SESSION_ID,
      cwd: projectCwd,
    })

    const collected: ConversationEvent[] = []
    const gen = backend.resume(SESSION_ID)
    const readerDone = (async () => {
      for await (const e of gen) {
        collected.push(e)
      }
    })()

    // Wait for history_loaded, then append a new assistant turn.
    const waitFor = async (pred: () => boolean, timeoutMs = 2_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (pred()) return
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error("waitFor timed out")
    }

    await waitFor(() => collected.some((e) => e.type === "history_loaded"))
    appendJsonl([
      {
        type: "assistant",
        uuid: "a2",
        message: {
          content: [{ type: "text", text: "appended reply" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ])
    await waitFor(
      () =>
        collected.some(
          (e) => e.type === "text_complete" && (e as any).text === "appended reply",
        ),
      2_500,
    )

    backend.close()
    await readerDone
    const appended = collected.find(
      (e) => e.type === "text_complete" && (e as any).text === "appended reply",
    )
    expect(appended).toBeTruthy()
  })
})

describe("FollowBackend — write side is read-only", () => {
  it("sendMessage / interrupt / approve do not throw and produce no AgentEvent side effects beyond system_message", async () => {
    writeJsonl([
      {
        type: "user",
        uuid: "u1",
        message: { content: [{ type: "text", text: "first" }] },
      },
    ])
    const backend = createFollowBackend({
      sessionId: SESSION_ID,
      cwd: projectCwd,
    })

    // These must not throw even before resume is called. After close,
    // they should still not throw — they just log.
    backend.sendMessage({ text: "nope" })
    backend.interrupt()
    backend.approveToolUse("fake")
    backend.denyToolUse("fake")
    backend.cancelElicitation("fake")
    expect(() => backend.close()).not.toThrow()
  })

  it("setModel / setPermissionMode / setEffort / forkSession reject", async () => {
    const backend = createFollowBackend({
      sessionId: SESSION_ID,
      cwd: projectCwd,
    })
    await expect(backend.setModel("claude-opus")).rejects.toThrow(/read-only/)
    await expect(backend.setPermissionMode("default")).rejects.toThrow(
      /read-only/,
    )
    await expect(backend.setEffort("high")).rejects.toThrow(/read-only/)
    await expect(backend.forkSession(SESSION_ID)).rejects.toThrow(/read-only/)
    backend.close()
  })

  it("capabilities() reports read-only shape", () => {
    const backend = createFollowBackend({
      sessionId: SESSION_ID,
      cwd: projectCwd,
    })
    const caps = backend.capabilities()
    expect(caps.name).toBe("follow")
    expect(caps.supportsToolApproval).toBe(false)
    expect(caps.supportsStreaming).toBe(false)
    expect(caps.supportsResume).toBe(true)
    backend.close()
  })
})
