/**
 * Tests for sync context logic — event batching, reducer integration,
 * store reconciliation, clearConversation, and resetCost.
 *
 * The SyncProvider is tightly coupled to SolidJS context providers and
 * backend lifecycle (onMount, onCleanup). Rather than rendering the full
 * component tree, we extract and test the core logic patterns:
 *
 * 1. EventBatcher — push/flush/batching behavior
 * 2. applyEvents — reducer integration + store updates
 * 3. clearConversation — state reset while preserving session metadata
 * 4. resetCost — cost counter reset
 * 5. pushEvent — init timeout logic
 */

import { describe, test, expect } from "bun:test"
import { createRoot, batch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { reduce } from "../../../src/protocol/reducer"
import {
  createInitialState,
  type AgentEvent,
  type ConversationEvent,
  type CostTotals,
} from "../../../src/protocol/types"
import { EventBatcher } from "../../../src/utils/event-batcher"
import type { MessagesState } from "../../../src/frontends/tui/context/messages"
import type { SessionContextState } from "../../../src/frontends/tui/context/session"
import type { PermissionsState } from "../../../src/frontends/tui/context/permissions"

// ---------------------------------------------------------------------------
// Helpers — replicate the store shapes from context providers
// ---------------------------------------------------------------------------

function createMessagesStore() {
  return createStore<MessagesState>({
    blocks: [],
    streamingText: "",
    streamingThinking: "",
    activeTasks: [],
    backgrounded: false,
    streamingOutputTokens: 0,
  })
}

function createSessionStore() {
  return createStore<SessionContextState>({
    sessionState: "INITIALIZING",
    session: null,
    cost: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0,
    },
    lastError: null,
    turnNumber: 0,
    lastTurnInputTokens: 0,
    lastTurnTtftMs: null,
    currentModel: "",
    currentEffort: "",
    rateLimits: null,
    agentCommands: [],
    configOptions: [],
    resuming: false,
    currentCwd: null,
    worktree: null,
  })
}

function createPermissionsStore() {
  return createStore<PermissionsState>({
    pendingPermission: null,
    pendingElicitation: null,
  })
}

/**
 * Creates the applyEvents function that mirrors SyncProvider's internal logic.
 * Returns the function plus the stores it writes to, so tests can assert
 * on reactive state after events are applied.
 */
function createApplyEventsHarness() {
  const [messagesState, setMessages] = createMessagesStore()
  const [sessionState, setSession] = createSessionStore()
  const [permissionsState, setPermissions] = createPermissionsStore()

  let conversationState = createInitialState()

  const applyEvents = (events: AgentEvent[]) => {
    for (const event of events) {
      conversationState = reduce(conversationState, event)
    }

    batch(() => {
      setMessages("blocks", reconcile(conversationState.blocks))
      setMessages("streamingText", conversationState.streamingText)
      setMessages("streamingThinking", conversationState.streamingThinking)
      setMessages("activeTasks", reconcile(Array.from(conversationState.activeTasks.entries())))
      setMessages("backgrounded", conversationState.backgrounded)
      setMessages("streamingOutputTokens", conversationState.streamingOutputTokens)
      setMessages("lastTurnFiles", reconcile(conversationState.lastTurnFiles ?? undefined as any))

      setSession("sessionState", conversationState.sessionState)
      setSession("session", reconcile(conversationState.session))
      setSession("cost", reconcile(conversationState.cost))
      setSession("lastError", reconcile(conversationState.lastError))
      setSession("turnNumber", conversationState.turnNumber)
      setSession("lastTurnInputTokens", conversationState.lastTurnInputTokens)
      setSession("currentModel", conversationState.currentModel ?? "")
      setSession("currentEffort", conversationState.currentEffort ?? "")
      setSession("rateLimits", reconcile(conversationState.rateLimits))
      setSession("agentCommands", reconcile(conversationState.agentCommands))
      setSession("configOptions", reconcile(conversationState.configOptions))

      setPermissions("pendingPermission", reconcile(conversationState.pendingPermission))
      setPermissions("pendingElicitation", reconcile(conversationState.pendingElicitation))
    })
  }

  const clearConversation = () => {
    conversationState = {
      ...createInitialState(),
      sessionState: conversationState.sessionState,
      session: conversationState.session,
      cost: { ...conversationState.cost },
      currentModel: conversationState.currentModel,
      currentEffort: conversationState.currentEffort,
    }

    batch(() => {
      setMessages("blocks", reconcile([]))
      setMessages("streamingText", "")
      setMessages("streamingThinking", "")
      setMessages("activeTasks", reconcile([]))
      setMessages("backgrounded", false)
      setMessages("streamingOutputTokens", 0)
      setMessages("lastTurnFiles", undefined)
      setSession("lastTurnInputTokens", 0)
      setSession("turnNumber", 0)
      setSession("rateLimits", null)
    })
  }

  const resetCost = () => {
    const zeroCost: CostTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0,
    }
    conversationState = {
      ...conversationState,
      cost: zeroCost,
      lastTurnInputTokens: 0,
      _contextFromStream: false,
      turnNumber: 0,
    }
    batch(() => {
      setSession("cost", reconcile(zeroCost))
      setSession("lastTurnInputTokens", 0)
      setSession("turnNumber", 0)
    })
  }

  return {
    applyEvents,
    clearConversation,
    resetCost,
    messages: messagesState,
    session: sessionState,
    permissions: permissionsState,
    getConversationState: () => conversationState,
  }
}

