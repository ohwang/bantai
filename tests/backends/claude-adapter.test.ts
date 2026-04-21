import { describe, expect, it } from "bun:test"
import { ClaudeAdapter } from "../../src/backends/claude/adapter"
import { mapSDKMessage, mapStreamEvent, mapAssistantMessage, ToolStreamState } from "../../src/backends/claude/event-mapper"
import { parseElicitationInput, handlePermission } from "../../src/backends/claude/permission-bridge"
import { AsyncQueue } from "../../src/utils/async-queue"
import type { AgentEvent } from "../../src/protocol/types"

/** Narrow an AgentEvent to a specific union member by its `type` discriminant. */
type EventOf<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>

describe("ClaudeAdapter", () => {
  describe("capabilities", () => {
    it("reports Claude capabilities", () => {
      const adapter = new ClaudeAdapter()
      const caps = adapter.capabilities()

      expect(caps.name).toBe("claude")
      expect(caps.supportsThinking).toBe(true)
      expect(caps.supportsToolApproval).toBe(true)
      expect(caps.supportsResume).toBe(true)
      expect(caps.supportsFork).toBe(true)
      expect(caps.supportsStreaming).toBe(true)
      expect(caps.supportsSubagents).toBe(true)
      expect(caps.supportedPermissionModes).toContain("default")
      expect(caps.supportedPermissionModes).toContain("bypassPermissions")
    })
  })

  describe("message queuing", () => {
    it("sendMessage queues messages", () => {
      const adapter = new ClaudeAdapter()

      // Should not throw
      adapter.sendMessage({ text: "hello" })
      adapter.sendMessage({ text: "world" })

      adapter.close()
    })
  })

  describe("permission bridge", () => {
    it("approveToolUse resolves pending permission", () => {
      const adapter = new ClaudeAdapter()

      // Simulate a pending permission (internal state)
      // We can't directly test the canUseTool callback without the SDK
      // but we verify approve/deny don't throw on unknown IDs
      adapter.approveToolUse("nonexistent")
      adapter.denyToolUse("nonexistent", "reason")

      adapter.close()
    })

    it("respondToElicitation resolves pending elicitation", () => {
      const adapter = new ClaudeAdapter()

      adapter.respondToElicitation("nonexistent", { answer: "yes" })

      adapter.close()
    })
  })

  describe("interrupt", () => {
    it("interrupt without active query is safe", () => {
      const adapter = new ClaudeAdapter()

      // Should not throw
      adapter.interrupt()

      adapter.close()
    })
  })

  describe("close", () => {
    it("close is idempotent", () => {
      const adapter = new ClaudeAdapter()

      adapter.close()
      adapter.close() // Should not throw

      // sendMessage after close should be safe
      adapter.sendMessage({ text: "after close" })
    })

    it("close nulls eventChannel without crashing background loop", () => {
      const adapter = new ClaudeAdapter()

      // Simulate the state where eventChannel exists (as during iterateQuery)
      const { EventChannel } = require("../../src/utils/event-channel")
      ;(adapter as any).eventChannel = new EventChannel()

      // close() nulls eventChannel — the background sdkLoop must not crash
      adapter.close()
      expect((adapter as any).eventChannel).toBeNull()

      // Simulating what the background loop does after close:
      // this.eventChannel?.close() should be safe (not this.eventChannel!.close())
      const channel = (adapter as any).eventChannel
      expect(() => channel?.close()).not.toThrow()
    })
  })

  describe("SDKMessage mapping", () => {
    // These test the extracted mapSDKMessage function directly.

    it("maps system init message correctly", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "system",
        subtype: "init",
        tools: ["Read", "Write", "Bash"],
        model: "claude-sonnet-4-6",
        cwd: "/tmp",
        uuid: "test-uuid",
        session_id: "test-session",
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"session_init">
      expect(ev.type).toBe("session_init")
      expect(ev.tools).toEqual([
        { name: "Read" },
        { name: "Write" },
        { name: "Bash" },
      ])
      expect(ev.models).toEqual([
        { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6", provider: "anthropic" },
      ])
    })

    it("maps result success to turn_complete", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
        },
        total_cost_usd: 0.005,
        uuid: "test",
        session_id: "test",
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"turn_complete">
      expect(ev.type).toBe("turn_complete")
      expect(ev.usage!.inputTokens).toBe(100)
      expect(ev.usage!.outputTokens).toBe(50)
      expect(ev.usage!.cacheReadTokens).toBe(10)
      expect(ev.usage!.totalCostUsd).toBe(0.005)
    })

    it("maps result error to error + turn_complete", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: ["Too many turns"],
        usage: { input_tokens: 200, output_tokens: 100 },
        total_cost_usd: 0.01,
        uuid: "test",
        session_id: "test",
      }, streamState)

      expect(events).toHaveLength(2)
      const errEv = events[0]! as EventOf<"error">
      expect(errEv.type).toBe("error")
      expect(errEv.code).toBe("error_max_turns")
      expect(events[1]!.type).toBe("turn_complete")
    })

    it("maps stream_event content_block_delta text_delta", () => {
      const streamState = new ToolStreamState()
      const events = mapStreamEvent(
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello world" },
        },
        null,
        streamState,
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ type: "text_delta", text: "Hello world" })
    })

    it("maps stream_event content_block_delta thinking_delta", () => {
      const streamState = new ToolStreamState()
      const events = mapStreamEvent(
        {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "Let me think..." },
        },
        null,
        streamState,
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "thinking_delta",
        text: "Let me think...",
      })
    })

    it("maps stream_event content_block_start tool_use", () => {
      const streamState = new ToolStreamState()
      const events = mapStreamEvent(
        {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            id: "tool_123",
            name: "Read",
          },
        },
        null,
        streamState,
      )

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"tool_use_start">
      expect(ev.type).toBe("tool_use_start")
      expect(ev.id).toBe("tool_123")
      expect(ev.tool).toBe("Read")
    })

    it("maps stream_event message_start to turn_start", () => {
      const streamState = new ToolStreamState()
      const events = mapStreamEvent(
        { type: "message_start" },
        null,
        streamState,
      )

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("turn_start")
    })

    it("emits in-progress compact event on compacting status", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "system",
        subtype: "status",
        status: "compacting",
        uuid: "test",
        session_id: "test",
      }, streamState)

      // "compacting" status now emits an in-progress compact event for spinner display
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("compact")
      expect((events[0] as any).inProgress).toBe(true)
    })

    it("maps rate_limit to recoverable error", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "rate_limit",
        uuid: "test",
        session_id: "test",
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"error">
      expect(ev.type).toBe("error")
      expect(ev.severity).toBe("recoverable")
    })

    it("maps rate_limit_event with a known bucket to rate_limit_update (informational, not error)", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "five_hour",
          utilization: 0.5,
          resetsAt: 1775019636,
          status: "allowed",
        },
        uuid: "test",
        session_id: "test",
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"rate_limit_update">
      expect(ev.type).toBe("rate_limit_update")
      expect(ev.rateLimitType).toBe("five_hour")
      expect(ev.utilization).toBe(0.5)
      expect(ev.source).toBe("claude")
    })

    it("maps rate_limit_event without a rateLimitType to backend_specific for diagnostics", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "rate_limit_event",
        rate_limit_info: { retry_after: 5 },
        uuid: "test",
        session_id: "test",
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"backend_specific">
      expect(ev.type).toBe("backend_specific")
      expect(ev.backend).toBe("claude")
    })

    it("maps unknown message type to backend_specific", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "some_future_type",
        data: "test",
        uuid: "test",
        session_id: "test",
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"backend_specific">
      expect(ev.type).toBe("backend_specific")
      expect(ev.backend).toBe("claude")
    })

    it("maps user tool_result with is_error to tool_use_end with error", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "user",
        tool_use_result: true,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_err_1",
              is_error: true,
              content: "File not found: /nonexistent.txt",
            },
          ],
        },
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"tool_use_end">
      expect(ev.type).toBe("tool_use_end")
      expect(ev.id).toBe("tool_err_1")
      expect(ev.error).toBe("File not found: /nonexistent.txt")
    })

    it("maps user tool_result with tool_use_id on msg directly", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "user",
        tool_use_result: "some output",
        tool_use_id: "tool_fb_1",
        message: { role: "user", content: [] },
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"tool_use_end">
      expect(ev.type).toBe("tool_use_end")
      expect(ev.id).toBe("tool_fb_1")
      expect(ev.output).toBe("some output")
    })

    it("maps user tool_result with object tool_use_result containing error", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "user",
        tool_use_result: {
          tool_use_id: "tool_obj_1",
          is_error: true,
          error: "Permission denied",
          content: "Permission denied",
        },
        message: { role: "user", content: [] },
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"tool_use_end">
      expect(ev.type).toBe("tool_use_end")
      expect(ev.id).toBe("tool_obj_1")
      expect(ev.error).toBe("Permission denied")
    })

    it("maps user tool_result with msg-level is_error flag", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "user",
        tool_use_result: "Timeout exceeded",
        is_error: true,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_flag_1",
              content: "Timeout exceeded",
            },
          ],
        },
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"tool_use_end">
      expect(ev.type).toBe("tool_use_end")
      expect(ev.id).toBe("tool_flag_1")
      expect(ev.error).toBe("Timeout exceeded")
    })

    it("emits tool_use_end with sentinel when tool_use_id cannot be determined", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "user",
        tool_use_result: 42, // non-string, non-object
        message: { role: "user", content: [] },
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"tool_use_end">
      expect(ev.type).toBe("tool_use_end")
      expect(ev.id).toBe("__last_running__")
    })

    it("maps user tool_result with array content blocks containing text", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "user",
        tool_use_result: true,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_arr_1",
              is_error: true,
              content: [
                { type: "text", text: "Error on line 1" },
                { type: "text", text: "Error on line 2" },
              ],
            },
          ],
        },
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"tool_use_end">
      expect(ev.type).toBe("tool_use_end")
      expect(ev.id).toBe("tool_arr_1")
      expect(ev.error).toBe("Error on line 1\nError on line 2")
      expect(ev.output).toBe("Error on line 1\nError on line 2")
    })

    it("maps replayed user message (no parent_tool_use_id) to user_message", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello, can you help?" }],
        },
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"user_message">
      expect(ev.type).toBe("user_message")
      expect(ev.text).toBe("Hello, can you help?")
    })

    it("suppresses subagent prompt (parent_tool_use_id is set)", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "user",
        parent_tool_use_id: "toolu_abc123",
        message: {
          role: "user",
          content: [{ type: "text", text: "I need a very thorough exploration of the codebase..." }],
        },
      }, streamState)

      // Subagent prompts should be suppressed — they're already shown
      // via the AgentToolView attached to the Agent tool block
      expect(events).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // mapAssistantMessage (V2 adapter path)
  // -------------------------------------------------------------------------

  describe("mapAssistantMessage", () => {
    it("extracts text from assistant message content blocks", () => {
      const events = mapAssistantMessage({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Four." },
          ],
        },
      })

      expect(events.length).toBeGreaterThanOrEqual(2)
      expect(events[0]!.type).toBe("turn_start")
      expect(events[1]!).toEqual({ type: "text_delta", text: "Four." })
    })

    it("extracts thinking blocks", () => {
      const events = mapAssistantMessage({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Let me think about this..." },
            { type: "text", text: "The answer is 4." },
          ],
        },
      })

      const thinkingEvents = events.filter((e): e is EventOf<"thinking_delta"> => e.type === "thinking_delta")
      const textEvents = events.filter((e): e is EventOf<"text_delta"> => e.type === "text_delta")
      expect(thinkingEvents).toHaveLength(1)
      expect(thinkingEvents[0]!.text).toBe("Let me think about this...")
      expect(textEvents).toHaveLength(1)
      expect(textEvents[0]!.text).toBe("The answer is 4.")
    })

    it("extracts tool_use blocks", () => {
      const events = mapAssistantMessage({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tool_1", name: "Read", input: { file: "test.txt" } },
          ],
        },
      })

      const toolStart = events.find(e => e.type === "tool_use_start")
      const toolProgress = events.find(e => e.type === "tool_use_progress")
      expect(toolStart).toBeTruthy()
      expect(toolStart!.tool).toBe("Read")
      expect(toolStart!.id).toBe("tool_1")
      expect(toolProgress).toBeTruthy()
      expect(toolProgress!.input).toEqual({ file: "test.txt" })
    })

    it("returns empty for missing content", () => {
      expect(mapAssistantMessage({ type: "assistant" })).toEqual([])
      expect(mapAssistantMessage({ type: "assistant", message: {} })).toEqual([])
    })
  })

  describe("mapAssistant option", () => {
    it("V1 live mode: assistant messages are ignored when streams already covered the turn", () => {
      const streamState = new ToolStreamState()
      // Simulate a turn that actually streamed — both the sticky "ever seen"
      // flag and the per-turn counter must be set, otherwise the adapter
      // falls back to mapping the final assistant message (see the
      // no-stream-this-turn fallback in event-mapper.ts).
      streamState.hasReceivedStreamEvent = true
      streamState.streamEventsThisTurn = 2
      const events = mapSDKMessage({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      }, streamState)

      expect(events).toHaveLength(0)
    })

    it("V1 replay mode: assistant messages are mapped before first stream_event", () => {
      const streamState = new ToolStreamState()
      // Before any stream_event, assistant messages are treated as replayed history
      const events = mapSDKMessage({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      }, streamState)

      // Should produce turn_start + text_delta + turn_complete
      expect(events.length).toBeGreaterThanOrEqual(3)
      expect(events[0]!.type).toBe("turn_start")
      const textEvent = events.find(e => e.type === "text_delta")
      expect(textEvent).toBeTruthy()
      expect(textEvent!.text).toBe("Hello")
      expect(events[events.length - 1]!.type).toBe("turn_complete")
    })

    it("V2 (mapAssistant: true): assistant messages are mapped", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      }, streamState, { mapAssistant: true })

      expect(events.length).toBeGreaterThanOrEqual(2)
      const textEvent = events.find(e => e.type === "text_delta")
      expect(textEvent).toBeTruthy()
      expect(textEvent!.text).toBe("Hello")
    })
  })

  // -------------------------------------------------------------------------
  // Context window bracket parsing in session_init
  // -------------------------------------------------------------------------

  describe("context window bracket parsing", () => {
    it("parses [1M context] -> contextWindow: 1_000_000 and cleans model name", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "system",
        subtype: "init",
        model: "claude-opus-4-6 [1M context]",
        tools: [],
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"session_init">
      expect(ev.type).toBe("session_init")
      expect(ev.models).toHaveLength(1)
      expect(ev.models[0]!.id).toBe("claude-opus-4-6")
      expect(ev.models[0]!.name).toBe("claude-opus-4-6")
      expect(ev.models[0]!.contextWindow).toBe(1_000_000)
    })

    it("parses [200K tokens] -> contextWindow: 200_000", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "system",
        subtype: "init",
        model: "claude-sonnet-4-6 [200K tokens]",
        tools: [],
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"session_init">
      expect(ev.models[0]!.id).toBe("claude-sonnet-4-6")
      expect(ev.models[0]!.contextWindow).toBe(200_000)
    })

    it("model string without brackets -> no contextWindow, name unchanged", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "system",
        subtype: "init",
        model: "claude-sonnet-4-6",
        tools: [],
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"session_init">
      expect(ev.models[0]!.id).toBe("claude-sonnet-4-6")
      expect(ev.models[0]!.name).toBe("claude-sonnet-4-6")
      expect(ev.models[0]!.contextWindow).toBeUndefined()
    })

    it("parses [8K context] -> contextWindow: 8_000", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "system",
        subtype: "init",
        model: "gpt-4o-mini [8K context]",
        tools: [],
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"session_init">
      expect(ev.models[0]!.id).toBe("gpt-4o-mini")
      expect(ev.models[0]!.contextWindow).toBe(8_000)
    })
  })

  // -------------------------------------------------------------------------
  // Tool input JSON accumulation (mapStreamEvent)
  // -------------------------------------------------------------------------

  describe("tool input JSON accumulation", () => {
    it("accumulates input_json_delta fragments and emits parsed input on content_block_stop", () => {
      const streamState = new ToolStreamState()

      // content_block_start: register the tool
      const startEvents = mapStreamEvent(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_json_1", name: "Read" },
        },
        null,
        streamState,
      )
      expect(startEvents).toHaveLength(1)
      expect(startEvents[0]!.type).toBe("tool_use_start")

      // Three input_json_delta fragments
      mapStreamEvent(
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file' } },
        null,
        streamState,
      )
      mapStreamEvent(
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '":"src/' } },
        null,
        streamState,
      )
      mapStreamEvent(
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'index.ts"}' } },
        null,
        streamState,
      )

      // content_block_stop: should emit tool_use_progress with parsed JSON
      const stopEvents = mapStreamEvent(
        { type: "content_block_stop", index: 0 },
        null,
        streamState,
      )

      expect(stopEvents).toHaveLength(1)
      const stopEv = stopEvents[0]! as EventOf<"tool_use_progress">
      expect(stopEv.type).toBe("tool_use_progress")
      expect(stopEv.id).toBe("tool_json_1")
      expect(stopEv.input).toEqual({ file: "src/index.ts" })
    })

    it("does not crash on invalid JSON — no tool_use_progress emitted with parsed input", () => {
      const streamState = new ToolStreamState()

      mapStreamEvent(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_bad_json", name: "Write" },
        },
        null,
        streamState,
      )

      mapStreamEvent(
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"incomplete: true' } },
        null,
        streamState,
      )

      // content_block_stop with unparseable JSON — should not crash
      const stopEvents = mapStreamEvent(
        { type: "content_block_stop", index: 0 },
        null,
        streamState,
      )

      // tool_use_progress emitted with raw JSON string (not parsed) so input is preserved
      expect(stopEvents).toHaveLength(1)
      const stopEv = stopEvents[0]! as EventOf<"tool_use_progress">
      expect(stopEv.type).toBe("tool_use_progress")
      expect(typeof stopEv.input).toBe("string")
    })

    it("tracks multiple concurrent tools at different event.index values independently", () => {
      const streamState = new ToolStreamState()

      // Start two tools at different indices
      mapStreamEvent(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_a", name: "Read" },
        },
        null,
        streamState,
      )
      mapStreamEvent(
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tool_b", name: "Write" },
        },
        null,
        streamState,
      )

      // Interleave deltas
      mapStreamEvent(
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } },
        null,
        streamState,
      )
      mapStreamEvent(
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"b":' } },
        null,
        streamState,
      )
      mapStreamEvent(
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "1}" } },
        null,
        streamState,
      )
      mapStreamEvent(
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "2}" } },
        null,
        streamState,
      )

      // Stop tool_a
      const stopA = mapStreamEvent(
        { type: "content_block_stop", index: 0 },
        null,
        streamState,
      )
      expect(stopA).toHaveLength(1)
      const evA = stopA[0]! as EventOf<"tool_use_progress">
      expect(evA.input).toEqual({ a: 1 })
      expect(evA.id).toBe("tool_a")

      // Stop tool_b
      const stopB = mapStreamEvent(
        { type: "content_block_stop", index: 1 },
        null,
        streamState,
      )
      expect(stopB).toHaveLength(1)
      const evB = stopB[0]! as EventOf<"tool_use_progress">
      expect(evB.input).toEqual({ b: 2 })
      expect(evB.id).toBe("tool_b")
    })
  })

  // -------------------------------------------------------------------------
  // Task lifecycle mapping (mapSDKMessage)
  // -------------------------------------------------------------------------

  describe("task lifecycle mapping", () => {
    it("maps task_started to task_start event", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "task_started",
        task_id: "task_1",
        description: "Running tests",
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"task_start">
      expect(ev.type).toBe("task_start")
      expect(ev.taskId).toBe("task_1")
      expect(ev.description).toBe("Running tests")
    })

    it("maps task_started falls back to uuid when task_id missing", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "task_started",
        uuid: "uuid_1",
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"task_start">
      expect(ev.type).toBe("task_start")
      expect(ev.taskId).toBe("uuid_1")
      expect(ev.description).toBe("Background task")
    })

    it("maps task_progress to task_progress event", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "task_progress",
        task_id: "task_2",
        content: "50% complete",
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"task_progress">
      expect(ev.type).toBe("task_progress")
      expect(ev.taskId).toBe("task_2")
      expect(ev.output).toBe("50% complete")
    })

    it("maps task_notification to task_complete event", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "task_notification",
        task_id: "task_3",
        content: "All tests passed",
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"task_complete">
      expect(ev.type).toBe("task_complete")
      expect(ev.taskId).toBe("task_3")
      expect(ev.output).toBe("All tests passed")
    })

    it("maps task_notification falls back to result when content missing", () => {
      const streamState = new ToolStreamState()
      const events = mapSDKMessage({
        type: "task_notification",
        task_id: "task_4",
        result: "Done",
      }, streamState)

      expect(events).toHaveLength(1)
      const ev = events[0]! as EventOf<"task_complete">
      expect(ev.type).toBe("task_complete")
      expect(ev.output).toBe("Done")
    })
  })

  // -------------------------------------------------------------------------
  // Elicitation parsing (parseElicitationInput)
  // -------------------------------------------------------------------------

  describe("parseElicitationInput", () => {
    it("parses modern format with questions array containing object options", () => {
      const result = parseElicitationInput({
        questions: [
          {
            question: "Pick one",
            options: [
              { label: "A", description: "Option A" },
              { label: "B", description: "Option B" },
            ],
          },
        ],
      })

      expect(result).toHaveLength(1)
      expect(result[0].question).toBe("Pick one")
      expect(result[0].options).toHaveLength(2)
      expect(result[0].options[0].label).toBe("A")
      expect(result[0].options[0].description).toBe("Option A")
      expect(result[0].options[1].label).toBe("B")
      expect(result[0].allowFreeText).toBe(true)
    })

    it("falls back to legacy single-question shape when questions array is missing", () => {
      const result = parseElicitationInput({
        question: "Choose",
        options: ["X", "Y", "Z"],
      })

      expect(result).toHaveLength(1)
      expect(result[0].question).toBe("Choose")
      expect(result[0].options).toHaveLength(3)
      expect(result[0].options[0].label).toBe("X")
      expect(result[0].options[0].description).toBeUndefined()
      expect(result[0].options[1].label).toBe("Y")
      expect(result[0].options[2].label).toBe("Z")
    })

    it("falls back to legacy shape when questions array is empty", () => {
      const result = parseElicitationInput({
        questions: [],
        question: "Fallback question",
        options: ["A"],
      })

      expect(result).toHaveLength(1)
      expect(result[0].question).toBe("Fallback question")
      expect(result[0].options[0].label).toBe("A")
    })

    it("handles options that are objects vs strings in legacy format", () => {
      const result = parseElicitationInput({
        question: "Mixed",
        options: [
          "plain-string",
          { label: "Obj", description: "Object option", preview: "preview text" },
        ],
      })

      expect(result).toHaveLength(1)
      expect(result[0].options[0].label).toBe("plain-string")
      expect(result[0].options[0].description).toBeUndefined()
      expect(result[0].options[0].preview).toBeUndefined()
      expect(result[0].options[1].label).toBe("Obj")
      expect(result[0].options[1].description).toBe("Object option")
      expect(result[0].options[1].preview).toBe("preview text")
    })

    it("defaults question text and options when legacy input is minimal", () => {
      const result = parseElicitationInput({})

      expect(result).toHaveLength(1)
      expect(result[0].question).toBe("Choose an option")
      expect(result[0].options).toHaveLength(0)
    })

    it("preserves multiSelect and header from modern format", () => {
      const result = parseElicitationInput({
        questions: [
          {
            question: "Select many",
            header: "Multi-select header",
            options: [{ label: "One" }],
            multiSelect: true,
          },
        ],
      })

      expect(result).toHaveLength(1)
      expect(result[0].multiSelect).toBe(true)
      expect(result[0].header).toBe("Multi-select header")
    })

    it("forces allowFreeText when options empty and allowFreeText false", () => {
      const result = parseElicitationInput({
        questions: [{ question: "Pick one", options: [], allowFreeText: false }]
      })
      expect(result[0].allowFreeText).toBe(true)
    })

    it("generates fallback question when questions array is empty", () => {
      const result = parseElicitationInput({ questions: [] })
      expect(result.length).toBeGreaterThan(0)
      expect(result[0].allowFreeText).toBe(true)
    })

    it("fallback question uses input.question text when available", () => {
      const result = parseElicitationInput({ questions: [], question: "Custom fallback?" })
      expect(result[0].question).toBe("Custom fallback?")
    })
  })

  // -------------------------------------------------------------------------
  // AsyncQueue (extracted utility)
  // -------------------------------------------------------------------------

  describe("AsyncQueue", () => {
    function createQueue() {
      return new AsyncQueue<{ text: string }>()
    }

    it("push then pull resolves immediately", async () => {
      const queue = createQueue()
      queue.push({ text: "first" })
      const item = await queue.pull()
      expect(item.text).toBe("first")
    })

    it("pull then push blocks then resolves", async () => {
      const queue = createQueue()
      let resolved = false

      const pullPromise = queue.pull().then((item: any) => {
        resolved = true
        return item
      })

      // Pull should be blocked
      // Use a microtask flush to confirm it hasn't resolved yet
      await Promise.resolve()
      expect(resolved).toBe(false)

      // Push should unblock the pull
      queue.push({ text: "delayed" })
      const item = await pullPromise
      expect(resolved).toBe(true)
      expect(item.text).toBe("delayed")
    })

    it("close rejects waiting pulls", async () => {
      const queue = createQueue()
      const pullPromise = queue.pull()

      queue.close()

      await expect(pullPromise).rejects.toThrow("Queue closed")
    })

    it("push after close is silent (no crash)", () => {
      const queue = createQueue()
      queue.close()

      // Should not throw
      expect(() => queue.push({ text: "ignored" })).not.toThrow()
    })

    it("size tracks queued items", () => {
      const queue = createQueue()
      expect(queue.size).toBe(0)

      queue.push({ text: "a" })
      queue.push({ text: "b" })
      expect(queue.size).toBe(2)

      // pull consumes from queue synchronously when items exist
      queue.pull() // returns a promise that resolves immediately
      expect(queue.size).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Streaming event edge cases
  // -------------------------------------------------------------------------

  describe("streaming event edge cases", () => {
    it("maps message_delta with usage to cost_update event", () => {
      // message_delta with usage should produce a cost_update event
      // This is what drives real-time token counting in the spinner
      const streamState = new ToolStreamState()
      const events = mapStreamEvent(
        { type: "message_delta", usage: { output_tokens: 42 } },
        null,
        streamState,
      )
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("cost_update")
      expect((events[0] as any).outputTokens).toBe(42)
    })

    it("message_delta without usage emits no events", () => {
      const streamState = new ToolStreamState()
      const events = mapStreamEvent(
        { type: "message_delta" },
        null,
        streamState,
      )
      expect(events).toHaveLength(0)
    })

    it("content_block_start for text block emits no events", () => {
      // Text block starts are markers only — the actual text comes via content_block_delta
      const streamState = new ToolStreamState()
      const events = mapStreamEvent(
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        null,
        streamState,
      )
      expect(events).toHaveLength(0)
    })

    it("content_block_start for thinking block emits no events", () => {
      const streamState = new ToolStreamState()
      const events = mapStreamEvent(
        { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        null,
        streamState,
      )
      expect(events).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Session denied tools
  // -------------------------------------------------------------------------

  describe("session denied tools", () => {
    it("after denyToolUse with denyForSession, handlePermission auto-denies", async () => {
      const adapter = new ClaudeAdapter()

      // Set up an event channel so the permission bridge can push events
      const { EventChannel } = require("../../src/utils/event-channel")
      ;(adapter as any).eventChannel = new EventChannel()

      // Simulate a pending permission for the tool we'll deny
      const firstPermPromise = handlePermission(
        "perm_1",
        "Bash",
        { command: "rm -rf /" },
        {},
        (adapter as any).bridgeState,
      )

      // Deny it with denyForSession
      adapter.denyToolUse("perm_1", "Too dangerous", { denyForSession: true })

      const firstResult = await firstPermPromise
      expect(firstResult.behavior).toBe("deny")

      // Now a second permission request for the same tool should be auto-denied
      const secondResult = await handlePermission(
        "perm_2",
        "Bash",
        { command: "ls" },
        {},
        (adapter as any).bridgeState,
      )

      expect(secondResult.behavior).toBe("deny")
      expect(secondResult.behavior === "deny" && secondResult.message).toBe("Denied for session")

      // A different tool should still prompt (not auto-denied)
      const thirdPermPromise = handlePermission(
        "perm_3",
        "Read",
        { file: "test.txt" },
        {},
        (adapter as any).bridgeState,
      )

      // The promise should be pending (not auto-resolved)
      let thirdResolved = false
      thirdPermPromise.then(() => { thirdResolved = true })
      await Promise.resolve()
      expect(thirdResolved).toBe(false)

      // Clean up: resolve pending permission before close
      adapter.approveToolUse("perm_3")
      await thirdPermPromise

      adapter.close()
    })
  })
})
