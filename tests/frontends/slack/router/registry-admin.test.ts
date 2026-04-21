import { afterEach, describe, expect, it, mock } from "bun:test"
import type {
  AgentBackend,
  AgentEvent,
  BackendCapabilities,
  ConversationEvent,
  ModelInfo,
  SessionConfig,
  SessionInfo,
  UserMessage,
} from "../../../../src/protocol/types"
import { createSessionHost, type SessionHost } from "../../../../src/session/host"
import { SubagentManager } from "../../../../src/subagents/manager"
import {
  createSessionRegistry,
  type HostPair,
  type RegistryAdminHook,
  type SessionCloseReason,
} from "../../../../src/frontends/slack/router/registry"
import type { ProjectConfig } from "../../../../src/frontends/slack/router/resolver"
import type {
  SessionPhase,
  SessionSummary,
} from "../../../../src/frontends/slack/admin/protocol"

// ---------------------------------------------------------------------------
// Test doubles — copied from registry.test.ts then trimmed to what we need.
// ---------------------------------------------------------------------------

function createFakeBackend(): {
  backend: AgentBackend
  emit: (event: ConversationEvent) => void
  end: () => void
  messages: UserMessage[]
  closed: boolean
} {
  const state = { messages: [] as UserMessage[], closed: false }
  let pushEvent: ((e: ConversationEvent) => void) | null = null
  let resolveEnd: (() => void) | null = null

  async function* start(_config: SessionConfig): AsyncGenerator<ConversationEvent> {
    const queue: ConversationEvent[] = []
    let waiter: ((e: ConversationEvent) => void) | null = null
    pushEvent = (e) => {
      if (waiter) {
        const w = waiter
        waiter = null
        w(e)
      } else {
        queue.push(e)
      }
    }
    const endPromise = new Promise<void>((resolve) => {
      resolveEnd = resolve
    })
    while (!state.closed) {
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      const next = await Promise.race([
        new Promise<ConversationEvent>((resolve) => {
          waiter = resolve
        }),
        endPromise.then(() => null),
      ])
      if (next === null) return
      yield next
    }
  }

  const backend: AgentBackend = {
    capabilities(): BackendCapabilities {
      return {
        name: "fake",
        supportsThinking: false,
        supportsToolApproval: false,
        supportsResume: false,
        supportsContinue: false,
        supportsFork: false,
        supportsStreaming: true,
        supportsSubagents: false,
        supportsCompact: false,
        supportedPermissionModes: ["default"],
      }
    },
    start,
    resume() {
      throw new Error("fake: resume not supported")
    },
    sendMessage(msg) {
      state.messages.push(msg)
    },
    interrupt() {},
    approveToolUse() {},
    denyToolUse() {},
    respondToElicitation() {},
    cancelElicitation() {},
    async setModel() {},
    async setPermissionMode() {},
    async setEffort() {},
    async availableModels(): Promise<ModelInfo[]> {
      return []
    },
    async listSessions(): Promise<SessionInfo[]> {
      return []
    },
    async forkSession(): Promise<string> {
      throw new Error("fake: fork not supported")
    },
    close() {
      state.closed = true
      resolveEnd?.()
    },
  }

  return {
    backend,
    emit: (e) => pushEvent?.(e),
    end: () => resolveEnd?.(),
    get messages() {
      return state.messages
    },
    get closed() {
      return state.closed
    },
  }
}

function fakeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    channelId: "C0ADM",
    channelName: "admin-channel",
    projectDir: "/tmp/proj",
    backend: "mock",
    approvers: [],
    verbosity: "normal",
    requireMention: true,
    permissionMode: "default",
    triggerName: "bantai",
    sessionBanner: true,
    showCost: false,
    autoJoinThreads: true,
    threadRequireExplicitMention: false,
    threadHistoryLimit: 0,
    interactiveReplies: false,
    debounceMs: 0,
    nativeStreaming: false,
    turnTimeoutS: 0,
    maxBudgetUsd: 0,
    env: {},
    ...overrides,
  }
}

function makeHostPair(backend: AgentBackend): HostPair {
  const closeSpy = mock(() => backend.close())
  const host: SessionHost = createSessionHost({
    backend,
    config: {},
    subagentManager: new SubagentManager(),
    currentBackend: "claude",
    close: closeSpy,
  })
  return { host, backend }
}

interface RecordedAdmin extends RegistryAdminHook {
  opened: SessionSummary[]
  events: Array<{ key: string; event: AgentEvent }>
  phases: Array<{ key: string; phase: SessionPhase }>
  summaries: Array<{ key: string; summary: SessionSummary }>
  closed: Array<{ key: string; reason: SessionCloseReason }>
}