// ---------------------------------------------------------------------------
// EventBatcher tests
// ---------------------------------------------------------------------------

describe("EventBatcher", () => {
  test("flushes immediately when interval has elapsed", () => {
    const received: ConversationEvent[][] = []
    const batcher = new EventBatcher((events) => received.push([...events]), 16)

    batcher.push({ type: "text_delta", text: "hello" })
    // First push should flush immediately (no prior flush, elapsed >= interval)
    expect(received).toHaveLength(1)
    expect(received[0]![0]!.type).toBe("text_delta")

    batcher.destroy()
  })

  test("batches events within the interval window", async () => {
    const received: ConversationEvent[][] = []
    // Use a longer interval so we can push multiple events before flush
    const batcher = new EventBatcher((events) => received.push([...events]), 100)

    // First push flushes immediately
    batcher.push({ type: "text_delta", text: "a" })
    expect(received).toHaveLength(1)

    // Subsequent pushes within 100ms should be batched
    batcher.push({ type: "text_delta", text: "b" })
    batcher.push({ type: "text_delta", text: "c" })
    expect(received).toHaveLength(1) // Not yet flushed

    // Wait for the batch timer to fire
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(received).toHaveLength(2)
    expect(received[1]).toHaveLength(2)

    batcher.destroy()
  })

  test("manual flush() drains the queue", () => {
    const received: ConversationEvent[][] = []
    const batcher = new EventBatcher((events) => received.push([...events]), 100)

    // First push flushes immediately
    batcher.push({ type: "turn_start" })
    expect(received).toHaveLength(1)

    // Queue more events
    batcher.push({ type: "text_delta", text: "a" })
    batcher.push({ type: "text_delta", text: "b" })

    // Manual flush drains without waiting
    batcher.flush()
    expect(received).toHaveLength(2)
    expect(received[1]).toHaveLength(2)

    batcher.destroy()
  })

  test("flush() is a no-op on empty queue", () => {
    const received: ConversationEvent[][] = []
    const batcher = new EventBatcher((events) => received.push([...events]), 16)

    batcher.flush()
    expect(received).toHaveLength(0)

    batcher.destroy()
  })

  test("destroy() flushes remaining events and prevents further pushes", () => {
    const received: ConversationEvent[][] = []
    const batcher = new EventBatcher((events) => received.push([...events]), 100)

    // First push flushes
    batcher.push({ type: "turn_start" })

    // Queue more
    batcher.push({ type: "text_delta", text: "final" })

    batcher.destroy()

    // Destroy should have flushed the remaining event
    expect(received).toHaveLength(2)

    // Further pushes are silently dropped
    batcher.push({ type: "text_delta", text: "ignored" })
    batcher.flush()
    expect(received).toHaveLength(2) // No new flush
  })

  test("handler errors are caught and forwarded to onError callback", () => {
    const errors: Error[] = []
    const batcher = new EventBatcher(
      () => { throw new Error("handler boom") },
      16,
      (err) => errors.push(err),
    )

    batcher.push({ type: "turn_start" })
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toBe("handler boom")

    batcher.destroy()
  })
})

