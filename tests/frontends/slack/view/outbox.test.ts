import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  createOutboundStream,
  type NativeStreamCapability,
  type NativeStreamHandle,
  type OutboundIdentity,
  type SendAdapter,
} from "../../../../src/frontends/slack/view/outbox"

interface Call {
  kind: "post" | "update"
  channel: string
  text: string
  threadTs?: string
  ts?: string
  identity?: OutboundIdentity
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
        ...(args.identity ? { identity: args.identity } : {}),
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

describe("createOutboundStream — tier-1 native streaming", () => {
  interface NativeState {
    appends: string[]
    stops: Array<string | undefined>
    startCalls: number
  }

  function makeNative(opts: {
    failStart?: boolean
    failAppendAt?: number
    failStop?: boolean
  } = {}): {
    capability: NativeStreamCapability
    state: NativeState
  } {
    const state: NativeState = {
      appends: [],
      stops: [],
      startCalls: 0,
    }
    const capability: NativeStreamCapability = {
      async start() {
        state.startCalls++
        if (opts.failStart) throw new Error("native start refused")
        let appendCount = 0
        const handle: NativeStreamHandle = {
          async append(text) {
            appendCount++
            if (
              opts.failAppendAt !== undefined &&
              appendCount === opts.failAppendAt
            ) {
              throw new Error(`native append failed at ${appendCount}`)
            }
            state.appends.push(text)
          },
          async stop(finalText) {
            if (opts.failStop) throw new Error("native stop failed")
            state.stops.push(finalText)
          },
        }
        return handle
      },
    }
    return { capability, state }
  }

  it("prefers native streaming when the capability is provided", async () => {
    const { adapter, calls } = createFakeAdapter()
    const native = makeNative()
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      nativeStream: native.capability,
    })
    stream.append("hello ")
    await drain()
    stream.append("world")
    await drain()
    await stream.stop()
    expect(native.state.startCalls).toBe(1)
    // First append kicks off the stream with the initial text; the second
    // append forwards only the delta.
    expect(native.state.appends.join("")).toContain("world")
    // Adapter (tier-2) should never be called.
    expect(calls).toHaveLength(0)
  })

  it("falls back to tier-2 when native start throws", async () => {
    const { adapter, calls } = createFakeAdapter()
    const native = makeNative({ failStart: true })
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      nativeStream: native.capability,
    })
    stream.append("draft text")
    await drain()
    await stream.stop("final text")
    // Tier-2 took over — we expect at least one postMessage.
    expect(calls.some((c) => c.kind === "post")).toBe(true)
    // And native.stop() must not have been called since start never
    // succeeded.
    expect(native.state.stops).toHaveLength(0)
  })

  it("follow-up Block Kit payload posts as a separate message when native stream succeeds", async () => {
    const { adapter, calls } = createFakeAdapter()
    const native = makeNative()
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      nativeStream: native.capability,
    })
    stream.append("body")
    await drain()
    await stream.stop("body", [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Go" },
            action_id: "x",
          },
        ],
      },
    ])
    // Native stream stopped, and blocks rode on a follow-up post.
    expect(native.state.stops).toHaveLength(1)
    expect(calls.filter((c) => c.kind === "post")).toHaveLength(1)
  })
})

