import { describe, expect, it } from "bun:test"
import {
  mapSDKMessage,
  mapAssistantMessage,
  mapStreamEvent,
  synthesizeWorktreeEvents,
  ToolStreamState,
} from "../../src/backends/claude/event-mapper"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(): ToolStreamState {
  return new ToolStreamState()
}

// ---------------------------------------------------------------------------
// mapSDKMessage — system messages
// ---------------------------------------------------------------------------

describe("Claude Event Mapper — mapSDKMessage", () => {
  describe("system init", () => {
    it("maps system init to session_init with tools and model", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "init",
          model: "claude-opus-4-6",
          tools: ["Read", "Edit", "Bash"],
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("session_init")
      const init = events[0] as any
      expect(init.tools).toEqual([
        { name: "Read" },
        { name: "Edit" },
        { name: "Bash" },
      ])
      expect(init.models).toHaveLength(1)
      expect(init.models[0].id).toBe("claude-opus-4-6")
      expect(init.models[0].provider).toBe("anthropic")
    })

    it("extracts context window from [1M context] suffix", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "init",
          model: "claude-opus-4-6 [1M context]",
          tools: [],
        },
        freshState(),
      )

      const init = events[0] as any
      expect(init.models[0].id).toBe("claude-opus-4-6")
      expect(init.models[0].contextWindow).toBe(1_000_000)
    })

    it("extracts context window from [200K context] suffix", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4 [200K context]",
          tools: [],
        },
        freshState(),
      )

      const init = events[0] as any
      expect(init.models[0].id).toBe("claude-sonnet-4")
      expect(init.models[0].contextWindow).toBe(200_000)
    })

    it("extracts context window from compact [1m] format", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "init",
          model: "claude-opus-4-6[1m]",
          tools: [],
        },
        freshState(),
      )

      const init = events[0] as any
      expect(init.models[0].id).toBe("claude-opus-4-6")
      expect(init.models[0].contextWindow).toBe(1_000_000)
    })

    it("extracts context window from (1M context) parenthetical", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "init",
          model: "opus (1M context)",
          tools: [],
        },
        freshState(),
      )

      const init = events[0] as any
      expect(init.models[0].id).toBe("opus")
      expect(init.models[0].contextWindow).toBe(1_000_000)
    })

    it("handles missing model gracefully", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "init",
          tools: ["Bash"],
        },
        freshState(),
      )

      const init = events[0] as any
      expect(init.models).toEqual([])
      expect(init.tools).toHaveLength(1)
    })

    it("handles missing tools gracefully", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4",
        },
        freshState(),
      )

      const init = events[0] as any
      expect(init.tools).toEqual([])
    })

    it("includes session_id when present", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4",
          tools: [],
          session_id: "sess-123",
        },
        freshState(),
      )

      const init = events[0] as any
      expect(init.sessionId).toBe("sess-123")
    })

    it("includes account when present", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4",
          tools: [],
          account: { plan: "pro" },
        },
        freshState(),
      )

      const init = events[0] as any
      expect(init.account).toEqual({ plan: "pro" })
    })
  })

  describe("system status", () => {
    it("emits in-progress compact event on compacting status", () => {
      const events = mapSDKMessage(
        { type: "system", subtype: "status", status: "compacting" },
        freshState(),
      )
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("compact")
      expect((events[0] as any).inProgress).toBe(true)
      expect((events[0] as any).trigger).toBe("user")
    })

    it("ignores other status events", () => {
      const events = mapSDKMessage(
        { type: "system", subtype: "status", status: "thinking" },
        freshState(),
      )
      expect(events).toHaveLength(0)
    })
  })

  describe("compact boundary", () => {
    it("maps compact_boundary to compact event", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 50000 },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("compact")
      expect((events[0] as any).trigger).toBe("auto")
      expect((events[0] as any).preTokens).toBe(50000)
    })

    it("handles missing compact_metadata gracefully", () => {
      const events = mapSDKMessage(
        { type: "system", subtype: "compact_boundary" },
        freshState(),
      )

      expect(events).toHaveLength(1)
      const compact = events[0] as any
      expect(compact.type).toBe("compact")
      expect(compact.summary).toBe("Conversation compacted.")
      expect(compact.trigger).toBe("user")
    })
  })

  describe("local_command_output", () => {
    it("maps to system_message", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "local_command_output",
          content: "Command output here",
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "system_message",
        text: "Command output here",
      })
    })

    it("suppresses empty/missing content", () => {
      const events = mapSDKMessage(
        { type: "system", subtype: "local_command_output" },
        freshState(),
      )

      expect(events).toHaveLength(0)
    })

    it("suppresses trivial compact output with XML tags", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "local_command_output",
          content: "<local-command-stdout>Compacted </local-command-stdout>",
        },
        freshState(),
      )

      expect(events).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // stream_event passthrough
  // ---------------------------------------------------------------------------

  describe("stream_event", () => {
    it("delegates to mapStreamEvent and sets hasReceivedStreamEvent", () => {
      const state = freshState()
      expect(state.hasReceivedStreamEvent).toBe(false)

      const events = mapSDKMessage(
        {
          type: "stream_event",
          event: { type: "message_start", message: {} },
          parent_tool_use_id: null,
        },
        state,
      )

      expect(state.hasReceivedStreamEvent).toBe(true)
      expect(events.some((e) => e.type === "turn_start")).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // assistant messages
  // ---------------------------------------------------------------------------

  describe("assistant messages", () => {
    it("skips assistant messages in V1 live mode when stream events already covered the turn", () => {
      const state = freshState()
      // Simulate a turn that actually streamed: flags reflect both "ever seen
      // stream events" and "≥1 stream event this turn". The assistant message
      // is a redundant final copy of the delta content, so it should be skipped.
      state.hasReceivedStreamEvent = true
      state.streamEventsThisTurn = 3

      const events = mapSDKMessage(
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Hello!" }],
          },
        },
        state,
      )

      expect(events).toHaveLength(0)
    })

    it("falls back to mapAssistantMessage when V1 turn arrives with no stream events (bug: silent content drop)", () => {
      const state = freshState()
      // Prior turn streamed, flipping the sticky flag. THIS turn arrived with
      // no stream events at all (SDK collapsed partials into the final
      // assistant message — observed in the wild after tool-use turns).
      state.hasReceivedStreamEvent = true
      state.streamEventsThisTurn = 0

      const events = mapSDKMessage(
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Recovered content" }],
          },
        },
        state,
      )

      // Must emit turn_start + text_delta so the UI renders the response.
      // No synthetic turn_complete — the following `result` message emits one.
      expect(events.some((e) => e.type === "turn_start")).toBe(true)
      const textDelta = events.find((e) => e.type === "text_delta")
      expect(textDelta).toBeTruthy()
      expect((textDelta as { type: "text_delta"; text: string }).text).toBe("Recovered content")
      expect(events.some((e) => e.type === "turn_complete")).toBe(false)
    })

    it("result message resets streamEventsThisTurn so the next turn starts clean", () => {
      const state = freshState()
      state.hasReceivedStreamEvent = true
      state.streamEventsThisTurn = 7

      mapSDKMessage(
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        state,
      )

      expect(state.streamEventsThisTurn).toBe(0)
      // Sticky flag must stay true — we still remember the session ever streamed
      expect(state.hasReceivedStreamEvent).toBe(true)
    })

    it("maps assistant messages in V2 mode (mapAssistant: true)", () => {
      const state = freshState()

      const events = mapSDKMessage(
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Hello!" }],
          },
        },
        state,
        { mapAssistant: true },
      )

      expect(events.length).toBeGreaterThan(0)
      expect(events.some((e) => e.type === "turn_start")).toBe(true)
      expect(events.some((e) => e.type === "text_delta")).toBe(true)
    })

    it("maps assistant messages in replay mode with synthetic turn_complete", () => {
      const state = freshState()
      // hasReceivedStreamEvent = false (default) + !mapAssistant = replay mode

      const events = mapSDKMessage(
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Replayed answer" }],
          },
        },
        state,
      )

      expect(events.some((e) => e.type === "turn_start")).toBe(true)
      expect(events.some((e) => e.type === "text_delta")).toBe(true)
      // Replay mode adds synthetic turn_complete
      const lastEvent = events[events.length - 1]!
      expect(lastEvent.type).toBe("turn_complete")
      expect((lastEvent as any).usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
      })
    })
  })

  // ---------------------------------------------------------------------------
  // result messages
  // ---------------------------------------------------------------------------

  describe("result messages", () => {
    it("maps success result to turn_complete with usage", () => {
      const events = mapSDKMessage(
        {
          type: "result",
          subtype: "success",
          session_id: "sess-abc",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
          },
          total_cost_usd: 0.015,
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("turn_complete")
      const tc = events[0] as any
      expect(tc.sessionId).toBe("sess-abc")
      expect(tc.usage.inputTokens).toBe(100)
      expect(tc.usage.outputTokens).toBe(50)
      expect(tc.usage.cacheReadTokens).toBe(20)
      expect(tc.usage.cacheWriteTokens).toBe(5)
      expect(tc.usage.totalCostUsd).toBe(0.015)
    })

    it("maps non-error result without subtype to turn_complete", () => {
      const events = mapSDKMessage(
        {
          type: "result",
          is_error: false,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("turn_complete")
    })

    it("maps error result to error + turn_complete", () => {
      const events = mapSDKMessage(
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Something went wrong"],
          usage: { input_tokens: 100, output_tokens: 0 },
          total_cost_usd: 0.001,
        },
        freshState(),
      )

      expect(events).toHaveLength(2)
      expect(events[0]!.type).toBe("error")
      const err = events[0] as any
      expect(err.code).toBe("error_during_execution")
      expect(err.message).toBe("Something went wrong")
      expect(err.severity).toBe("fatal")

      expect(events[1]!.type).toBe("turn_complete")
    })

    it("cleans error messages — strips stack traces and deduplicates", () => {
      const events = mapSDKMessage(
        {
          type: "result",
          is_error: true,
          errors: [
            "Error: connection failed\n    at Socket.connect (net.js:100)\n    at Object.<anonymous> (app.js:5)",
            "Error: connection failed\n    at Socket.connect (net.js:100)",
          ],
          usage: {},
        },
        freshState(),
      )

      const err = events[0] as any
      // Both errors should be deduped to one "Error: connection failed"
      expect(err.message).toBe("Error: connection failed")
    })

    it("caps error message at 200 characters", () => {
      const longError = "A".repeat(300)
      const events = mapSDKMessage(
        {
          type: "result",
          is_error: true,
          errors: [longError],
          usage: {},
        },
        freshState(),
      )

      const err = events[0] as any
      expect(err.message.length).toBeLessThanOrEqual(200)
      expect(err.message).toEndWith("...")
    })

    it("handles missing usage gracefully", () => {
      const events = mapSDKMessage(
        {
          type: "result",
          subtype: "success",
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      const tc = events[0] as any
      expect(tc.usage.inputTokens).toBe(0)
      expect(tc.usage.outputTokens).toBe(0)
    })

    it("flushes captured ttft_ms onto turn_complete", () => {
      // TTFT is captured when the SDK emits its first partial assistant
      // stream_event (SDK 0.2.112+). The mapper stashes it on ToolStreamState
      // and drains it on the subsequent `result` message so the TUI can
      // show it in the status bar after the turn finishes.
      const state = freshState()

      // Simulate a partial assistant stream event that carries ttft_ms.
      mapSDKMessage(
        {
          type: "stream_event",
          ttft_ms: 1234,
          event: { type: "message_start", message: { usage: {} } },
          parent_tool_use_id: null,
        },
        state,
      )
      // A second stream_event with a different ttft_ms should NOT overwrite
      // the first — we keep the earliest report for the turn.
      mapSDKMessage(
        {
          type: "stream_event",
          ttft_ms: 9999,
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" }, index: 0 },
          parent_tool_use_id: null,
        },
        state,
      )

      const events = mapSDKMessage(
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        state,
      )

      expect(events).toHaveLength(1)
      expect((events[0] as any).ttftMs).toBe(1234)
    })

    it("resets ttft capture between turns", () => {
      // Guarantees stale TTFT doesn't leak into a later turn where the SDK
      // stopped reporting the field — the mapper drains its stash on every
      // result and starts each turn from undefined.
      const state = freshState()

      mapSDKMessage(
        {
          type: "stream_event",
          ttft_ms: 800,
          event: { type: "message_start", message: { usage: {} } },
          parent_tool_use_id: null,
        },
        state,
      )
      mapSDKMessage({ type: "result", subtype: "success" }, state)

      // Second turn has no ttft_ms at all.
      mapSDKMessage(
        {
          type: "stream_event",
          event: { type: "message_start", message: { usage: {} } },
          parent_tool_use_id: null,
        },
        state,
      )
      const second = mapSDKMessage({ type: "result", subtype: "success" }, state)
      expect((second[0] as any).ttftMs).toBeUndefined()
    })

    it("ignores ttft_ms from sub-agent stream events", () => {
      // Sub-agent partials (parent_tool_use_id set) carry their own TTFT but
      // shouldn't influence the main turn's figure. The status bar surfaces
      // the user-facing turn, not skills running underneath it.
      const state = freshState()

      mapSDKMessage(
        {
          type: "stream_event",
          ttft_ms: 500,
          parent_tool_use_id: "tool-abc",
          event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Bash" }, index: 0 },
        },
        state,
      )
      const events = mapSDKMessage(
        { type: "result", subtype: "success" },
        state,
      )
      expect((events[0] as any).ttftMs).toBeUndefined()
    })

    it("passes through ttft_ms even on error results", () => {
      // An errored turn still has a meaningful TTFT — the first-token latency
      // up to the point the error fired. Expose it so the status bar stays
      // useful after failures.
      const state = freshState()
      mapSDKMessage(
        {
          type: "stream_event",
          ttft_ms: 2100,
          event: { type: "message_start", message: { usage: {} } },
          parent_tool_use_id: null,
        },
        state,
      )

      const events = mapSDKMessage(
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["boom"],
          usage: {},
        },
        state,
      )
      // [error, turn_complete]
      expect(events).toHaveLength(2)
      expect((events[1] as any).type).toBe("turn_complete")
      expect((events[1] as any).ttftMs).toBe(2100)
    })

    it("handles missing errors array on error result", () => {
      const events = mapSDKMessage(
        {
          type: "result",
          is_error: true,
          usage: {},
        },
        freshState(),
      )

      const err = events[0] as any
      expect(err.message).toBe("Unknown error")
    })

    it("forwards duration_ms from the SDK onto turn_complete for the baked-for line", () => {
      // The TUI renders a "Baked for X · Y tokens · $Z" summary after each
      // turn using the reducer's lastTurnSummary. The mapper must pass the
      // SDK's wall-clock duration through so that line can show time.
      const events = mapSDKMessage(
        {
          type: "result",
          subtype: "success",
          duration_ms: 45123,
          total_cost_usd: 0.0421,
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect((events[0] as any).type).toBe("turn_complete")
      expect((events[0] as any).durationMs).toBe(45123)
      expect((events[0] as any).usage.totalCostUsd).toBe(0.0421)
    })

    it("forwards duration_ms on error results too (failed turns still took time)", () => {
      const events = mapSDKMessage(
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          duration_ms: 12000,
          errors: ["boom"],
          usage: {},
        },
        freshState(),
      )

      // [error, turn_complete]
      expect(events).toHaveLength(2)
      expect((events[1] as any).type).toBe("turn_complete")
      expect((events[1] as any).durationMs).toBe(12000)
    })

    it("leaves durationMs undefined when the SDK omits it", () => {
      const events = mapSDKMessage(
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        freshState(),
      )
      expect((events[0] as any).durationMs).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // tool_progress
  // ---------------------------------------------------------------------------

  describe("tool_progress", () => {
    it("maps to tool_use_progress", () => {
      const events = mapSDKMessage(
        {
          type: "tool_progress",
          tool_use_id: "tool-1",
          content: "Executing...",
          tool_name: "Bash",
          elapsed_time_seconds: 5,
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "tool_use_progress",
        id: "tool-1",
        output: "Executing...",
      })
    })

    it("generates fallback output from tool_name and elapsed time", () => {
      const events = mapSDKMessage(
        {
          type: "tool_progress",
          tool_use_id: "tool-2",
          tool_name: "Read",
          elapsed_time_seconds: 10,
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect((events[0] as any).output).toBe("[Read] 10s elapsed")
    })
  })

  // ---------------------------------------------------------------------------
  // task events
  // ---------------------------------------------------------------------------

  describe("task lifecycle", () => {
    it("maps task_started to task_start", () => {
      const events = mapSDKMessage(
        {
          type: "task_started",
          task_id: "task-1",
          description: "Running tests",
          tool_use_id: "tool-1",
          task_type: "background",
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "task_start",
        taskId: "task-1",
        description: "Running tests",
        toolUseId: "tool-1",
        taskType: "background",
        skipTranscript: undefined,
      })
    })

    it("maps task_started with uuid fallback", () => {
      const events = mapSDKMessage(
        {
          type: "task_started",
          uuid: "uuid-1",
          description: "Compiling",
        },
        freshState(),
      )

      expect((events[0] as any).taskId).toBe("uuid-1")
    })

    it("maps task_progress", () => {
      const events = mapSDKMessage(
        {
          type: "task_progress",
          task_id: "task-1",
          content: "50% complete",
          last_tool_name: "Bash",
          summary: "Halfway done",
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "task_progress",
        taskId: "task-1",
        output: "50% complete",
        lastToolName: "Bash",
        summary: "Halfway done",
      })
    })

    it("maps task_notification to task_complete", () => {
      const events = mapSDKMessage(
        {
          type: "task_notification",
          task_id: "task-1",
          content: "All tests passed",
          tool_use_id: "tool-1",
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "task_complete",
        taskId: "task-1",
        output: "All tests passed",
        toolUseId: "tool-1",
        skipTranscript: undefined,
      })
    })
  })

  // ---------------------------------------------------------------------------
  // task lifecycle — modern SDK shape (type: "system", subtype: "task_*")
  // ---------------------------------------------------------------------------

  describe("task lifecycle (SDK 0.2.107+ system-subtype shape)", () => {
    it("maps system/task_started to task_start", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          tool_use_id: "tool-1",
          description: "Explore codebase",
          task_type: "Explore",
          prompt: "Find all API endpoints",
          uuid: "uuid-1",
          session_id: "sess-1",
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "task_start",
        taskId: "task-1",
        description: "Explore codebase",
        toolUseId: "tool-1",
        taskType: "Explore",
        skipTranscript: undefined,
      })
    })

    it("maps system/task_progress using description as output", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "task_progress",
          task_id: "task-1",
          tool_use_id: "tool-1",
          description: "Reading files",
          usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 5000 },
          last_tool_name: "Read",
          summary: "Making good progress",
          uuid: "uuid-1",
          session_id: "sess-1",
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      const ev = events[0] as any
      expect(ev.type).toBe("task_progress")
      expect(ev.taskId).toBe("task-1")
      expect(ev.output).toBe("Reading files")
      expect(ev.lastToolName).toBe("Read")
      expect(ev.summary).toBe("Making good progress")
      expect(ev.tokenUsage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 1200,
      })
      expect(ev.toolUseCount).toBe(3)
    })

    it("maps system/task_notification with status=completed", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "task_notification",
          task_id: "task-1",
          tool_use_id: "tool-1",
          status: "completed",
          output_file: "/tmp/task-1.log",
          summary: "Found 12 matches",
          uuid: "uuid-1",
          session_id: "sess-1",
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      const ev = events[0] as any
      expect(ev.type).toBe("task_complete")
      expect(ev.taskId).toBe("task-1")
      expect(ev.output).toBe("Found 12 matches")
      expect(ev.toolUseId).toBe("tool-1")
      expect(ev.state).toBe("completed")
      expect(ev.errorMessage).toBeUndefined()
    })

    it("maps system/task_notification with status=failed to error state", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "task_notification",
          task_id: "task-1",
          status: "failed",
          summary: "Tool invocation crashed",
          uuid: "uuid-1",
          session_id: "sess-1",
        },
        freshState(),
      )

      const ev = events[0] as any
      expect(ev.type).toBe("task_complete")
      expect(ev.state).toBe("error")
      expect(ev.errorMessage).toBe("Tool invocation crashed")
      expect(ev.output).toBe("Tool invocation crashed")
    })

    it("maps system/task_notification with status=stopped to error state", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "task_notification",
          task_id: "task-1",
          status: "stopped",
          summary: "Aborted by user",
          uuid: "uuid-1",
          session_id: "sess-1",
        },
        freshState(),
      )

      const ev = events[0] as any
      expect(ev.state).toBe("error")
      expect(ev.errorMessage).toBe("Aborted by user")
    })

    it("does NOT log a warning for system-subtype task events", () => {
      // Regression check for the log flood we saw:
      //   [WARN ] Unhandled system subtype {"subtype":"task_started"}
      // Mapped events must not land in the backend_specific catch-all.
      const warnings: any[] = []
      const origWarn = console.warn
      console.warn = (...args: any[]) => { warnings.push(args) }
      try {
        for (const subtype of ["task_started", "task_progress", "task_notification"]) {
          const events = mapSDKMessage(
            {
              type: "system",
              subtype,
              task_id: "t",
              description: "d",
              status: "completed",
            },
            freshState(),
          )
          // Must not be backend_specific (that's the catch-all fallback)
          expect(events.every((e) => e.type !== "backend_specific")).toBe(true)
        }
      } finally {
        console.warn = origWarn
      }
    })
  })

  // ---------------------------------------------------------------------------
  // rate_limit
  // ---------------------------------------------------------------------------

  describe("rate_limit", () => {
    it("maps to recoverable error", () => {
      const events = mapSDKMessage(
        { type: "rate_limit" },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "error",
        code: "rate_limit",
        message: "Rate limited by API",
        severity: "recoverable",
      })
    })
  })

  // ---------------------------------------------------------------------------
  // user messages (tool results)
  // ---------------------------------------------------------------------------

  describe("user messages — tool results", () => {
    it("extracts tool_use_end from tool_result content block", () => {
      const events = mapSDKMessage(
        {
          type: "user",
          tool_use_result: true,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "file contents here",
                is_error: false,
              },
            ],
          },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "tool_use_end",
        id: "tool-1",
        output: "file contents here",
        error: undefined,
      })
    })

    it("marks tool error when is_error is true", () => {
      const events = mapSDKMessage(
        {
          type: "user",
          tool_use_result: true,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "Permission denied",
                is_error: true,
              },
            ],
          },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      const end = events[0] as any
      expect(end.error).toBe("Permission denied")
    })

    it("extracts text from array content blocks", () => {
      const events = mapSDKMessage(
        {
          type: "user",
          tool_use_result: true,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: [
                  { type: "text", text: "line 1" },
                  { type: "image", data: "..." },
                  { type: "text", text: "line 2" },
                ],
              },
            ],
          },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect((events[0] as any).output).toBe("line 1\nline 2")
    })

    it("falls back to msg.tool_use_id when missing from content", () => {
      const events = mapSDKMessage(
        {
          type: "user",
          tool_use_result: "result text",
          tool_use_id: "tool-fallback",
          message: { content: [] },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect((events[0] as any).id).toBe("tool-fallback")
      expect((events[0] as any).output).toBe("result text")
    })

    it("falls back to tool_use_result object with tool_use_id", () => {
      const events = mapSDKMessage(
        {
          type: "user",
          tool_use_result: {
            tool_use_id: "tool-obj",
            content: "object content",
          },
          message: { content: [] },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect((events[0] as any).id).toBe("tool-obj")
      expect((events[0] as any).output).toBe("object content")
    })

    it("falls back to __last_running__ when no tool_use_id anywhere", () => {
      const events = mapSDKMessage(
        {
          type: "user",
          tool_use_result: "some output",
          message: { content: [] },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect((events[0] as any).id).toBe("__last_running__")
    })

    it("detects error from msg-level is_error flag", () => {
      const events = mapSDKMessage(
        {
          type: "user",
          tool_use_result: "bad result",
          tool_use_id: "tool-1",
          is_error: true,
          message: { content: [] },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      const end = events[0] as any
      expect(end.error).toBe("bad result")
    })

    it("detects error from tool_use_result.error field", () => {
      const events = mapSDKMessage(
        {
          type: "user",
          tool_use_result: {
            tool_use_id: "tool-1",
            error: "Something broke",
          },
          message: { content: [] },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      const end = events[0] as any
      expect(end.error).toBe("Something broke")
    })
  })

  describe("user messages — replay", () => {
    it("extracts text content from replayed user message", () => {
      const events = mapSDKMessage(
        {
          type: "user",
          message: {
            content: [
              { type: "text", text: "What is 2+2?" },
            ],
          },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "user_message",
        text: "What is 2+2?",
      })
    })

    it("handles string content", () => {
      const events = mapSDKMessage(
        {
          type: "user",
          message: {
            content: "Plain string content",
          },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect((events[0] as any).text).toBe("Plain string content")
    })

    it("skips subagent prompts (parent_tool_use_id present)", () => {
      const events = mapSDKMessage(
        {
          type: "user",
          parent_tool_use_id: "parent-tool-1",
          message: {
            content: [{ type: "text", text: "Subagent instruction" }],
          },
        },
        freshState(),
      )

      expect(events).toHaveLength(0)
    })

    it("skips empty text content", () => {
      const events = mapSDKMessage(
        {
          type: "user",
          message: {
            content: [{ type: "image", data: "..." }],
          },
        },
        freshState(),
      )

      expect(events).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // rate_limit_event (informational)
  // ---------------------------------------------------------------------------

  describe("rate_limit_event", () => {
    it("maps a five_hour bucket to a typed rate_limit_update", () => {
      const msg = {
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "five_hour",
          status: "allowed",
          utilization: 0.42,
          resetsAt: 1775019636,
          isUsingOverage: false,
        },
      }
      const events = mapSDKMessage(msg, freshState())

      expect(events).toHaveLength(1)
      const ev = events[0]! as any
      expect(ev.type).toBe("rate_limit_update")
      expect(ev.rateLimitType).toBe("five_hour")
      expect(ev.utilization).toBe(0.42)
      expect(ev.resetsAt).toBe(1775019636)
      expect(ev.status).toBe("allowed")
      expect(ev.isUsingOverage).toBe(false)
      expect(ev.source).toBe("claude")
    })

    it("preserves 7-day sub-type variants (opus/sonnet)", () => {
      const events = mapSDKMessage(
        {
          type: "rate_limit_event",
          rate_limit_info: { rateLimitType: "seven_day_opus", utilization: 0.9 },
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      const ev = events[0]! as any
      expect(ev.type).toBe("rate_limit_update")
      expect(ev.rateLimitType).toBe("seven_day_opus")
    })

    it("falls back to backend_specific when rateLimitType is missing/unknown", () => {
      const msg = {
        type: "rate_limit_event",
        rate_limit_info: { remaining: 100 },
      }
      const events = mapSDKMessage(msg, freshState())

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("backend_specific")
      expect((events[0] as any).backend).toBe("claude")
      expect((events[0] as any).data).toBe(msg)
    })
  })

  // ---------------------------------------------------------------------------
  // unknown message types
  // ---------------------------------------------------------------------------

  describe("unknown message types", () => {
    it("maps to backend_specific event", () => {
      const msg = { type: "future_event", data: "hello" }
      const events = mapSDKMessage(msg, freshState())

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("backend_specific")
      expect((events[0] as any).backend).toBe("claude")
    })
  })

  // ---------------------------------------------------------------------------
  // SDK 0.2.107+ new system subtypes
  // ---------------------------------------------------------------------------

  describe("system memory_recall (SDK 0.2.107+)", () => {
    it("maps memory_recall to system_message with formatted summary", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "memory_recall",
        mode: "select",
        memories: [
          { path: "~/.claude/memories/coding.md", scope: "personal" },
          { path: "/team/.claude/memories/style.md", scope: "team", content: "..." },
        ],
      }, freshState())

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("system_message")
      const msg = events[0] as any
      expect(msg.text).toContain("Recalled 2 memories")
      expect(msg.text).toContain("[personal]")
      expect(msg.text).toContain("[team]")
    })

    it("produces no events for empty memories array", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "memory_recall",
        mode: "synthesize",
        memories: [],
      }, freshState())

      expect(events).toHaveLength(0)
    })

    it("uses 'Synthesized' label for synthesize mode", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "memory_recall",
        mode: "synthesize",
        memories: [{ path: "<synthesis:~/.claude>", scope: "personal" }],
      }, freshState())

      expect(events).toHaveLength(1)
      expect((events[0] as any).text).toContain("Synthesized 1 memory")
    })

    it("handles missing memories array gracefully", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "memory_recall",
        mode: "select",
      }, freshState())

      expect(events).toHaveLength(0)
    })
  })

  describe("system notification (SDK 0.2.107+)", () => {
    it("maps to ephemeral system_message", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "notification",
        key: "update-available",
        text: "A new version is available",
        priority: "medium",
      }, freshState())

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "system_message",
        text: "A new version is available",
        ephemeral: true,
      })
    })

    it("maps low-priority notifications (still emits event)", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "notification",
        key: "telemetry",
        text: "Telemetry sent",
        priority: "low",
      }, freshState())

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("system_message")
      expect((events[0] as any).ephemeral).toBe(true)
    })

    it("maps immediate-priority notifications", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "notification",
        key: "urgent",
        text: "Action required",
        priority: "immediate",
        color: "red",
        timeout_ms: 0,
      }, freshState())

      expect(events).toHaveLength(1)
      expect((events[0] as any).text).toBe("Action required")
    })

    it("falls back to key when text is missing", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "notification",
        key: "some-key",
        priority: "high",
      }, freshState())

      expect((events[0] as any).text).toBe("some-key")
    })
  })

  describe("system task_updated (SDK 0.2.107+)", () => {
    it("maps to task_updated event with camelCase patch", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "task_updated",
        task_id: "task-1",
        patch: {
          status: "completed",
          end_time: 1700000000,
          total_paused_ms: 500,
          is_backgrounded: true,
        },
      }, freshState())

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("task_updated")
      const evt = events[0] as any
      expect(evt.taskId).toBe("task-1")
      expect(evt.patch.status).toBe("completed")
      expect(evt.patch.endTime).toBe(1700000000)
      expect(evt.patch.totalPausedMs).toBe(500)
      expect(evt.patch.isBackgrounded).toBe(true)
    })

    it("maps partial patch (only some fields present)", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "task_updated",
        task_id: "task-1",
        patch: { status: "running" },
      }, freshState())

      expect(events).toHaveLength(1)
      const patch = (events[0] as any).patch
      expect(patch.status).toBe("running")
      expect(patch.endTime).toBeUndefined()
      expect(patch.error).toBeUndefined()
    })

    it("maps error and description in patch", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "task_updated",
        task_id: "task-1",
        patch: {
          status: "failed",
          error: "Out of memory",
          description: "Updated description",
        },
      }, freshState())

      const patch = (events[0] as any).patch
      expect(patch.status).toBe("failed")
      expect(patch.error).toBe("Out of memory")
      expect(patch.description).toBe("Updated description")
    })

    it("produces no events when task_id is missing", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "task_updated",
        patch: { status: "error" },
      }, freshState())

      expect(events).toHaveLength(0)
    })

    it("produces no events when patch is missing", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "task_updated",
        task_id: "task-1",
      }, freshState())

      expect(events).toHaveLength(0)
    })
  })

  describe("system request_user_dialog (SDK 0.2.107+)", () => {
    it("maps to backend_specific with warning (not yet handled)", () => {
      const msg = {
        type: "system",
        subtype: "request_user_dialog",
        dialog_kind: "computer_use_approval",
        payload: { action: "click" },
        tool_use_id: "tool-1",
      }
      const events = mapSDKMessage(msg, freshState())

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("backend_specific")
      expect((events[0] as any).backend).toBe("claude")
      expect((events[0] as any).data).toBe(msg)
    })
  })

  describe("system plugin_install (SDK 0.2.112+)", () => {
    it("emits system_message on install success", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "plugin_install",
          status: "installed",
          name: "my-plugin",
          uuid: "abc-123",
          session_id: "sess-1",
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("system_message")
      expect((events[0] as any).text).toContain("my-plugin")
    })

    it("emits system_message on install failure", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "plugin_install",
          status: "failed",
          name: "bad-plugin",
          error: "not found",
          uuid: "abc-123",
          session_id: "sess-1",
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("system_message")
      expect((events[0] as any).text).toContain("bad-plugin")
      expect((events[0] as any).text).toContain("not found")
    })

    it("emits no events for started/completed bookends", () => {
      for (const status of ["started", "completed"]) {
        const events = mapSDKMessage(
          {
            type: "system",
            subtype: "plugin_install",
            status,
            uuid: "abc-123",
            session_id: "sess-1",
          },
          freshState(),
        )
        expect(events).toHaveLength(0)
      }
    })
  })

  describe("system status requesting (SDK 0.2.112+)", () => {
    it("silently handles requesting status without emitting events", () => {
      const events = mapSDKMessage(
        { type: "system", subtype: "status", status: "requesting" },
        freshState(),
      )
      expect(events).toHaveLength(0)
    })
  })

  describe("system api_retry (SDK 0.2.112+)", () => {
    it("emits ephemeral system_message with attempt, delay, reason, and HTTP status", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "api_retry",
          attempt: 2,
          max_retries: 3,
          retry_delay_ms: 2000,
          error_status: 529,
          error: "server_error",
          uuid: "u",
          session_id: "s",
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("system_message")
      expect((events[0] as any).ephemeral).toBe(true)
      const text = (events[0] as any).text as string
      expect(text).toContain("2/3")
      expect(text).toContain("2.0s")
      expect(text).toContain("server_error")
      expect(text).toContain("529")
    })

    it("omits HTTP status for connection errors (error_status null)", () => {
      const events = mapSDKMessage(
        {
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 3,
          retry_delay_ms: 1000,
          error_status: null,
          error: "unknown",
          uuid: "u",
          session_id: "s",
        },
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("system_message")
      expect((events[0] as any).ephemeral).toBe(true)
      expect((events[0] as any).text).not.toContain("HTTP")
      expect((events[0] as any).text).toContain("unknown")
      expect((events[0] as any).text).toContain("1.0s")
    })
  })

  describe("unknown system subtypes (catch-all)", () => {
    it("maps to backend_specific and logs warning", () => {
      const msg = {
        type: "system",
        subtype: "future_subtype",
        data: "whatever",
      }
      const events = mapSDKMessage(msg, freshState())

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("backend_specific")
      expect((events[0] as any).backend).toBe("claude")
    })
  })

  // ---------------------------------------------------------------------------
  // SDK 0.2.107+ skip_transcript on task events
  // ---------------------------------------------------------------------------

  describe("task events with skip_transcript (SDK 0.2.107+)", () => {
    it("passes skip_transcript on task_started", () => {
      const events = mapSDKMessage({
        type: "task_started",
        task_id: "task-1",
        description: "Ambient check",
        skip_transcript: true,
      }, freshState())

      expect(events).toHaveLength(1)
      expect((events[0] as any).skipTranscript).toBe(true)
    })

    it("passes skip_transcript=false on task_started", () => {
      const events = mapSDKMessage({
        type: "task_started",
        task_id: "task-1",
        description: "Normal task",
        skip_transcript: false,
      }, freshState())

      expect((events[0] as any).skipTranscript).toBe(false)
    })

    it("passes skip_transcript on task_notification", () => {
      const events = mapSDKMessage({
        type: "task_notification",
        task_id: "task-1",
        content: "Done",
        skip_transcript: true,
      }, freshState())

      expect(events).toHaveLength(1)
      expect((events[0] as any).skipTranscript).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // SDK 0.2.107+ compact enrichments
  // ---------------------------------------------------------------------------

  describe("compact enrichments (SDK 0.2.107+)", () => {
    it("extracts duration_ms from compact_metadata", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger: "auto",
          pre_tokens: 80000,
          post_tokens: 20000,
          duration_ms: 1500,
        },
      }, freshState())

      expect(events).toHaveLength(1)
      expect((events[0] as any).durationMs).toBe(1500)
      expect((events[0] as any).preTokens).toBe(80000)
      expect((events[0] as any).postTokens).toBe(20000)
    })

    it("handles compact_result on status message", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "status",
        status: "idle",
        compact_result: "success",
      }, freshState())

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("compact")
      expect((events[0] as any).summary).toBe("Conversation compacted.")
      expect((events[0] as any).inProgress).toBe(false)
    })

    it("handles compact_result with custom message on status", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "status",
        status: "idle",
        compact_result: "Compacted to 20K tokens",
      }, freshState())

      expect(events).toHaveLength(1)
      expect((events[0] as any).summary).toBe("Compacted to 20K tokens")
    })

    it("handles compact_error on status message", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "status",
        status: "idle",
        compact_error: "Context too short to compact",
      }, freshState())

      expect(events).toHaveLength(1)
      expect((events[0] as any).summary).toBe("Compaction failed: Context too short to compact")
      expect((events[0] as any).inProgress).toBe(false)
    })

    it("handles missing duration_ms in compact_metadata", () => {
      const events = mapSDKMessage({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger: "user",
          pre_tokens: 50000,
        },
      }, freshState())

      expect((events[0] as any).durationMs).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// mapAssistantMessage
// ---------------------------------------------------------------------------

describe("Claude Event Mapper — mapAssistantMessage", () => {
  it("returns empty for non-array content", () => {
    expect(mapAssistantMessage({ message: {} })).toEqual([])
    expect(mapAssistantMessage({ message: { content: "string" } })).toEqual([])
    expect(mapAssistantMessage({})).toEqual([])
  })

  it("emits turn_start + text_delta for text block", () => {
    const events = mapAssistantMessage({
      message: {
        content: [{ type: "text", text: "Hello world" }],
      },
    })

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ type: "turn_start" })
    expect(events[1]).toEqual({ type: "text_delta", text: "Hello world" })
  })

  it("skips empty text blocks", () => {
    const events = mapAssistantMessage({
      message: {
        content: [{ type: "text", text: "" }],
      },
    })

    // Only turn_start, no text_delta
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe("turn_start")
  })

  it("maps thinking blocks to thinking_delta", () => {
    const events = mapAssistantMessage({
      message: {
        content: [{ type: "thinking", thinking: "Let me think..." }],
      },
    })

    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({
      type: "thinking_delta",
      text: "Let me think...",
    })
  })

  it("maps tool_use blocks to tool_use_start + tool_use_progress", () => {
    const events = mapAssistantMessage({
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "/tmp/test.txt" },
          },
        ],
      },
    })

    expect(events).toHaveLength(3) // turn_start + tool_use_start + tool_use_progress
    expect(events[1]).toEqual({
      type: "tool_use_start",
      id: "tool-1",
      tool: "Read",
      input: { file_path: "/tmp/test.txt" },
    })
    expect(events[2]).toEqual({
      type: "tool_use_progress",
      id: "tool-1",
      output: "",
      input: { file_path: "/tmp/test.txt" },
    })
  })

  it("handles tool_use with no input", () => {
    const events = mapAssistantMessage({
      message: {
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash" },
        ],
      },
    })

    // turn_start + tool_use_start (no progress since input is falsy)
    expect(events).toHaveLength(2)
    expect((events[1] as any).input).toEqual({})
  })

  it("maps mixed content blocks in order", () => {
    const events = mapAssistantMessage({
      message: {
        content: [
          { type: "thinking", thinking: "Planning..." },
          { type: "text", text: "I'll read the file." },
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { path: "test.ts" },
          },
        ],
      },
    })

    const types = events.map((e) => e.type)
    expect(types).toEqual([
      "turn_start",
      "thinking_delta",
      "text_delta",
      "tool_use_start",
      "tool_use_progress",
    ])
  })

  it("handles unknown content block types gracefully", () => {
    const events = mapAssistantMessage({
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "future_block_type", data: "unknown" },
        ],
      },
    })

    // Should have turn_start + text_delta (unknown block silently skipped with log.warn)
    expect(events).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// mapStreamEvent
