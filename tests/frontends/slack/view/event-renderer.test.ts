import { describe, expect, it } from "bun:test"
import type { App } from "@slack/bolt"
import type { ConversationEvent } from "../../../../src/protocol/types"
import { createEventRenderer } from "../../../../src/frontends/slack/view/event-renderer"

function makeStubApp(): App {
  // The renderer never touches app.* when postMessage override is supplied.
  return {} as App
}

function harness() {
  const posts: Array<{ channel: string; text: string; threadTs?: string }> = []
  const renderer = createEventRenderer({
    app: makeStubApp(),
    binding: { channel: "C01", threadTs: "100.001" },
    postMessage: async (args) => {
      posts.push(args)
      return { ts: "200.000", channel: args.channel }
    },
  })
  function push(events: ConversationEvent[]) {
    for (const e of events) renderer.onEvent(e)
  }
  return { renderer, posts, push }
}

async function drain(ms = 25) {
  await new Promise((r) => setTimeout(r, ms))
}

describe("event-renderer at S1 verbosity", () => {
  it("posts assistant text once on turn_complete", async () => {
    const h = harness()
    h.push([
      { type: "turn_start" },
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: ", world!" },
      { type: "text_complete", text: "Hello, world!" },
      { type: "turn_complete" },
    ])
    await drain()
    expect(h.posts).toEqual([
      { channel: "C01", threadTs: "100.001", text: "Hello, world!" },
    ])
  })

  it("prefers text_complete over accumulated deltas (defensive)", async () => {
    const h = harness()
    h.push([
      { type: "turn_start" },
      { type: "text_delta", text: "par" },
      { type: "text_delta", text: "tial" },
      { type: "text_complete", text: "CANONICAL" },
      { type: "turn_complete" },
    ])
    await drain()
    expect(h.posts[0]?.text).toBe("CANONICAL")
  })

  it("skips empty-body turns silently", async () => {
    const h = harness()
    h.push([{ type: "turn_start" }, { type: "turn_complete" }])
    await drain()
    expect(h.posts.length).toBe(0)
  })

  it("posts a fatal error as an [error] message", async () => {
    const h = harness()
    h.push([
      {
        type: "error",
        code: "rate_limited",
        message: "Slow down",
        severity: "fatal",
      },
    ])
    await drain()
    expect(h.posts.length).toBe(1)
    expect(h.posts[0]?.text).toMatch(/\[error\] rate_limited: Slow down/)
  })

  it("posts a recoverable error with a warn prefix", async () => {
    const h = harness()
    h.push([
      {
        type: "error",
        code: "flaky_thing",
        message: "transient",
        severity: "recoverable",
      },
    ])
    await drain()
    expect(h.posts[0]?.text).toMatch(/^\[warn\] flaky_thing: transient/)
  })

  it("resets assistant buffer between turns", async () => {
    const h = harness()
    h.push([
      { type: "turn_start" },
      { type: "text_complete", text: "first" },
      { type: "turn_complete" },
    ])
    h.push([
      { type: "turn_start" },
      { type: "text_complete", text: "second" },
      { type: "turn_complete" },
    ])
    await drain(50)
    expect(h.posts.map((p) => p.text)).toEqual(["first", "second"])
  })
})
