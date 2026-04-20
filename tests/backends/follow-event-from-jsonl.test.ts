/**
 * Tests for the follow backend's JSONL → AgentEvent translator.
 *
 * Verifies the rule table from team/bantai-follow-tui.md §Architecture:
 *   - user text  → turn_start + user_message
 *   - assistant text → text_complete + turn_complete(usage)
 *   - assistant thinking (no text) → thinking_delta + turn_complete
 *   - tool pairing: assistant tool_use → start; subsequent tool_result → end
 *   - synthetic (compaction) → compact event
 *   - synthetic (slash marker / local-command) → skipped (debug log)
 *   - unknown block type → skipped + log.warn
 *   - unmatched tool_result → skipped + log.warn
 *   - message.usage → plumbed into turn_complete.usage
 *
 * We do not assert on log output directly — those are behavioural notes,
 * not test hooks. Event-level assertions are what the reducer actually
 * consumes, so the tests check exactly that.
 */

import { describe, expect, it } from "bun:test"
import {
  createTranslatorState,
  eventsFromJsonlEntry,
} from "../../src/backends/follow/event-from-jsonl"
import type { AgentEvent } from "../../src/protocol/types"

function typesOf(events: AgentEvent[]): string[] {
  return events.map((e) => e.type)
}

describe("eventsFromJsonlEntry — user entries", () => {
  it("array-form user text opens a turn and emits user_message", () => {
    const state = createTranslatorState()
    const events = eventsFromJsonlEntry(
      {
        type: "user",
        uuid: "u1",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      state,
    )
    expect(typesOf(events)).toEqual(["turn_start", "user_message"])
    expect(events[1]).toMatchObject({ type: "user_message", text: "hi" })
    expect(state.inTurn).toBe(true)
  })

  it("string-form user text is treated identically to array form", () => {
    const state = createTranslatorState()
    const events = eventsFromJsonlEntry(
      { type: "user", uuid: "u2", message: { content: "hello there" } },
      state,
    )
    expect(typesOf(events)).toEqual(["turn_start", "user_message"])
    expect(events[1]).toMatchObject({ type: "user_message", text: "hello there" })
  })

  it("compaction-summary synthetic → emits compact event (not a user message)", () => {
    const state = createTranslatorState()
    const events = eventsFromJsonlEntry(
      {
        type: "user",
        uuid: "u3",
        message: {
          content:
            "This session is being continued from a previous conversation that ran out of context…",
        },
      },
      state,
    )
    expect(typesOf(events)).toEqual(["compact"])
    expect((events[0] as any).trigger).toBe("auto")
    expect(state.inTurn).toBe(false)
  })

  it("slash-command marker synthetic → no events", () => {
    const state = createTranslatorState()
    const events = eventsFromJsonlEntry(
      {
        type: "user",
        uuid: "u4",
        message: { content: "<command-name>/clear</command-name>" },
      },
      state,
    )
    expect(events).toEqual([])
  })

  it("empty user entry → no events", () => {
    const state = createTranslatorState()
    const events = eventsFromJsonlEntry(
      { type: "user", uuid: "u5", message: { content: "" } },
      state,
    )
    expect(events).toEqual([])
  })
})

describe("eventsFromJsonlEntry — assistant entries", () => {
  it("text-only assistant emits text_complete + turn_complete(usage)", () => {
    const state = createTranslatorState()
    // Seed the turn as if a prior user entry had opened it.
    state.inTurn = true
    const events = eventsFromJsonlEntry(
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [{ type: "text", text: "hello world" }],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 0,
          },
        },
        costUSD: 0.0042,
      },
      state,
    )
    expect(typesOf(events)).toEqual(["text_complete", "turn_complete"])
    expect(events[0]).toMatchObject({ type: "text_complete", text: "hello world" })
    const complete = events[1] as Extract<AgentEvent, { type: "turn_complete" }>
    expect(complete.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      totalCostUsd: 0.0042,
    })
    expect(state.inTurn).toBe(false)
  })

  it("thinking-only assistant entry emits thinking_delta + turn_complete", () => {
    const state = createTranslatorState()
    state.inTurn = true
    const events = eventsFromJsonlEntry(
      {
        type: "assistant",
        uuid: "a2",
        message: {
          content: [{ type: "thinking", thinking: "let me think…" }],
        },
      },
      state,
    )
    expect(typesOf(events)).toEqual(["thinking_delta", "turn_complete"])
    expect(events[0]).toMatchObject({
      type: "thinking_delta",
      text: "let me think…",
    })
  })

  it("assistant entry with no prior user turn auto-opens one", () => {
    const state = createTranslatorState()
    const events = eventsFromJsonlEntry(
      {
        type: "assistant",
        uuid: "a3",
        message: { content: [{ type: "text", text: "standalone" }] },
      },
      state,
    )
    expect(typesOf(events)).toEqual([
      "turn_start",
      "text_complete",
      "turn_complete",
    ])
  })

  it("assistant string-form content is upgraded to text_complete", () => {
    const state = createTranslatorState()
    state.inTurn = true
    const events = eventsFromJsonlEntry(
      {
        type: "assistant",
        uuid: "a4",
        message: { content: "quick reply" },
      },
      state,
    )
    expect(typesOf(events)).toEqual(["text_complete", "turn_complete"])
  })

  it("unknown assistant block type is skipped (not thrown)", () => {
    const state = createTranslatorState()
    state.inTurn = true
    const events = eventsFromJsonlEntry(
      {
        type: "assistant",
        uuid: "a5",
        message: {
          content: [
            { type: "text", text: "ok" },
            { type: "tomorrows-frame-type", payload: {} },
          ],
        },
      },
      state,
    )
    // The unknown block is warned-and-skipped; the real text still lands.
    expect(typesOf(events)).toEqual(["text_complete", "turn_complete"])
  })
})