// ---------------------------------------------------------------------------

describe("Claude Event Mapper — mapStreamEvent", () => {
  describe("message_start", () => {
    it("emits turn_start", () => {
      const events = mapStreamEvent(
        { type: "message_start", message: {} },
        null,
        freshState(),
      )

      expect(events.some((e) => e.type === "turn_start")).toBe(true)
    })

    it("emits cost_update from message usage", () => {
      const events = mapStreamEvent(
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 1000,
              cache_read_input_tokens: 500,
              cache_creation_input_tokens: 200,
            },
          },
        },
        null,
        freshState(),
      )

      expect(events).toHaveLength(2) // turn_start + cost_update
      const cost = events.find((e) => e.type === "cost_update") as any
      expect(cost).toBeTruthy()
      expect(cost.contextTokens).toBe(1700) // 1000 + 500 + 200
      expect(cost.inputTokens).toBe(0)
      expect(cost.outputTokens).toBe(0)
    })

    it("skips cost_update when usage totals to zero", () => {
      const events = mapStreamEvent(
        {
          type: "message_start",
          message: {
            usage: { input_tokens: 0 },
          },
        },
        null,
        freshState(),
      )

      expect(events).toHaveLength(1) // just turn_start
    })
  })

  describe("content_block_start", () => {
    it("emits tool_use_start for tool_use blocks", () => {
      const state = freshState()
      const events = mapStreamEvent(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool-1", name: "Bash" },
        },
        null,
        state,
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "tool_use_start",
        id: "tool-1",
        tool: "Bash",
        input: {},
      })

      // Verify stream state was updated
      expect(state.currentToolIds.get(0)).toBe("tool-1")
      expect(state.toolInputJsons.get("tool-1")).toBe("")
    })

    it("ignores text and thinking block starts", () => {
      const events = mapStreamEvent(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        },
        null,
        freshState(),
      )

      expect(events).toHaveLength(0)
    })
  })

  describe("content_block_delta", () => {
    it("maps text_delta", () => {
      const events = mapStreamEvent(
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" },
        },
        null,
        freshState(),
      )

      expect(events).toEqual([{ type: "text_delta", text: "Hello" }])
    })

    it("maps thinking_delta", () => {
      const events = mapStreamEvent(
        {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "Analyzing..." },
        },
        null,
        freshState(),
      )

      expect(events).toEqual([
        { type: "thinking_delta", text: "Analyzing..." },
      ])
    })

    it("accumulates input_json_delta fragments", () => {
      const state = freshState()
      state.currentToolIds.set(0, "tool-1")
      state.toolInputJsons.set("tool-1", "")

      // First fragment
      mapStreamEvent(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"com' },
        },
        null,
        state,
      )

      expect(state.toolInputJsons.get("tool-1")).toBe('{"com')

      // Second fragment
      mapStreamEvent(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: 'mand":"ls"}' },
        },
        null,
        state,
      )

      expect(state.toolInputJsons.get("tool-1")).toBe('{"command":"ls"}')
    })
  })

  describe("content_block_stop", () => {
    it("emits tool_use_progress with parsed JSON on tool block stop", () => {
      const state = freshState()
      state.currentToolIds.set(0, "tool-1")
      state.toolInputJsons.set("tool-1", '{"command":"ls -la"}')

      const events = mapStreamEvent(
        { type: "content_block_stop", index: 0 },
        null,
        state,
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "tool_use_progress",
        id: "tool-1",
        output: "",
        input: { command: "ls -la" },
      })

      // Stream state cleaned up
      expect(state.currentToolIds.has(0)).toBe(false)
      expect(state.toolInputJsons.has("tool-1")).toBe(false)
    })

    it("emits raw JSON string on parse failure", () => {
      const state = freshState()
      state.currentToolIds.set(0, "tool-1")
      state.toolInputJsons.set("tool-1", "{invalid json")

      const events = mapStreamEvent(
        { type: "content_block_stop", index: 0 },
        null,
        state,
      )

      expect(events).toHaveLength(1)
      expect((events[0] as any).input).toBe("{invalid json")
    })

    it("is a no-op for non-tool blocks", () => {
      const state = freshState()
      // index 0 not in currentToolIds

      const events = mapStreamEvent(
        { type: "content_block_stop", index: 0 },
        null,
        state,
      )

      expect(events).toHaveLength(0)
    })
  })

  describe("message_delta", () => {
    it("emits cost_update with output tokens", () => {
      const events = mapStreamEvent(
        {
          type: "message_delta",
          usage: { output_tokens: 150 },
        },
        null,
        freshState(),
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "cost_update",
        inputTokens: 0,
        outputTokens: 150,
      })
    })

    it("skips cost_update when no usage", () => {
      const events = mapStreamEvent(
        { type: "message_delta" },
        null,
        freshState(),
      )

      expect(events).toHaveLength(0)
    })
  })

  describe("message_stop", () => {
    it("produces no events", () => {
      const events = mapStreamEvent(
        { type: "message_stop" },
        null,
        freshState(),
      )

      expect(events).toHaveLength(0)
    })
  })

  describe("unknown stream events", () => {
    it("produces no events (logs warning)", () => {
      const events = mapStreamEvent(
        { type: "future_stream_event" },
        null,
        freshState(),
      )

      expect(events).toHaveLength(0)
    })
  })
})

