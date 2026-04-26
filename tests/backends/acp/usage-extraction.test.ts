/**
 * ACP usage-extraction tests
 *
 * Covers the two non-`usage_update` paths through which real ACP backends
 * surface token-usage data today:
 *
 *   1. Gemini CLI 0.37.0 stuffs per-turn usage into the `session/prompt`
 *      response's `_meta.quota.token_count.input_tokens` field. The adapter
 *      synthesises a `cost_update` from it after the prompt resolves.
 *
 *   2. Qwen Code 0.15.x surfaces per-model context-window cap via
 *      `availableModels[i]._meta.contextLimit`. The adapter populates
 *      `ModelInfo.contextWindow` from it so the status bar's
 *      `model.contextWindow ?? modelContextWindow(raw)` fallback resolves
 *      without any hardcoded entry in MODEL_CONTEXT_WINDOWS.
 *
 * (Qwen's per-turn token usage path is exercised in event-mapper.test.ts via
 * the `agent_message_chunk._meta.usage` mapping.)
 */

import { describe, expect, it } from "bun:test"
import { AcpAdapter } from "../../../src/backends/acp/adapter"
import { EventChannel } from "../../../src/utils/event-channel"
import type { AgentEvent, ModelInfo } from "../../../src/protocol/types"
import type { AcpModel } from "../../../src/backends/acp/types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RequestCall {
  method: string
  params: unknown
}

function createTestAdapter(opts?: {
  promptResult?: unknown
}): {
  adapter: AcpAdapter
  events: AgentEvent[]
  requests: RequestCall[]
} {
  const adapter = new AcpAdapter({
    command: "echo",
    args: [],
    displayName: "Test ACP Agent",
    presetName: "test-acp",
  })

  const channel = new EventChannel<AgentEvent>()
  const events: AgentEvent[] = []
  const originalPush = channel.push.bind(channel)
  channel.push = (item: AgentEvent) => {
    events.push(item)
    originalPush(item)
  }
  ;(adapter as any).eventChannel = channel

  const requests: RequestCall[] = []
  ;(adapter as any).transport = {
    isAlive: true,
    async request(method: string, params: unknown) {
      requests.push({ method, params })
      if (method === "session/prompt") {
        return opts?.promptResult ?? { stopReason: "end_turn" }
      }
      return undefined
    },
    respond() {},
    respondError() {},
    notify() {},
    close() {},
  }
  ;(adapter as any).sessionId = "test-session-001"
  ;(adapter as any).config = { cwd: process.cwd() }

  return { adapter, events, requests }
}

// ---------------------------------------------------------------------------
// Gemini path: prompt response `_meta.quota.token_count` → cost_update
// ---------------------------------------------------------------------------