function makeRecordingAdminHook(): RecordedAdmin {
  const rec = {
    opened: [] as SessionSummary[],
    events: [] as Array<{ key: string; event: AgentEvent }>,
    phases: [] as Array<{ key: string; phase: SessionPhase }>,
    summaries: [] as Array<{ key: string; summary: SessionSummary }>,
    closed: [] as Array<{ key: string; reason: SessionCloseReason }>,
    onSessionOpened(summary: SessionSummary) {
      rec.opened.push(summary)
    },
    onSessionEvent(key: string, event: AgentEvent) {
      rec.events.push({ key, event })
    },
    onSessionPhase(key: string, phase: SessionPhase) {
      rec.phases.push({ key, phase })
    },
    onSessionSummaryChanged(key: string, summary: SessionSummary) {
      rec.summaries.push({ key, summary })
    },
    onSessionClosed(key: string, reason: SessionCloseReason) {
      rec.closed.push({ key, reason })
    },
  }
  return rec
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSessionRegistry — admin hook wiring", () => {
  const openFakes: ReturnType<typeof createFakeBackend>[] = []
  afterEach(() => {
    for (const f of openFakes) f.backend.close()
    openFakes.length = 0
  })

  function makeRegistry(adminHook: RegistryAdminHook, idleMs = 10_000) {
    return createSessionRegistry({
      workspace: "W1",
      idleTimeoutMs: idleMs,
      admin: adminHook,
      buildHost({ project }) {
        const fake = createFakeBackend()
        openFakes.push(fake)
        void project
        return makeHostPair(fake.backend)
      },
    })
  }

  function lastFake() {
    return openFakes[openFakes.length - 1]!
  }

  it("publishes onSessionOpened with a summary + starts at UNKNOWN phase", () => {
    const rec = makeRecordingAdminHook()
    const r = makeRegistry(rec)
    const entry = r.getOrCreate({ workspace: "W1", channelId: "C0ADM" }, fakeProject(), "t1")
    expect(rec.opened).toHaveLength(1)
    const summary = rec.opened[0]!
    expect(summary.key).toBe(entry.key)
    expect(summary.channelId).toBe("C0ADM")
    expect(summary.backend).toBe("mock")
    expect(summary.projectName).toBe("admin-channel")
    // Fresh session → UNKNOWN; phase flips to IDLE on the first session_init.
    expect(summary.phase).toBe("UNKNOWN")
    expect(summary.turns).toBe(0)
    expect(summary.totalCostUsd).toBe(0)
    expect(summary.resumed).toBe(false)
  })

  it("forwards session_event frames + emits session_phase on actual transitions", async () => {
    const rec = makeRecordingAdminHook()
    const r = makeRegistry(rec)
    const entry = r.getOrCreate({ workspace: "W1", channelId: "C0ADM" }, fakeProject(), "t1")
    entry.send({ text: "hi" })
    await Promise.resolve()

    const f = lastFake()
    f.emit({ type: "session_init", tools: [], models: [] })
    f.emit({ type: "turn_start" })
    f.emit({ type: "text_delta", text: "h" })
    f.emit({ type: "text_delta", text: "i" })
    f.emit({ type: "turn_complete" })
    await new Promise((r) => setTimeout(r, 30))

    // Every AgentEvent reaches the admin hook.
    expect(rec.events.map((e) => e.event.type)).toEqual([
      "session_init",
      "turn_start",
      "text_delta",
      "text_delta",
      "turn_complete",
    ])
    // Phase transitions: UNKNOWN → IDLE (session_init) → RUNNING (turn_start)
    // → IDLE (turn_complete). Streaming deltas do NOT flap the label.
    expect(rec.phases.map((p) => p.phase)).toEqual(["IDLE", "RUNNING", "IDLE"])
    // Live entry fields reflect the cumulative state.
    expect(entry.phase).toBe("IDLE")
    expect(entry.turns).toBe(1)
  })

  it("accumulates cost across turn_complete events for the live summary", async () => {
    const rec = makeRecordingAdminHook()
    const r = makeRegistry(rec)
    const entry = r.getOrCreate({ workspace: "W1", channelId: "C0ADM" }, fakeProject(), "t1")
    entry.send({ text: "hi" })
    await Promise.resolve()
    const f = lastFake()
    f.emit({ type: "session_init", tools: [], models: [] })
    f.emit({ type: "turn_start" })
    f.emit({
      type: "turn_complete",
      usage: { inputTokens: 1, outputTokens: 1, totalCostUsd: 0.25 },
    })
    f.emit({ type: "turn_start" })
    f.emit({
      type: "turn_complete",
      usage: { inputTokens: 1, outputTokens: 1, totalCostUsd: 0.1 },
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(entry.turns).toBe(2)
    expect(entry.totalCostUsd).toBeCloseTo(0.35, 5)
  })

  it("publishes close with 'shutdown' from closeAll and 'reset' from reset()", () => {
    const rec = makeRecordingAdminHook()
    const r = makeRegistry(rec)
    r.getOrCreate({ workspace: "W1", channelId: "C0ADM" }, fakeProject(), "t1")
    r.getOrCreate({ workspace: "W1", channelId: "C0ADM", threadTs: "99.9" }, fakeProject(), "99.9")

    const thread = r.peek({ workspace: "W1", channelId: "C0ADM", threadTs: "99.9" })!
    thread.reset()
    expect(rec.closed.map((c) => c.reason)).toEqual(["reset"])

    r.closeAll()
    expect(rec.closed.map((c) => c.reason)).toEqual(["reset", "shutdown"])
  })

  it("idle timeout reports 'idle' through the admin hook", async () => {
    const rec = makeRecordingAdminHook()
    const r = makeRegistry(rec, 50)
    r.getOrCreate({ workspace: "W1", channelId: "C0ADM" }, fakeProject(), "t1")
    await new Promise((res) => setTimeout(res, 150))
    expect(rec.closed).toHaveLength(1)
    expect(rec.closed[0]!.reason).toBe("idle")
  })

  it("entries() returns a snapshot of live entries", () => {
    const rec = makeRecordingAdminHook()
    const r = makeRegistry(rec)
    r.getOrCreate({ workspace: "W1", channelId: "C0ADM" }, fakeProject(), "t1")
    r.getOrCreate({ workspace: "W1", channelId: "C0ADM", threadTs: "9.9" }, fakeProject(), "9.9")
    const list = r.entries()
    expect(list).toHaveLength(2)
    // Mutating the returned array must not change the registry state.
    list.splice(0, list.length)
    expect(r.entries()).toHaveLength(2)
  })

  it("isolates a throwing admin hook — subscribers + pump keep running", async () => {
    const throwing: RegistryAdminHook = {
      onSessionOpened() {
        throw new Error("boom-open")
      },
      onSessionEvent() {
        throw new Error("boom-event")
      },
      onSessionPhase() {
        throw new Error("boom-phase")
      },
      onSessionClosed() {
        throw new Error("boom-close")
      },
      onSessionSummaryChanged() {
        throw new Error("boom-summary")
      },
    }
    const r = createSessionRegistry({
      workspace: "W1",
      idleTimeoutMs: 10_000,
      admin: throwing,
      buildHost({ project }) {
        const fake = createFakeBackend()
        openFakes.push(fake)
        void project
        return makeHostPair(fake.backend)
      },
    })
    const entry = r.getOrCreate({ workspace: "W1", channelId: "C0ADM" }, fakeProject(), "t1")
    const received: AgentEvent[] = []
    entry.subscribe((e) => {
      // Only AgentEvents are forwarded to admin, but all ConversationEvents
      // reach the view subscriber — casting is safe for this fake stream.
      received.push(e as AgentEvent)
    })
    entry.send({ text: "hi" })
    await Promise.resolve()
    const f = lastFake()
    f.emit({ type: "session_init", tools: [], models: [] })
    f.emit({ type: "turn_start" })
    f.emit({ type: "turn_complete" })
    await new Promise((r) => setTimeout(r, 30))
    expect(received.map((e) => e.type)).toEqual(["session_init", "turn_start", "turn_complete"])
    // close() still fires; the throw in onSessionClosed is swallowed.
    expect(() => entry.close()).not.toThrow()
  })

  it("rehydrated session starts at IDLE phase", async () => {
    const rec = makeRecordingAdminHook()
    // Fake store that reports a prior backend session id so the registry
    // treats the entry as rehydrated.
    const r = createSessionRegistry({
      workspace: "W1",
      idleTimeoutMs: 10_000,
      admin: rec,
      store: {
        get: () => ({
          key: "slack:W1:C0ADM:main",
          workspace: "W1",
          channelId: "C0ADM",
          threadTs: "main",
          backendId: "mock",
          backendSessionId: "prev-session-id",
          turns: 2,
          totalCostUsd: 0.5,
          lastActiveAt: 0,
          createdAt: 0,
        }),
        upsert() {},
        setBackendSessionId() {},
        recordTurn() {},
        touch() {},
        delete() {},
        list: () => [],
        clearBackendSessionId() {},
        recordThreadPost() {},
        hasThreadPost: () => false,
        pruneThreadPosts: () => 0,
        putPendingResumePrompt() {},
        getPendingResumePrompt: () => undefined,
        deletePendingResumePrompt() {},
        listPendingResumePrompts: () => [],
        close() {},
      },
      buildHost({ project }) {
        const fake = createFakeBackend()
        openFakes.push(fake)
        void project
        return makeHostPair(fake.backend)
      },
    })
    const entry = r.getOrCreate({ workspace: "W1", channelId: "C0ADM" }, fakeProject(), "t1")
    expect(entry.resumed).toBe(true)
    expect(entry.phase).toBe("IDLE")
    expect(entry.turns).toBe(2)
    expect(entry.totalCostUsd).toBeCloseTo(0.5, 5)
    expect(rec.opened[0]!.phase).toBe("IDLE")
  })

  it("skips resume when persisted backend differs from configured backend", () => {
    // Regression: before the backend-id guard in registry.ts, a channel whose
    // config backend was swapped (codex → gemini, etc.) would still feed the
    // previous backend's sessionId into `session/load`. Gemini replies with
    // JSON-RPC -32603 and the session dies on open. After the fix the registry
    // must skip resume when backend_id doesn't match and fall through to a
    // fresh session/new — leaving the stale-resume coordinator (later commit)
    // the opportunity to offer cross-backend history injection.
    const rec = makeRecordingAdminHook()
    let capturedResume: string | undefined
    const r = createSessionRegistry({
      workspace: "W1",
      idleTimeoutMs: 10_000,
      admin: rec,
      store: {
        get: () => ({
          key: "slack:W1:C0ADM:main",
          workspace: "W1",
          channelId: "C0ADM",
          threadTs: "main",
          backendId: "codex", // prior run was codex …
          backendSessionId: "codex-era-uuid",
          turns: 3,
          totalCostUsd: 0.75,
          lastActiveAt: 0,
          createdAt: 0,
        }),
        upsert() {},
        setBackendSessionId() {},
        recordTurn() {},
        touch() {},
        delete() {},
        list: () => [],
        clearBackendSessionId() {},
        recordThreadPost() {},
        hasThreadPost: () => false,
        pruneThreadPosts: () => 0,
        putPendingResumePrompt() {},
        getPendingResumePrompt: () => undefined,
        deletePendingResumePrompt() {},
        listPendingResumePrompts: () => [],
        close() {},
      },
      buildHost({ project, sessionConfig }) {
        capturedResume = sessionConfig.resume
        void project
        const fake = createFakeBackend()
        openFakes.push(fake)
        return makeHostPair(fake.backend)
      },
    })
    // … current config says gemini.
    const entry = r.getOrCreate(
      { workspace: "W1", channelId: "C0ADM" },
      fakeProject({ backend: "gemini" }),
      "t1",
    )
    // No resume id passed to the backend.
    expect(capturedResume).toBeUndefined()
    // `resumed` is false because no id was forwarded — even though the store
    // HAD a row, the mismatch means we effectively start fresh.
    expect(entry.resumed).toBe(false)
    // Prior turn/cost counters are still surfaced so Slack users don't lose
    // their running total on a backend swap.
    expect(entry.turns).toBe(3)
    expect(entry.totalCostUsd).toBeCloseTo(0.75, 5)
  })

  it("still resumes when persisted backend matches configured backend", () => {
    // Mirror of the mismatch test to pin down the happy path.
    let capturedResume: string | undefined
    const rec = makeRecordingAdminHook()
    const r = createSessionRegistry({
      workspace: "W1",
      idleTimeoutMs: 10_000,
      admin: rec,
      store: {
        get: () => ({
          key: "slack:W1:C0ADM:main",
          workspace: "W1",
          channelId: "C0ADM",
          threadTs: "main",
          backendId: "mock",
          backendSessionId: "same-backend-id",
          turns: 1,
          totalCostUsd: 0.1,
          lastActiveAt: 0,
          createdAt: 0,
        }),
        upsert() {},
        setBackendSessionId() {},
        recordTurn() {},
        touch() {},
        delete() {},
        list: () => [],
        clearBackendSessionId() {},
        recordThreadPost() {},
        hasThreadPost: () => false,
        pruneThreadPosts: () => 0,
        putPendingResumePrompt() {},
        getPendingResumePrompt: () => undefined,
        deletePendingResumePrompt() {},
        listPendingResumePrompts: () => [],
        close() {},
      },
      buildHost({ project, sessionConfig }) {
        capturedResume = sessionConfig.resume
        void project
        const fake = createFakeBackend()
        openFakes.push(fake)
        return makeHostPair(fake.backend)
      },
    })
    const entry = r.getOrCreate(
      { workspace: "W1", channelId: "C0ADM" },
      fakeProject({ backend: "mock" }),
      "t1",
    )
    expect(capturedResume).toBe("same-backend-id")
    expect(entry.resumed).toBe(true)
  })
})