// ---------------------------------------------------------------------------
// ToolStreamState
// ---------------------------------------------------------------------------

describe("ToolStreamState", () => {
  it("initializes with empty maps, false sticky flag, and zeroed per-turn counter", () => {
    const state = new ToolStreamState()
    expect(state.toolInputJsons.size).toBe(0)
    expect(state.currentToolIds.size).toBe(0)
    expect(state.hasReceivedStreamEvent).toBe(false)
    expect(state.streamEventsThisTurn).toBe(0)
  })

  it("stream_event increments per-turn counter and sets sticky flag", () => {
    const state = freshState()
    mapSDKMessage(
      { type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null },
      state,
    )
    expect(state.hasReceivedStreamEvent).toBe(true)
    expect(state.streamEventsThisTurn).toBe(1)

    mapSDKMessage(
      { type: "stream_event", event: { type: "message_stop", message: {} }, parent_tool_use_id: null },
      state,
    )
    expect(state.streamEventsThisTurn).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Full stream simulation
// ---------------------------------------------------------------------------

describe("Claude Event Mapper — full stream simulation", () => {
  it("simulates a complete text response turn", () => {
    const state = freshState()
    const allEvents: any[] = []

    // message_start
    allEvents.push(
      ...mapStreamEvent(
        {
          type: "message_start",
          message: { usage: { input_tokens: 500 } },
        },
        null,
        state,
      ),
    )

    // text deltas
    allEvents.push(
      ...mapStreamEvent(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        },
        null,
        state,
      ),
    )
    allEvents.push(
      ...mapStreamEvent(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello " },
        },
        null,
        state,
      ),
    )
    allEvents.push(
      ...mapStreamEvent(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "world!" },
        },
        null,
        state,
      ),
    )
    allEvents.push(
      ...mapStreamEvent(
        { type: "content_block_stop", index: 0 },
        null,
        state,
      ),
    )

    // message_delta with output usage
    allEvents.push(
      ...mapStreamEvent(
        {
          type: "message_delta",
          usage: { output_tokens: 10 },
        },
        null,
        state,
      ),
    )

    // message_stop
    allEvents.push(
      ...mapStreamEvent({ type: "message_stop" }, null, state),
    )

    // Then result comes as SDK message
    allEvents.push(
      ...mapSDKMessage(
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 500, output_tokens: 10 },
          total_cost_usd: 0.01,
        },
        state,
      ),
    )

    const types = allEvents.map((e) => e.type)
    expect(types).toEqual([
      "turn_start",
      "cost_update",     // input context fill
      "text_delta",      // "Hello "
      "text_delta",      // "world!"
      "cost_update",     // output tokens
      "turn_complete",   // from result
    ])
  })

  it("simulates a tool-use turn with input JSON streaming", () => {
    const state = freshState()
    const allEvents: any[] = []

    // message_start
    allEvents.push(
      ...mapStreamEvent(
        { type: "message_start", message: {} },
        null,
        state,
      ),
    )

    // tool_use block start
    allEvents.push(
      ...mapStreamEvent(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool-1", name: "Bash" },
        },
        null,
        state,
      ),
    )

    // Stream the tool input JSON
    allEvents.push(
      ...mapStreamEvent(
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: '{"command":',
          },
        },
        null,
        state,
      ),
    )
    allEvents.push(
      ...mapStreamEvent(
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: '"ls -la"}',
          },
        },
        null,
        state,
      ),
    )

    // content_block_stop — parses accumulated JSON
    allEvents.push(
      ...mapStreamEvent(
        { type: "content_block_stop", index: 0 },
        null,
        state,
      ),
    )

    const types = allEvents.map((e) => e.type)
    expect(types).toEqual([
      "turn_start",
      "tool_use_start",
      "tool_use_progress", // parsed input
    ])

    // Verify the parsed input
    const progress = allEvents.find(
      (e) => e.type === "tool_use_progress",
    )
    expect(progress.input).toEqual({ command: "ls -la" })
    expect(progress.id).toBe("tool-1")
  })
})

