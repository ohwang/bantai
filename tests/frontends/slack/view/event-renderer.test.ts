import { describe, expect, it } from "bun:test"
import type { App } from "@slack/bolt"
import type { ConversationEvent } from "../../../../src/protocol/types"
import { createEventRenderer } from "../../../../src/frontends/slack/view/event-renderer"
import type { SendAdapter } from "../../../../src/frontends/slack/view/outbox"
import type { ReactionAdapter } from "../../../../src/frontends/slack/view/reactions"

function makeStubApp(): App {
  return {} as App
}

function harness(triggerTs?: string) {
  interface Send {
    kind: "post" | "update"
    channel: string
    text: string
    ts?: string
    threadTs?: string
  }
  interface React {
    op: "add" | "remove"
    name: string
  }
  const sends: Send[] = []
  const reacts: React[] = []
  let counter = 0
  const sendAdapter: SendAdapter = {
    async postMessage(args) {
      counter++
      sends.push({
        kind: "post",
        channel: args.channel,
        text: args.text,
        threadTs: args.threadTs,
      })
      return { ts: `ts${counter}`, channel: args.channel }
    },
    async updateMessage(args) {
      sends.push({ kind: "update", channel: args.channel, text: args.text, ts: args.ts })
    },
  }
  const reactionAdapter: ReactionAdapter = {
    async addReaction(args) {
      reacts.push({ op: "add", name: args.name })
    },
    async removeReaction(args) {
      reacts.push({ op: "remove", name: args.name })
    },
  }
  const renderer = createEventRenderer({
    app: makeStubApp(),
    binding: { channel: "C01", threadTs: "100.001", triggerTs },
    sendAdapter,
    reactionAdapter,
  })
  function push(events: ConversationEvent[]) {
    for (const e of events) renderer.onEvent(e)
  }
  return { renderer, sends, reacts, push }
}

async function drain(ms = 40) {
  await new Promise((r) => setTimeout(r, ms))
}

describe("event-renderer — streaming", () => {
  it("posts a draft on first text_delta and finalises on turn_complete", async () => {
    const h = harness("t1")
    h.push([
      { type: "turn_start" },
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: ", world!" },
      { type: "text_complete", text: "Hello, world!" },
      { type: "turn_complete" },
    ])
    await drain()
    // At least one post and one update, ending with the canonical text.
    expect(h.sends.some((s) => s.kind === "post")).toBe(true)
    const lastText = h.sends.at(-1)!.text
    expect(lastText).toBe("Hello, world!")
  })

  it("text stream does not post when the turn emits no text (tool-only turn)", async () => {
    const h = harness("t1")
    h.push([
      { type: "turn_start" },
      { type: "tool_use_start", id: "1", tool: "Read", input: {} },
      { type: "tool_use_end", id: "1", output: "..." },
      { type: "turn_complete" },
    ])
    await drain()
    // Nothing that looks like streamed assistant text — tool cards have a
    // "Tool — done/running" text fallback, never "...".
    const streamed = h.sends.filter((s) => s.text === "..." || s.text === "…")
    expect(streamed.length).toBe(0)
  })
})

describe("event-renderer — reactions", () => {
  it("transitions queued-style emojis through the turn", async () => {
    const h = harness("t1")
    h.push([
      { type: "turn_start" },
      { type: "tool_use_start", id: "1", tool: "Read", input: {} },
      { type: "text_delta", text: "result" },
      { type: "text_complete", text: "result" },
      { type: "turn_complete" },
    ])
    await drain(100)
    const adds = h.reacts.filter((r) => r.op === "add").map((r) => r.name)
    // initial: working (primed on construct). Then tool_use_start → reading.
    // turn_complete → done. text_delta keeps the reading state.
    expect(adds).toEqual(["cyclone", "eyes", "white_check_mark"])
  })

  it("omits reactions entirely when no triggerTs is provided", async () => {
    const h = harness(undefined)
    h.push([{ type: "turn_start" }, { type: "turn_complete" }])
    await drain()
    expect(h.reacts).toEqual([])
  })
})

describe("event-renderer — errors", () => {
  it("posts a recoverable error inline and keeps running", async () => {
    const h = harness("t1")
    h.push([
      { type: "turn_start" },
      {
        type: "error",
        code: "flaky",
        message: "transient",
        severity: "recoverable",
      },
      { type: "text_delta", text: "recovered" },
      { type: "text_complete", text: "recovered" },
      { type: "turn_complete" },
    ])
    await drain(100)
    // One post for the error line, then post+update for the streamed text.
    const errorPost = h.sends.find((s) => s.text.startsWith("[warn]"))
    expect(errorPost).toBeTruthy()
    const finalText = h.sends.at(-1)?.text
    expect(finalText).toBe("recovered")
  })

  it("fatal errors post an [error] line and finish the turn", async () => {
    const h = harness("t1")
    h.push([
      { type: "turn_start" },
      {
        type: "error",
        code: "rate_limited",
        message: "slow down",
        severity: "fatal",
      },
    ])
    await drain(100)
    expect(h.sends[0]?.text).toMatch(/^\[error\] rate_limited: slow down/)
    // Reaction ends at error state.
    const adds = h.reacts.filter((r) => r.op === "add").map((r) => r.name)
    expect(adds.at(-1)).toBe("x")
  })
})