describe("eventsFromJsonlEntry — tool pairing", () => {
  it("tool_use_start in assistant entry pairs with later tool_result", () => {
    const state = createTranslatorState()
    // Open a turn with a user entry first.
    eventsFromJsonlEntry(
      {
        type: "user",
        uuid: "u1",
        message: { content: [{ type: "text", text: "do thing" }] },
      },
      state,
    )

    const assistantEvents = eventsFromJsonlEntry(
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            { type: "tool_use", id: "tool_1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
      },
      state,
    )
    expect(typesOf(assistantEvents)).toEqual([
      "tool_use_start",
      "turn_complete",
    ])
    expect((assistantEvents[0] as any).id).toBe("tool_1")
    expect(state.pendingToolUses.has("tool_1")).toBe(true)

    const toolResultEvents = eventsFromJsonlEntry(
      {
        type: "user",
        uuid: "u2",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: "line1\nline2",
            },
          ],
        },
      },
      state,
    )
    expect(typesOf(toolResultEvents)).toEqual(["tool_use_end"])
    expect(toolResultEvents[0]).toMatchObject({
      type: "tool_use_end",
      id: "tool_1",
      output: "line1\nline2",
    })
    expect(state.pendingToolUses.has("tool_1")).toBe(false)
  })

  it("tool_result with is_error surfaces as tool_use_end.error", () => {
    const state = createTranslatorState()
    state.pendingToolUses.add("tool_x")
    const events = eventsFromJsonlEntry(
      {
        type: "user",
        uuid: "u99",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_x",
              content: "command failed",
              is_error: true,
            },
          ],
        },
      },
      state,
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool_use_end",
      id: "tool_x",
      output: "command failed",
      error: "command failed",
    })
  })

  it("unmatched tool_result is skipped (logged), not thrown", () => {
    const state = createTranslatorState()
    // No pendingToolUses.
    const events = eventsFromJsonlEntry(
      {
        type: "user",
        uuid: "u42",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "ghost_tool",
              content: "never-seen",
            },
          ],
        },
      },
      state,
    )
    expect(events).toEqual([])
  })
})

describe("eventsFromJsonlEntry — edge cases and safety", () => {
  it("unknown top-level type → skipped, returns []", () => {
    const state = createTranslatorState()
    const events = eventsFromJsonlEntry(
      { type: "queue-operation", uuid: "q1" },
      state,
    )
    expect(events).toEqual([])
  })

  it("non-object input → skipped, returns []", () => {
    const state = createTranslatorState()
    expect(eventsFromJsonlEntry(null, state)).toEqual([])
    expect(eventsFromJsonlEntry("string", state)).toEqual([])
    expect(eventsFromJsonlEntry(42, state)).toEqual([])
  })

  it("entry with no type field → skipped (warn)", () => {
    const state = createTranslatorState()
    const events = eventsFromJsonlEntry({ uuid: "noop" }, state)
    expect(events).toEqual([])
  })
})