// ---------------------------------------------------------------------------
// applyEvents — reducer integration + store reconciliation
// ---------------------------------------------------------------------------

describe("applyEvents (reducer -> store sync)", () => {
  test("session_init updates session store", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([{
        type: "session_init",
        tools: [{ name: "Read" }, { name: "Write" }],
        models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
        account: { email: "test@example.com" },
      }])

      expect(h.session.sessionState).toBe("IDLE")
      expect(h.session.session).not.toBeNull()
      expect(h.session.session!.tools).toHaveLength(2)
      expect(h.session.session!.models).toHaveLength(1)
      expect(h.session.session!.account?.email).toBe("test@example.com")
      expect(h.session.currentModel).toBe("Claude Sonnet 4.6")
      dispose()
    })
  })

  test("turn lifecycle updates session and messages stores", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      // Init -> IDLE
      h.applyEvents([{ type: "session_init", tools: [], models: [] }])
      expect(h.session.sessionState).toBe("IDLE")

      // Turn start -> RUNNING
      h.applyEvents([{ type: "turn_start" }])
      expect(h.session.sessionState).toBe("RUNNING")
      expect(h.session.turnNumber).toBe(1)

      // Text streaming
      h.applyEvents([{ type: "text_delta", text: "Hello " }])
      expect(h.messages.streamingText).toBe("Hello ")

      h.applyEvents([{ type: "text_delta", text: "world" }])
      expect(h.messages.streamingText).toBe("Hello world")

      // Turn complete -> IDLE
      h.applyEvents([{
        type: "turn_complete",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, totalCostUsd: 0.01 },
      }])
      expect(h.session.sessionState).toBe("IDLE")
      expect(h.messages.streamingText).toBe("")
      // Text should be committed as an assistant block
      expect(h.messages.blocks).toHaveLength(1)
      expect(h.messages.blocks[0]!.type).toBe("assistant")

      // Cost should be updated
      expect(h.session.cost.inputTokens).toBe(100)
      expect(h.session.cost.outputTokens).toBe(50)
      expect(h.session.cost.totalCostUsd).toBe(0.01)
      dispose()
    })
  })

  test("user_message in IDLE state transitions to RUNNING and adds block", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([{ type: "session_init", tools: [], models: [] }])
      h.applyEvents([{ type: "user_message", text: "Hello Claude" }])

      expect(h.session.sessionState).toBe("RUNNING")
      expect(h.messages.blocks).toHaveLength(1)
      expect(h.messages.blocks[0]!.type).toBe("user")
      dispose()
    })
  })

  test("user_message during RUNNING state is queued", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
      ])
      h.applyEvents([{ type: "user_message", text: "queued message" }])

      expect(h.messages.blocks).toHaveLength(1)
      const block = h.messages.blocks[0]!
      expect(block.type).toBe("user")
      if (block.type === "user") {
        expect(block.queued).toBe(true)
      }
      dispose()
    })
  })

  test("thinking deltas update streamingThinking", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
      ])
      h.applyEvents([
        { type: "thinking_delta", text: "Let me think..." },
        { type: "thinking_delta", text: " step 1" },
      ])

      expect(h.messages.streamingThinking).toBe("Let me think... step 1")
      dispose()
    })
  })

  test("tool_use lifecycle creates and updates tool blocks", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
      ])

      // Tool start
      h.applyEvents([{
        type: "tool_use_start",
        id: "tool-1",
        tool: "Read",
        input: { file_path: "/tmp/test.ts" },
      }])

      expect(h.messages.blocks).toHaveLength(1)
      const toolBlock = h.messages.blocks[0]!
      expect(toolBlock.type).toBe("tool")
      if (toolBlock.type === "tool") {
        expect(toolBlock.tool).toBe("Read")
        expect(toolBlock.status).toBe("running")
      }

      // Tool progress
      h.applyEvents([{
        type: "tool_use_progress",
        id: "tool-1",
        output: "file contents here",
      }])

      const updated = h.messages.blocks[0]!
      if (updated.type === "tool") {
        expect(updated.output).toBe("file contents here")
      }

      // Tool end
      h.applyEvents([{
        type: "tool_use_end",
        id: "tool-1",
        output: "final output",
      }])

      const ended = h.messages.blocks[0]!
      if (ended.type === "tool") {
        expect(ended.status).toBe("done")
        expect(ended.output).toBe("final output")
      }
      dispose()
    })
  })

  test("permission_request updates permissions store", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
      ])

      h.applyEvents([{
        type: "permission_request",
        id: "perm-1",
        tool: "Bash",
        input: { command: "rm -rf /tmp/test" },
      }])

      expect(h.session.sessionState).toBe("WAITING_FOR_PERM")
      expect(h.permissions.pendingPermission).not.toBeNull()
      expect(h.permissions.pendingPermission!.id).toBe("perm-1")

      // Permission response clears it
      h.applyEvents([{
        type: "permission_response",
        id: "perm-1",
        behavior: "allow",
      }])

      expect(h.session.sessionState).toBe("RUNNING")
      expect(h.permissions.pendingPermission).toBeNull()
      dispose()
    })
  })

  test("elicitation_request updates permissions store", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
      ])

      h.applyEvents([{
        type: "elicitation_request",
        id: "elic-1",
        questions: [{ question: "Choose", options: [{ label: "A" }] }],
      }])

      expect(h.session.sessionState).toBe("WAITING_FOR_ELIC")
      expect(h.permissions.pendingElicitation).not.toBeNull()
      expect(h.permissions.pendingElicitation!.id).toBe("elic-1")

      h.applyEvents([{
        type: "elicitation_response",
        id: "elic-1",
        answers: { "Choose": "A" },
      }])

      expect(h.session.sessionState).toBe("RUNNING")
      expect(h.permissions.pendingElicitation).toBeNull()
      dispose()
    })
  })

  test("interrupt clears permissions and transitions to INTERRUPTING", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "permission_request", id: "perm-1", tool: "Bash", input: { command: "ls" } },
      ])

      expect(h.session.sessionState).toBe("WAITING_FOR_PERM")
      expect(h.permissions.pendingPermission).not.toBeNull()

      h.applyEvents([{ type: "interrupt" }])

      expect(h.session.sessionState).toBe("INTERRUPTING")
      expect(h.permissions.pendingPermission).toBeNull()
      expect(h.permissions.pendingElicitation).toBeNull()
      dispose()
    })
  })

  test("error events update session store", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
      ])

      h.applyEvents([{
        type: "error",
        code: "api_error",
        message: "Rate limited",
        severity: "fatal",
      }])

      expect(h.session.sessionState).toBe("ERROR")
      expect(h.session.lastError).not.toBeNull()
      expect(h.session.lastError!.code).toBe("api_error")
      expect(h.session.lastError!.message).toBe("Rate limited")

      // Error block should be added to messages
      const errorBlocks = h.messages.blocks.filter(b => b.type === "error")
      expect(errorBlocks).toHaveLength(1)
      dispose()
    })
  })

  test("cost_update tracks streaming output tokens", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
      ])

      h.applyEvents([{ type: "cost_update", inputTokens: 100, outputTokens: 25 }])
      expect(h.messages.streamingOutputTokens).toBe(25)

      h.applyEvents([{ type: "cost_update", inputTokens: 100, outputTokens: 30 }])
      expect(h.messages.streamingOutputTokens).toBe(55) // Accumulated
      dispose()
    })
  })

  test("multiple events in a single batch are processed sequentially", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      // Apply a full session lifecycle in one batch
      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world" },
        { type: "text_complete", text: "Hello world" },
        { type: "turn_complete", usage: { inputTokens: 50, outputTokens: 20 } },
      ])

      expect(h.session.sessionState).toBe("IDLE")
      expect(h.session.turnNumber).toBe(1)
      expect(h.messages.blocks).toHaveLength(1)
      expect(h.messages.blocks[0]!.type).toBe("assistant")
      expect(h.messages.streamingText).toBe("")
      dispose()
    })
  })

  test("task lifecycle updates activeTasks in messages store", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
      ])

      h.applyEvents([{
        type: "task_start",
        taskId: "task-1",
        description: "Exploring codebase",
      }])

      expect(h.messages.activeTasks).toHaveLength(1)
      expect(h.messages.activeTasks[0]![0]).toBe("task-1")
      expect(h.messages.activeTasks[0]![1].status).toBe("running")

      h.applyEvents([{
        type: "task_complete",
        taskId: "task-1",
        output: "Found 10 files",
      }])

      expect(h.messages.activeTasks).toHaveLength(1)
      expect(h.messages.activeTasks[0]![1].status).toBe("completed")
      dispose()
    })
  })

  test("model_changed updates session store", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([{ type: "session_init", tools: [], models: [] }])
      h.applyEvents([{ type: "model_changed", model: "claude-opus-4-6" }])

      expect(h.session.currentModel).toBe("claude-opus-4-6")
      dispose()
    })
  })

  test("system_message adds a system block", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([{ type: "session_init", tools: [], models: [] }])
      h.applyEvents([{ type: "system_message", text: "Context compacted" }])

      expect(h.messages.blocks).toHaveLength(1)
      expect(h.messages.blocks[0]!.type).toBe("system")
      dispose()
    })
  })
})

