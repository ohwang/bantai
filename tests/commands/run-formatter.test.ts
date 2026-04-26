import { describe, expect, it } from "bun:test"
import {
  createTextSegmentSeparator,
  formatHeadlessEvent,
} from "../../src/cli/commands/run"
import type { ConversationEvent } from "../../src/protocol/types"

/**
 * Headless transcript formatter — guards the case where the agent emits
 * multiple text segments interleaved by tool calls. Without a separator the
 * segments concatenate ("...regarded.Keng Eng Kee..."), which we hit in
 * `bantai run --backend gemini "..."` against tool-using turns.
 */
describe("run formatter — text segment separator", () => {
  function render(events: ConversationEvent[]): string {
    const sep = createTextSegmentSeparator()
    let out = ""
    for (const event of events) {
      const piece = formatHeadlessEvent(event, sep)
      if (piece !== null) out += piece
    }
    return out
  }

  it("inserts \\n\\n between text segments separated by a tool call", () => {
    const out = render([
      { type: "text_delta", text: "I will search for reviews." },
      { type: "tool_use_start", id: "t1", tool: "google_search", input: {} },
      { type: "text_delta", text: "Keng Eng Kee remains a powerhouse." },
    ])
    expect(out).toBe("I will search for reviews.\n\nKeng Eng Kee remains a powerhouse.")
  })

  it("does not insert a separator between consecutive text deltas (one paragraph)", () => {
    const out = render([
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "world." },
    ])
    expect(out).toBe("Hello world.")
  })

  it("does not insert a leading separator when a tool runs before any text", () => {
    const out = render([
      { type: "tool_use_start", id: "t1", tool: "google_search", input: {} },
      { type: "text_delta", text: "First line." },
    ])
    expect(out).toBe("First line.")
  })

  it("collapses multiple consecutive tool calls into a single separator", () => {
    const out = render([
      { type: "text_delta", text: "Looking up." },
      { type: "tool_use_start", id: "t1", tool: "google_search", input: {} },
      { type: "tool_use_start", id: "t2", tool: "google_search", input: {} },
      { type: "text_delta", text: "Done." },
    ])
    expect(out).toBe("Looking up.\n\nDone.")
  })

  it("handles text → tool → text → tool → text correctly", () => {
    const out = render([
      { type: "text_delta", text: "A" },
      { type: "tool_use_start", id: "t1", tool: "x", input: {} },
      { type: "text_delta", text: "B" },
      { type: "tool_use_start", id: "t2", tool: "x", input: {} },
      { type: "text_delta", text: "C" },
    ])
    expect(out).toBe("A\n\nB\n\nC")
  })

  it("ignores tool calls when no text follows", () => {
    const out = render([
      { type: "text_delta", text: "Final." },
      { type: "tool_use_start", id: "t1", tool: "x", input: {} },
    ])
    expect(out).toBe("Final.")
  })

  it("ignores unrelated events (no output, no separator)", () => {
    const out = render([
      { type: "text_delta", text: "A" },
      { type: "thinking_delta", text: "hidden" },
      { type: "text_delta", text: "B" },
    ])
    expect(out).toBe("AB")
  })
})
