import { afterEach, describe, expect, it, mock } from "bun:test"
import type {
  AgentBackend,
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
  sessionKeyFor,
  type HostPair,
} from "../../../../src/frontends/slack/router/registry"
import type { ProjectConfig } from "../../../../src/frontends/slack/router/resolver"

// ---------------------------------------------------------------------------
// Tiny AgentBackend stub with full control over event emission.
// ---------------------------------------------------------------------------

function createFakeBackend(): {
  backend: AgentBackend
  emit: (event: ConversationEvent) => void
  end: () => void
  messages: UserMessage[]
  interrupted: boolean
  closed: boolean
} {
  const state = {
    messages: [] as UserMessage[],
    interrupted: false,
    closed: false,
  }
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
    // Drain the queue first.
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
    interrupt() {
      state.interrupted = true
    },
    approveToolUse() {},
    denyToolUse() {},
    respondToElicitation() {},
    cancelElicitation() {},
    async setModel() {},
    async setPermissionMode() {},
    async setEffort() {},
    async availableModels(): Promise<ModelInfo[]> { return [] },
    async listSessions(): Promise<SessionInfo[]> { return [] },
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
    get messages() { return state.messages },
    get interrupted() { return state.interrupted },
    get closed() { return state.closed },
  }
}

function fakeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    channelId: "C0TEST",
    projectDir: "/tmp/proj",
    backend: "mock",
    approvers: [],
    verbosity: "normal",
    requireMention: true,
    permissionMode: "default",
    triggerName: "bantai",
    controlPrefix: "!bantai",
    sessionBanner: true,
    showCost: false,
    autoJoinThreads: true,
    threadRequireExplicitMention: false,
    interactiveReplies: false,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sessionKeyFor", () => {
  it("collapses top-level messages to 'main'", () => {
    expect(sessionKeyFor({ workspace: "W1", channelId: "C1" })).toBe("slack:W1:C1:main")
  })
  it("includes threadTs when present", () => {
    expect(sessionKeyFor({ workspace: "W1", channelId: "C1", threadTs: "123.456" })).toBe(
      "slack:W1:C1:123.456",
    )
  })
})

describe("createSessionRegistry", () => {
  // Track fakes across tests so we can assert teardown.
  const openFakes: ReturnType<typeof createFakeBackend>[] = []

  afterEach(() => {
    for (const f of openFakes) f.backend.close()
    openFakes.length = 0
  })

  function makeRegistry(idleTimeoutMs = 10_000) {
    return createSessionRegistry({
      workspace: "W1",
      idleTimeoutMs,
      buildHost({ project }) {
        const fake = createFakeBackend()
        openFakes.push(fake)
        const pair = makeHostPair(fake.backend)
        ;(pair as HostPair & { _fake: typeof fake })._fake = fake
        void project
        return pair
      },
    })
  }

  function lastFake() {
    return openFakes[openFakes.length - 1]!
  }

  it("constructs a new entry on first getOrCreate and reuses it thereafter", () => {
    const r = makeRegistry()
    const proj = fakeProject()
    const a = r.getOrCreate({ workspace: "W1", channelId: "C1" }, proj, "123.1")
    const b = r.getOrCreate({ workspace: "W1", channelId: "C1" }, proj, "123.1")
    expect(a).toBe(b)
    expect(r.size()).toBe(1)
    expect(a.key).toBe("slack:W1:C1:main")
    expect(a.routing.channel).toBe("C0TEST")
    expect(a.routing.parentTs).toBe("123.1")
  })

  it("distinguishes threads within the same channel", () => {
    const r = makeRegistry()
    const proj = fakeProject()
    const main = r.getOrCreate({ workspace: "W1", channelId: "C1" }, proj, "1")
    const thread = r.getOrCreate(
      { workspace: "W1", channelId: "C1", threadTs: "1" },
      proj,
      "1",
    )
    expect(main).not.toBe(thread)
    expect(r.size()).toBe(2)
  })

  it("forwards AgentEvents to subscribers", async () => {
    const r = makeRegistry()
    const entry = r.getOrCreate({ workspace: "W1", channelId: "C1" }, fakeProject(), "1")
    const seen: ConversationEvent[] = []
    const unsub = entry.subscribe((e) => seen.push(e))

    entry.send({ text: "hi" })

    // Allow the pump to take the generator's first tick.
    await Promise.resolve()

    const f = lastFake()
    expect(f.messages).toEqual([{ text: "hi" }])

    f.emit({ type: "session_init", tools: [], models: [] })
    f.emit({ type: "turn_start" })
    f.emit({ type: "text_delta", text: "hello" })
    f.emit({ type: "text_complete", text: "hello" })
    f.emit({ type: "turn_complete" })

    // Yield so the async generator can deliver events to the subscriber.
    await new Promise((r) => setTimeout(r, 20))

    expect(seen.map((e) => e.type)).toEqual([
      "session_init",
      "turn_start",
      "text_delta",
      "text_complete",
      "turn_complete",
    ])

    unsub()
  })

  it("close() is idempotent and removes the entry", () => {
    const r = makeRegistry()
    const proj = fakeProject()
    const entry = r.getOrCreate({ workspace: "W1", channelId: "C1" }, proj, "1")
    entry.close()
    entry.close() // second call must not throw
    expect(r.size()).toBe(0)
    expect(r.peek({ workspace: "W1", channelId: "C1" })).toBeUndefined()
    expect(lastFake().closed).toBe(true)
  })

  it("closeAll tears down every session", () => {
    const r = makeRegistry()
    r.getOrCreate({ workspace: "W1", channelId: "C1" }, fakeProject(), "1")
    r.getOrCreate({ workspace: "W1", channelId: "C2" }, fakeProject({ channelId: "C2" }), "2")
    expect(r.size()).toBe(2)
    r.closeAll()
    expect(r.size()).toBe(0)
  })

  it("sends after close() are dropped quietly", () => {
    const r = makeRegistry()
    const entry = r.getOrCreate({ workspace: "W1", channelId: "C1" }, fakeProject(), "1")
    entry.close()
    // No throw.
    entry.send({ text: "post-mortem" })
    expect(lastFake().messages.length).toBe(0)
  })

  it("idle timeout closes the session", async () => {
    const r = makeRegistry(50 /* ms */)
    const entry = r.getOrCreate({ workspace: "W1", channelId: "C1" }, fakeProject(), "1")
    expect(r.size()).toBe(1)
    await new Promise((res) => setTimeout(res, 150))
    expect(r.size()).toBe(0)
    expect(lastFake().closed).toBe(true)
    // entry.close() after auto-close is fine.
    entry.close()
  })
})
