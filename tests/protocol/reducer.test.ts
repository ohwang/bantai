import { describe, expect, it } from "bun:test"
import { reduce } from "../../src/protocol/reducer"
import {
  createInitialState,
  type AgentEvent,
  type Block,
  type ConversationEvent,
  type ConversationState,
  type ImageContent,
  type SessionResumeSummary,
} from "../../src/protocol/types"

// Helper: apply a sequence of events to initial state
function applyEvents(events: AgentEvent[]): ConversationState {
  return events.reduce(
    (state, event) => reduce(state, event),
    createInitialState(),
  )
}

describe("ConversationState reducer", () => {
  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  describe("session_init", () => {
    it("transitions from INITIALIZING to IDLE", () => {
      const state = applyEvents([
        {
          type: "session_init",
          tools: [{ name: "Read" }, { name: "Write" }],
          models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
        },
      ])
      expect(state.sessionState).toBe("IDLE")
      expect(state.session).not.toBeNull()
      expect(state.session!.tools).toHaveLength(2)
      expect(state.session!.models).toHaveLength(1)
    })

    it("stores account info when provided", () => {
      const state = applyEvents([
        {
          type: "session_init",
          tools: [],
          models: [],
          account: { email: "test@example.com", plan: "pro" },
        },
      ])
      expect(state.session!.account?.email).toBe("test@example.com")
    })
  })

  // -----------------------------------------------------------------------
  // Turn lifecycle
  // -----------------------------------------------------------------------

  describe("turn_start", () => {
    it("transitions from IDLE to RUNNING", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
      ])
      expect(state.sessionState).toBe("RUNNING")
    })

    it("increments turn number", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
      ])
      expect(state.turnNumber).toBe(1)
    })

    it("is ignored during INTERRUPTING state", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "working..." },
        { type: "interrupt" },
        { type: "turn_start" }, // should be ignored
      ])
      expect(state.sessionState).toBe("INTERRUPTING")
      expect(state.turnNumber).toBe(1) // not incremented
    })

    it("is ignored during ERROR state", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "error", code: "fatal", message: "something broke", severity: "fatal" },
        { type: "turn_start" }, // should be ignored
      ])
      expect(state.sessionState).toBe("ERROR")
      expect(state.turnNumber).toBe(0)
    })

    it("is ignored during RUNNING state (duplicate turn_start)", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "hello" },
        { type: "turn_start" }, // duplicate, should be ignored
      ])
      expect(state.sessionState).toBe("RUNNING")
      expect(state.turnNumber).toBe(1) // not incremented again
      expect(state.streamingText).toBe("hello") // not cleared
    })
  })

  describe("turn_complete", () => {
    it("transitions from RUNNING to IDLE", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "turn_complete" },
      ])
      expect(state.sessionState).toBe("IDLE")
    })

    it("clears streaming text", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "hello" },
        { type: "turn_complete" },
      ])
      expect(state.streamingText).toBe("")
    })

    it("updates cost totals when usage provided", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "turn_complete",
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            totalCostUsd: 0.005,
          },
        },
      ])
      expect(state.cost.inputTokens).toBe(100)
      expect(state.cost.outputTokens).toBe(50)
      expect(state.cost.cacheReadTokens).toBe(10)
      expect(state.cost.totalCostUsd).toBe(0.005)
    })

    it("turn_complete flushes streaming text as assistant block", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world" },
        { type: "turn_complete" },
      ])
      expect(state.blocks).toHaveLength(1)
      expect(state.blocks[0]!.type).toBe("assistant")
      expect(state.blocks[0]!).toMatchObject({ type: "assistant", text: "Hello world" })
    })

    it("produces chronological blocks: text then tool", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "Let me read that file." },
        { type: "text_complete", text: "Let me read that file." },
        {
          type: "tool_use_start",
          id: "t1",
          tool: "Read",
          input: { path: "/foo" },
        },
        { type: "tool_use_end", id: "t1", output: "file contents" },
        { type: "turn_complete" },
      ])
      // text_complete flushes text, tool_use_start flushes before appending tool
      expect(state.blocks).toHaveLength(2)
      expect(state.blocks[0]!).toMatchObject({
        type: "assistant",
        text: "Let me read that file.",
      })
      const toolBlock1 = state.blocks[1]!
      expect(toolBlock1.type).toBe("tool")
      if (toolBlock1.type === "tool") {
        expect(toolBlock1.status).toBe("done")
        expect(toolBlock1.output).toBe("file contents")
      }
    })

    it("produces chronological blocks: thinking, text, tool", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "thinking_delta", text: "I should read the file." },
        { type: "text_delta", text: "Reading the file now." },
        { type: "text_complete", text: "Reading the file now." },
        {
          type: "tool_use_start",
          id: "t1",
          tool: "Read",
          input: { path: "/bar" },
        },
        { type: "tool_use_end", id: "t1", output: "bar contents" },
        { type: "turn_complete" },
      ])
      expect(state.blocks).toHaveLength(3)
      expect(state.blocks[0]!).toMatchObject({
        type: "thinking",
        text: "I should read the file.",
      })
      expect(state.blocks[1]!).toMatchObject({
        type: "assistant",
        text: "Reading the file now.",
      })
      const toolBlock2 = state.blocks[2]!
      expect(toolBlock2.type).toBe("tool")
      if (toolBlock2.type === "tool") {
        expect(toolBlock2.id).toBe("t1")
      }
    })

    it("produces tool block for tools-only turn", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "tool_use_start",
          id: "t1",
          tool: "Bash",
          input: { command: "ls" },
        },
        { type: "tool_use_end", id: "t1", output: "file1\nfile2" },
        { type: "turn_complete" },
      ])
      expect(state.blocks).toHaveLength(1)
      const toolBlock0 = state.blocks[0]!
      expect(toolBlock0.type).toBe("tool")
      if (toolBlock0.type === "tool") {
        expect(toolBlock0.status).toBe("done")
        expect(toolBlock0.output).toBe("file1\nfile2")
      }
    })

    it("ignores duplicate turn_complete", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "turn_complete" },
        { type: "turn_complete" }, // duplicate
      ])
      expect(state.sessionState).toBe("IDLE")
      expect(state.turnNumber).toBe(1) // not incremented by duplicate
    })
  })

  // -----------------------------------------------------------------------
  // TTFT (time-to-first-token) surfacing
  // -----------------------------------------------------------------------

  describe("lastTurnTtftMs", () => {
    it("starts at null on a fresh conversation", () => {
      const state = createInitialState()
      expect(state.lastTurnTtftMs).toBeNull()
    })

    it("is populated when turn_complete carries ttftMs", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "turn_complete", ttftMs: 742 },
      ])
      expect(state.lastTurnTtftMs).toBe(742)
    })

    it("stays null when turn_complete omits ttftMs for a backend that never reports it", () => {
      // Codex/Gemini don't emit ttft_ms. After a clean turn on these backends,
      // the status bar should simply not show a TTFT segment — there's no
      // earlier reading to fall back to either, since turn_start resets.
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "turn_complete" },
      ])
      expect(state.lastTurnTtftMs).toBeNull()
    })

    it("resets to null on turn_start so the status bar blanks until the next measurement", () => {
      // Mid-turn, the previous TTFT must not linger on screen — otherwise the
      // user sees a stale "TTFT: 0.7s" label while the current turn is still
      // streaming its first token.
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "turn_complete", ttftMs: 450 },
        { type: "turn_start" }, // new turn begins — clear last reading
      ])
      expect(state.lastTurnTtftMs).toBeNull()
    })

    it("overwrites an earlier reading when the next turn reports a new ttftMs", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "turn_complete", ttftMs: 200 },
        { type: "turn_start" },
        { type: "turn_complete", ttftMs: 1800 },
      ])
      expect(state.lastTurnTtftMs).toBe(1800)
    })
  })

  // -----------------------------------------------------------------------
  // Per-turn summary (powers the TUI "Baked for X · Y tokens · $Z" line)
  // -----------------------------------------------------------------------

  describe("lastTurnSummary", () => {
    it("starts at null on a fresh conversation", () => {
      const state = createInitialState()
      expect(state.lastTurnSummary).toBeNull()
    })

    it("captures durationMs, costUsd, and usage from turn_complete", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "turn_complete",
          durationMs: 45000,
          usage: {
            inputTokens: 1200,
            outputTokens: 340,
            cacheReadTokens: 8000,
            cacheWriteTokens: 0,
            totalCostUsd: 0.0421,
          },
        },
      ])
      expect(state.lastTurnSummary).not.toBeNull()
      expect(state.lastTurnSummary?.durationMs).toBe(45000)
      expect(state.lastTurnSummary?.costUsd).toBe(0.0421)
      expect(state.lastTurnSummary?.usage?.inputTokens).toBe(1200)
      expect(state.lastTurnSummary?.usage?.cacheReadTokens).toBe(8000)
    })

    it("stays null when backend reports neither duration nor any tokens", () => {
      // ACP-style turn_complete — no duration, no usage. Nothing to show.
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "turn_complete" },
      ])
      expect(state.lastTurnSummary).toBeNull()
    })

    it("records duration even when the backend omits usage", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "turn_complete", durationMs: 2500 },
      ])
      expect(state.lastTurnSummary?.durationMs).toBe(2500)
      expect(state.lastTurnSummary?.usage).toBeUndefined()
    })

    it("replaces the previous turn's summary on the next turn_complete", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "turn_complete", durationMs: 1000, usage: { inputTokens: 10, outputTokens: 20 } },
        { type: "turn_start" },
        { type: "turn_complete", durationMs: 8000, usage: { inputTokens: 500, outputTokens: 600 } },
      ])
      expect(state.lastTurnSummary?.durationMs).toBe(8000)
      expect(state.lastTurnSummary?.usage?.outputTokens).toBe(600)
    })
  })

  // -----------------------------------------------------------------------
  // User messages
  // -----------------------------------------------------------------------

  describe("user_message", () => {
    it("adds a user block to the blocks array", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "user_message", text: "Hello, world!" },
      ])
      expect(state.blocks).toHaveLength(1)
      expect(state.blocks[0]!).toMatchObject({
        type: "user",
        text: "Hello, world!",
      })
    })

    it("preserves existing blocks when adding user message", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "user_message", text: "First" },
        { type: "turn_start" },
        { type: "text_complete", text: "Response" },
        { type: "turn_complete" },
        { type: "user_message", text: "Second" },
      ])
      expect(state.blocks).toHaveLength(3)
      expect(state.blocks[0]!).toMatchObject({ type: "user", text: "First" })
      expect(state.blocks[1]!).toMatchObject({ type: "assistant", text: "Response" })
      expect(state.blocks[2]!).toMatchObject({ type: "user", text: "Second" })
    })
  })

  // -----------------------------------------------------------------------
  // Interrupt
  // -----------------------------------------------------------------------

  describe("interrupt", () => {
    it("transitions RUNNING to INTERRUPTING", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "interrupt" },
      ])
      expect(state.sessionState).toBe("INTERRUPTING")
    })

    it("does not change state when IDLE", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "interrupt" },
      ])
      expect(state.sessionState).toBe("IDLE")
    })
  })

  // -----------------------------------------------------------------------
  // System messages
  // -----------------------------------------------------------------------

  describe("system_message", () => {
    it("adds system block to blocks array", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "system_message", text: "Command output here" },
      ])
      expect(state.blocks).toHaveLength(1)
      expect(state.blocks[0]!).toMatchObject({
        type: "system",
        text: "Command output here",
      })
    })
  })

  // -----------------------------------------------------------------------
  // Text streaming
  // -----------------------------------------------------------------------

  describe("text_delta", () => {
    it("accumulates streaming text", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world" },
      ])
      expect(state.streamingText).toBe("Hello world")
    })
  })

  describe("thinking_delta", () => {
    it("accumulates streaming thinking", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "thinking_delta", text: "Let me " },
        { type: "thinking_delta", text: "think..." },
      ])
      expect(state.streamingThinking).toBe("Let me think...")
    })

    it("flushed thinking block always has a string text property", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "thinking_delta", text: "reasoning" },
        { type: "text_delta", text: "response" },
        { type: "turn_complete" },
      ])
      const thinkingBlocks = state.blocks.filter((b) => b.type === "thinking")
      expect(thinkingBlocks.length).toBeGreaterThan(0)
      for (const block of thinkingBlocks) {
        expect(typeof block.text).toBe("string")
        expect(block.text.length).toBeGreaterThan(0)
      }
    })
  })

  describe("text_complete", () => {
    it("commits text as assistant block", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_complete", text: "Hello world" },
      ])
      // text_complete flushes the finalized text as a block
      expect(state.blocks).toHaveLength(1)
      expect(state.blocks[0]!).toMatchObject({ type: "assistant", text: "Hello world" })
      expect(state.streamingText).toBe("")
    })

    it("overwrites streaming text with finalized text and flushes", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "partial" },
        { type: "text_complete", text: "full text" },
      ])
      expect(state.blocks).toHaveLength(1)
      expect(state.blocks[0]!).toMatchObject({ type: "assistant", text: "full text" })
      expect(state.streamingText).toBe("")
    })
  })

  // -----------------------------------------------------------------------
  // Tool lifecycle
  // -----------------------------------------------------------------------

  describe("tool_use_start", () => {
    it("tool_use_start appends running tool block", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "tool_use_start",
          id: "tool1",
          tool: "Read",
          input: { path: "/foo" },
        },
      ])
      const toolBlock = state.blocks.find(
        b => b.type === "tool" && b.id === "tool1"
      )
      expect(toolBlock).toBeDefined()
      if (toolBlock && toolBlock.type === "tool") {
        expect(toolBlock.tool).toBe("Read")
        expect(toolBlock.status).toBe("running")
      }
    })
  })

  describe("tool_use_progress", () => {
    it("tool_use_progress updates tool block output", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "tool_use_start",
          id: "tool1",
          tool: "Read",
          input: { path: "/foo" },
        },
        { type: "tool_use_progress", id: "tool1", output: "line 1\n" },
        { type: "tool_use_progress", id: "tool1", output: "line 2\n" },
      ])
      const toolBlock = state.blocks.find(
        b => b.type === "tool" && b.id === "tool1"
      )
      expect(toolBlock).toBeDefined()
      if (toolBlock && toolBlock.type === "tool") {
        expect(toolBlock.output).toBe("line 1\nline 2\n")
      }
    })
  })

  describe("tool_use_end", () => {
    it("tool_use_end sets tool block to done", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "tool_use_start",
          id: "tool1",
          tool: "Read",
          input: { path: "/foo" },
        },
        { type: "tool_use_end", id: "tool1", output: "file contents" },
      ])
      const toolBlock = state.blocks.find(
        b => b.type === "tool" && b.id === "tool1"
      )
      expect(toolBlock).toBeDefined()
      if (toolBlock && toolBlock.type === "tool") {
        expect(toolBlock.status).toBe("done")
        expect(toolBlock.output).toBe("file contents")
      }
    })

    it("preserves error on tool failure", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "tool_use_start",
          id: "tool1",
          tool: "Read",
          input: { path: "/nonexistent" },
        },
        {
          type: "tool_use_end",
          id: "tool1",
          output: "",
          error: "File not found",
        },
      ])
      const toolBlock = state.blocks.find(
        b => b.type === "tool" && b.id === "tool1"
      )
      expect(toolBlock).toBeDefined()
      if (toolBlock && toolBlock.type === "tool") {
        expect(toolBlock.status).toBe("error")
        expect(toolBlock.error).toBe("File not found")
      }
    })

    it("__last_running__ sentinel closes the most recent running tool", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "tool_use_start",
          id: "tool_a",
          tool: "Read",
          input: { path: "/a" },
        },
        {
          type: "tool_use_end",
          id: "tool_a",
          output: "done",
        },
        {
          type: "tool_use_start",
          id: "tool_b",
          tool: "Bash",
          input: { command: "ls" },
        },
        {
          type: "tool_use_end",
          id: "__last_running__",
          output: "",
          error: "Command failed",
        },
      ])
      const toolA = state.blocks.find(
        b => b.type === "tool" && b.id === "tool_a"
      )
      const toolB = state.blocks.find(
        b => b.type === "tool" && b.id === "tool_b"
      )
      expect(toolA).toBeDefined()
      expect(toolB).toBeDefined()
      if (toolA && toolA.type === "tool") {
        expect(toolA.status).toBe("done") // already completed, should not change
      }
      if (toolB && toolB.type === "tool") {
        expect(toolB.status).toBe("error") // sentinel should match this one
        expect(toolB.error).toBe("Command failed")
      }
    })

    it("__last_running__ sentinel is a no-op when no running tools exist", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "tool_use_start",
          id: "tool_c",
          tool: "Read",
          input: { path: "/c" },
        },
        {
          type: "tool_use_end",
          id: "tool_c",
          output: "file contents",
        },
        {
          type: "tool_use_end",
          id: "__last_running__",
          output: "",
          error: "Orphan error",
        },
      ])
      // tool_c should remain "done", not be overwritten
      const toolC = state.blocks.find(
        b => b.type === "tool" && b.id === "tool_c"
      )
      expect(toolC).toBeDefined()
      if (toolC && toolC.type === "tool") {
        expect(toolC.status).toBe("done")
        expect(toolC.error).toBeUndefined()
      }
    })
  })

  // -----------------------------------------------------------------------
  // Permission flow
  // -----------------------------------------------------------------------

  describe("permission_request", () => {
    it("transitions to WAITING_FOR_PERM", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "permission_request",
          id: "perm1",
          tool: "Bash",
          input: { command: "rm -rf /" },
        },
      ])
      expect(state.sessionState).toBe("WAITING_FOR_PERM")
      expect(state.pendingPermission).not.toBeNull()
      expect(state.pendingPermission!.id).toBe("perm1")
    })
  })

  // -----------------------------------------------------------------------
  // Elicitation flow
  // -----------------------------------------------------------------------

  describe("elicitation_request", () => {
    it("transitions to WAITING_FOR_ELIC", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "elicitation_request",
          id: "elic1",
          questions: [
            {
              question: "Which option?",
              options: [
                { label: "A" },
                { label: "B" },
              ],
            },
          ],
        },
      ])
      expect(state.sessionState).toBe("WAITING_FOR_ELIC")
      expect(state.pendingElicitation).not.toBeNull()
    })
  })

  describe("elicitation_response", () => {
    it("clears pending elicitation and returns to RUNNING", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "elicitation_request",
          id: "elic1",
          questions: [
            {
              question: "Which?",
              options: [{ label: "A" }],
            },
          ],
        },
        {
          type: "elicitation_response",
          id: "elic1",
          answers: { "0": "a" },
        },
      ])
      expect(state.sessionState).toBe("RUNNING")
      expect(state.pendingElicitation).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Response state guards (interrupt vs response race)
  // -----------------------------------------------------------------------

  describe("permission_response state guard", () => {
    it("is ignored during INTERRUPTING state", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "permission_request",
          id: "perm1",
          tool: "Bash",
          input: { command: "rm -rf /" },
        },
        { type: "interrupt" }, // Ctrl+C while waiting for permission
        {
          type: "permission_response",
          id: "perm1",
          behavior: "allow",
        },
      ])
      // Interrupt should NOT be overridden by the late permission_response
      expect(state.sessionState).toBe("INTERRUPTING")
    })
  })

  describe("elicitation_response state guard", () => {
    it("is ignored during INTERRUPTING state", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "elicitation_request",
          id: "elic1",
          questions: [
            {
              question: "Which?",
              options: [{ label: "A" }],
            },
          ],
        },
        { type: "interrupt" }, // Ctrl+C while waiting for elicitation
        {
          type: "elicitation_response",
          id: "elic1",
          answers: { "0": "a" },
        },
      ])
      // Interrupt should NOT be overridden by the late elicitation_response
      expect(state.sessionState).toBe("INTERRUPTING")
    })
  })

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe("error", () => {
    it("fatal error transitions to ERROR state", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "error",
          code: "error_max_turns",
          message: "Too many turns",
          severity: "fatal",
        },
      ])
      expect(state.sessionState).toBe("ERROR")
      expect(state.lastError).not.toBeNull()
      expect(state.lastError!.code).toBe("error_max_turns")
    })

    it("fatal error appends error block", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "error",
          code: "error_max_turns",
          message: "Too many turns",
          severity: "fatal",
        },
      ])
      expect(state.blocks).toHaveLength(1)
      expect(state.blocks[0]!).toMatchObject({
        type: "error",
        code: "error_max_turns",
        message: "Too many turns",
      })
    })

    it("recoverable error stays in current state", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "error",
          code: "rate_limit",
          message: "Rate limited",
          severity: "recoverable",
        },
      ])
      expect(state.sessionState).toBe("RUNNING")
    })

    it("error without severity defaults to fatal", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "error",
          code: "unknown",
          message: "Something broke",
        },
      ])
      expect(state.sessionState).toBe("ERROR")
    })

    it("suppresses fatal errors during INTERRUPTING state", () => {
      // Start from INTERRUPTING state
      const initialState = createInitialState()
      const interruptingState = {
        ...initialState,
        sessionState: "INTERRUPTING" as const,
      }

      const errorEvent: AgentEvent = {
        type: "error",
        code: "error_during_execution",
        message: "EACCES: permission denied, posix_spawn ripgrep",
        severity: "fatal",
      }

      const result = reduce(interruptingState, errorEvent)

      // Should NOT transition to ERROR state
      expect(result.sessionState).toBe("INTERRUPTING")
      // Should NOT add an error block
      expect(result.blocks.filter(b => b.type === "error")).toHaveLength(0)
      // Should still record the error for diagnostics
      expect(result.lastError).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // Cost tracking
  // -----------------------------------------------------------------------

  describe("cost_update", () => {
    it("is ignored to prevent double-counting with turn_complete", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "cost_update",
          inputTokens: 100,
          outputTokens: 50,
          cost: 0.005,
        },
        {
          type: "cost_update",
          inputTokens: 200,
          outputTokens: 75,
          cost: 0.01,
        },
      ])
      // cost_update events are no-ops; turn_complete is the authoritative source
      expect(state.cost.inputTokens).toBe(0)
      expect(state.cost.outputTokens).toBe(0)
      expect(state.cost.totalCostUsd).toBe(0)
    })

    it("turn_complete is the sole source of cost accumulation", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        // Turn 1: streaming cost_update + turn_complete with usage
        { type: "turn_start" },
        { type: "cost_update", inputTokens: 50, outputTokens: 25, cost: 0.003 },
        {
          type: "turn_complete",
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            totalCostUsd: 0.005,
          },
        },
        // Turn 2: another turn_complete with usage
        { type: "turn_start" },
        {
          type: "turn_complete",
          usage: {
            inputTokens: 200,
            outputTokens: 75,
            totalCostUsd: 0.01,
          },
        },
      ])
      // Only turn_complete usage is counted, cost_update is ignored
      expect(state.cost.inputTokens).toBe(300)
      expect(state.cost.outputTokens).toBe(125)
      expect(state.cost.cacheReadTokens).toBe(10)
      expect(state.cost.totalCostUsd).toBeCloseTo(0.015)
    })
  })

  // -----------------------------------------------------------------------
  // Task / subagent events
  // -----------------------------------------------------------------------

  describe("task_start", () => {
    it("adds to active tasks", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Searching files" },
      ])
      expect(state.activeTasks.has("t1")).toBe(true)
      expect(state.activeTasks.get("t1")!.description).toBe("Searching files")
    })
  })

  describe("task_progress", () => {
    it("updates task output", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Searching" },
        { type: "task_progress", taskId: "t1", output: "Found 3 matches" },
      ])
      expect(state.activeTasks.get("t1")!.output).toBe("Found 3 matches")
    })
  })

  describe("task_complete", () => {
    it("marks task as completed", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Searching" },
        { type: "task_complete", taskId: "t1", output: "Done" },
      ])
      expect(state.activeTasks.get("t1")!.status).toBe("completed")
    })

    it("defaults to completed when state is not provided", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Searching" },
        { type: "task_complete", taskId: "t1", output: "Done" },
      ])
      expect(state.activeTasks.get("t1")!.status).toBe("completed")
    })

    it("sets status to error when event.state is error", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Searching" },
        { type: "task_complete", taskId: "t1", output: "Failed", state: "error", errorMessage: "Something went wrong" },
      ])
      expect(state.activeTasks.get("t1")!.status).toBe("error")
      expect(state.activeTasks.get("t1")!.errorMessage).toBe("Something went wrong")
    })

    it("sets endTime on completion", () => {
      const before = Date.now()
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Searching" },
        { type: "task_complete", taskId: "t1", output: "Done" },
      ])
      const after = Date.now()
      const endTime = state.activeTasks.get("t1")!.endTime
      expect(endTime).toBeDefined()
      expect(endTime).toBeGreaterThanOrEqual(before)
      expect(endTime).toBeLessThanOrEqual(after)
    })
  })

  // -----------------------------------------------------------------------
  // task_updated (SDK 0.2.107+)
  // -----------------------------------------------------------------------

  describe("task_updated", () => {
    it("merges patch into existing task", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Searching" },
        { type: "task_updated", taskId: "t1", patch: { description: "Updated desc", isBackgrounded: true } },
      ])
      const task = state.activeTasks.get("t1")!
      expect(task.description).toBe("Updated desc")
      expect(task.isBackgrounded).toBe(true)
      expect(task.status).toBe("running") // unchanged
    })

    it("maps 'killed' status to 'error'", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Searching" },
        { type: "task_updated", taskId: "t1", patch: { status: "killed" } },
      ])
      expect(state.activeTasks.get("t1")!.status).toBe("error")
    })

    it("maps 'failed' status to 'error'", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Searching" },
        { type: "task_updated", taskId: "t1", patch: { status: "failed", error: "Out of memory" } },
      ])
      const task = state.activeTasks.get("t1")!
      expect(task.status).toBe("error")
      expect(task.errorMessage).toBe("Out of memory")
    })

    it("maps 'completed' status", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Searching" },
        { type: "task_updated", taskId: "t1", patch: { status: "completed", endTime: 1700000000 } },
      ])
      const task = state.activeTasks.get("t1")!
      expect(task.status).toBe("completed")
      expect(task.endTime).toBe(1700000000)
    })

    it("maps 'pending' status to 'running'", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Searching" },
        { type: "task_updated", taskId: "t1", patch: { status: "pending" } },
      ])
      expect(state.activeTasks.get("t1")!.status).toBe("running")
    })

    it("sets totalPausedMs", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Searching" },
        { type: "task_updated", taskId: "t1", patch: { totalPausedMs: 500 } },
      ])
      expect(state.activeTasks.get("t1")!.totalPausedMs).toBe(500)
    })

    it("is a no-op for unknown task IDs", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_updated", taskId: "nonexistent", patch: { status: "completed" } },
      ])
      expect(state.activeTasks.has("nonexistent")).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // skipTranscript on task events (SDK 0.2.107+)
  // -----------------------------------------------------------------------

  describe("skipTranscript on task events", () => {
    it("stores skipTranscript from task_start", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Ambient", skipTranscript: true },
      ])
      expect(state.activeTasks.get("t1")!.skipTranscript).toBe(true)
    })

    it("preserves skipTranscript from task_start through task_complete", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Ambient", skipTranscript: true },
        { type: "task_complete", taskId: "t1", output: "Done" },
      ])
      expect(state.activeTasks.get("t1")!.skipTranscript).toBe(true)
    })

    it("task_complete can override skipTranscript", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_start", taskId: "t1", description: "Ambient", skipTranscript: true },
        { type: "task_complete", taskId: "t1", output: "Done", skipTranscript: false },
      ])
      expect(state.activeTasks.get("t1")!.skipTranscript).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Compact
  // -----------------------------------------------------------------------

  describe("compact", () => {
    it("adds compact block", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "compact", summary: "Conversation was compacted" },
      ])
      const compactBlock = state.blocks.find(b => b.type === "compact")
      expect(compactBlock).toBeDefined()
      if (compactBlock && compactBlock.type === "compact") {
        expect(compactBlock.summary).toBe("Conversation was compacted")
      }
    })

    it("stores durationMs in compact block", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "compact", summary: "Compacted", durationMs: 1500 },
      ])
      const compactBlock = state.blocks.find(b => b.type === "compact") as any
      expect(compactBlock.durationMs).toBe(1500)
    })

    it("merges durationMs in dedup adjacent compact blocks", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "compact", summary: "First", trigger: "auto" },
        { type: "compact", summary: "Second", trigger: "auto", durationMs: 2000 },
      ])
      const compactBlocks = state.blocks.filter(b => b.type === "compact")
      expect(compactBlocks).toHaveLength(1)
      expect((compactBlocks[0] as any).durationMs).toBe(2000)
    })
  })

  // -----------------------------------------------------------------------
  // Backend-specific events
  // -----------------------------------------------------------------------

  describe("backend_specific", () => {
    it("does not change state", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        {
          type: "backend_specific",
          backend: "claude",
          data: { hook: "PreToolUse" },
        },
      ])
      expect(state.sessionState).toBe("IDLE")
    })

    it("stores normalized rate-limit info for status bar consumers", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        {
          type: "rate_limit_update",
          rateLimitType: "five_hour",
          utilization: 0.12,
          resetsAt: 1775019636,
          windowDurationMins: 300,
          source: "codex",
        },
        {
          type: "rate_limit_update",
          rateLimitType: "seven_day",
          utilization: 0.08,
          resetsAt: 1775206513,
          windowDurationMins: 10080,
          source: "codex",
        },
      ])

      expect(state.rateLimits).toEqual({
        fiveHour: {
          usedPercentage: 12,
          resetsAt: 1775019636,
          windowDurationMins: 300,
        },
        sevenDay: {
          usedPercentage: 8,
          resetsAt: 1775206513,
          windowDurationMins: 10080,
        },
      })
    })

    it("stores generic primary/secondary Codex windows", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        {
          type: "rate_limit_update",
          rateLimitType: "primary",
          utilization: 0.25,
          resetsAt: 1775019636,
          windowDurationMins: 15,
          source: "codex",
        },
        {
          type: "rate_limit_update",
          rateLimitType: "secondary",
          utilization: 0.40,
          resetsAt: 1775020236,
          windowDurationMins: 60,
          source: "codex",
        },
      ])

      expect(state.rateLimits).toEqual({
        primary: {
          usedPercentage: 25,
          resetsAt: 1775019636,
          windowDurationMins: 15,
        },
        secondary: {
          usedPercentage: 40,
          resetsAt: 1775020236,
          windowDurationMins: 60,
        },
      })
    })

    it("folds 7-day Opus/Sonnet variants into the sevenDay slot", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        {
          type: "rate_limit_update",
          rateLimitType: "seven_day_opus",
          utilization: 0.66,
          resetsAt: 1775206513,
          source: "claude",
        },
      ])

      expect(state.rateLimits?.sevenDay).toEqual({
        usedPercentage: 66,
        resetsAt: 1775206513,
        windowDurationMins: undefined,
      })
    })

    it("derives usedPercentage from status when numeric signals are missing", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        {
          type: "rate_limit_update",
          rateLimitType: "five_hour",
          status: "rejected",
          source: "claude",
        },
      ])

      expect(state.rateLimits?.fiveHour?.usedPercentage).toBe(100)
    })

    it("drops updates with no derivable usedPercentage", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        {
          type: "rate_limit_update",
          rateLimitType: "five_hour",
          source: "claude",
        },
      ])

      expect(state.rateLimits).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Task backgrounding
  // -----------------------------------------------------------------------

  describe("task_background", () => {
    it("sets backgrounded to true when RUNNING", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_background" },
      ])
      expect(state.backgrounded).toBe(true)
      expect(state.sessionState).toBe("RUNNING")
    })

    it("is ignored when not RUNNING", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "task_background" },
      ])
      expect(state.backgrounded).toBe(false)
    })
  })

  describe("task_foreground", () => {
    it("sets backgrounded to false when backgrounded", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_background" },
        { type: "task_foreground" },
      ])
      expect(state.backgrounded).toBe(false)
    })

    it("is ignored when not backgrounded", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_foreground" },
      ])
      expect(state.backgrounded).toBe(false)
    })
  })

  describe("backgrounded auto-clear", () => {
    it("turn_complete clears backgrounded", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_background" },
        { type: "turn_complete", usage: { inputTokens: 10, outputTokens: 5 } },
      ])
      expect(state.backgrounded).toBe(false)
      expect(state.sessionState).toBe("IDLE")
    })

    it("interrupt clears backgrounded", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "working..." },
        { type: "task_background" },
        { type: "interrupt" },
      ])
      expect(state.backgrounded).toBe(false)
      expect(state.sessionState).toBe("INTERRUPTING")
    })

    it("streaming continues while backgrounded (blocks still accumulate)", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "task_background" },
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world" },
      ])
      expect(state.backgrounded).toBe(true)
      expect(state.streamingText).toBe("Hello world")
    })
  })

  // -----------------------------------------------------------------------
  // Event log invariant
  // -----------------------------------------------------------------------

  describe("event log invariant", () => {
    it("eventLog is not grown by the reducer (caller-managed)", () => {
      const events: AgentEvent[] = [
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "hi" },
        { type: "text_complete", text: "hi" },
        { type: "turn_complete" },
      ]
      const state = applyEvents(events)
      // Reducer no longer copies events into eventLog (O(n²) fix)
      expect(state.eventLog).toHaveLength(0)
    })

    it("state is reconstructable from replaying events", () => {
      const events: AgentEvent[] = [
        { type: "session_init", tools: [{ name: "Read" }], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world" },
        {
          type: "tool_use_start",
          id: "t1",
          tool: "Read",
          input: { path: "/x" },
        },
        { type: "tool_use_end", id: "t1", output: "contents" },
        { type: "text_complete", text: "Hello world" },
        {
          type: "turn_complete",
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      ]

      // Apply all at once
      const state1 = applyEvents(events)

      // Replay from the same event array
      const state2 = events.reduce(
        (s, e) => reduce(s, e),
        createInitialState(),
      )

      // Strip time-dependent fields (timestamp, duration, startTime) before
      // comparing — the two reduce loops call Date.now() at different wall-clock
      // times, so 1ms drift is expected and not a real inconsistency.
      const stripTime = (blocks: any[]) =>
        blocks.map(({ timestamp, duration, startTime, ...rest }: any) => rest)

      // States should match
      expect(state2.sessionState).toBe(state1.sessionState)
      expect(stripTime(state2.blocks)).toEqual(stripTime(state1.blocks))
      expect(state2.cost).toEqual(state1.cost)
      expect(state2.turnNumber).toBe(state1.turnNumber)
    })
  })

  // -----------------------------------------------------------------------
  // Message ordering during streaming
  // -----------------------------------------------------------------------

  describe("message ordering during streaming", () => {
    it("user_message during RUNNING shows as queued block", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "hello" },
        { type: "user_message", text: "msg2" },
      ])
      const userBlock = state.blocks.find(
        b => b.type === "user" && b.text === "msg2"
      ) as Extract<Block, { type: "user" }> | undefined
      expect(userBlock).toBeDefined()
      expect(userBlock!.queued).toBe(true)
    })

    it("turn_complete unqueues user blocks and preserves order", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "user_message", text: "msg1" },
        { type: "turn_start" },
        { type: "text_delta", text: "response" },
        { type: "user_message", text: "msg2" },
        { type: "turn_complete" },
      ])
      expect(state.blocks).toHaveLength(3)
      expect(state.blocks[0]!).toMatchObject({ type: "user", text: "msg1" })
      expect(state.blocks[1]!).toMatchObject({ type: "assistant", text: "response" })
      expect(state.blocks[2]!).toMatchObject({ type: "user", text: "msg2" })
      // msg2 should be unqueued after turn_complete
      expect((state.blocks[2]! as Extract<Block, { type: "user" }>).queued).toBeUndefined()
    })

    it("multiple queued messages maintain order", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "user_message", text: "msg1" },
        { type: "turn_start" },
        { type: "text_delta", text: "resp" },
        { type: "user_message", text: "msg2" },
        { type: "user_message", text: "msg3" },
        { type: "turn_complete" },
      ])
      expect(state.blocks).toHaveLength(4)
      expect(state.blocks[0]!).toMatchObject({ type: "user", text: "msg1" })
      expect(state.blocks[1]!).toMatchObject({ type: "assistant", text: "resp" })
      expect(state.blocks[2]!).toMatchObject({ type: "user", text: "msg2" })
      expect(state.blocks[3]!).toMatchObject({ type: "user", text: "msg3" })
      // Both should be unqueued
      expect((state.blocks[2]! as Extract<Block, { type: "user" }>).queued).toBeUndefined()
      expect((state.blocks[3]! as Extract<Block, { type: "user" }>).queued).toBeUndefined()
    })

    it("user_message in IDLE still adds immediately", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "user_message", text: "msg1" },
      ])
      expect(state.blocks).toHaveLength(1)
      expect(state.blocks[0]!).toMatchObject({ type: "user", text: "msg1" })
      expect((state.blocks[0]! as Extract<Block, { type: "user" }>).queued).toBeUndefined()
    })

    it("user_message during WAITING_FOR_PERM queues", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "permission_request",
          id: "perm1",
          tool: "Bash",
          input: { command: "ls" },
        },
        { type: "user_message", text: "queued" },
      ])
      const userBlock = state.blocks.find(
        b => b.type === "user" && b.text === "queued"
      ) as Extract<Block, { type: "user" }> | undefined
      expect(userBlock).toBeDefined()
      expect(userBlock!.queued).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // flushBuffers ordering
  // -----------------------------------------------------------------------

  describe("flushBuffers ordering", () => {
    it("tool_use_start flushes buffers before appending tool block", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "thinking_delta", text: "Let me think" },
        { type: "text_delta", text: "I'll read the file" },
        { type: "tool_use_start", id: "t1", tool: "Read", input: {} },
      ])
      // Thinking and text should be committed BEFORE the tool
      expect(state.blocks).toHaveLength(3)
      expect(state.blocks[0]!.type).toBe("thinking")
      expect(state.blocks[1]!.type).toBe("assistant")
      expect(state.blocks[2]!.type).toBe("tool")
    })

    it("multi-turn tool loop produces continuous block sequence", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "user_message", text: "Fix the bug" },
        // Turn 1: text + tool
        { type: "turn_start" },
        { type: "text_delta", text: "I'll read first" },
        { type: "tool_use_start", id: "t1", tool: "Read", input: {} },
        { type: "tool_use_end", id: "t1", output: "contents" },
        { type: "turn_complete" },
        // Turn 2: text + tool
        { type: "turn_start" },
        { type: "text_delta", text: "Now I'll edit" },
        { type: "tool_use_start", id: "t2", tool: "Edit", input: {} },
        { type: "tool_use_end", id: "t2", output: "edited" },
        { type: "turn_complete" },
        // Turn 3: final text
        { type: "turn_start" },
        { type: "text_delta", text: "Done!" },
        { type: "turn_complete" },
      ])
      // Should be: user, text, tool, text, tool, text -- continuous, no gaps
      expect(state.blocks).toHaveLength(6)
      expect(state.blocks[0]!).toMatchObject({ type: "user", text: "Fix the bug" })
      expect(state.blocks[1]!).toMatchObject({ type: "assistant", text: "I'll read first" })
      expect(state.blocks[2]!).toMatchObject({ type: "tool", tool: "Read", status: "done" })
      expect(state.blocks[3]!).toMatchObject({ type: "assistant", text: "Now I'll edit" })
      expect(state.blocks[4]!).toMatchObject({ type: "tool", tool: "Edit", status: "done" })
      expect(state.blocks[5]!).toMatchObject({ type: "assistant", text: "Done!" })
    })

    it("text_complete commits text as assistant block", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "partial" },
        { type: "text_complete", text: "full text" },
      ])
      // text_complete should flush the finalized text as a block
      expect(state.blocks).toHaveLength(1)
      expect(state.blocks[0]!).toMatchObject({ type: "assistant", text: "full text" })
      expect(state.streamingText).toBe("")
    })

    it("interrupt flushes buffers before transitioning", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "partial response" },
        { type: "interrupt" },
      ])
      expect(state.sessionState).toBe("INTERRUPTING")
      expect(state.blocks).toHaveLength(1)
      expect(state.blocks[0]!).toMatchObject({ type: "assistant", text: "partial response" })
      expect(state.streamingText).toBe("")
    })

    it("queued user blocks get unqueued on turn_complete", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "response" },
        { type: "user_message", text: "queued msg" },
        { type: "turn_complete" },
      ])
      const userBlock = state.blocks.find(b => b.type === "user" && b.text === "queued msg") as Extract<Block, { type: "user" }> | undefined
      expect(userBlock).toBeDefined()
      expect(userBlock!.queued).toBeUndefined() // unqueued after turn_complete
    })
  })

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  describe("shutdown", () => {
    it("transitions to SHUTTING_DOWN from RUNNING", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "shutdown" },
      ])
      expect(state.sessionState).toBe("SHUTTING_DOWN")
    })

    it("transitions to SHUTTING_DOWN from IDLE", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "shutdown" },
      ])
      expect(state.sessionState).toBe("SHUTTING_DOWN")
    })

    it("transitions to SHUTTING_DOWN from WAITING_FOR_PERM", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "permission_request",
          id: "perm1",
          tool: "Bash",
          input: { command: "rm -rf /" },
        },
        { type: "shutdown" },
      ])
      expect(state.sessionState).toBe("SHUTTING_DOWN")
    })

    it("flushes streaming text buffer as assistant block", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "partial " },
        { type: "text_delta", text: "response" },
        { type: "shutdown" },
      ])
      expect(state.streamingText).toBe("")
      expect(state.blocks).toHaveLength(1)
      expect(state.blocks[0]!).toMatchObject({ type: "assistant", text: "partial response" })
    })

    it("flushes streaming thinking buffer as thinking block", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "thinking_delta", text: "deep " },
        { type: "thinking_delta", text: "thought" },
        { type: "shutdown" },
      ])
      expect(state.streamingThinking).toBe("")
      expect(state.blocks).toHaveLength(1)
      expect(state.blocks[0]!).toMatchObject({ type: "thinking", text: "deep thought" })
    })

    it("cancels running tool blocks with status and duration", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "tool_use_start",
          id: "t1",
          tool: "Bash",
          input: { command: "sleep 100" },
        },
        { type: "shutdown" },
      ])
      const toolBlock = state.blocks.find(b => b.type === "tool" && b.id === "t1")
      expect(toolBlock).toBeDefined()
      if (toolBlock && toolBlock.type === "tool") {
        expect(toolBlock.status).toBe("canceled")
        expect(toolBlock.duration).toBeDefined()
        expect(typeof toolBlock.duration).toBe("number")
      }
    })

    it("clears pendingPermission and pendingElicitation", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "permission_request",
          id: "perm1",
          tool: "Bash",
          input: { command: "rm -rf /" },
        },
        { type: "shutdown" },
      ])
      expect(state.pendingPermission).toBeNull()
      expect(state.pendingElicitation).toBeNull()
    })

    it("cancels multiple running tool blocks", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "tool_use_start",
          id: "t1",
          tool: "Read",
          input: { path: "/a" },
        },
        {
          type: "tool_use_start",
          id: "t2",
          tool: "Bash",
          input: { command: "ls" },
        },
        {
          type: "tool_use_start",
          id: "t3",
          tool: "Write",
          input: { path: "/b", content: "x" },
        },
        { type: "shutdown" },
      ])
      const toolBlocks = state.blocks.filter(b => b.type === "tool")
      expect(toolBlocks).toHaveLength(3)
      for (const block of toolBlocks) {
        if (block.type === "tool") {
          expect(block.status).toBe("canceled")
          expect(block.duration).toBeDefined()
        }
      }
    })

    it("does not cancel already-completed tool blocks", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        {
          type: "tool_use_start",
          id: "t1",
          tool: "Read",
          input: { path: "/a" },
        },
        { type: "tool_use_end", id: "t1", output: "contents" },
        {
          type: "tool_use_start",
          id: "t2",
          tool: "Bash",
          input: { command: "ls" },
        },
        { type: "shutdown" },
      ])
      const t1 = state.blocks.find(b => b.type === "tool" && b.id === "t1")
      const t2 = state.blocks.find(b => b.type === "tool" && b.id === "t2")
      expect(t1).toBeDefined()
      expect(t2).toBeDefined()
      if (t1 && t1.type === "tool") {
        expect(t1.status).toBe("done") // already completed, not canceled
      }
      if (t2 && t2.type === "tool") {
        expect(t2.status).toBe("canceled") // was running, gets canceled
      }
    })
  })

  // -----------------------------------------------------------------------
  // Model changed
  // -----------------------------------------------------------------------

  describe("model_changed", () => {
    it("updates currentModel", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "model_changed", model: "Claude Opus 4.6" },
      ])
      expect(state.currentModel).toBe("Claude Opus 4.6")
    })

    it("does not change sessionState", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "model_changed", model: "Claude Sonnet 4.6" },
      ])
      expect(state.sessionState).toBe("RUNNING")
    })

    it("overwrites previous model", () => {
      const state = applyEvents([
        {
          type: "session_init",
          tools: [],
          models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
        },
        { type: "model_changed", model: "Claude Opus 4.6" },
        { type: "model_changed", model: "Claude Haiku 3.5" },
      ])
      expect(state.currentModel).toBe("Claude Haiku 3.5")
    })
  })

  // -----------------------------------------------------------------------
  // Compact (additional coverage)
  // -----------------------------------------------------------------------

  describe("compact (extended)", () => {
    it("adds compact block with summary text", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "compact", summary: "Previous discussion about file handling" },
      ])
      expect(state.blocks).toHaveLength(1)
      expect(state.blocks[0]!).toMatchObject({
        type: "compact",
        summary: "Previous discussion about file handling",
      })
    })

    it("preserves existing blocks", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "user_message", text: "Hello" },
        { type: "turn_start" },
        { type: "text_complete", text: "Hi there" },
        { type: "turn_complete" },
        { type: "compact", summary: "User greeted assistant" },
      ])
      expect(state.blocks).toHaveLength(3)
      expect(state.blocks[0]!).toMatchObject({ type: "user", text: "Hello" })
      expect(state.blocks[1]!).toMatchObject({ type: "assistant", text: "Hi there" })
      expect(state.blocks[2]!).toMatchObject({
        type: "compact",
        summary: "User greeted assistant",
      })
    })
  })

  // -----------------------------------------------------------------------
  // Compact lifecycle / edge cases (audit: compaction-audit-and-bugbash)
  // -----------------------------------------------------------------------

  describe("compact (lifecycle edge cases)", () => {
    it("in-progress event creates a placeholder block with inProgress=true", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "compact", summary: "Compacting...", inProgress: true, trigger: "user" },
      ])
      expect(state.blocks).toHaveLength(1)
      const block = state.blocks[0]!
      expect(block.type).toBe("compact")
      if (block.type === "compact") {
        expect(block.inProgress).toBe(true)
        expect(block.trigger).toBe("user")
      }
    })

    it("completion event replaces the in-progress placeholder (single block, not two)", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "compact", summary: "Compacting...", inProgress: true, trigger: "user" },
        {
          type: "compact",
          summary: "Summary of conversation.",
          trigger: "user",
          preTokens: 50000,
          postTokens: 12000,
        },
      ])
      const compactBlocks = state.blocks.filter(b => b.type === "compact")
      expect(compactBlocks).toHaveLength(1)
      const block = compactBlocks[0]!
      if (block.type === "compact") {
        expect(block.inProgress).toBeFalsy()
        expect(block.summary).toBe("Summary of conversation.")
        expect(block.preTokens).toBe(50000)
        expect(block.postTokens).toBe(12000)
      }
    })

    it("orphaned in-progress (never completed) remains visible with inProgress=true", () => {
      // Simulates a crashed/interrupted backend: compacting spinner starts,
      // compact_boundary never arrives. The TUI should still render the spinner
      // block; it's up to higher-level flows (interrupt, turn_complete) to
      // resolve the spinner state.
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "compact", summary: "Compacting...", inProgress: true, trigger: "user" },
        { type: "user_message", text: "next turn" },
      ])
      const compactBlocks = state.blocks.filter(b => b.type === "compact")
      expect(compactBlocks).toHaveLength(1)
      const block = compactBlocks[0]!
      if (block.type === "compact") {
        expect(block.inProgress).toBe(true)
      }
    })

    it("completion without prior in-progress appends a fresh block", () => {
      // Codex auto-compaction path: only a single completion event arrives.
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "user_message", text: "hello" },
        { type: "turn_start" },
        { type: "text_complete", text: "hi" },
        { type: "turn_complete" },
        { type: "compact", summary: "Auto-compacted by Codex.", trigger: "auto" },
      ])
      const compactBlocks = state.blocks.filter(b => b.type === "compact")
      expect(compactBlocks).toHaveLength(1)
      const block = compactBlocks[0]!
      if (block.type === "compact") {
        expect(block.trigger).toBe("auto")
        expect(block.inProgress).toBeFalsy()
      }
    })

    it("compact event arriving mid-turn does not tear down the turn", () => {
      // A compact event should not reset sessionState; turn lifecycle is
      // governed by turn_start/turn_complete, not compact.
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "user_message", text: "work" },
        { type: "turn_start" },
        { type: "text_delta", text: "thinking..." },
        { type: "compact", summary: "Compacting mid-turn.", trigger: "auto" },
      ])
      expect(state.sessionState).toBe("RUNNING")
      const compactBlocks = state.blocks.filter(b => b.type === "compact")
      expect(compactBlocks).toHaveLength(1)
      // Streaming text buffer should not be corrupted by the compact event
      expect(state.streamingText).toBe("thinking...")
    })

    it("back-to-back completion compact events coalesce into one block (Codex dual-event dedup)", () => {
      // Codex emits `thread/compacted` (thread-level) and `item/started` with
      // `contextCompaction` (item-level) for the same auto-compaction. Two
      // distinct compact events should not produce two stacked boundary
      // markers in the UI — coalesce into a single block.
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "compact", summary: "Conversation compacted by Codex.", trigger: "auto" },
        { type: "compact", summary: "Codex compacted conversation context.", trigger: "auto" },
      ])
      const compactBlocks = state.blocks.filter(b => b.type === "compact")
      expect(compactBlocks).toHaveLength(1)
    })

    it("back-to-back coalesce prefers token metadata from whichever event supplies it", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "compact", summary: "First event.", trigger: "auto" },
        {
          type: "compact",
          summary: "Second event with tokens.",
          trigger: "auto",
          preTokens: 90000,
          postTokens: 20000,
        },
      ])
      const compactBlocks = state.blocks.filter(b => b.type === "compact")
      expect(compactBlocks).toHaveLength(1)
      const block = compactBlocks[0]!
      if (block.type === "compact") {
        expect(block.preTokens).toBe(90000)
        expect(block.postTokens).toBe(20000)
      }
    })

    it("a compact block separated by other blocks is not coalesced with a later one", () => {
      // Two genuinely distinct compactions (separated by user/assistant
      // activity) should still produce two compact blocks.
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "compact", summary: "First compaction.", trigger: "auto" },
        { type: "user_message", text: "continue" },
        { type: "turn_start" },
        { type: "text_complete", text: "ok" },
        { type: "turn_complete" },
        { type: "compact", summary: "Second compaction.", trigger: "auto" },
      ])
      const compactBlocks = state.blocks.filter(b => b.type === "compact")
      expect(compactBlocks).toHaveLength(2)
    })

    it("strips SDK local-command XML wrappers from summary", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        {
          type: "compact",
          summary: "<local-command-stdout>Compacted.</local-command-stdout>",
          trigger: "user",
        },
      ])
      const block = state.blocks[0]!
      if (block.type === "compact") {
        expect(block.summary).not.toContain("local-command-stdout")
        expect(block.summary).toContain("Compacted.")
      }
    })

    it("interrupt resolves an in-progress compact spinner (no stuck state)", () => {
      // Ctrl+C while `/compact` is mid-run must not leave a forever-spinning
      // compact boundary. The interrupt transition should mark any in-progress
      // compact block as no longer in progress.
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "compact", summary: "Compacting...", inProgress: true, trigger: "user" },
        { type: "interrupt" },
      ])
      const compactBlocks = state.blocks.filter(b => b.type === "compact")
      expect(compactBlocks).toHaveLength(1)
      const block = compactBlocks[0]!
      if (block.type === "compact") {
        expect(block.inProgress).toBeFalsy()
      }
      expect(state.sessionState).toBe("INTERRUPTING")
    })
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("error recovery", () => {
    it("user_message in ERROR state auto-recovers to IDLE", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "error", code: "stream_error", message: "Stream died", severity: "fatal" },
        { type: "user_message", text: "Try again" },
      ])
      expect(state.sessionState).toBe("IDLE")
      expect(state.lastError).toBeNull()
      expect(state.blocks.some(b => b.type === "user" && b.text === "Try again")).toBe(true)
    })

    it("turn_complete with zero usage preserves last known token count", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "turn_complete", usage: { inputTokens: 5000, outputTokens: 1000 } },
        { type: "turn_start" },
        { type: "turn_complete", usage: { inputTokens: 0, outputTokens: 0 } },
      ])
      // Should preserve the 5000 from first turn, not reset to 0
      expect(state.lastTurnInputTokens).toBe(5000)
    })

    it("lastTurnInputTokens sums all three disjoint token categories", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "turn_complete", usage: {
          inputTokens: 15000,        // uncached input tokens (disjoint from cache categories)
          outputTokens: 2000,
          cacheReadTokens: 40000,    // tokens read from prompt cache
          cacheWriteTokens: 5000,    // tokens newly written to cache (disjoint from inputTokens)
        }},
      ])
      // Context fill = inputTokens + cacheReadTokens + cacheWriteTokens = 60000
      // All three are disjoint in the Anthropic API, matching Claude Code's calculateContextPercentages()
      expect(state.lastTurnInputTokens).toBe(60000)
    })

    it("per-API-call contextTokens overrides cumulative turn_complete usage", () => {
      // Simulates a multi-step agentic turn: message_start emits per-API-call
      // context fill via cost_update.contextTokens. The result.usage is cumulative
      // across all API calls and would overcount.
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        // First API call: 350K context
        { type: "cost_update", inputTokens: 0, outputTokens: 0, contextTokens: 350000 },
        // Second API call: 360K context (grows as tool results are added)
        { type: "cost_update", inputTokens: 0, outputTokens: 0, contextTokens: 360000 },
        // turn_complete with CUMULATIVE usage (350K + 360K = 710K) — should be ignored
        { type: "turn_complete", usage: {
          inputTokens: 30,
          outputTokens: 4000,
          cacheReadTokens: 700000,
          cacheWriteTokens: 10000,
        }},
      ])
      // Should use the last per-API-call value (360K), not cumulative (710K)
      expect(state.lastTurnInputTokens).toBe(360000)
    })

    it("cost_update.contextWindow patches matching session.models entry", () => {
      // Codex 0.122+ reports the live per-model cap in
      // thread/tokenUsage/updated.modelContextWindow. The reducer should
      // patch session.models so downstream consumers (header bar, status
      // bar) pick up the live value via their existing
      // `model?.contextWindow ?? MODEL_CONTEXT_WINDOWS[id]` chain.
      const state = applyEvents([
        {
          type: "session_init",
          tools: [],
          models: [{ id: "gpt-5.5", name: "gpt-5.5", provider: "openai" }],
        },
        { type: "turn_start" },
        { type: "cost_update", inputTokens: 0, outputTokens: 0, contextWindow: 400_000 },
      ])
      const m = state.session?.models.find((x) => x.id === "gpt-5.5")
      expect(m?.contextWindow).toBe(400_000)
    })

    it("cost_update without contextWindow leaves session.models untouched", () => {
      const state = applyEvents([
        {
          type: "session_init",
          tools: [],
          models: [{ id: "gpt-5.5", name: "gpt-5.5", contextWindow: 1_000_000 }],
        },
        { type: "turn_start" },
        { type: "cost_update", inputTokens: 100, outputTokens: 50 },
      ])
      const m = state.session?.models.find((x) => x.id === "gpt-5.5")
      expect(m?.contextWindow).toBe(1_000_000)
    })

    it("turn_complete usage is used as fallback when no contextTokens emitted", () => {
      // Codex/Gemini backends don't emit cost_update.contextTokens
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "turn_complete", usage: {
          inputTokens: 5000,
          outputTokens: 1000,
          cacheReadTokens: 40000,
        }},
      ])
      // Should use turn_complete usage: 5000 + 40000 = 45000
      expect(state.lastTurnInputTokens).toBe(45000)
    })

    it("turn_complete in ERROR state recovers to IDLE", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "error", code: "test", message: "err", severity: "fatal" },
        { type: "turn_complete", usage: { inputTokens: 100, outputTokens: 50 } },
      ])
      expect(state.sessionState).toBe("IDLE")
    })
  })

  describe("edge cases", () => {
    it("events before session_init stay in INITIALIZING", () => {
      const state = applyEvents([{ type: "text_delta", text: "premature" }])
      expect(state.sessionState).toBe("INITIALIZING")
    })

    it("unknown event type does not crash", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "unknown_event" } as any,
      ])
      expect(state.sessionState).toBe("IDLE")
    })

    it("session_state event does not override state machine", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "session_state", state: "running" },
      ])
      // session_state is informational, doesn't override our state machine
      expect(state.sessionState).toBe("IDLE")
    })
  })

  // -----------------------------------------------------------------------
  // Image support
  // -----------------------------------------------------------------------

  describe("image support", () => {
    const sampleImage: ImageContent = {
      data: "iVBORw0KGgoAAAANSUhEUg==",
      mediaType: "image/png",
    }

    it("user_message propagates images to block", () => {
      let state = reduce(createInitialState(), { type: "session_init", tools: [], models: [] })
      state = reduce(state, { type: "user_message", text: "look at this [Image #1]", images: [sampleImage] })
      const userBlock = state.blocks.find(b => b.type === "user")
      expect(userBlock).toBeDefined()
      expect(userBlock!.type).toBe("user")
      if (userBlock!.type === "user") {
        expect(userBlock!.images).toEqual([sampleImage])
      }
    })

    it("user_message without images has undefined images field", () => {
      let state = reduce(createInitialState(), { type: "session_init", tools: [], models: [] })
      state = reduce(state, { type: "user_message", text: "hello" })
      const userBlock = state.blocks.find(b => b.type === "user")
      expect(userBlock!.type === "user" && userBlock!.images).toBeUndefined()
    })

    it("queued user_message preserves images", () => {
      let state = reduce(createInitialState(), { type: "session_init", tools: [], models: [] })
      state = reduce(state, { type: "turn_start" })
      // During RUNNING, messages are queued
      state = reduce(state, { type: "user_message", text: "see this [Image #1]", images: [sampleImage] })
      const queuedBlock = state.blocks.find(b => b.type === "user" && (b as Extract<Block, { type: "user" }>).queued) as Extract<Block, { type: "user" }> | undefined
      expect(queuedBlock).toBeDefined()
      if (queuedBlock!.type === "user") {
        expect(queuedBlock!.images).toEqual([sampleImage])
        expect(queuedBlock!.queued).toBe(true)
      }
    })

    it("ERROR recovery user_message preserves images", () => {
      let state = reduce(createInitialState(), { type: "session_init", tools: [], models: [] })
      state = reduce(state, { type: "error", code: "TEST", message: "test error", severity: "fatal" })
      expect(state.sessionState).toBe("ERROR")
      state = reduce(state, { type: "user_message", text: "retry [Image #1]", images: [sampleImage] })
      expect(state.sessionState).toBe("IDLE")
      const userBlock = state.blocks.find(b => b.type === "user")
      if (userBlock!.type === "user") {
        expect(userBlock!.images).toEqual([sampleImage])
      }
    })

    it("multiple images in single message", () => {
      const img2: ImageContent = { data: "AAAA", mediaType: "image/jpeg" }
      let state = reduce(createInitialState(), { type: "session_init", tools: [], models: [] })
      state = reduce(state, { type: "user_message", text: "[Image #1] [Image #2]", images: [sampleImage, img2] })
      const userBlock = state.blocks.find(b => b.type === "user")
      if (userBlock!.type === "user") {
        expect(userBlock!.images).toHaveLength(2)
        expect(userBlock!.images![0]!.mediaType).toBe("image/png")
        expect(userBlock!.images![1]!.mediaType).toBe("image/jpeg")
      }
    })
  })

  // -----------------------------------------------------------------------
  // Turn file change tracking
  // -----------------------------------------------------------------------

  describe("lastTurnFiles", () => {
    it("extracts file changes from tool blocks on turn_complete", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "tool_use_start", id: "t1", tool: "Read", input: { file_path: "/src/foo.ts" } },
        { type: "tool_use_end", id: "t1", output: "contents" },
        { type: "tool_use_start", id: "t2", tool: "Edit", input: { file_path: "/src/bar.ts", old_string: "a", new_string: "b" } },
        { type: "tool_use_end", id: "t2", output: "ok" },
        { type: "turn_complete" },
      ])
      expect(state.lastTurnFiles).toBeDefined()
      expect(state.lastTurnFiles).toHaveLength(2)
      expect(state.lastTurnFiles![0]).toMatchObject({ path: "/src/bar.ts", action: "edit", tool: "Edit" })
      expect(state.lastTurnFiles![1]).toMatchObject({ path: "/src/foo.ts", action: "read", tool: "Read" })
    })

    it("classifies Write tool as create action", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "tool_use_start", id: "t1", tool: "Write", input: { file_path: "/src/new-file.ts", content: "hello" } },
        { type: "tool_use_end", id: "t1", output: "ok" },
        { type: "turn_complete" },
      ])
      expect(state.lastTurnFiles).toHaveLength(1)
      expect(state.lastTurnFiles![0]).toMatchObject({ path: "/src/new-file.ts", action: "create", tool: "Write" })
    })

    it("returns undefined when no file tools used", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "Hello world" },
        { type: "turn_complete" },
      ])
      expect(state.lastTurnFiles).toBeUndefined()
    })

    it("ignores tools without file_path input", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "tool_use_start", id: "t1", tool: "Bash", input: { command: "ls" } },
        { type: "tool_use_end", id: "t1", output: "file.txt" },
        { type: "turn_complete" },
      ])
      expect(state.lastTurnFiles).toBeUndefined()
    })

    it("stops at user block boundary when scanning backwards", () => {
      // Simulate: turn 1 with Read, turn 2 with Edit — lastTurnFiles should only have turn 2's files
      let state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "tool_use_start", id: "t1", tool: "Read", input: { file_path: "/old-file.ts" } },
        { type: "tool_use_end", id: "t1", output: "contents" },
        { type: "turn_complete" },
      ])
      // Now simulate a second turn
      state = reduce(state, { type: "user_message", text: "edit the file" })
      state = reduce(state, { type: "turn_start" })
      state = reduce(state, { type: "tool_use_start", id: "t2", tool: "Edit", input: { file_path: "/new-file.ts", old_string: "x", new_string: "y" } })
      state = reduce(state, { type: "tool_use_end", id: "t2", output: "ok" })
      state = reduce(state, { type: "turn_complete" })

      expect(state.lastTurnFiles).toHaveLength(1)
      expect(state.lastTurnFiles![0]).toMatchObject({ path: "/new-file.ts", action: "edit" })
    })

    it("only includes done tools (not running or error)", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "tool_use_start", id: "t1", tool: "Edit", input: { file_path: "/good.ts", old_string: "a", new_string: "b" } },
        { type: "tool_use_end", id: "t1", output: "ok" },
        { type: "tool_use_start", id: "t2", tool: "Edit", input: { file_path: "/bad.ts", old_string: "c", new_string: "d" } },
        { type: "tool_use_end", id: "t2", output: "", error: "failed" },
        { type: "turn_complete" },
      ])
      // t1 becomes "done" (closed by turn_complete), t2 becomes "error"
      // Only "done" tools should be included
      expect(state.lastTurnFiles).toHaveLength(1)
      expect(state.lastTurnFiles![0]).toMatchObject({ path: "/good.ts", action: "edit" })
    })

    it("clears lastTurnFiles when next turn has no file tools", () => {
      let state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "tool_use_start", id: "t1", tool: "Edit", input: { file_path: "/file.ts", old_string: "a", new_string: "b" } },
        { type: "tool_use_end", id: "t1", output: "ok" },
        { type: "turn_complete" },
      ])
      expect(state.lastTurnFiles).toHaveLength(1)

      // Next turn with no file tools
      state = reduce(state, { type: "user_message", text: "hello" })
      state = reduce(state, { type: "turn_start" })
      state = reduce(state, { type: "text_delta", text: "Hi there" })
      state = reduce(state, { type: "turn_complete" })
      expect(state.lastTurnFiles).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // Duplicate assistant block prevention
  // -----------------------------------------------------------------------

  describe("duplicate assistant block prevention", () => {
    it("text_complete after tool_use_start does not create duplicate assistant block", () => {
      // Scenario: Codex adapter emits text_delta during streaming, tool_use_start
      // flushes the text, then text_complete arrives with the same finalized text.
      // The text_complete should NOT create a second assistant block.
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "Let me check the diagnostics." },
        { type: "tool_use_start", id: "t1", tool: "ToolSearch", input: {} },
        // text_complete arrives after tool_use_start already flushed the text
        { type: "text_complete", text: "Let me check the diagnostics." },
        { type: "tool_use_end", id: "t1", output: "results" },
        { type: "turn_complete" },
      ])
      // Should be exactly 2 blocks: one assistant + one tool
      const assistantBlocks = state.blocks.filter(b => b.type === "assistant")
      expect(assistantBlocks).toHaveLength(1)
      expect(assistantBlocks[0]!).toMatchObject({ type: "assistant", text: "Let me check the diagnostics." })
      expect(state.blocks).toHaveLength(2)
    })

    it("text_complete after tool_use_start with different text keeps the original flushed text", () => {
      // Edge case: text_complete finalizes with slightly different text than
      // what was streamed. The original (already flushed) version should be kept.
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "partial te" },
        { type: "text_delta", text: "xt" },
        { type: "tool_use_start", id: "t1", tool: "Read", input: {} },
        // text_complete with finalized text — but text was already flushed
        { type: "text_complete", text: "partial text" },
        { type: "turn_complete" },
      ])
      const assistantBlocks = state.blocks.filter(b => b.type === "assistant")
      expect(assistantBlocks).toHaveLength(1)
      expect(state.blocks).toHaveLength(2)
    })

    it("multi-step turn with text_complete after each tool does not duplicate", () => {
      // Simulates Codex-style flow: text + tool + text_complete per step
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        // Step 1: text → tool → text_complete
        { type: "text_delta", text: "Reading file..." },
        { type: "tool_use_start", id: "t1", tool: "Read", input: {} },
        { type: "text_complete", text: "Reading file..." },
        { type: "tool_use_end", id: "t1", output: "contents" },
        // Step 2: text → tool → text_complete
        { type: "text_delta", text: "Now editing..." },
        { type: "tool_use_start", id: "t2", tool: "Edit", input: {} },
        { type: "text_complete", text: "Now editing..." },
        { type: "tool_use_end", id: "t2", output: "done" },
        { type: "turn_complete" },
      ])
      const assistantBlocks = state.blocks.filter(b => b.type === "assistant")
      expect(assistantBlocks).toHaveLength(2)
      expect(assistantBlocks[0]!).toMatchObject({ type: "assistant", text: "Reading file..." })
      expect(assistantBlocks[1]!).toMatchObject({ type: "assistant", text: "Now editing..." })
      expect(state.blocks).toHaveLength(4) // 2 assistant + 2 tool
    })

    it("consecutive identical text_delta sequences with tool_use_start produce one block each", () => {
      // Guard against adjacent duplicate assistant blocks from separate flush triggers
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "Same text" },
        { type: "tool_use_start", id: "t1", tool: "Bash", input: {} },
        { type: "tool_use_end", id: "t1", output: "ok" },
        // Second step with different text
        { type: "text_delta", text: "Different text" },
        { type: "tool_use_start", id: "t2", tool: "Bash", input: {} },
        { type: "tool_use_end", id: "t2", output: "ok" },
        { type: "turn_complete" },
      ])
      const assistantBlocks = state.blocks.filter(b => b.type === "assistant")
      expect(assistantBlocks).toHaveLength(2)
      expect(assistantBlocks[0]!).toMatchObject({ text: "Same text" })
      expect(assistantBlocks[1]!).toMatchObject({ text: "Different text" })
    })

    it("text_complete without prior text_delta still creates block", () => {
      // text_complete alone (no streaming) should work normally
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "turn_start" },
        { type: "text_complete", text: "Direct message" },
        { type: "turn_complete" },
      ])
      expect(state.blocks).toHaveLength(1)
      expect(state.blocks[0]!).toMatchObject({ type: "assistant", text: "Direct message" })
    })

    it("state is reconstructable without duplicate blocks", () => {
      // Validates the event sequence from the "state is reconstructable" test
      // doesn't produce duplicates
      const events: AgentEvent[] = [
        { type: "session_init", tools: [{ name: "Read" }], models: [] },
        { type: "turn_start" },
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world" },
        { type: "tool_use_start", id: "t1", tool: "Read", input: { path: "/x" } },
        { type: "tool_use_end", id: "t1", output: "contents" },
        { type: "text_complete", text: "Hello world" },
        { type: "turn_complete", usage: { inputTokens: 100, outputTokens: 50 } },
      ]
      const state = applyEvents(events)
      // Must have exactly 2 blocks: 1 assistant + 1 tool (NOT 3 with duplicate assistant)
      const assistantBlocks = state.blocks.filter(b => b.type === "assistant")
      expect(assistantBlocks).toHaveLength(1)
      expect(assistantBlocks[0]!).toMatchObject({ text: "Hello world" })
      expect(state.blocks).toHaveLength(2)
    })
  })

  // -----------------------------------------------------------------------
  // Resume lifecycle (SystemEvents)
  // -----------------------------------------------------------------------

  describe("history_load_started / history_loaded / history_load_failed", () => {
    const sampleSummary: SessionResumeSummary = {
      sessionId: "abc-123",
      origin: "gemini",
      target: "gemini",
      messageCount: 12,
      toolCallCount: 3,
      turnCount: 6,
      lastActiveAt: Date.now() - 3_600_000,
      usage: {
        inputTokens: 10_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        contextTokens: 10_000,
      },
      contextWindowTokens: 200_000,
      filePath: "/tmp/session.json",
    }

    function reduceSeq(events: ConversationEvent[]): ConversationState {
      return events.reduce((s, e) => reduce(s, e), createInitialState())
    }

    it("history_load_started sets state.resuming = true", () => {
      const state = reduceSeq([
        {
          type: "history_load_started",
          sessionId: "abc-123",
          filePath: "/tmp/session.json",
          origin: "gemini",
        },
      ])
      expect(state.resuming).toBe(true)
      expect(state.blocks).toHaveLength(0)
    })

    it("history_loaded appends a session_resume_summary block and clears resuming", () => {
      const state = reduceSeq([
        {
          type: "history_load_started",
          sessionId: "abc-123",
          filePath: "/tmp/session.json",
          origin: "gemini",
        },
        {
          type: "history_loaded",
          sessionId: "abc-123",
          origin: "gemini",
          target: "gemini",
          summary: sampleSummary,
        },
      ])
      expect(state.resuming).toBe(false)
      expect(state.blocks).toHaveLength(1)
      const block = state.blocks[0]!
      expect(block.type).toBe("session_resume_summary")
      expect((block as any).sessionId).toBe("abc-123")
      expect((block as any).messageCount).toBe(12)
      expect((block as any).usage.contextTokens).toBe(10_000)
    })

    it("history_loaded event fields override fields inside summary", () => {
      const state = reduceSeq([
        {
          type: "history_loaded",
          sessionId: "from-event",
          origin: "codex",
          target: "claude",
          summary: { ...sampleSummary, sessionId: "stale", origin: "gemini", target: "gemini" },
        },
      ])
      const block = state.blocks[0]! as any
      expect(block.sessionId).toBe("from-event")
      expect(block.origin).toBe("codex")
      expect(block.target).toBe("claude")
    })

    it("history_load_failed appends an error block with sessionId, filePath, and error details", () => {
      const state = reduceSeq([
        {
          type: "history_load_started",
          sessionId: "bad-id",
          filePath: "/tmp/missing.json",
          origin: "gemini",
        },
        {
          type: "history_load_failed",
          sessionId: "bad-id",
          filePath: "/tmp/missing.json",
          origin: "gemini",
          error: "Unexpected end of JSON input",
          details: "SyntaxError: Unexpected end of JSON input\n    at parse (<anonymous>)",
        },
      ])
      expect(state.resuming).toBe(false)
      expect(state.blocks).toHaveLength(1)
      const block = state.blocks[0]!
      expect(block.type).toBe("error")
      const errorBlock = block as Extract<Block, { type: "error" }>
      expect(errorBlock.code).toBe("history_load_failed")
      expect(errorBlock.message).toContain("bad-id")
      expect(errorBlock.message).toContain("/tmp/missing.json")
      expect(errorBlock.message).toContain("Unexpected end of JSON input")
      expect(errorBlock.message).toContain("Starting a fresh session")
    })

    it("history_load_failed clears resuming even if started never fired", () => {
      const state = reduceSeq([
        {
          type: "history_load_failed",
          sessionId: "orphan",
          error: "file not found",
        },
      ])
      expect(state.resuming).toBe(false)
      expect(state.blocks).toHaveLength(1)
    })
  })

  describe("worktree / cwd lifecycle", () => {
    it("starts with no worktree and null currentCwd", () => {
      const state = createInitialState()
      expect(state.worktree).toBeNull()
      expect(state.currentCwd).toBeNull()
    })

    it("worktree_created populates the worktree field", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        {
          type: "worktree_created",
          name: "feature-x",
          path: "/repo/.claude/worktrees/feature-x",
        },
      ])
      expect(state.worktree).toEqual({
        path: "/repo/.claude/worktrees/feature-x",
        name: "feature-x",
      })
    })

    it("cwd_changed updates currentCwd", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "cwd_changed", oldCwd: "/a", newCwd: "/b" },
      ])
      expect(state.currentCwd).toBe("/b")
    })

    it("worktree_removed clears the worktree when paths match", () => {
      const path = "/repo/.claude/worktrees/feature-x"
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        { type: "worktree_created", name: "feature-x", path },
        { type: "worktree_removed", path },
      ])
      expect(state.worktree).toBeNull()
    })

    it("worktree_removed is a no-op when paths do not match", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        {
          type: "worktree_created",
          name: "feature-x",
          path: "/repo/.claude/worktrees/feature-x",
        },
        { type: "worktree_removed", path: "/repo/.claude/worktrees/other" },
      ])
      expect(state.worktree).toEqual({
        path: "/repo/.claude/worktrees/feature-x",
        name: "feature-x",
      })
    })

    it("does not append any block (keeps transcript clean)", () => {
      const state = applyEvents([
        { type: "session_init", tools: [], models: [] },
        {
          type: "worktree_created",
          name: "feature-x",
          path: "/repo/.claude/worktrees/feature-x",
        },
        { type: "cwd_changed", oldCwd: "", newCwd: "/repo/.claude/worktrees/feature-x" },
        {
          type: "worktree_removed",
          path: "/repo/.claude/worktrees/feature-x",
        },
      ])
      // Blocks should be unchanged by worktree/cwd events
      expect(state.blocks).toHaveLength(0)
    })
  })
})