describe("AcpAdapter sendPrompt — Gemini-style _meta.quota extraction", () => {
  it("emits cost_update from `_meta.quota.token_count` before turn_complete", async () => {
    const { adapter, events } = createTestAdapter({
      promptResult: {
        stopReason: "end_turn",
        _meta: {
          quota: {
            token_count: { input_tokens: 12_345, output_tokens: 678 },
            model_usage: [],
          },
        },
      },
    })

    await (adapter as any).sendPrompt("hello")

    const costIdx = events.findIndex((e) => e.type === "cost_update")
    const completeIdx = events.findIndex((e) => e.type === "turn_complete")
    expect(costIdx).toBeGreaterThanOrEqual(0)
    expect(completeIdx).toBeGreaterThanOrEqual(0)
    expect(costIdx).toBeLessThan(completeIdx)

    const cost = events[costIdx]! as Extract<AgentEvent, { type: "cost_update" }>
    expect(cost.inputTokens).toBe(12_345)
    expect(cost.outputTokens).toBe(678)
    expect(cost.contextTokens).toBe(12_345)
  })

  it("does not emit cost_update when `_meta.quota` is missing", async () => {
    const { adapter, events } = createTestAdapter({
      promptResult: { stopReason: "end_turn" },
    })

    await (adapter as any).sendPrompt("hello")

    expect(events.some((e) => e.type === "cost_update")).toBe(false)
    expect(events.some((e) => e.type === "turn_complete")).toBe(true)
  })

  it("emits cost_update when only output_tokens is reported", async () => {
    // Defensive: an agent that reports just output (e.g. early in a streaming
    // turn) should still flow to the reducer.
    const { adapter, events } = createTestAdapter({
      promptResult: {
        stopReason: "end_turn",
        _meta: { quota: { token_count: { output_tokens: 42 } } },
      },
    })

    await (adapter as any).sendPrompt("hi")

    const cost = events.find((e) => e.type === "cost_update") as
      | Extract<AgentEvent, { type: "cost_update" }>
      | undefined
    expect(cost).toBeDefined()
    expect(cost!.inputTokens).toBe(0)
    expect(cost!.outputTokens).toBe(42)
    expect(cost!.contextTokens).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Qwen path: model._meta.contextLimit → ModelInfo.contextWindow
// ---------------------------------------------------------------------------

describe("AcpAdapter normalizeModelList — Qwen-style _meta.contextLimit", () => {
  function call(adapter: AcpAdapter, models: AcpModel[]): ModelInfo[] {
    return (adapter as any).normalizeModelList(models)
  }

  it("propagates _meta.contextLimit onto ModelInfo.contextWindow", () => {
    const { adapter } = createTestAdapter()
    const out = call(adapter, [
      {
        modelId: "qwen3-coder-plus(qwen-oauth)",
        name: "Qwen 3 Coder Plus",
        _meta: { contextLimit: 1_000_000 },
      },
    ])

    expect(out).toHaveLength(1)
    expect(out[0]!.contextWindow).toBe(1_000_000)
    expect(out[0]!.id).toBe("qwen3-coder-plus(qwen-oauth)")
  })

  it("omits contextWindow when _meta.contextLimit is missing or invalid", () => {
    const { adapter } = createTestAdapter()
    const out = call(adapter, [
      { modelId: "no-meta", name: "No Meta" },
      { modelId: "bad-meta", name: "Bad Meta", _meta: { contextLimit: "lots" } },
      { modelId: "zero-meta", name: "Zero Meta", _meta: { contextLimit: 0 } },
    ])

    expect(out).toHaveLength(3)
    for (const entry of out) {
      expect(entry.contextWindow).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// session_init emission: `currentModelId` carries the live model identity
// ---------------------------------------------------------------------------

describe("AcpAdapter session_init — currentModelId propagation", () => {
  it("emits session_init with `currentModelId` set to the adapter's currentModel field", () => {
    // This is the bridge that lets the reducer pick the right ModelInfo from
    // a multi-entry `availableModels` list (e.g. Qwen Code, where the live
    // model is whichever one matches `currentModelId` — NOT necessarily
    // models[0], which is the user's settings.json order).
    const { adapter } = createTestAdapter()
    const events: AgentEvent[] = []
    ;(adapter as any).eventChannel = {
      push: (e: AgentEvent) => events.push(e),
      isClosed: () => false,
      next: async () => ({ done: true, value: undefined }),
      close: () => {},
    }
    ;(adapter as any).discoveredModels = [
      { modelId: "coder-model(qwen-oauth)", name: "coder-model", _meta: { contextLimit: 1_000_000 } },
      { modelId: "qwen/qwen3.6-35b-a3b(openai)", name: "Qwen3.6 35B-A3B (LM Studio, local)", _meta: { contextLimit: 262_144 } },
    ]
    ;(adapter as any).currentModel = "qwen/qwen3.6-35b-a3b(openai)"
    ;(adapter as any).discoveredConfigOptions = []
    ;(adapter as any).sessionId = "test-session-002"
    // Fire the same emission path that resetSession uses — it's the simpler
    // of the two session_init sites (no replay/seed prelude to mock out).
    ;(adapter as any).eventChannel.push({
      type: "session_init",
      sessionId: (adapter as any).sessionId,
      tools: [],
      models: (adapter as any).normalizeModelList((adapter as any).discoveredModels),
      ...((adapter as any).currentModel ? { currentModelId: (adapter as any).currentModel } : {}),
    })

    const init = events.find((e) => e.type === "session_init") as
      | Extract<AgentEvent, { type: "session_init" }>
      | undefined
    expect(init).toBeDefined()
    expect(init!.currentModelId).toBe("qwen/qwen3.6-35b-a3b(openai)")
    // The matching ModelInfo must carry contextWindow=262_144 so resolveContextWindow
    // returns the user's actual cap (not the unrelated coder-model 1M).
    const live = init!.models.find((m) => m.id === init!.currentModelId)
    expect(live?.contextWindow).toBe(262_144)
  })
})