// ---------------------------------------------------------------------------
// synthesizeWorktreeEvents
// ---------------------------------------------------------------------------

describe("synthesizeWorktreeEvents", () => {
  it("emits worktree_created + cwd_changed on EnterWorktree success", () => {
    const output = JSON.stringify({
      worktreePath: "/repo/.claude/worktrees/feature-test",
      worktreeBranch: "worktree-feature-test",
      message: "Created worktree feature-test",
    })
    const events = synthesizeWorktreeEvents("EnterWorktree", output)

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      type: "worktree_created",
      name: "feature-test",
      path: "/repo/.claude/worktrees/feature-test",
    })
    expect(events[1]).toEqual({
      type: "cwd_changed",
      oldCwd: "",
      newCwd: "/repo/.claude/worktrees/feature-test",
    })
  })

  it("parses plain-text EnterWorktree output (SDK's actual tool_result form)", () => {
    // This is what the SDK really ships in tool_result — not JSON.
    const output =
      "Created worktree at /repo/.claude/worktrees/feature-x on branch " +
      "worktree-feature-x. The session is now working in the worktree. " +
      "Use ExitWorktree to leave mid-session."
    const events = synthesizeWorktreeEvents("EnterWorktree", output)

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      type: "worktree_created",
      name: "feature-x",
      path: "/repo/.claude/worktrees/feature-x",
    })
    expect(events[1]).toEqual({
      type: "cwd_changed",
      oldCwd: "",
      newCwd: "/repo/.claude/worktrees/feature-x",
    })
  })

  it("emits worktree_removed on ExitWorktree remove (plain-text)", () => {
    const output = "Removed worktree at /repo/.claude/worktrees/feature-test."
    const events = synthesizeWorktreeEvents("ExitWorktree", output)

    const types = events.map(e => e.type)
    expect(types).toContain("worktree_removed")
    expect(events.find(e => e.type === "worktree_removed")).toMatchObject({
      path: "/repo/.claude/worktrees/feature-test",
    })
  })

  it("emits worktree_removed on ExitWorktree keep too (state tracks active worktree)", () => {
    // "Keep" leaves the directory on disk but the agent is back at originalCwd,
    // so the badge should disappear. The `worktree` field tracks the *active*
    // worktree, not physical existence.
    const output = "Kept worktree at /repo/.claude/worktrees/feature-test."
    const events = synthesizeWorktreeEvents("ExitWorktree", output)

    expect(events.some(e => e.type === "worktree_removed")).toBe(true)
  })

  it("parses the real 'Exited worktree … preserved at … back in …' output", () => {
    // This is the actual plain-text ExitWorktree output observed in the wild.
    const output =
      "Exited worktree. Your work is preserved at " +
      "/private/tmp/bantai-worktree-test/.claude/worktrees/feature-x on branch " +
      "worktree-feature-x. Session is now back in /private/tmp/bantai-worktree-test."
    const events = synthesizeWorktreeEvents("ExitWorktree", output)
    const types = events.map(e => e.type)

    // Both cwd_changed and worktree_removed should fire — the badge must
    // clear and the path should return to the repo root.
    expect(types).toContain("cwd_changed")
    expect(types).toContain("worktree_removed")

    const cwd = events.find(e => e.type === "cwd_changed") as any
    expect(cwd.oldCwd).toBe("/private/tmp/bantai-worktree-test/.claude/worktrees/feature-x")
    expect(cwd.newCwd).toBe("/private/tmp/bantai-worktree-test")

    const removed = events.find(e => e.type === "worktree_removed") as any
    expect(removed.path).toBe("/private/tmp/bantai-worktree-test/.claude/worktrees/feature-x")
  })

  it("still handles structured JSON if the SDK starts returning it", () => {
    const output = JSON.stringify({
      worktreePath: "/repo/.claude/worktrees/feature-j",
      worktreeBranch: "worktree-feature-j",
      message: "Created worktree",
    })
    const events = synthesizeWorktreeEvents("EnterWorktree", output)
    expect(events[0]).toMatchObject({
      type: "worktree_created",
      path: "/repo/.claude/worktrees/feature-j",
      name: "feature-j",
    })
  })

  it("JSON ExitWorktree with action=remove and originalCwd emits cwd_changed + worktree_removed", () => {
    const output = JSON.stringify({
      action: "remove",
      originalCwd: "/repo",
      worktreePath: "/repo/.claude/worktrees/feature-j",
      message: "Removed worktree",
    })
    const events = synthesizeWorktreeEvents("ExitWorktree", output)
    const types = events.map(e => e.type)
    expect(types).toEqual(["cwd_changed", "worktree_removed"])
    expect(events.find(e => e.type === "cwd_changed")).toMatchObject({
      oldCwd: "/repo/.claude/worktrees/feature-j",
      newCwd: "/repo",
    })
  })

  it("returns [] for empty output", () => {
    expect(synthesizeWorktreeEvents("EnterWorktree", "")).toEqual([])
  })

  it("returns [] when EnterWorktree output has no recognizable path", () => {
    expect(
      synthesizeWorktreeEvents("EnterWorktree", "Something went wrong"),
    ).toEqual([])
  })

  it("returns [] when EnterWorktree JSON output has no worktreePath", () => {
    const output = JSON.stringify({ message: "ok but no path" })
    expect(synthesizeWorktreeEvents("EnterWorktree", output)).toEqual([])
  })

  it("returns [] for unrecognized tool names", () => {
    const output = JSON.stringify({ worktreePath: "/repo/wt" })
    expect(synthesizeWorktreeEvents("Read", output)).toEqual([])
    expect(synthesizeWorktreeEvents("SomethingElse", output)).toEqual([])
  })

  it("derives worktree name from the last path segment", () => {
    const cases: Array<[string, string]> = [
      ["/repo/.claude/worktrees/feature-test", "feature-test"],
      ["/repo/.claude/worktrees/pr-123", "pr-123"],
      ["/a/b/c/my-slash+branch", "my-slash+branch"],
    ]
    for (const [path, expected] of cases) {
      const events = synthesizeWorktreeEvents(
        "EnterWorktree",
        JSON.stringify({ worktreePath: path }),
      )
      expect(events[0]).toMatchObject({ type: "worktree_created", name: expected })
    }
  })
})

