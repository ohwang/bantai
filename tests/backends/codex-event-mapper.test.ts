import { describe, expect, it } from "bun:test"
import { mapCodexNotification } from "../../src/backends/codex/event-mapper"

describe("Codex Event Mapper", () => {
  describe("thread lifecycle", () => {
    it("maps thread/started to session_init (sessionId = Codex thread id)", () => {
      // Regression: the mapper used to emit `sessionId: crypto.randomUUID()`
      // on every thread/started, which silently broke resume. Slack persisted
      // the ghost id to ~/.bantai/slack.db; on the next turn bantai asked
      // Codex to resume it, Codex couldn't find it, and from a cross-backend
      // POV the id existed nowhere on disk — a hard phantom. Now the session
      // id IS the Codex thread id, so persistence + resume + cross-backend
      // lookup all agree on one identifier.
      const events = mapCodexNotification("thread/started", {
        thread: {
          id: "thread-1",
          preview: "Hello",
          modelProvider: "openai",
          createdAt: 1234567890,
          status: "active",
        },
      })

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("session_init")
      const init = events[0]! as any
      expect(init.sessionId).toBe("thread-1")
      expect(init.models).toHaveLength(1)
      expect(init.models[0].provider).toBe("openai")
    })

    it("leaves sessionId undefined when thread.id is missing (do NOT forge a random UUID)", () => {
      // Defensive: if Codex ever changes its notification shape, emitting a
      // synthetic UUID again would re-introduce the ghost-id class of bug.
      // Prefer an undefined sessionId (the adapter has a separate safety-net
      // that injects this.threadId from the thread/start response) so any
      // downstream "resume" path correctly sees "no id to resume with".
      const events = mapCodexNotification("thread/started", {
        thread: { preview: "no-id", modelProvider: "openai" },
      })
      expect(events).toHaveLength(1)
      const init = events[0]! as any
      expect(init.type).toBe("session_init")
      expect(init.sessionId).toBeUndefined()
    })

    it("leaves sessionId undefined when thread.id is empty string", () => {
      const events = mapCodexNotification("thread/started", {
        thread: { id: "", modelProvider: "openai" },
      })
      expect(events).toHaveLength(1)
      expect((events[0]! as any).sessionId).toBeUndefined()
    })

    it("maps thread/status/changed to session_state", () => {
      const idle = mapCodexNotification("thread/status/changed", { status: "idle" })
      expect(idle).toHaveLength(1)
      expect(idle[0]).toEqual({ type: "session_state", state: "idle" })

      const active = mapCodexNotification("thread/status/changed", {
        status: "active",
      })
      expect(active).toHaveLength(1)
      expect(active[0]).toEqual({ type: "session_state", state: "running" })
    })

    it("maps thread/tokenUsage/updated to cost_update", () => {
      const events = mapCodexNotification("thread/tokenUsage/updated", {
        tokenUsage: {
          last: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 },
          total: { inputTokens: 200, outputTokens: 100, cachedInputTokens: 20 },
        },
      })

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("cost_update")
      const cost = events[0]! as any
      // Should prefer .last over .total
      expect(cost.inputTokens).toBe(100)
      expect(cost.outputTokens).toBe(50)
      expect(cost.cacheReadTokens).toBe(10)
    })

    it("forwards reasoningOutputTokens and modelContextWindow (codex 0.122+)", () => {
      const events = mapCodexNotification("thread/tokenUsage/updated", {
        tokenUsage: {
          last: {
            inputTokens: 100,
            outputTokens: 50,
            cachedInputTokens: 10,
            reasoningOutputTokens: 30,
          },
          total: { inputTokens: 200, outputTokens: 100, cachedInputTokens: 20 },
          modelContextWindow: 400_000,
        },
      })

      expect(events).toHaveLength(1)
      const cost = events[0]! as any
      expect(cost.type).toBe("cost_update")
      // reasoningOutputTokens is a SUBSET of outputTokens — outputTokens stays at 50
      expect(cost.outputTokens).toBe(50)
      expect(cost.reasoningTokens).toBe(30)
      expect(cost.contextWindow).toBe(400_000)
    })

    it("propagates reasoningOutputTokens through turn/completed.usage", () => {
      const events = mapCodexNotification("turn/completed", {
        turn: {
          id: "turn-1",
          status: "completed",
          usage: {
            inputTokens: 200,
            outputTokens: 80,
            cachedInputTokens: 40,
            reasoningOutputTokens: 25,
          },
        },
      })

      expect(events).toHaveLength(1)
      const ev = events[0]! as any
      expect(ev.type).toBe("turn_complete")
      expect(ev.usage.outputTokens).toBe(80)
      expect(ev.usage.reasoningTokens).toBe(25)
    })

    it("maps thread/compacted to compact", () => {
      const events = mapCodexNotification("thread/compacted", {})
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("compact")
    })

    it("maps thread/compacted with summary and token metadata", () => {
      const events = mapCodexNotification("thread/compacted", {
        summary: "Discussed TypeScript refactor.",
        preTokens: 90000,
        postTokens: 22000,
      })
      expect(events).toHaveLength(1)
      const ev = events[0]! as any
      expect(ev.type).toBe("compact")
      expect(ev.summary).toBe("Discussed TypeScript refactor.")
      expect(ev.trigger).toBe("auto")
      expect(ev.preTokens).toBe(90000)
      expect(ev.postTokens).toBe(22000)
    })

    it("Codex dual compact events end up as a single block in reducer state", async () => {
      // This guards against Codex emitting both `thread/compacted` (thread-level)
      // and `item/started:contextCompaction` (item-level) for the same
      // auto-compaction. The reducer must coalesce them.
      const { reduce } = await import("../../src/protocol/reducer")
      const { createInitialState } = await import("../../src/protocol/types")

      const threadCompacted = mapCodexNotification("thread/compacted", {
        summary: "Auto-compacted.",
        preTokens: 80000,
        postTokens: 12000,
      })
      const itemCompaction = mapCodexNotification("item/started", {
        item: { type: "contextCompaction", id: "cc-1", summary: "Context compaction." },
      })

      expect(threadCompacted).toHaveLength(1)
      expect(itemCompaction).toHaveLength(1)

      let state = createInitialState()
      state = reduce(state, { type: "session_init", tools: [], models: [] })
      for (const ev of [...threadCompacted, ...itemCompaction]) {
        state = reduce(state, ev)
      }

      const compactBlocks = state.blocks.filter(b => b.type === "compact")
      expect(compactBlocks).toHaveLength(1)
      // Dedup preserves token metadata from whichever event supplied it
      const block = compactBlocks[0]!
      if (block.type === "compact") {
        expect(block.preTokens).toBe(80000)
        expect(block.postTokens).toBe(12000)
      }
    })
  })

  describe("turn lifecycle", () => {
    it("maps turn/started to turn_start", () => {
      const events = mapCodexNotification("turn/started", {
        threadId: "t1",
        turn: { id: "turn-1", status: "inProgress" },
      })

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("turn_start")
    })

    it("maps turn/completed to turn_complete", () => {
      const events = mapCodexNotification("turn/completed", {
        turn: { id: "turn-1", status: "completed" },
      })

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("turn_complete")
    })

    it("maps turn/completed with failure to error + turn_complete", () => {
      const events = mapCodexNotification("turn/completed", {
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "Something went wrong", codexErrorInfo: "internalServerError" },
        },
      })

      expect(events).toHaveLength(2)
      expect(events[0]!.type).toBe("turn_complete")
      expect(events[1]!.type).toBe("error")
      const err = events[1]! as any
      expect(err.code).toBe("internalServerError")
      expect(err.message).toBe("Something went wrong")
    })

    it("maps interrupted turn/completed without error", () => {
      const events = mapCodexNotification("turn/completed", {
        turn: { id: "turn-1", status: "interrupted" },
      })

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("turn_complete")
    })
  })

  describe("streaming deltas", () => {
    it("maps item/agentMessage/delta to text_delta", () => {
      const events = mapCodexNotification("item/agentMessage/delta", {
        delta: "Hello, ",
      })

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({ type: "text_delta", text: "Hello, " })
    })

    it("maps item/reasoning/summaryTextDelta to thinking_delta", () => {
      const events = mapCodexNotification("item/reasoning/summaryTextDelta", {
        delta: "Analyzing...",
      })

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({ type: "thinking_delta", text: "Analyzing..." })
    })

    it("maps item/reasoning/textDelta to thinking_delta", () => {
      const events = mapCodexNotification("item/reasoning/textDelta", {
        delta: "raw reasoning",
      })

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({ type: "thinking_delta", text: "raw reasoning" })
    })

    it("maps item/commandExecution/outputDelta to tool_use_progress", () => {
      const events = mapCodexNotification("item/commandExecution/outputDelta", {
        itemId: "item-1",
        delta: "$ npm test\n",
      })

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "tool_use_progress",
        id: "item-1",
        output: "$ npm test\n",
      })
    })

    it("maps item/fileChange/outputDelta to tool_use_progress", () => {
      const events = mapCodexNotification("item/fileChange/outputDelta", {
        itemId: "item-2",
        delta: "+new line\n",
      })

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "tool_use_progress",
        id: "item-2",
        output: "+new line\n",
      })
    })

    it("maps item/plan/delta to thinking_delta", () => {
      const events = mapCodexNotification("item/plan/delta", {
        delta: "Step 1: ",
      })

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({ type: "thinking_delta", text: "Step 1: " })
    })

    it("ignores deltas with missing data", () => {
      expect(mapCodexNotification("item/agentMessage/delta", {})).toHaveLength(0)
      expect(
        mapCodexNotification("item/commandExecution/outputDelta", {
          delta: "text",
        }),
      ).toHaveLength(0)  // missing itemId
    })
  })

  describe("item/started", () => {
    it("maps commandExecution to tool_use_start", () => {
      const events = mapCodexNotification("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "npm test",
          cwd: "/project",
        },
      })

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("tool_use_start")
      const start = events[0]! as any
      expect(start.id).toBe("cmd-1")
      expect(start.tool).toBe("Bash")
      expect(start.input.command).toBe("npm test")
    })

    it("maps fileChange to tool_use_start", () => {
      const events = mapCodexNotification("item/started", {
        item: {
          type: "fileChange",
          id: "fc-1",
          changes: [{ path: "src/foo.ts", kind: "update" }],
        },
      })

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("tool_use_start")
      const start = events[0]! as any
      expect(start.id).toBe("fc-1")
      expect(start.tool).toBe("Edit")
    })

    it("maps mcpToolCall to tool_use_start", () => {
      const events = mapCodexNotification("item/started", {
        item: {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "my-server",
          tool: "search",
          arguments: { query: "test" },
        },
      })

      expect(events).toHaveLength(1)
      const start = events[0]! as any
      expect(start.type).toBe("tool_use_start")
      expect(start.tool).toBe("mcp:my-server/search")
      expect(start.input).toEqual({ query: "test" })
    })

    it("maps webSearch to tool_use_start", () => {
      const events = mapCodexNotification("item/started", {
        item: {
          type: "webSearch",
          id: "ws-1",
          query: "typescript generics",
        },
      })

      expect(events).toHaveLength(1)
      const start = events[0]! as any
      expect(start.tool).toBe("WebSearch")
      expect(start.input).toEqual({ query: "typescript generics" })
    })

    it("does not emit event for agentMessage start", () => {
      const events = mapCodexNotification("item/started", {
        item: { type: "agentMessage", id: "am-1" },
      })
      expect(events).toHaveLength(0)
    })

    it("does not emit event for reasoning start", () => {
      const events = mapCodexNotification("item/started", {
        item: { type: "reasoning", id: "r-1" },
      })
      expect(events).toHaveLength(0)
    })

    it("maps contextCompaction to compact", () => {
      const events = mapCodexNotification("item/started", {
        item: { type: "contextCompaction", id: "cc-1" },
      })
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("compact")
    })
  })

  describe("item/completed", () => {
    it("maps agentMessage completion to text_complete", () => {
      const events = mapCodexNotification("item/completed", {
        item: {
          type: "agentMessage",
          id: "am-1",
          text: "The answer is 42.",
        },
      })

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "text_complete",
        text: "The answer is 42.",
      })
    })

    it("maps commandExecution success to tool_use_end", () => {
      const events = mapCodexNotification("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-1",
          status: "completed",
          aggregatedOutput: "All tests passed\n",
          exitCode: 0,
        },
      })

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.type).toBe("tool_use_end")
      expect(end.id).toBe("cmd-1")
      expect(end.output).toBe("All tests passed\n")
      expect(end.error).toBeUndefined()
    })

    it("maps commandExecution failure to tool_use_end with error", () => {
      const events = mapCodexNotification("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-2",
          status: "failed",
          aggregatedOutput: "Error: file not found",
          exitCode: 1,
        },
      })

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.type).toBe("tool_use_end")
      expect(end.error).toBe("Error: file not found")
    })

    it("maps fileChange completion to tool_use_end", () => {
      const events = mapCodexNotification("item/completed", {
        item: {
          type: "fileChange",
          id: "fc-1",
          status: "completed",
          changes: [
            { path: "src/a.ts", kind: "update" },
            { path: "src/b.ts", kind: "add" },
          ],
        },
      })

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.type).toBe("tool_use_end")
      expect(end.output).toContain("update: src/a.ts")
      expect(end.output).toContain("add: src/b.ts")
    })

    it("maps mcpToolCall completion to tool_use_end", () => {
      const events = mapCodexNotification("item/completed", {
        item: {
          type: "mcpToolCall",
          id: "mcp-1",
          status: "completed",
          result: {
            content: [{ type: "text", text: "Result data" }],
          },
        },
      })

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.type).toBe("tool_use_end")
      expect(end.output).toBe("Result data")
    })

    it("maps mcpToolCall failure to tool_use_end with error", () => {
      const events = mapCodexNotification("item/completed", {
        item: {
          type: "mcpToolCall",
          id: "mcp-2",
          status: "failed",
          error: { message: "Server unavailable" },
        },
      })

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.error).toBe("Server unavailable")
    })

    it("maps webSearch completion to tool_use_end", () => {
      const events = mapCodexNotification("item/completed", {
        item: { type: "webSearch", id: "ws-1" },
      })

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.type).toBe("tool_use_end")
      expect(end.output).toBe("Web search completed")
    })

    it("propagates query from webSearch completion via tool_use_progress", () => {
      const events = mapCodexNotification("item/completed", {
        item: { type: "webSearch", id: "ws-1", query: "typescript generics" },
      })

      expect(events).toHaveLength(2)
      // First: progress event propagates the query to update tool block input
      const progress = events[0]! as any
      expect(progress.type).toBe("tool_use_progress")
      expect(progress.input).toEqual({ query: "typescript generics" })
      expect(progress.output).toBe("")
      // Second: end event
      const end = events[1]! as any
      expect(end.type).toBe("tool_use_end")
      expect(end.output).toBe("Web search completed")
    })
  })

  describe("error handling", () => {
    it("maps error notification", () => {
      const events = mapCodexNotification("error", {
        code: "rate_limit",
        message: "Too many requests",
      })

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "error",
        code: "rate_limit",
        message: "Too many requests",
        severity: "recoverable",
      })
    })
  })

  describe("passthrough events", () => {
    it("maps account/rateLimits/updated with 5h/7d durations to Claude-compatible buckets", () => {
      const events = mapCodexNotification("account/rateLimits/updated", {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 12,
            windowDurationMins: 300,
            resetsAt: 1775019636,
          },
          secondary: {
            usedPercent: 8,
            windowDurationMins: 10080,
            resetsAt: 1775206513,
          },
        },
      })

      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({
        type: "rate_limit_update",
        rateLimitType: "five_hour",
        utilization: 0.12,
        resetsAt: 1775019636,
        windowDurationMins: 300,
        source: "codex",
      })
      expect(events[1]).toEqual({
        type: "rate_limit_update",
        rateLimitType: "seven_day",
        utilization: 0.08,
        resetsAt: 1775206513,
        windowDurationMins: 10080,
        source: "codex",
      })
    })

    it("preserves generic primary/secondary when durations don't match 5h/7d", () => {
      const events = mapCodexNotification("account/rateLimits/updated", {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 25,
            windowDurationMins: 15,
            resetsAt: 1775019636,
          },
          secondary: {
            usedPercent: 40,
            windowDurationMins: 60,
            resetsAt: 1775020236,
          },
        },
      })

      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({
        type: "rate_limit_update",
        rateLimitType: "primary",
        utilization: 0.25,
        resetsAt: 1775019636,
        windowDurationMins: 15,
        source: "codex",
      })
      expect(events[1]).toEqual({
        type: "rate_limit_update",
        rateLimitType: "secondary",
        utilization: 0.40,
        resetsAt: 1775020236,
        windowDurationMins: 60,
        source: "codex",
      })
    })

    it("falls back to slot name when windowDurationMins is missing", () => {
      const events = mapCodexNotification("account/rateLimits/updated", {
        rateLimits: {
          primary: {
            usedPercent: 50,
            resetsAt: 1775019636,
          },
        },
      })

      expect(events).toHaveLength(1)
      expect((events[0] as any).type).toBe("rate_limit_update")
      expect((events[0] as any).rateLimitType).toBe("primary")
      expect((events[0] as any).windowDurationMins).toBeUndefined()
    })

    it("passes turn/diff/updated as backend_specific", () => {
      const events = mapCodexNotification("turn/diff/updated", { diff: "..." })
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("backend_specific")
      expect((events[0]! as any).backend).toBe("codex")
    })

    it("passes unknown methods as backend_specific", () => {
      const events = mapCodexNotification("some/future/event", { data: 1 })
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("backend_specific")
    })

    it("ignores serverRequest/resolved", () => {
      const events = mapCodexNotification("serverRequest/resolved", {})
      expect(events).toHaveLength(0)
    })

    it("ignores thread/name/updated", () => {
      const events = mapCodexNotification("thread/name/updated", {
        name: "My Thread",
      })
      expect(events).toHaveLength(0)
    })
  })

  describe("edge cases", () => {
    it("handles missing item in item/started", () => {
      const events = mapCodexNotification("item/started", {})
      expect(events).toHaveLength(0)
    })

    it("handles missing item in item/completed", () => {
      const events = mapCodexNotification("item/completed", {})
      expect(events).toHaveLength(0)
    })

    it("handles empty agentMessage text", () => {
      const events = mapCodexNotification("item/completed", {
        item: { type: "agentMessage", id: "am-1", text: "" },
      })
      expect(events).toHaveLength(0) // empty text is skipped
    })

    it("handles thread/started with no modelProvider", () => {
      const events = mapCodexNotification("thread/started", {
        thread: { id: "t1", status: "active" },
      })
      expect(events).toHaveLength(1)
      expect((events[0]! as any).models).toHaveLength(0)
    })
  })
})
