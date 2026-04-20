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
        text: args.markdownText ?? args.text ?? "",
        threadTs: args.threadTs,
      })
      return { ts: `ts${counter}`, channel: args.channel }
    },
    async updateMessage(args) {
      sends.push({
        kind: "update",
        channel: args.channel,
        text: args.markdownText ?? args.text ?? "",
        ts: args.ts,
      })
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
  it("collapses a synchronous event batch to speech_balloon → round_pushpin", async () => {
    // All events land in the same 16ms EventBatcher window. The reaction
    // controller coalesces them into at most two API adds: the initial
    // :speech_balloon: (agent working) and the :round_pushpin: that lands
    // on turn_complete (agent idle, ball back in user's court). Tool /
    // text events are intentionally silent — intermediate reactions used
    // to burn through the Slack rate limit on long turns. :white_check_mark:
    // is never emitted by the bot (reserved for humans).
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
    const removes = h.reacts.filter((r) => r.op === "remove").map((r) => r.name)
    expect(adds).toEqual(["speech_balloon", "round_pushpin"])
    expect(removes).toEqual(["speech_balloon"])
    expect(h.reacts.some((r) => r.name === "white_check_mark")).toBe(false)
  })

  it("omits reactions entirely when no triggerTs is provided", async () => {
    const h = harness(undefined)
    h.push([{ type: "turn_start" }, { type: "turn_complete" }])
    await drain()
    expect(h.reacts).toEqual([])
  })

  it("pins reactions to a single ts across multiple turns in the same thread", async () => {
    // Regression guard: prior behaviour recreated the reaction controller
    // per turn and rebound it to whichever user message triggered the
    // turn. That left :round_pushpin: stacked on the previous message(s)
    // while a fresh :speech_balloon: landed on the new one. The fix pins
    // the reaction to the thread root for the renderer's whole lifetime,
    // so every add/remove call in this test targets exactly one ts.
    const THREAD_ROOT = "thread_root_ts"
    const seen = new Set<string>()
    const reacts: Array<{ op: "add" | "remove"; name: string; ts: string }> = []
    const sendAdapter: SendAdapter = {
      async postMessage(args) {
        return { ts: "draft-1", channel: args.channel }
      },
      async updateMessage() {},
    }
    const reactionAdapter: ReactionAdapter = {
      async addReaction(args) {
        seen.add(args.timestamp)
        reacts.push({ op: "add", name: args.name, ts: args.timestamp })
      },
      async removeReaction(args) {
        seen.add(args.timestamp)
        reacts.push({ op: "remove", name: args.name, ts: args.timestamp })
      },
    }
    const renderer = createEventRenderer({
      app: makeStubApp(),
      binding: { channel: "C01", threadTs: THREAD_ROOT, triggerTs: THREAD_ROOT },
      sendAdapter,
      reactionAdapter,
    })
    // Turn 1.
    renderer.onEvent({ type: "turn_start" } as ConversationEvent)
    renderer.onEvent({ type: "text_complete", text: "done 1" } as ConversationEvent)
    renderer.onEvent({ type: "turn_complete" } as ConversationEvent)
    await drain(100)
    // Turn 2.
    renderer.onEvent({ type: "turn_start" } as ConversationEvent)
    renderer.onEvent({ type: "text_complete", text: "done 2" } as ConversationEvent)
    renderer.onEvent({ type: "turn_complete" } as ConversationEvent)
    await drain(100)
    // Every reaction API call landed on THE SAME ts — the thread root.
    expect([...seen]).toEqual([THREAD_ROOT])
    for (const r of reacts) expect(r.ts).toBe(THREAD_ROOT)
    renderer.destroy()
  })

  it("flips :round_pushpin: → :speech_balloon: on the next turn_start", async () => {
    // Issue #2 regression guard: once a turn finished and left the thread
    // on :round_pushpin:, a subsequent user message must drive the emoji
    // back to :speech_balloon: for the working phase of the new turn.
    const h = harness("t1")
    // Turn 1 — primes :speech_balloon:, lands on :round_pushpin:.
    h.push([
      { type: "turn_start" },
      { type: "text_complete", text: "reply 1" },
      { type: "turn_complete" },
    ])
    await drain(80)
    const addsTurn1 = h.reacts.filter((r) => r.op === "add").map((r) => r.name)
    expect(addsTurn1).toEqual(["speech_balloon", "round_pushpin"])

    // Turn 2 — the controller lives on, so turn_start flips back to working
    // before landing on :round_pushpin: again at turn_complete.
    h.push([
      { type: "turn_start" },
      { type: "text_complete", text: "reply 2" },
      { type: "turn_complete" },
    ])
    await drain(80)
    const allAdds = h.reacts.filter((r) => r.op === "add").map((r) => r.name)
    const allRemoves = h.reacts.filter((r) => r.op === "remove").map((r) => r.name)
    expect(allAdds).toEqual([
      "speech_balloon",
      "round_pushpin",
      "speech_balloon",
      "round_pushpin",
    ])
    // Each 💬/📍 that comes after the prime removes its predecessor, so
    // the sequence of removes has length == adds - 1.
    expect(allRemoves).toEqual([
      "speech_balloon",
      "round_pushpin",
      "speech_balloon",
    ])
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
    // Fatal error surfaces as :octagonal_sign: — "session state compromised."
    const adds = h.reacts.filter((r) => r.op === "add").map((r) => r.name)
    expect(adds.at(-1)).toBe("octagonal_sign")
  })
})