// ---------------------------------------------------------------------------
// clearConversation
// ---------------------------------------------------------------------------

describe("clearConversation", () => {
  test("resets messages but preserves session metadata and cost", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      // Build up some state
      h.applyEvents([
        { type: "session_init", tools: [{ name: "Read" }], models: [{ id: "m1", name: "Model" }] },
        { type: "turn_start" },
        { type: "text_delta", text: "some text" },
        { type: "text_complete", text: "some text" },
        { type: "turn_complete", usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.01 } },
      ])

      expect(h.messages.blocks).toHaveLength(1)
      expect(h.session.cost.inputTokens).toBe(100)
      expect(h.session.session).not.toBeNull()

      h.clearConversation()

      // Messages cleared
      expect(h.messages.blocks).toHaveLength(0)
      expect(h.messages.streamingText).toBe("")
      expect(h.messages.streamingThinking).toBe("")
      expect(h.messages.activeTasks).toHaveLength(0)
      expect(h.messages.backgrounded).toBe(false)
      expect(h.messages.streamingOutputTokens).toBe(0)

      // Session metadata and cost preserved
      expect(h.session.sessionState).toBe("IDLE")
      expect(h.session.session).not.toBeNull()
      expect(h.session.session!.tools).toHaveLength(1)
      expect(h.session.cost.inputTokens).toBe(100)
      expect(h.session.cost.totalCostUsd).toBe(0.01)

      // Turn number and input tokens reset
      expect(h.session.turnNumber).toBe(0)
      expect(h.session.lastTurnInputTokens).toBe(0)
      dispose()
    })
  })

  test("preserves currentModel across clear", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "model_changed", model: "claude-opus-4-6" },
      ])

      expect(h.session.currentModel).toBe("claude-opus-4-6")

      h.clearConversation()

      // Model info is preserved in the underlying conversationState
      // (the store reflects what conversationState has)
      const cs = h.getConversationState()
      expect(cs.currentModel).toBe("claude-opus-4-6")
      dispose()
    })
  })
})