describe("createOutboundStream — identity forwarding", () => {
  const identity: OutboundIdentity = {
    username: "Reviewer",
    iconEmoji: ":robot_face:",
  }

  it("forwards identity on the tier-2 draft post", async () => {
    const { adapter, calls } = createFakeAdapter()
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      identity,
    })
    stream.append("hello")
    await drain()
    await stream.stop("hello")
    const firstPost = calls.find((c) => c.kind === "post")!
    expect(firstPost.identity).toEqual(identity)
  })

  it("forwards identity on tier-3 fallback chunks", async () => {
    // First post throws → fallback → stop() reposts via tier-3.
    const { adapter, calls } = createFakeAdapter({ failPostAt: 1 })
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      identity,
    })
    stream.append("the full body of this reply")
    await drain()
    await stream.stop("the full body of this reply")
    const fallbackPosts = calls.filter((c) => c.kind === "post")
    expect(fallbackPosts.length).toBeGreaterThanOrEqual(1)
    for (const p of fallbackPosts) {
      expect(p.identity).toEqual(identity)
    }
  })

  it("forwards identity on the native-stream Block Kit follow-up", async () => {
    const { adapter, calls } = createFakeAdapter()
    const native: NativeStreamCapability = {
      async start() {
        return {
          async append() {},
          async stop() {},
        }
      },
    }
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      nativeStream: native,
      identity,
    })
    stream.append("body")
    await drain()
    await stream.stop("body", [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Go" },
            action_id: "x",
          },
        ],
      },
    ])
    const followup = calls.find((c) => c.kind === "post")!
    expect(followup.identity).toEqual(identity)
  })

  it("is absent when no identity was supplied (no accidental defaults)", async () => {
    const { adapter, calls } = createFakeAdapter()
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
    })
    stream.append("hello")
    await drain()
    await stream.stop("hello")
    for (const c of calls) {
      expect(c.identity).toBeUndefined()
    }
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

describe("createOutboundStream — markdown → mrkdwn conversion", () => {
  it("converts markdown in the initial draft post", async () => {
    const { adapter, calls } = createFakeAdapter()
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
    })
    stream.append("**bold** and _italic_")
    await drain()
    const draft = calls.find((c) => c.kind === "post")!
    expect(draft.text).toBe("*bold* and _italic_")
  })

  it("converts markdown in throttled intermediate updates", async () => {
    const { adapter, calls } = createFakeAdapter()
    let t = 0
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      minUpdateMs: 50,
      now: () => t,
    })
    stream.append("**bold**")
    await drain()
    t = 60
    stream.append(" more")
    await drain(60)
    const update = calls.find((c) => c.kind === "update")!
    expect(update.text).toBe("*bold* more")
    await stream.stop()
  })

  it("converts markdown in the tier-2 final stop update", async () => {
    const { adapter, calls } = createFakeAdapter()
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
    })
    stream.append("# Heading\n\n- item one\n- item two")
    await drain()
    await stream.stop()
    const finalCall = calls.at(-1)!
    expect(finalCall.text).toBe("*Heading*\n\n• item one\n• item two")
  })

  it("flushes overflow as extra postMessage chunks at stop() (tier-2)", async () => {
    // maxChunkLen=50, accumulator will exceed it so stop() must post overflow
    const { adapter, calls } = createFakeAdapter()
    const para1 = "First paragraph that fits in the first chunk easily."
    const para2 = "Second paragraph that lands in the overflow chunk."
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      maxChunkLen: 55,
    })
    stream.append(para1 + "\n\n" + para2)
    await drain()
    await stream.stop()
    // The draft post carries the head (truncated) during streaming; the
    // final stop() should update it with chunk-1 and post chunk-2 onwards.
    const postCalls = calls.filter((c) => c.kind === "post")
    const updateCalls = calls.filter((c) => c.kind === "update")
    // At least the draft post + final update on the draft, plus ≥1 overflow post.
    expect(postCalls.length).toBeGreaterThanOrEqual(2) // draft + overflow
    expect(updateCalls.length).toBeGreaterThanOrEqual(1)
    const allText = [...updateCalls, ...postCalls].map((c) => c.text).join("\n\n")
    expect(allText).toContain("First paragraph")
    expect(allText).toContain("Second paragraph")
  })

  it("overflow chunks inherit identity when set", async () => {
    const para1 = "First paragraph that fits in the first chunk here."
    const para2 = "Second paragraph that lands in overflow."
    const id: OutboundIdentity = { username: "Bot", iconEmoji: ":robot_face:" }
    const { adapter, calls } = createFakeAdapter()
    const stream = createOutboundStream({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      maxChunkLen: 55,
      identity: id,
    })
    stream.append(para1 + "\n\n" + para2)
    await drain()
    await stream.stop()
    // Every postMessage (draft + overflow) should carry the identity.
    const posts = calls.filter((c) => c.kind === "post")
    expect(posts.length).toBeGreaterThanOrEqual(2)
    for (const p of posts) {
      expect(p.identity).toEqual(id)
    }
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
