/**
 * Integration test for the backend hot-swap flow in SyncProvider.
 *
 * The real SyncProvider is tightly coupled to SolidJS context + onMount,
 * so we rebuild just enough of its internals to exercise the switch path:
 * a loop-generation counter, a close-old-then-start-new sequence, and the
 * formatFullHistory() replay hand-off to the new adapter's initialPrompt.
 *
 * This is the higher-level companion to tests/commands/switch.test.ts,
 * which covers the command-surface behaviour (gates, messaging, error
 * paths) against a fake ctx.switchBackend.
 */

import { describe, test, expect } from "bun:test"
import { MockAdapter } from "../../../src/backends/mock/adapter"
import {
  createInitialState,
  resetVolatileSessionState,
  type AgentBackend,
  type Block,
  type ConversationEvent,
  type SessionConfig,
} from "../../../src/protocol/types"
import { reduce } from "../../../src/protocol/reducer"
import { formatFullHistory } from "../../../src/session/cross-backend"

/** Minimal reproduction of sync.tsx's event loop + switchBackend logic. */
function createHarness(initial: AgentBackend) {
  let conversationState = createInitialState()
  const config: SessionConfig = { cwd: process.cwd() }
  let currentBackend = initial
  let loopGeneration = 0
  let pendingInitResolvers: Array<() => void> = []
  const events: ConversationEvent[] = []

  const apply = (event: ConversationEvent) => {
    events.push(event)
    if (event.type === "session_init" && pendingInitResolvers.length > 0) {
      const r = pendingInitResolvers
      pendingInitResolvers = []
      r.forEach((fn) => fn())
    }
    conversationState = reduce(conversationState, event)
  }

  const startEventLoop = async () => {
    const gen = ++loopGeneration
    const backend = currentBackend
    try {
      for await (const ev of backend.start(config)) {
        if (gen !== loopGeneration) break
        apply(ev)
      }
    } catch {
      // swallowed in superseded loops — mirrors sync.tsx
    }
  }

  const switchBackend = async (adapter: AgentBackend, model?: string) => {
    const old = currentBackend
    const oldName = old.capabilities().name

    loopGeneration++
    old.close()

    const blocks = conversationState.blocks
    if (blocks.length > 0) {
      const { contextText } = formatFullHistory(blocks, oldName)
      config.initialPrompt = contextText
    }
    config.resume = undefined
    config.continue = undefined

    currentBackend = adapter

    const ready = new Promise<void>((resolve) => pendingInitResolvers.push(resolve))

    // Mirror sync.tsx: use the shared helper so the harness resets the same
    // volatile slice the real switch path does. The explicit `currentModel`
    // override models the sync.tsx branch that applies `opts.model` on top.
    conversationState = {
      ...resetVolatileSessionState(conversationState),
      currentModel: model ?? null,
    }

    startEventLoop()

    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 3000),
    )
    await Promise.race([ready, timeout])
  }

  return {
    get state() {
      return conversationState
    },
    get config() {
      return config
    },
    get currentBackend() {
      return currentBackend
    },
    get blocks(): Block[] {
      return conversationState.blocks
    },
    startEventLoop,
    switchBackend,
    events,
    sendMessage: (text: string) => {
      apply({ type: "user_message", text })
      currentBackend.sendMessage({ text })
    },
  }
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor: timeout")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("switchBackend hot-swap (integration)", () => {
  test("preserves conversation history across a mock -> mock swap", async () => {
    const a = new MockAdapter()
    const harness = createHarness(a)

    // Kick off the first loop; wait for session_init.
    harness.startEventLoop()
    await waitFor(() => harness.state.session !== null)

    // Exchange a turn.
    harness.sendMessage("hello")
    await waitFor(() => harness.state.sessionState === "IDLE" && harness.state.blocks.some(b => b.type === "assistant"))

    const priorBlocks = [...harness.blocks]
    expect(priorBlocks.some((b) => b.type === "user")).toBe(true)
    expect(priorBlocks.some((b) => b.type === "assistant")).toBe(true)
    const firstBackendName = harness.currentBackend.capabilities().name

    // Swap to a fresh MockAdapter.
    const b = new MockAdapter()
    await harness.switchBackend(b)

    // Blocks carried over (identical references).
    expect(harness.blocks).toEqual(priorBlocks)

    // The replay prompt was built from the old backend's block history.
    expect(harness.config.initialPrompt).toBeTruthy()
    expect(harness.config.initialPrompt!).toContain(
      `Previous conversation history from ${firstBackendName} session`,
    )
    expect(harness.config.initialPrompt!).toContain("User: hello")

    // The live backend reference is the new adapter.
    expect(harness.currentBackend).toBe(b)
    expect(harness.currentBackend.capabilities().name).toBe("mock")

    // The new backend has reached IDLE (session_init fired).
    expect(harness.state.session).not.toBeNull()
  })

  test("loopGeneration supersedes events from the closed backend", async () => {
    const a = new MockAdapter()
    const harness = createHarness(a)
    harness.startEventLoop()
    await waitFor(() => harness.state.session !== null)

    // Start a long-running turn that will stream for a while.
    harness.sendMessage("please read a file that is long enough to stream")

    // Swap immediately — the in-flight adapter's stream should be ignored.
    const b = new MockAdapter()
    await harness.switchBackend(b)

    expect(harness.currentBackend).toBe(b)
    // We should not have observed events from a `stream_error` the closed
    // adapter's generator might have surfaced.
    expect(harness.events.some((e) => e.type === "error" && (e as any).code === "stream_error")).toBe(false)
  })

  test("replay is skipped when the prior conversation is empty", async () => {
    const a = new MockAdapter()
    const harness = createHarness(a)
    harness.startEventLoop()
    await waitFor(() => harness.state.session !== null)

    // No user messages yet — swap without any blocks.
    const b = new MockAdapter()
    await harness.switchBackend(b)
    expect(harness.config.initialPrompt).toBeUndefined()
  })

  test("resets volatile status-bar state (cost, rate-limits, turn counters) while preserving blocks", async () => {
    const a = new MockAdapter()
    const harness = createHarness(a)
    harness.startEventLoop()
    await waitFor(() => harness.state.session !== null)

    // Exchange a turn so the state picks up non-defaults the reducer writes:
    // session metadata, cost (from turn_complete), turnNumber, blocks.
    harness.sendMessage("hello")
    await waitFor(
      () =>
        harness.state.sessionState === "IDLE" &&
        harness.state.blocks.some((b) => b.type === "assistant"),
    )

    // Seed the remaining volatile fields by hand — the mock adapter doesn't
    // necessarily drive rate-limits or streaming output tokens, but the real
    // switch path has to reset them regardless of whether they were set.
    ;(harness as any).state_mutate?.()
    // Direct write into the mutable state mirror so we don't depend on
    // internal event shapes the mock doesn't emit.
    const dirty = harness.state as any
    dirty.rateLimits = { primary: { usedPercentage: 75, resetsAt: Date.now() + 1000 } }
    dirty.lastTurnInputTokens = 12_345
    dirty._contextFromStream = true
    dirty.streamingOutputTokens = 77
    dirty.lastTurnFiles = [{ path: "/x", type: "modified", added: 1, removed: 0 }]

    const priorBlocks = [...harness.blocks]
    expect(priorBlocks.length).toBeGreaterThan(0)
    expect(harness.state.turnNumber).toBeGreaterThan(0)

    const fresh = createInitialState()

    const b = new MockAdapter()
    await harness.switchBackend(b)

    // Post-switch, the new backend has already driven session_init → IDLE on
    // our harness, which repopulates `session`, `sessionState`, `turnNumber`
    // is still 0 (no new turn yet), etc. Assert the *reset-specific* fields
    // match the factory before the new turn runs.
    const s = harness.state
    expect(s.cost).toEqual(fresh.cost)
    expect(s.rateLimits).toEqual(fresh.rateLimits)
    expect(s.lastTurnInputTokens).toBe(fresh.lastTurnInputTokens)
    expect(s._contextFromStream).toBe(fresh._contextFromStream)
    expect(s.streamingOutputTokens).toBe(fresh.streamingOutputTokens)
    expect(s.turnNumber).toBe(fresh.turnNumber)
    expect(s.lastTurnFiles).toBe(fresh.lastTurnFiles)

    // Blocks preserved (reference-stable).
    expect(s.blocks).toEqual(priorBlocks)
  })
})