// ---------------------------------------------------------------------------
// resetCost
// ---------------------------------------------------------------------------

describe("resetCost", () => {
  test("zeros all cost counters", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "turn_complete", usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10, totalCostUsd: 0.05 } },
      ])

      expect(h.session.cost.inputTokens).toBe(500)
      expect(h.session.cost.outputTokens).toBe(200)
      expect(h.session.cost.totalCostUsd).toBe(0.05)
      expect(h.session.turnNumber).toBe(1)

      h.resetCost()

      expect(h.session.cost.inputTokens).toBe(0)
      expect(h.session.cost.outputTokens).toBe(0)
      expect(h.session.cost.cacheReadTokens).toBe(0)
      expect(h.session.cost.cacheWriteTokens).toBe(0)
      expect(h.session.cost.totalCostUsd).toBe(0)
      expect(h.session.lastTurnInputTokens).toBe(0)
      expect(h.session.turnNumber).toBe(0)
      dispose()
    })
  })

  test("resets _contextFromStream flag in conversation state", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "cost_update", inputTokens: 100, outputTokens: 10, contextTokens: 500 },
      ])

      const beforeReset = h.getConversationState()
      expect(beforeReset._contextFromStream).toBe(true)

      h.resetCost()

      const afterReset = h.getConversationState()
      expect(afterReset._contextFromStream).toBe(false)
      dispose()
    })
  })

  test("preserves session state and model after cost reset", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [{ name: "Read" }], models: [{ id: "m1", name: "Model" }] },
        { type: "turn_start" },
        { type: "turn_complete", usage: { inputTokens: 100, outputTokens: 50 } },
        { type: "model_changed", model: "claude-opus-4-6" },
      ])

      h.resetCost()

      // Session metadata preserved
      expect(h.session.sessionState).toBe("IDLE")
      expect(h.session.session).not.toBeNull()
      expect(h.session.currentModel).toBe("claude-opus-4-6")
      dispose()
    })
  })
})