// ---------------------------------------------------------------------------
// Worktree side-effect synthesis inside the full tool_use_end flow
// ---------------------------------------------------------------------------

describe("Event Mapper — worktree tool_use_end integration", () => {
  it("emits worktree_created + cwd_changed after an EnterWorktree tool_result", () => {
    const state = freshState()
    // Simulate the stream_event content_block_start that stashes the tool name
    mapStreamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_ew_1", name: "EnterWorktree" },
      },
      null,
      state,
    )
    expect(state.toolNamesById.get("tu_ew_1")).toBe("EnterWorktree")

    // Now the tool_result arrives as a user message carrying the tool's
    // plain-text output (the form the SDK actually ships).
    const events = mapSDKMessage(
      {
        type: "user",
        tool_use_result: "ok",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_ew_1",
              content:
                "Created worktree at /repo/.claude/worktrees/feature-x " +
                "on branch worktree-feature-x. The session is now working in the worktree.",
            },
          ],
        },
      },
      state,
    )

    const types = events.map(e => e.type)
    expect(types).toContain("tool_use_end")
    expect(types).toContain("worktree_created")
    expect(types).toContain("cwd_changed")

    const created = events.find(e => e.type === "worktree_created") as any
    expect(created.path).toBe("/repo/.claude/worktrees/feature-x")
    expect(created.name).toBe("feature-x")

    // Map should be cleaned up after consumption
    expect(state.toolNamesById.has("tu_ew_1")).toBe(false)
  })

  it("does not emit worktree_created when the tool_result is an error", () => {
    const state = freshState()
    state.toolNamesById.set("tu_err", "EnterWorktree")

    const events = mapSDKMessage(
      {
        type: "user",
        tool_use_result: "err",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_err",
              is_error: true,
              content: "failed: not a git repo",
            },
          ],
        },
      },
      state,
    )

    const types = events.map(e => e.type)
    expect(types).toContain("tool_use_end")
    expect(types).not.toContain("worktree_created")
    expect(types).not.toContain("cwd_changed")
  })
})

