import { describe, expect, it } from "bun:test"
import type { App } from "@slack/bolt"
import type { ConversationEvent } from "../../../../src/protocol/types"
import { createEventRenderer } from "../../../../src/frontends/slack/view/event-renderer"
import type { SendAdapter } from "../../../../src/frontends/slack/view/outbox"
import type { ReactionAdapter } from "../../../../src/frontends/slack/view/reactions"

function makeStubApp(): App {
  return {} as App
}

function noopReactionAdapter(): ReactionAdapter {
  return {
    async addReaction() {},
    async removeReaction() {},
  }
}

function capturingSendAdapter(): {
  adapter: SendAdapter
  texts: string[]
} {
  const texts: string[] = []
  let counter = 0
  const adapter: SendAdapter = {
    async postMessage(args) {
      counter++
      texts.push(args.markdownText ?? args.text ?? "")
      return { ts: `ts${counter}`, channel: args.channel }
    },
    async updateMessage(args) {
      texts.push(args.markdownText ?? args.text ?? "")
    },
  }
  return { adapter, texts }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe("event-renderer — turn timeout guard", () => {
  it("does not fire when turnTimeoutS is 0 / undefined", async () => {
    const { adapter, texts } = capturingSendAdapter()
    let timeoutCalls = 0
    const renderer = createEventRenderer({
      app: makeStubApp(),
      binding: { channel: "C01", threadTs: "100.001", triggerTs: "100.001" },
      sendAdapter: adapter,
      reactionAdapter: noopReactionAdapter(),
      turnTimeoutS: 0,
      onTurnTimeout: () => { timeoutCalls++ },
    })
    renderer.onEvent({ type: "turn_start" } as ConversationEvent)
    await sleep(100)
    expect(timeoutCalls).toBe(0)
    expect(texts.some((t) => t.includes(":hourglass"))).toBe(false)
    renderer.destroy()
  })

  it("fires onTurnTimeout + posts an :hourglass_flowing_sand: note when turn overruns", async () => {
    const { adapter, texts } = capturingSendAdapter()
    let timeoutCalls = 0
    const renderer = createEventRenderer({
      app: makeStubApp(),
      binding: { channel: "C01", threadTs: "100.001", triggerTs: "100.001" },
      sendAdapter: adapter,
      reactionAdapter: noopReactionAdapter(),
      // 0.05s — small enough to race past setTimeout in a test.
      // The schema field is an int so we go through opts directly here.
      turnTimeoutS: 0.05 as number,
      onTurnTimeout: () => { timeoutCalls++ },
    })
    renderer.onEvent({ type: "turn_start" } as ConversationEvent)
    await sleep(120)
    expect(timeoutCalls).toBe(1)
    expect(texts.some((t) => t.includes(":hourglass_flowing_sand:"))).toBe(true)
    renderer.destroy()
  })

  it("turn_complete cancels the timer — no-op after", async () => {
    const { adapter, texts } = capturingSendAdapter()
    let timeoutCalls = 0
    const renderer = createEventRenderer({
      app: makeStubApp(),
      binding: { channel: "C01", threadTs: "100.001", triggerTs: "100.001" },
      sendAdapter: adapter,
      reactionAdapter: noopReactionAdapter(),
      turnTimeoutS: 0.1 as number,
      onTurnTimeout: () => { timeoutCalls++ },
    })
    renderer.onEvent({ type: "turn_start" } as ConversationEvent)
    renderer.onEvent({ type: "turn_complete" } as ConversationEvent)
    await sleep(200)
    expect(timeoutCalls).toBe(0)
    expect(texts.some((t) => t.includes(":hourglass"))).toBe(false)
    renderer.destroy()
  })
})

describe("event-renderer — budget cap guard", () => {
  it("fires onBudgetExceeded the first time cumulative cost crosses the cap", async () => {
    const { adapter, texts } = capturingSendAdapter()
    let budgetCalls: Array<{ actual: number; cap: number }> = []
    const renderer = createEventRenderer({
      app: makeStubApp(),
      binding: { channel: "C01", threadTs: "100.001", triggerTs: "100.001" },
      sendAdapter: adapter,
      reactionAdapter: noopReactionAdapter(),
      maxBudgetUsd: 0.5,
      onBudgetExceeded: (actual, cap) => {
        budgetCalls.push({ actual, cap })
      },
    })
    // First turn — under cap.
    renderer.onEvent({ type: "turn_start" } as ConversationEvent)
    renderer.onEvent({
      type: "turn_complete",
      usage: { inputTokens: 100, outputTokens: 200, totalCostUsd: 0.3 },
    } as ConversationEvent)
    await sleep(50)
    expect(budgetCalls.length).toBe(0)

    // Second turn — crosses 0.5 cap (0.3 + 0.4 = 0.7 > 0.5).
    renderer.onEvent({ type: "turn_start" } as ConversationEvent)
    renderer.onEvent({
      type: "turn_complete",
      usage: { inputTokens: 100, outputTokens: 200, totalCostUsd: 0.4 },
    } as ConversationEvent)
    await sleep(50)
    expect(budgetCalls).toHaveLength(1)
    expect(budgetCalls[0]!.actual).toBeCloseTo(0.7, 5)
    expect(budgetCalls[0]!.cap).toBe(0.5)
    expect(texts.some((t) => t.includes(":moneybag:") && t.includes("crossed cap"))).toBe(true)

    // Third turn — also over, but onBudgetExceeded was already latched.
    renderer.onEvent({ type: "turn_start" } as ConversationEvent)
    renderer.onEvent({
      type: "turn_complete",
      usage: { inputTokens: 10, outputTokens: 10, totalCostUsd: 0.05 },
    } as ConversationEvent)
    await sleep(50)
    expect(budgetCalls).toHaveLength(1)
    renderer.destroy()
  })

  it("does not fire when cap is 0 (disabled)", async () => {
    const { adapter } = capturingSendAdapter()
    let budgetCalls = 0
    const renderer = createEventRenderer({
      app: makeStubApp(),
      binding: { channel: "C01", threadTs: "100.001", triggerTs: "100.001" },
      sendAdapter: adapter,
      reactionAdapter: noopReactionAdapter(),
      maxBudgetUsd: 0,
      onBudgetExceeded: () => { budgetCalls++ },
    })
    renderer.onEvent({ type: "turn_start" } as ConversationEvent)
    renderer.onEvent({
      type: "turn_complete",
      usage: { inputTokens: 100, outputTokens: 200, totalCostUsd: 999 },
    } as ConversationEvent)
    await sleep(50)
    expect(budgetCalls).toBe(0)
    renderer.destroy()
  })
})