// ---------------------------------------------------------------------------
// pushEvent init timeout logic (tested via the pattern, not the timer)
// ---------------------------------------------------------------------------

describe("pushEvent patterns", () => {
  test("user_message event is forwarded through batcher to handler", () => {
    createRoot(dispose => {
      const received: ConversationEvent[][] = []
      const batcher = new EventBatcher((events) => received.push([...events]), 16)

      batcher.push({ type: "user_message", text: "Hello" })

      expect(received).toHaveLength(1)
      expect(received[0]![0]!.type).toBe("user_message")

      batcher.destroy()
      dispose()
    })
  })

  test("synthetic events (interrupt, shutdown) pass through batcher", () => {
    createRoot(dispose => {
      const received: ConversationEvent[] = []
      const batcher = new EventBatcher((events) => received.push(...events), 16)

      batcher.push({ type: "interrupt" })
      batcher.push({ type: "shutdown" })

      // Second push is within 16ms of the first flush, so it's deferred.
      // Flush explicitly to drain the queue before asserting.
      batcher.flush()

      expect(received).toHaveLength(2)
      expect(received[0]!.type).toBe("interrupt")
      expect(received[1]!.type).toBe("shutdown")

      batcher.destroy()
      dispose()
    })
  })
})

// ---------------------------------------------------------------------------
// Full event sequence integration
// ---------------------------------------------------------------------------

