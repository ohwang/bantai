/**
 * S5 — verbosity and cost footer behaviours of the event-renderer.
 *
 * Each fixture drives the same event stream (turn_start → tool_use_start →
 * tool_use_end → text_delta → text_complete → turn_complete) and checks
 * what the renderer emitted against the expected verbosity shape.
 */

import { describe, expect, it } from "bun:test"
import type { App } from "@slack/bolt"
import type { ConversationEvent } from "../../../../src/protocol/types"
import { createEventRenderer } from "../../../../src/frontends/slack/view/event-renderer"
import type { SendAdapter } from "../../../../src/frontends/slack/view/outbox"
import type { ReactionAdapter } from "../../../../src/frontends/slack/view/reactions"
import type { VerbosityLevel } from "../../../../src/frontends/slack/config/schema"

interface Send {
  kind: "post" | "update"
  text: string
  ts?: string
  blocks?: unknown[]
}

function makeStubApp(): App {
  return {} as App
}

function harness(opts: { verbosity: VerbosityLevel; showCost?: boolean }) {
  const sends: Send[] = []
  let counter = 0
  const sendAdapter: SendAdapter = {
    async postMessage(args) {
      counter++
      const ts = `ts${counter}`
      sends.push({
        kind: "post",
        text: args.markdownText ?? args.text ?? "",
        ts,
        blocks: args.blocks,
      })
      return { ts, channel: args.channel }
    },
    async updateMessage(args) {
      sends.push({
        kind: "update",
        text: args.markdownText ?? args.text ?? "",
        ts: args.ts,
        blocks: args.blocks,
      })
    },
  }
  const reactionAdapter: ReactionAdapter = {
    async addReaction() {},
    async removeReaction() {},
  }
  const renderer = createEventRenderer({
    app: makeStubApp(),
    binding: { channel: "C01", threadTs: "100.001", triggerTs: "t1" },
    sendAdapter,
    reactionAdapter,
    verbosity: opts.verbosity,
    ...(opts.showCost !== undefined ? { showCost: opts.showCost } : {}),
  })
  function push(events: ConversationEvent[]) {
    for (const e of events) renderer.onEvent(e)
  }
  return { sends, push }
}

async function drain(ms = 80) {
  await new Promise((r) => setTimeout(r, ms))
}

const TOOL_TURN: ConversationEvent[] = [
  { type: "turn_start" },
  { type: "tool_use_start", id: "u1", tool: "Bash", input: { command: "ls" } },
  { type: "tool_use_end", id: "u1", output: "line1\nline2" },
  { type: "text_delta", text: "done" },
  { type: "text_complete", text: "done" },
  {
    type: "turn_complete",
    usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.01 },
  },
]

// ---------------------------------------------------------------------------
// Silent
// ---------------------------------------------------------------------------