// ---------------------------------------------------------------------------
// TodoWrite tool_use -> todos_updated synthesis
// ---------------------------------------------------------------------------

describe("Claude Event Mapper — TodoWrite tool_use -> todos_updated", () => {
  it("emits todos_updated in addition to the tool block for a well-formed TodoWrite", () => {
    const events = mapAssistantMessage({
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-todos-1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Plan steps", activeForm: "Planning steps", status: "completed" },
                { content: "Run tests", activeForm: "Running tests", status: "in_progress" },
                { content: "Deploy", activeForm: "Deploying", status: "pending" },
              ],
            },
          },
        ],
      },
    })

    const types = events.map(e => e.type)
    // Normal tool-block flow must not be suppressed here.
    expect(types).toContain("tool_use_start")
    expect(types).toContain("tool_use_progress")
    expect(types).toContain("todos_updated")

    const todosEvent = events.find(e => e.type === "todos_updated") as any
    expect(todosEvent.todos).toEqual([
      { content: "Plan steps", activeForm: "Planning steps", status: "completed" },
      { content: "Run tests", activeForm: "Running tests", status: "in_progress" },
      { content: "Deploy", activeForm: "Deploying", status: "pending" },
    ])
  })

  it("drops malformed todo items (missing activeForm) but keeps valid ones", () => {
    const events = mapAssistantMessage({
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-todos-2",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Good item", activeForm: "Doing good item", status: "pending" },
                { content: "Bad item missing activeForm", status: "pending" },
                { content: "Another good", activeForm: "Doing another", status: "in_progress" },
              ],
            },
          },
        ],
      },
    })

    const todosEvent = events.find(e => e.type === "todos_updated") as any
    expect(todosEvent).toBeDefined()
    expect(todosEvent.todos).toHaveLength(2)
    expect(todosEvent.todos.map((t: any) => t.content)).toEqual([
      "Good item",
      "Another good",
    ])
  })

  it("emits empty todos_updated when the todos field is missing/malformed", () => {
    const events = mapAssistantMessage({
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-todos-3",
            name: "TodoWrite",
            input: { notTodos: "oops" },
          },
        ],
      },
    })

    const todosEvent = events.find(e => e.type === "todos_updated") as any
    expect(todosEvent).toBeDefined()
    expect(todosEvent.todos).toEqual([])
  })

  it("emits todos_updated from the streaming (content_block_stop) path too", () => {
    const state = freshState()
    // Simulate a streamed TodoWrite tool_use: start, input_json deltas, stop.
    mapStreamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tool-stream-todos", name: "TodoWrite" },
      },
      null,
      state,
    )
    const jsonStr = JSON.stringify({
      todos: [
        { content: "Write code", activeForm: "Writing code", status: "in_progress" },
      ],
    })
    mapStreamEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: jsonStr },
      },
      null,
      state,
    )
    const stopEvents = mapStreamEvent(
      { type: "content_block_stop", index: 0 },
      null,
      state,
    )

    const types = stopEvents.map(e => e.type)
    expect(types).toContain("tool_use_progress")
    expect(types).toContain("todos_updated")
    const todosEvent = stopEvents.find(e => e.type === "todos_updated") as any
    expect(todosEvent.todos).toEqual([
      { content: "Write code", activeForm: "Writing code", status: "in_progress" },
    ])
  })
})