describe("full event sequences", () => {
  test("complete turn with tool use, permission, and completion", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      // Session init
      h.applyEvents([{ type: "session_init", tools: [{ name: "Bash" }], models: [] }])

      // User sends message
      h.applyEvents([{ type: "user_message", text: "Run ls" }])
      expect(h.session.sessionState).toBe("RUNNING")

      // Turn starts
      h.applyEvents([{ type: "turn_start" }])
      expect(h.session.turnNumber).toBe(1)

      // Tool starts
      h.applyEvents([{
        type: "tool_use_start",
        id: "tool-1",
        tool: "Bash",
        input: { command: "ls" },
      }])

      // Permission required
      h.applyEvents([{
        type: "permission_request",
        id: "tool-1",
        tool: "Bash",
        input: { command: "ls" },
      }])
      expect(h.session.sessionState).toBe("WAITING_FOR_PERM")

      // User approves
      h.applyEvents([{ type: "permission_response", id: "tool-1", behavior: "allow" }])
      expect(h.session.sessionState).toBe("RUNNING")

      // Tool completes
      h.applyEvents([{
        type: "tool_use_end",
        id: "tool-1",
        output: "file1.ts\nfile2.ts",
      }])

      // Assistant responds
      h.applyEvents([{ type: "text_delta", text: "Here are the files:" }])

      // Turn completes
      h.applyEvents([{
        type: "turn_complete",
        usage: { inputTokens: 200, outputTokens: 100, totalCostUsd: 0.02 },
      }])

      expect(h.session.sessionState).toBe("IDLE")
      expect(h.session.cost.inputTokens).toBe(200)

      // Blocks: user message + tool block + assistant text
      expect(h.messages.blocks.length).toBeGreaterThanOrEqual(2)
      dispose()
    })
  })

  test("multi-turn conversation accumulates cost", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([{ type: "session_init", tools: [], models: [] }])

      // Turn 1
      h.applyEvents([
        { type: "turn_start" },
        { type: "text_delta", text: "Turn 1" },
        { type: "turn_complete", usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.01 } },
      ])

      // Turn 2
      h.applyEvents([
        { type: "user_message", text: "Next" },
        { type: "turn_start" },
        { type: "text_delta", text: "Turn 2" },
        { type: "turn_complete", usage: { inputTokens: 200, outputTokens: 80, totalCostUsd: 0.02 } },
      ])

      expect(h.session.turnNumber).toBe(2)
      expect(h.session.cost.inputTokens).toBe(300)
      expect(h.session.cost.outputTokens).toBe(130)
      expect(h.session.cost.totalCostUsd).toBeCloseTo(0.03)
      dispose()
    })
  })

  test("interrupt during permission clears pending and transitions", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "tool_use_start", id: "t1", tool: "Bash", input: { command: "dangerous" } },
        { type: "permission_request", id: "t1", tool: "Bash", input: { command: "dangerous" } },
      ])

      expect(h.session.sessionState).toBe("WAITING_FOR_PERM")
      expect(h.permissions.pendingPermission).not.toBeNull()

      h.applyEvents([{ type: "interrupt" }])

      expect(h.session.sessionState).toBe("INTERRUPTING")
      expect(h.permissions.pendingPermission).toBeNull()

      // turn_complete after interrupt recovers to IDLE
      h.applyEvents([{ type: "turn_complete" }])
      expect(h.session.sessionState).toBe("IDLE")
      dispose()
    })
  })

  test("shutdown cancels running tools", () => {
    createRoot(dispose => {
      const h = createApplyEventsHarness()

      h.applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "tool_use_start", id: "t1", tool: "Read", input: { file_path: "/tmp/x" } },
      ])

      const toolBefore = h.messages.blocks[0]!
      if (toolBefore.type === "tool") {
        expect(toolBefore.status).toBe("running")
      }

      h.applyEvents([{ type: "shutdown" }])

      expect(h.session.sessionState).toBe("SHUTTING_DOWN")
      const toolAfter = h.messages.blocks[0]!
      if (toolAfter.type === "tool") {
        expect(toolAfter.status).toBe("canceled")
      }
      dispose()
    })
  })
})