describe("event-renderer — paragraph breaks across content-block boundaries", () => {
  // Regression: Claude's streaming API splits a single user-visible turn into
  // multiple content blocks (text → tool_use → text → …). Each text block is a
  // separate paragraph in the model's output, but the event stream delivers
  // them as two separate bursts of text_deltas with a tool_use_start /
  // tool_use_end pair in between. Prior to the fix, the renderer
  // concatenated every text_delta directly into the accumulator, collapsing
  // "first ending.\n\nSecond start" into "first ending.Second start" in the
  // final Slack message. These tests guard the text_delta→boundary→text_delta
  // path end-to-end (renderer + mrkdwn round-trip via the outbox).
  function primaryText(sends: Array<{ kind: "post" | "update"; text: string }>) {
    // Tool cards hit the adapter too — filter to the draft/update pair that
    // belongs to the streaming reply body. Tool cards carry "*Read*" or
    // similar; the reply draft is whatever landed as the final update.
    const updates = sends.filter((s) => s.kind === "update")
    return updates.at(-1)?.text ?? ""
  }

  it("injects a blank line between two text blocks separated by a tool call", async () => {
    const h = harness("t1")
    h.push([
      { type: "turn_start" },
      { type: "text_delta", text: "First paragraph ending:" },
      { type: "tool_use_start", id: "1", tool: "Read", input: {} },
      { type: "tool_use_end", id: "1", output: "ok" },
      { type: "text_delta", text: "Second paragraph after tool." },
      { type: "turn_complete" },
    ])
    await drain(100)
    const text = primaryText(h.sends)
    expect(text).toContain("First paragraph ending:")
    expect(text).toContain("Second paragraph after tool.")
    expect(text).toMatch(/First paragraph ending:\n\nSecond paragraph after tool\./)
  })

  it("injects a blank line between two text blocks separated by a mid-turn turn_start (agentic step)", async () => {
    // Claude's event-mapper emits turn_start per message_start — that is,
    // once per agentic step (think → act → observe). A user-visible turn
    // with two steps therefore looks like:
    //   turn_start, text_delta "A", …tool…, turn_start, text_delta "B", turn_complete
    // The second turn_start must force a paragraph break so "A" and "B"
    // don't glue together.
    const h = harness("t1")
    h.push([
      { type: "turn_start" },
      { type: "text_delta", text: "Step 1." },
      { type: "turn_start" },
      { type: "text_delta", text: "Step 2." },
      { type: "turn_complete" },
    ])
    await drain(100)
    expect(primaryText(h.sends)).toMatch(/Step 1\.\n\nStep 2\./)
  })

  it("does not inject anything before the first text_delta of a fresh turn", async () => {
    // Regression guard: turn_start sets the paragraph-break flag so that
    // mid-turn turn_starts work, but the FIRST turn_start of a user turn
    // starts with an empty accumulator — injection must be a no-op there.
    const h = harness("t1")
    h.push([
      { type: "turn_start" },
      { type: "text_delta", text: "Just one thing." },
      { type: "turn_complete" },
    ])
    await drain(100)
    const text = primaryText(h.sends)
    expect(text).toBe("Just one thing.")
    expect(text.startsWith("\n")).toBe(false)
  })

  it("does not insert extra blank lines between adjacent text_deltas in the same block", async () => {
    // Regression guard: the flag must clear on each text_delta so that
    // streaming deltas inside a single text block stay concatenated
    // verbatim — Claude splits a paragraph across many text_deltas during
    // streaming and injecting "\n\n" between them would shred sentences.
    const h = harness("t1")
    h.push([
      { type: "turn_start" },
      { type: "text_delta", text: "Hello, " },
      { type: "text_delta", text: "world! " },
      { type: "text_delta", text: "How are you?" },
      { type: "turn_complete" },
    ])
    await drain(100)
    expect(primaryText(h.sends)).toBe("Hello, world! How are you?")
  })

  it("does not leak the paragraph-break flag across turns", async () => {
    // A turn that ends on a tool_use_end leaves the flag set in a naive
    // implementation. endTurn must reset it so the first text_delta of
    // the NEXT turn doesn't come out prefixed by "\n\n".
    const h = harness("t1")
    h.push([
      { type: "turn_start" },
      { type: "text_delta", text: "prev turn's last word." },
      { type: "tool_use_start", id: "1", tool: "Read", input: {} },
      { type: "tool_use_end", id: "1", output: "ok" },
      { type: "turn_complete" },
    ])
    await drain(100)
    // Turn 2 starts fresh — its first text_delta should not be "\n\nNext"
    h.push([
      { type: "turn_start" },
      { type: "text_delta", text: "Next turn starts clean." },
      { type: "turn_complete" },
    ])
    await drain(100)
    const updates = h.sends.filter((s) => s.kind === "update")
    const last = updates.at(-1)?.text ?? ""
    expect(last).toBe("Next turn starts clean.")
  })

  it("injects a blank line when thinking splits two text blocks", async () => {
    // Interleaved thinking is surfaced in a separate Slack message, but
    // in the model's output it still separates two text blocks into two
    // paragraphs — so a text_delta after thinking_delta must still get
    // the break.
    const h = harness("t1")
    h.push([
      { type: "turn_start" },
      { type: "text_delta", text: "Before thinking." },
      { type: "thinking_delta", text: "…considering…" },
      { type: "text_delta", text: "After thinking." },
      { type: "turn_complete" },
    ])
    await drain(100)
    expect(primaryText(h.sends)).toMatch(/Before thinking\.\n\nAfter thinking\./)
  })
})
