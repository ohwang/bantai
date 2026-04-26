import { describe, expect, it } from "bun:test"
import { createRunFormatter, type RunFormatter } from "../../src/cli/commands/run"
import type { ConversationEvent } from "../../src/protocol/types"

/**
 * Headless transcript formatter — exercises every `--output-format` mode of
 * `bantai run`. The fix that motivated this suite: when the agent emits
 * multiple text segments interleaved by tool calls (e.g. Gemini search:
 * "I will search…" → google_search → "Keng Eng Kee remains…"), the
 * `stream-text` mode must insert `\n\n` between segments. Same scenario in
 * `text` mode must drop the intermediate "I will search…" and emit only the
 * final segment, mirroring `claude -p`.
 */

function drive(formatter: RunFormatter, events: ConversationEvent[]): string {
  let out = ""
  for (const event of events) {
    const piece = formatter.onEvent(event)
    if (piece !== null) out += piece
  }
  const tail = formatter.onComplete()
  if (tail !== null) out += tail
  return out
}

const TURN_COMPLETE: ConversationEvent = { type: "turn_complete" }

const TOOL_START: ConversationEvent = {
  type: "tool_use_start",
  id: "t1",
  tool: "google_search",
  input: {},
}

describe("stream-text format (default)", () => {
  it("inserts \\n\\n between text segments separated by a tool call", () => {
    const out = drive(createRunFormatter("stream-text"), [
      { type: "text_delta", text: "I will search for reviews." },
      TOOL_START,
      { type: "text_delta", text: "Keng Eng Kee remains a powerhouse." },
      TURN_COMPLETE,
    ])
    expect(out).toBe(
      "I will search for reviews.\n\nKeng Eng Kee remains a powerhouse.\n",
    )
  })

  it("does not separate consecutive text deltas (single paragraph)", () => {
    const out = drive(createRunFormatter("stream-text"), [
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "world." },
      TURN_COMPLETE,
    ])
    expect(out).toBe("Hello world.\n")
  })

  it("does not write a leading separator when a tool runs before any text", () => {
    const out = drive(createRunFormatter("stream-text"), [
      TOOL_START,
      { type: "text_delta", text: "First line." },
      TURN_COMPLETE,
    ])
    expect(out).toBe("First line.\n")
  })

  it("collapses multiple consecutive tool calls into a single separator", () => {
    const out = drive(createRunFormatter("stream-text"), [
      { type: "text_delta", text: "Looking up." },
      TOOL_START,
      { type: "tool_use_start", id: "t2", tool: "x", input: {} },
      { type: "text_delta", text: "Done." },
      TURN_COMPLETE,
    ])
    expect(out).toBe("Looking up.\n\nDone.\n")
  })

  it("handles text → tool → text → tool → text", () => {
    const out = drive(createRunFormatter("stream-text"), [
      { type: "text_delta", text: "A" },
      TOOL_START,
      { type: "text_delta", text: "B" },
      { type: "tool_use_start", id: "t2", tool: "x", input: {} },
      { type: "text_delta", text: "C" },
      TURN_COMPLETE,
    ])
    expect(out).toBe("A\n\nB\n\nC\n")
  })

  it("ignores trailing tool calls when no text follows", () => {
    const out = drive(createRunFormatter("stream-text"), [
      { type: "text_delta", text: "Final." },
      TOOL_START,
      TURN_COMPLETE,
    ])
    expect(out).toBe("Final.\n")
  })

  it("ignores unrelated events (no output, no separator)", () => {
    const out = drive(createRunFormatter("stream-text"), [
      { type: "text_delta", text: "A" },
      { type: "thinking_delta", text: "hidden" },
      { type: "text_delta", text: "B" },
      TURN_COMPLETE,
    ])
    expect(out).toBe("AB\n")
  })
})

describe("text format (final-only, claude -p style)", () => {
  it("drops intermediate text segments separated by a tool call", () => {
    const out = drive(createRunFormatter("text"), [
      { type: "text_delta", text: "I will search for reviews." },
      TOOL_START,
      { type: "text_delta", text: "Keng Eng Kee remains a powerhouse." },
      TURN_COMPLETE,
    ])
    expect(out).toBe("Keng Eng Kee remains a powerhouse.\n")
  })

  it("emits only the last segment when multiple tool calls precede final text", () => {
    const out = drive(createRunFormatter("text"), [
      { type: "text_delta", text: "intermediate A" },
      TOOL_START,
      { type: "text_delta", text: "intermediate B" },
      { type: "tool_use_start", id: "t2", tool: "x", input: {} },
      { type: "text_delta", text: "final answer" },
      TURN_COMPLETE,
    ])
    expect(out).toBe("final answer\n")
  })

  it("emits an empty line when the turn ended on a tool call (no final text)", () => {
    const out = drive(createRunFormatter("text"), [
      { type: "text_delta", text: "intermediate" },
      TOOL_START,
      TURN_COMPLETE,
    ])
    expect(out).toBe("\n")
  })

  it("emits the buffered text when no tool call ever fires", () => {
    const out = drive(createRunFormatter("text"), [
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "world." },
      TURN_COMPLETE,
    ])
    expect(out).toBe("Hello world.\n")
  })
})

describe("json format (single array dump)", () => {
  it("emits a single newline-terminated JSON array on completion", () => {
    const events: ConversationEvent[] = [
      { type: "session_init", tools: [], models: [] },
      { type: "text_delta", text: "hi" },
      TOOL_START,
      { type: "text_delta", text: "done" },
      TURN_COMPLETE,
    ]
    const out = drive(createRunFormatter("json"), events)
    expect(out.endsWith("\n")).toBe(true)
    const parsed = JSON.parse(out)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toEqual(events)
  })

  it("writes nothing live — output is empty until completion", () => {
    const formatter = createRunFormatter("json")
    expect(formatter.onEvent({ type: "text_delta", text: "hi" })).toBeNull()
    expect(formatter.onEvent(TOOL_START)).toBeNull()
    expect(formatter.onEvent(TURN_COMPLETE)).toBeNull()
    const tail = formatter.onComplete()
    expect(tail).not.toBeNull()
    expect(JSON.parse(tail!).length).toBe(3)
  })
})

describe("stream-json format (NDJSON live)", () => {
  it("emits one JSON object per line, one per event", () => {
    const events: ConversationEvent[] = [
      { type: "text_delta", text: "hi" },
      TOOL_START,
      { type: "text_delta", text: "done" },
      TURN_COMPLETE,
    ]
    const out = drive(createRunFormatter("stream-json"), events)
    const lines = out.trimEnd().split("\n")
    expect(lines).toHaveLength(events.length)
    for (let i = 0; i < lines.length; i++) {
      expect(JSON.parse(lines[i]!)).toEqual(events[i]!)
    }
  })

  it("returns null from onComplete (no trailing flush)", () => {
    const formatter = createRunFormatter("stream-json")
    formatter.onEvent({ type: "text_delta", text: "hi" })
    expect(formatter.onComplete()).toBeNull()
  })
})