describe("verbosity=silent", () => {
  it("posts nothing — no text, no tool cards, no cost footer", async () => {
    const h = harness({ verbosity: "silent", showCost: true })
    h.push(TOOL_TURN)
    await drain(100)
    // Streaming is suppressed; tool cards are suppressed; cost footer is
    // suppressed by the gate (even with showCost=true).
    expect(h.sends).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Concise
// ---------------------------------------------------------------------------

describe("verbosity=concise", () => {
  it("posts the text body + a single summary line at turn end", async () => {
    const h = harness({ verbosity: "concise" })
    h.push(TOOL_TURN)
    await drain(100)
    // 2 for the streamed text (post draft + final update), 1 for the
    // concise aggregator post at turn_complete.
    const posts = h.sends.filter((s) => s.kind === "post")
    const summary = posts.find((p) => p.text.includes("tool"))
    expect(summary).toBeTruthy()
    expect(summary!.text).toContain("1 tool")

    // No per-tool card was posted.
    const toolCards = h.sends.filter(
      (s) => (s.text ?? "").includes("Bash — running") || (s.text ?? "").includes("Bash — done"),
    )
    expect(toolCards).toHaveLength(0)
  })

  it("concise aggregator is NOT posted when no tools ran", async () => {
    const h = harness({ verbosity: "concise" })
    h.push([
      { type: "turn_start" },
      { type: "text_delta", text: "hi" },
      { type: "text_complete", text: "hi" },
      { type: "turn_complete" },
    ])
    await drain(100)
    const summary = h.sends.find((s) => (s.text ?? "").includes("tool"))
    expect(summary).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Normal
// ---------------------------------------------------------------------------

describe("verbosity=normal", () => {
  it("emits a per-tool card (post → update) and the streamed text", async () => {
    const h = harness({ verbosity: "normal" })
    h.push(TOOL_TURN)
    await drain(100)

    const toolPost = h.sends.find((s) => s.kind === "post" && s.text === "Bash — running")
    const toolUpdate = h.sends.find((s) => s.kind === "update" && s.text === "Bash — done")
    expect(toolPost).toBeTruthy()
    expect(toolUpdate).toBeTruthy()
    // Tool card ts is reused between post + update (in-place edit).
    expect(toolUpdate!.ts).toBe(toolPost!.ts)

    // Streamed text lands (one post + one update for the stream).
    const textFinal = h.sends.filter((s) => s.text === "done")
    expect(textFinal.length).toBeGreaterThanOrEqual(1)
  })

  it("no cost footer when showCost is off (default)", async () => {
    const h = harness({ verbosity: "normal" })
    h.push(TOOL_TURN)
    await drain(100)
    const cost = h.sends.find((s) => (s.text ?? "").startsWith("cost:"))
    expect(cost).toBeUndefined()
  })

  it("posts a one-line cost footer when showCost=true", async () => {
    const h = harness({ verbosity: "normal", showCost: true })
    h.push(TOOL_TURN)
    await drain(100)
    const cost = h.sends.find((s) => (s.text ?? "").startsWith("cost:"))
    expect(cost).toBeTruthy()
    expect(cost!.text).toContain("$0.0100")
  })
})

// ---------------------------------------------------------------------------
// Verbose
// ---------------------------------------------------------------------------

describe("verbosity=verbose", () => {
  it("emits a per-tool card, a thinking block, and a detailed cost footer when enabled", async () => {
    const h = harness({ verbosity: "verbose", showCost: true })
    h.push([
      { type: "turn_start" },
      { type: "thinking_delta", text: "Let me consider this" },
      { type: "tool_use_start", id: "u1", tool: "Bash", input: { command: "ls" } },
      { type: "tool_use_end", id: "u1", output: "ok" },
      { type: "text_delta", text: "done" },
      { type: "text_complete", text: "done" },
      {
        type: "turn_complete",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
          totalCostUsd: 0.0123,
        },
      },
    ])
    await drain(120)
    const thinking = h.sends.find((s) => s.text === "thinking…")
    expect(thinking).toBeTruthy()

    const toolPost = h.sends.find((s) => s.text === "Bash — running")
    expect(toolPost).toBeTruthy()

    const cost = h.sends.find((s) => (s.text ?? "").startsWith("cost:"))
    expect(cost).toBeTruthy()
    // verbose-level cost includes a breakdown in parens.
    expect(cost!.text).toContain("in 100")
    expect(cost!.text).toContain("out 50")
    expect(cost!.text).toContain("cache-r 20")
    expect(cost!.text).toContain("cache-w 10")
  })

  it("thinking block is updated in place across bursts of deltas", async () => {
    const h = harness({ verbosity: "verbose" })
    h.push([
      { type: "turn_start" },
      { type: "thinking_delta", text: "first " },
    ])
    await drain(60)
    h.push([{ type: "thinking_delta", text: "second " }])
    // We deliberately wait long enough for the throttle (250ms) to elapse.
    await drain(350)
    h.push([{ type: "thinking_delta", text: "third" }, { type: "turn_complete" }])
    await drain(120)
    const thinkingMessages = h.sends.filter((s) => s.text === "thinking…")
    const posts = thinkingMessages.filter((s) => s.kind === "post")
    // Exactly one "post" — further deltas update in place.
    expect(posts.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

describe("plan_update → checklist block (any verbosity ≥ concise)", () => {
  it("posts once, updates in place on subsequent plan_updates", async () => {
    const h = harness({ verbosity: "normal" })
    h.push([
      { type: "turn_start" },
      {
        type: "plan_update",
        entries: [
          { content: "Read", status: "in_progress" },
          { content: "Write", status: "pending" },
        ],
      },
    ])
    await drain(60)
    h.push([
      {
        type: "plan_update",
        entries: [
          { content: "Read", status: "completed" },
          { content: "Write", status: "in_progress" },
        ],
      },
    ])
    await drain(60)
    h.push([{ type: "turn_complete" }])
    await drain(60)

    const planPosts = h.sends.filter((s) => s.kind === "post" && (s.text ?? "").includes("plan:"))
    const planUpdates = h.sends.filter((s) => s.kind === "update" && (s.text ?? "").includes("plan:"))
    expect(planPosts).toHaveLength(1)
    expect(planUpdates.length).toBeGreaterThanOrEqual(1)
    expect(planUpdates.at(-1)!.text).toContain("1/2")
  })

  it("plan is silent at silent verbosity", async () => {
    const h = harness({ verbosity: "silent" })
    h.push([
      { type: "turn_start" },
      {
        type: "plan_update",
        entries: [{ content: "x", status: "pending" }],
      },
      { type: "turn_complete" },
    ])
    await drain(60)
    expect(h.sends).toHaveLength(0)
  })
})
