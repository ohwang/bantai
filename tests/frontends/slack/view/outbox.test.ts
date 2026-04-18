import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createOutboundStream, type SendAdapter } from "../../../../src/frontends/slack/view/outbox"

interface Call {
  kind: "post" | "update"
  channel: string
  text: string
  threadTs?: string
  ts?: string
}

function createFakeAdapter(opts: { failPostAt?: number; failUpdateAt?: number } = {}): {
  adapter: SendAdapter
  calls: Call[]
  tsCounter: { n: number }
} {
  const calls: Call[] = []
  const counter = { n: 0 }
  const adapter: SendAdapter = {
    async postMessage(args) {
      counter.n++
      if (opts.failPostAt !== undefined && counter.n === opts.failPostAt) {
        throw new Error(`simulated post failure on call ${counter.n}`)
      }
      calls.push({
        kind: "post",
        channel: args.channel,
        text: args.text,
        threadTs: args.threadTs,
      })
      return { ts: `ts${counter.n}`, channel: args.channel }
    },
    async updateMessage(args) {
      counter.n++
      if (opts.failUpdateAt !== undefined && counter.n === opts.failUpdateAt) {
        throw new Error(`simulated update failure on call ${counter.n}`)
      }
      calls.push({
        kind: "update",
        channel: args.channel,
        ts: args.ts,
        text: args.text,
      })
    },
  }
  return { adapter, calls, tsCounter: counter }
}

describe("createOutboundStream — tier-2 happy path", () => {
  it("posts a draft then updates once per minUpdateMs window", async () => {
    const { adapter, calls } = createFakeAdapter()
    let t = 0
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      minUpdateMs: 100,
      now: () => t,
    })

    stream.append("Hello")
    await drain()
    // First append → draft post.
    expect(calls.length).toBe(1)
    expect(calls[0]?.kind).toBe("post")
    expect(calls[0]?.text).toBe("Hello")

    // Within 100ms, appends should be throttled.
    t = 50
    stream.append(", world")
    await drain(50)
    // Throttled update fires after minUpdateMs - elapsed = 50ms.
    t = 110
    await drain(60)
    expect(calls.at(-1)?.kind).toBe("update")
    expect(calls.at(-1)?.text).toBe("Hello, world")

    // Stop with a canonical final text.
    t = 200
    await stream.stop("Hello, world!")
    expect(calls.at(-1)?.text).toBe("Hello, world!")
    expect(calls.at(-1)?.kind).toBe("update")
  })

  it("draft post uses a placeholder when append text arrives empty-first", async () => {
    const { adapter, calls } = createFakeAdapter()
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
    })
    await stream.stop()
    // Even with no append calls, stop() posts at least once.
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const last = calls.at(-1)!
    expect(last.kind).toMatch(/post|update/)
  })

  it("final stop(finalText) replaces the accumulator", async () => {
    const { adapter, calls } = createFakeAdapter()
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      minUpdateMs: 100,
    })
    stream.append("Hello")
    await drain()
    await stream.stop("CANONICAL FINAL")
    expect(calls.at(-1)?.text).toBe("CANONICAL FINAL")
  })
})

describe("createOutboundStream — tier-3 fallback", () => {
  it("falls back when the initial draft post throws", async () => {
    const { adapter, calls } = createFakeAdapter({ failPostAt: 1 })
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
    })
    stream.append("this is the agent's only real reply")
    await drain()
    await stream.stop("this is the agent's only real reply")
    expect(stream.fellBack()).toBe(true)
    // Tier-3 posts the full text as one or more fresh chat.postMessage calls.
    const postCalls = calls.filter((c) => c.kind === "post")
    expect(postCalls.length).toBeGreaterThanOrEqual(1)
    const joined = postCalls.map((c) => c.text).join("")
    expect(joined).toContain("agent's only real reply")
  })

  it("falls back when an update throws mid-stream", async () => {
    const { adapter, calls } = createFakeAdapter({ failUpdateAt: 3 })
    // Call 1 = draft post (ok). Call 2 = update (ok). Call 3 = update (fails).
    let t = 0
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      minUpdateMs: 10,
      now: () => t,
    })
    stream.append("A")
    await drain()
    t = 20
    stream.append("B")
    await drain(20)
    t = 40
    stream.append("C")
    await drain(20)
    t = 60
    await stream.stop("A" + "B" + "C")
    expect(stream.fellBack()).toBe(true)
    // After fallback, stop() reposts the full text as a new message.
    const postTexts = calls.filter((c) => c.kind === "post").map((c) => c.text)
    expect(postTexts.some((t) => t === "ABC")).toBe(true)
  })
})

describe("createOutboundStream — currentText", () => {
  it("exposes the running accumulator", async () => {
    const { adapter } = createFakeAdapter()
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
    })
    stream.append("one ")
    stream.append("two ")
    stream.append("three")
    expect(stream.currentText()).toBe("one two three")
    await stream.stop()
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function drain(ms = 20) {
  await new Promise((r) => setTimeout(r, ms))
}

// Silence Bun's test cleanup noise for the sleeps above.
beforeEach(() => void 0)
afterEach(() => void 0)
