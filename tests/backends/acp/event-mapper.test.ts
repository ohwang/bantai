import { describe, expect, it } from "bun:test"
import { mapAcpUpdate } from "../../../src/backends/acp/event-mapper"
import type { AcpSessionUpdateParams } from "../../../src/backends/acp/types"
// AgentEvent type used for documentation — assertions use `as any` casts

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeParams(update: any): AcpSessionUpdateParams {
  return { sessionId: "test-session", update }
}

// ---------------------------------------------------------------------------
// agent_message_chunk → text_delta
// ---------------------------------------------------------------------------

describe("ACP Event Mapper", () => {
  describe("agent_message_chunk → text_delta", () => {
    it("maps text content to text_delta", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello, world!" },
        }),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({ type: "text_delta", text: "Hello, world!" })
    })

    it("returns empty array for missing content", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: undefined,
        }),
      )

      expect(events).toHaveLength(0)
    })

    it("maps text content with empty string to empty array (keep-alive skip)", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "" },
        }),
      )

      // Empty string is a keep-alive — should be silently dropped, not backend_specific
      expect(events).toHaveLength(0)
    })

    it("maps image with uri to text_delta with filename link", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgo=",
            uri: "https://example.com/assets/screenshot.png",
          },
        }),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "text_delta",
        text: "\n[Image: screenshot.png](https://example.com/assets/screenshot.png)\n",
      })
    })

    it("maps image without uri to text_delta with mimeType", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgo=",
          },
        }),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "text_delta",
        text: "\n[Image: image/png]\n",
      })
    })

    it("maps resource_link to text_delta with markdown link", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "resource_link",
            uri: "file:///project/src/foo.ts",
            name: "foo.ts",
          },
        }),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "text_delta",
        text: "[foo.ts](file:///project/src/foo.ts)",
      })
    })

    it("maps resource_link without name to text_delta using uri as label", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "resource_link",
            uri: "file:///project/src/bar.ts",
            name: "",
          },
        }),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "text_delta",
        text: "[file:///project/src/bar.ts](file:///project/src/bar.ts)",
      })
    })
  })

  // ---------------------------------------------------------------------------
  // agent_thought_chunk → thinking_delta
  // ---------------------------------------------------------------------------

  describe("agent_thought_chunk → thinking_delta", () => {
    it("maps text thinking content to thinking_delta", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Let me think about this..." },
        }),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({ type: "thinking_delta", text: "Let me think about this..." })
    })

    it("returns empty array for missing content", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_thought_chunk",
          content: undefined,
        }),
      )

      expect(events).toHaveLength(0)
    })

    it("returns empty array for empty text", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "" },
        }),
      )

      expect(events).toHaveLength(0)
    })

    it("returns empty array for null text", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: null },
        }),
      )

      expect(events).toHaveLength(0)
    })

    it("maps non-text thinking content to backend_specific", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "image", mimeType: "image/png", data: "abc123" },
        }),
      )

      expect(events).toHaveLength(1)
      expect((events[0] as any).type).toBe("backend_specific")
      expect((events[0] as any).backend).toBe("acp")
    })

    it("accumulates multiple thought chunks", () => {
      const events1 = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "First, I should " },
        }),
      )
      const events2 = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "check the file structure." },
        }),
      )

      expect(events1).toHaveLength(1)
      expect(events1[0]!).toEqual({ type: "thinking_delta", text: "First, I should " })
      expect(events2).toHaveLength(1)
      expect(events2[0]!).toEqual({ type: "thinking_delta", text: "check the file structure." })
    })
  })

  // ---------------------------------------------------------------------------
  // tool_call → tool_use_start
  // ---------------------------------------------------------------------------

  describe("tool_call → tool_use_start", () => {
    it("maps toolCallId to id", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-42",
          kind: "read",
          title: "Read file",
          status: "in_progress",
          content: [],
        }),
      )

      expect(events).toHaveLength(1)
      const start = events[0]! as any
      expect(start.type).toBe("tool_use_start")
      expect(start.id).toBe("tc-42")
    })

    it("maps kind 'read' to tool name 'Read'", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          kind: "read",
          status: "in_progress",
          content: [],
        }),
      )

      expect((events[0]! as any).tool).toBe("Read")
    })

    it("maps kind 'edit' to tool name 'Edit'", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-2",
          kind: "edit",
          status: "in_progress",
          content: [],
        }),
      )

      expect((events[0]! as any).tool).toBe("Edit")
    })

    it("maps kind 'execute' to tool name 'Bash'", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-3",
          kind: "execute",
          status: "in_progress",
          content: [],
        }),
      )

      expect((events[0]! as any).tool).toBe("Bash")
    })

    it("maps kind 'search' to tool name 'Search'", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-4",
          kind: "search",
          status: "in_progress",
          content: [],
        }),
      )

      expect((events[0]! as any).tool).toBe("Search")
    })

    it("maps kind 'fetch' to tool name 'WebFetch'", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-5",
          kind: "fetch",
          status: "in_progress",
          content: [],
        }),
      )

      expect((events[0]! as any).tool).toBe("WebFetch")
    })

    it("maps kind 'think' to tool name 'Think'", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-6",
          kind: "think",
          status: "in_progress",
          content: [],
        }),
      )

      expect((events[0]! as any).tool).toBe("Think")
    })

    it("maps kind 'delete' to tool name 'Delete'", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-7",
          kind: "delete",
          status: "in_progress",
          content: [],
        }),
      )

      expect((events[0]! as any).tool).toBe("Delete")
    })

    it("maps kind 'move' to tool name 'Move'", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-8",
          kind: "move",
          status: "in_progress",
          content: [],
        }),
      )

      expect((events[0]! as any).tool).toBe("Move")
    })

    it("falls back to title for unknown kind", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-9",
          kind: "custom_tool",
          title: "My Custom Tool",
          status: "in_progress",
          content: [],
        }),
      )

      expect((events[0]! as any).tool).toBe("My Custom Tool")
    })

    it("falls back to kind when title is absent for unknown kind", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-10",
          kind: "custom_tool",
          status: "in_progress",
          content: [],
        }),
      )

      expect((events[0]! as any).tool).toBe("custom_tool")
    })

    it("falls back to 'Tool' when both kind and title are absent", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-11",
          status: "in_progress",
          content: [],
        }),
      )

      expect((events[0]! as any).tool).toBe("Tool")
    })

    it("includes title, kind, locations, and rawInput in input", () => {
      const locations = [{ path: "/project/src/foo.ts", line: 42 }]
      const rawInput = { file_path: "/project/src/foo.ts" }

      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-12",
          kind: "read",
          title: "Read foo.ts",
          status: "in_progress",
          content: [],
          locations,
          rawInput,
        }),
      )

      expect(events).toHaveLength(1)
      const start = events[0]! as any
      expect(start.input.title).toBe("Read foo.ts")
      expect(start.input.kind).toBe("read")
      expect(start.input.locations).toEqual(locations)
      expect(start.input.rawInput).toEqual(rawInput)
      // Normalized field extracted from rawInput
      expect(start.input.file_path).toBe("/project/src/foo.ts")
    })

    it("extracts file_path from rawInput object", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-13",
          kind: "read",
          status: "in_progress",
          content: [],
          rawInput: { file_path: "/project/src/bar.ts" },
        }),
      )

      const start = events[0]! as any
      expect(start.input.file_path).toBe("/project/src/bar.ts")
    })

    it("extracts command from rawInput object", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-14",
          kind: "execute",
          status: "in_progress",
          content: [],
          rawInput: { command: "ls -la" },
        }),
      )

      const start = events[0]! as any
      expect(start.input.command).toBe("ls -la")
    })

    it("extracts pattern from rawInput object", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-15",
          kind: "search",
          status: "in_progress",
          content: [],
          rawInput: { pattern: "TODO" },
        }),
      )

      const start = events[0]! as any
      expect(start.input.pattern).toBe("TODO")
    })

    it("extracts query from rawInput object", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-16",
          kind: "fetch",
          status: "in_progress",
          content: [],
          rawInput: { query: "how to use bun" },
        }),
      )

      const start = events[0]! as any
      expect(start.input.query).toBe("how to use bun")
    })

    it("extracts command from rawInput string for Bash tool", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-17",
          kind: "execute",
          status: "in_progress",
          content: [],
          rawInput: "git status",
        }),
      )

      const start = events[0]! as any
      expect(start.input.command).toBe("git status")
    })

    it("extracts file_path from rawInput string for Read tool", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-18",
          kind: "read",
          status: "in_progress",
          content: [],
          rawInput: "/project/src/main.ts",
        }),
      )

      const start = events[0]! as any
      expect(start.input.file_path).toBe("/project/src/main.ts")
    })

    it("extracts file_path from locations when rawInput has no file_path", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-19",
          kind: "read",
          status: "in_progress",
          content: [],
          locations: [{ path: "/project/src/index.ts", line: 1 }],
        }),
      )

      const start = events[0]! as any
      expect(start.input.file_path).toBe("/project/src/index.ts")
    })

    it("prefers rawInput.file_path over locations[0].path", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-20a",
          kind: "read",
          status: "in_progress",
          content: [],
          rawInput: { file_path: "/from/rawInput.ts" },
          locations: [{ path: "/from/locations.ts" }],
        }),
      )

      const start = events[0]! as any
      expect(start.input.file_path).toBe("/from/rawInput.ts")
    })

    it("falls back to rawInput.path for file_path", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-20b",
          kind: "read",
          status: "in_progress",
          content: [],
          rawInput: { path: "/project/src/alt.ts" },
        }),
      )

      const start = events[0]! as any
      expect(start.input.file_path).toBe("/project/src/alt.ts")
    })

    it("extracts pattern from rawInput string for Search tool", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call",
          toolCallId: "tc-20c",
          kind: "search",
          status: "in_progress",
          content: [],
          rawInput: "function.*export",
        }),
      )

      const start = events[0]! as any
      expect(start.input.pattern).toBe("function.*export")
    })
  })

  // ---------------------------------------------------------------------------
  // tool_call_update — status variations
  // ---------------------------------------------------------------------------

  describe("tool_call_update — status variations", () => {
    it("maps completed status to tool_use_end with output text", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-20",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "File contents here" },
            },
          ],
        }),
      )

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.type).toBe("tool_use_end")
      expect(end.id).toBe("tc-20")
      expect(end.output).toBe("File contents here")
      expect(end.error).toBeUndefined()
    })

    it("maps failed status to tool_use_end with error field", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-21",
          status: "failed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "Permission denied" },
            },
          ],
        }),
      )

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.type).toBe("tool_use_end")
      expect(end.id).toBe("tc-21")
      expect(end.output).toBe("Permission denied")
      expect(end.error).toBe("Permission denied")
    })

    it("maps in_progress with text content to tool_use_progress", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-22",
          status: "in_progress",
          content: [
            {
              type: "content",
              content: { type: "text", text: "Processing line 42..." },
            },
          ],
        }),
      )

      expect(events).toHaveLength(1)
      const progress = events[0]! as any
      expect(progress.type).toBe("tool_use_progress")
      expect(progress.id).toBe("tc-22")
      expect(progress.output).toBe("Processing line 42...")
    })

    it("returns empty array for in_progress with no content", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-23",
          status: "in_progress",
        }),
      )

      expect(events).toHaveLength(0)
    })

    it("returns empty array for in_progress with empty content array", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-24",
          status: "in_progress",
          content: [],
        }),
      )

      expect(events).toHaveLength(0)
    })

    it("includes diff content as unified diff in tool_use_progress output", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-25",
          status: "in_progress",
          content: [
            {
              type: "content",
              content: { type: "text", text: "Editing file..." },
            },
            {
              type: "diff",
              path: "/project/src/foo.ts",
              oldText: "const x = 1",
              newText: "const x = 2",
            },
          ],
        }),
      )

      // Single tool_use_progress with combined text + diff output (no backend_specific for diffs)
      expect(events).toHaveLength(1)

      const progress = events[0]! as any
      expect(progress.type).toBe("tool_use_progress")
      expect(progress.output).toContain("Editing file...")
      expect(progress.output).toContain("--- a//project/src/foo.ts")
      expect(progress.output).toContain("+++ b//project/src/foo.ts")
      expect(progress.output).toContain("@@ -1,1 +1,1 @@")
      expect(progress.output).toContain("-const x = 1")
      expect(progress.output).toContain("+const x = 2")
    })

    it("produces additional backend_specific for terminal content (terminal only)", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-26",
          status: "in_progress",
          content: [
            {
              type: "content",
              content: { type: "text", text: "Running command..." },
            },
            { type: "terminal", terminalId: "term-1" },
          ],
        }),
      )

      expect(events).toHaveLength(2)
      expect(events[0]!.type).toBe("tool_use_progress")
      expect(events[1]!.type).toBe("backend_specific")
      const bs = events[1]! as any
      expect(bs.data.type).toBe("tool_call_rich_content")
      // Only terminal content in the backend_specific, not diffs
      expect(bs.data.content).toHaveLength(1)
      expect(bs.data.content[0].type).toBe("terminal")
    })

    it("uses 'Tool completed' fallback when completed with empty content", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-27",
          status: "completed",
          content: [],
        }),
      )

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.type).toBe("tool_use_end")
      expect(end.output).toBe("Tool completed")
      expect(end.error).toBeUndefined()
    })

    it("uses 'Tool failed' fallback when failed with empty content", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-28",
          status: "failed",
          content: [],
        }),
      )

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.type).toBe("tool_use_end")
      expect(end.output).toBe("Tool failed")
      expect(end.error).toBe("Tool call failed")
    })

    it("uses 'Tool completed' fallback when completed with no content", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-29",
          status: "completed",
        }),
      )

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.output).toBe("Tool completed")
    })

    it("joins multiple text content items with newline", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-30",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "Line 1" },
            },
            {
              type: "content",
              content: { type: "text", text: "Line 2" },
            },
          ],
        }),
      )

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.output).toBe("Line 1\nLine 2")
    })

    it("combines text and diff content in output for completed status", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-31",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "Useful output" },
            },
            {
              type: "diff",
              path: "/project/src/bar.ts",
              oldText: "a",
              newText: "b",
            },
          ],
        }),
      )

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.output).toContain("Useful output")
      expect(end.output).toContain("--- a//project/src/bar.ts")
      expect(end.output).toContain("+++ b//project/src/bar.ts")
      expect(end.output).toContain("-a")
      expect(end.output).toContain("+b")
    })
  })

  // ---------------------------------------------------------------------------
  // plan → plan_update (structured plan entries)
  // ---------------------------------------------------------------------------

  describe("plan → plan_update", () => {
    it("maps plan entries with text to plan_update with structured entries", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "plan",
          entries: [
            { text: "Step 1: Read the file", status: "completed" },
            { text: "Step 2: Edit the function", status: "in_progress" },
          ],
        }),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "plan_update",
        entries: [
          { content: "Step 1: Read the file", priority: undefined, status: "completed" },
          { content: "Step 2: Edit the function", priority: undefined, status: "in_progress" },
        ],
      })
    })

    it("maps plan entries with title to plan_update using title as content", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "plan",
          entries: [{ title: "Investigate the bug" }],
        }),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "plan_update",
        entries: [{ content: "Investigate the bug", priority: undefined, status: undefined }],
      })
    })

    it("prefers content over text over title", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "plan",
          entries: [{ content: "Primary", text: "Secondary", title: "Tertiary" }],
        }),
      )

      expect(events).toHaveLength(1)
      expect((events[0]! as any).entries[0].content).toBe("Primary")
    })

    it("JSON-stringifies entries without content, text, or title", () => {
      const entry = { status: "pending", priority: 1 }
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "plan",
          entries: [entry],
        }),
      )

      expect(events).toHaveLength(1)
      expect((events[0]! as any).entries[0].content).toBe(JSON.stringify(entry))
    })

    it("returns empty array for empty entries", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "plan",
          entries: [],
        }),
      )

      expect(events).toHaveLength(0)
    })

    it("returns empty array for missing entries", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "plan",
        }),
      )

      expect(events).toHaveLength(0)
    })

    it("preserves priority and status fields", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "plan",
          entries: [
            { text: "First", priority: "high", status: "completed" },
            { title: "Second", priority: "low", status: "pending" },
            { status: "done" },
          ],
        }),
      )

      expect(events).toHaveLength(1)
      const entries = (events[0]! as any).entries
      expect(entries).toHaveLength(3)
      expect(entries[0].content).toBe("First")
      expect(entries[0].priority).toBe("high")
      expect(entries[0].status).toBe("completed")
      expect(entries[1].content).toBe("Second")
      expect(entries[1].priority).toBe("low")
      expect(entries[2].content).toBe('{"status":"done"}')
    })
  })

  // ---------------------------------------------------------------------------
  // available_commands_update → backend_specific
  // ---------------------------------------------------------------------------

  describe("available_commands_update → backend_specific", () => {
    it("maps commands array to backend_specific with type 'available_commands'", () => {
      const commands = [
        { name: "/help", description: "Show help" },
        { name: "/clear", description: "Clear conversation" },
        { name: "/compact" },
      ]

      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "available_commands_update",
          availableCommands: commands,
        }),
      )

      expect(events).toHaveLength(1)
      const bs = events[0]! as any
      expect(bs.type).toBe("backend_specific")
      expect(bs.backend).toBe("acp")
      expect(bs.data.type).toBe("available_commands")
      expect(bs.data.commands).toEqual(commands)
    })

    it("handles empty commands array", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "available_commands_update",
          availableCommands: [],
        }),
      )

      expect(events).toHaveLength(1)
      const bs = events[0]! as any
      expect(bs.data.commands).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // usage_update → cost_update
  // ---------------------------------------------------------------------------

  describe("usage_update → cost_update", () => {
    it("maps used/size to cost_update with contextTokens and contextWindow", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "usage_update",
          used: 5000,
          size: 128000,
        }),
      )

      expect(events).toHaveLength(1)
      const cost = events[0]! as any
      expect(cost.type).toBe("cost_update")
      expect(cost.inputTokens).toBe(5000)
      expect(cost.outputTokens).toBe(0)
      expect(cost.contextTokens).toBe(5000)
      expect(cost.contextWindow).toBe(128000)
      expect(cost.cost).toBeUndefined()
    })

    it("maps cost field to cost amount", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "usage_update",
          used: 3000,
          size: 128000,
          cost: { amount: 0.05, currency: "USD" },
        }),
      )

      expect(events).toHaveLength(1)
      const cost = events[0]! as any
      expect(cost.type).toBe("cost_update")
      expect(cost.inputTokens).toBe(3000)
      expect(cost.contextTokens).toBe(3000)
      expect(cost.contextWindow).toBe(128000)
      expect(cost.cost).toBe(0.05)
    })

    it("emits a cost_update with only contextWindow when only `size` is reported", () => {
      // Edge case: an agent that reports just the context-window cap without
      // a per-call usage figure. We still surface it so the reducer can patch
      // `session.models[].contextWindow`.
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "usage_update",
          size: 128000,
        }),
      )

      expect(events).toHaveLength(1)
      const cost = events[0]! as any
      expect(cost.contextWindow).toBe(128000)
      expect(cost.contextTokens).toBeUndefined()
    })

    it("returns empty array when used, size, and cost are all missing", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "usage_update",
          other: "field",
        }),
      )

      expect(events).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // agent_message_chunk piggyback usage (Qwen Code emitUsageMetadata path)
  // ---------------------------------------------------------------------------

  describe("agent_message_chunk._meta.usage → cost_update", () => {
    it("emits a cost_update alongside the text mapping when _meta.usage is present", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
          _meta: {
            usage: {
              inputTokens: 12345,
              outputTokens: 678,
              totalTokens: 13023,
            },
            durationMs: 1500,
          },
        }),
      )

      expect(events).toHaveLength(2)
      const text = events[0]! as any
      expect(text.type).toBe("text_delta")
      expect(text.text).toBe("hello")
      const cost = events[1]! as any
      expect(cost.type).toBe("cost_update")
      expect(cost.inputTokens).toBe(12345)
      expect(cost.outputTokens).toBe(678)
      expect(cost.contextTokens).toBe(12345)
    })

    it("emits cost_update even when text is empty (Qwen's keep-alive usage carrier)", () => {
      // Qwen Code 0.15.x emits an `agent_message_chunk` with `text: ""` purely
      // to attach `_meta.usage`; the text branch logs+drops the empty string,
      // but we still want the usage to flow to the reducer.
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "" },
          _meta: {
            usage: { inputTokens: 9000, outputTokens: 0 },
          },
        }),
      )

      expect(events).toHaveLength(1)
      const cost = events[0]! as any
      expect(cost.type).toBe("cost_update")
      expect(cost.contextTokens).toBe(9000)
    })

    it("ignores _meta without usage", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ok" },
          _meta: { other: "field" },
        }),
      )

      expect(events).toHaveLength(1)
      expect((events[0]! as any).type).toBe("text_delta")
    })
  })

  // ---------------------------------------------------------------------------
  // config_option_update → backend_specific
  // ---------------------------------------------------------------------------

  describe("config_option_update → backend_specific", () => {
    it("maps configOptions to backend_specific with config data", () => {
      const configOptions = [
        { id: "opt1", name: "Option 1", type: "boolean", value: true },
        { id: "opt2", name: "Option 2", type: "string", value: "hello" },
      ]

      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "config_option_update",
          configOptions,
        }),
      )

      expect(events).toHaveLength(1)
      const bs = events[0]! as any
      expect(bs.type).toBe("backend_specific")
      expect(bs.backend).toBe("acp")
      expect(bs.data.type).toBe("config_option_session_update")
      expect(bs.data.configOptions).toEqual(configOptions)
    })
  })

  // ---------------------------------------------------------------------------
  // current_mode_update → backend_specific
  // ---------------------------------------------------------------------------

  describe("current_mode_update → backend_specific", () => {
    it("maps currentModeId to backend_specific", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "current_mode_update",
          currentModeId: "agent",
        }),
      )

      expect(events).toHaveLength(1)
      const bs = events[0]! as any
      expect(bs.type).toBe("backend_specific")
      expect(bs.backend).toBe("acp")
      expect(bs.data.type).toBe("current_mode_update")
      expect(bs.data.currentModeId).toBe("agent")
    })
  })

  // ---------------------------------------------------------------------------
  // session_info_update → backend_specific
  // ---------------------------------------------------------------------------

  describe("session_info_update → backend_specific", () => {
    it("maps title and updatedAt to backend_specific", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "session_info_update",
          title: "My Session",
          updatedAt: "2026-04-09T12:00:00Z",
        }),
      )

      expect(events).toHaveLength(1)
      const bs = events[0]! as any
      expect(bs.type).toBe("backend_specific")
      expect(bs.backend).toBe("acp")
      expect(bs.data.type).toBe("session_info_update")
      expect(bs.data.title).toBe("My Session")
      expect(bs.data.updatedAt).toBe("2026-04-09T12:00:00Z")
    })
  })

  // ---------------------------------------------------------------------------
  // user_message_chunk → user_message
  // ---------------------------------------------------------------------------

  describe("user_message_chunk → user_message", () => {
    it("maps text content to user_message", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Hello from the user" },
        }),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({ type: "user_message", text: "Hello from the user" })
    })

    it("returns empty array for empty text", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "" },
        }),
      )

      expect(events).toHaveLength(0)
    })

    it("returns empty array for missing content", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "user_message_chunk",
          content: undefined,
        }),
      )

      expect(events).toHaveLength(0)
    })

    it("drops non-text user content with log", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "user_message_chunk",
          content: { type: "image", mimeType: "image/png", data: "abc=" },
        }),
      )

      expect(events).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // audio content → text_delta placeholder
  // ---------------------------------------------------------------------------

  describe("audio content → text_delta", () => {
    it("maps audio content to text_delta with mimeType placeholder", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: { type: "audio", mimeType: "audio/wav", data: "UklGR..." },
        }),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "text_delta",
        text: "\n[Audio: audio/wav]\n",
      })
    })
  })

  // ---------------------------------------------------------------------------
  // resource content → text_delta
  // ---------------------------------------------------------------------------

  describe("resource content → text_delta", () => {
    it("inlines text resource directly", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "resource",
            resource: { uri: "file:///data.txt", text: "Hello from resource", mimeType: "text/plain" },
          },
        }),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "text_delta",
        text: "Hello from resource",
      })
    })

    it("renders URI link for resource without text", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "resource",
            resource: { uri: "file:///project/data.bin", mimeType: "application/octet-stream" },
          },
        }),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "text_delta",
        text: "[Resource: file:///project/data.bin]",
      })
    })

    it("falls back to 'resource' label when URI is missing", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "resource",
            resource: { mimeType: "application/json" },
          },
        }),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!).toEqual({
        type: "text_delta",
        text: "[Resource: resource]",
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Unknown update type → backend_specific
  // ---------------------------------------------------------------------------

  describe("unknown update type → backend_specific", () => {
    it("returns backend_specific with backend 'acp'", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "some_future_update",
          payload: { data: 123 },
        }),
      )

      expect(events).toHaveLength(1)
      const bs = events[0]! as any
      expect(bs.type).toBe("backend_specific")
      expect(bs.backend).toBe("acp")
    })

    it("contains the original update in data", () => {
      const update = {
        sessionUpdate: "new_protocol_feature",
        extra: "value",
      }

      const events = mapAcpUpdate(makeParams(update))

      expect(events).toHaveLength(1)
      const bs = events[0]! as any
      expect(bs.data.method).toBe("session/update")
      expect(bs.data.update).toEqual(update)
    })
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("returns empty array when update is undefined", () => {
      const events = mapAcpUpdate({ sessionId: "test-session", update: undefined as any })
      expect(events).toHaveLength(0)
    })

    it("returns empty array when update is null", () => {
      const events = mapAcpUpdate({ sessionId: "test-session", update: null as any })
      expect(events).toHaveLength(0)
    })

    it("returns empty array when sessionUpdate field is missing", () => {
      const events = mapAcpUpdate(makeParams({}))
      expect(events).toHaveLength(0)
    })

    it("returns empty array when sessionUpdate is empty string", () => {
      const events = mapAcpUpdate(makeParams({ sessionUpdate: "" }))
      expect(events).toHaveLength(0)
    })

    it("handles tool_call_update with completed status and diff-only content", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-40",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "/project/src/a.ts",
              oldText: "old",
              newText: "new",
            },
          ],
        }),
      )

      // Diff content is now included in output as unified diff
      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.type).toBe("tool_use_end")
      expect(end.output).toContain("--- a//project/src/a.ts")
      expect(end.output).toContain("+++ b//project/src/a.ts")
      expect(end.output).toContain("-old")
      expect(end.output).toContain("+new")
      expect(end.error).toBeUndefined()
    })

    it("handles tool_call_update with failed status and non-text content only", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-41",
          status: "failed",
          content: [
            { type: "terminal", terminalId: "term-2" },
          ],
        }),
      )

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.type).toBe("tool_use_end")
      expect(end.output).toBe("Tool failed")
      expect(end.error).toBe("Tool call failed")
    })

    it("in_progress with only diff content produces tool_use_progress with unified diff", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-42",
          status: "in_progress",
          content: [
            {
              type: "diff",
              path: "/project/src/b.ts",
              oldText: "x",
              newText: "y",
            },
          ],
        }),
      )

      // Diff content now included in tool_use_progress (no backend_specific)
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("tool_use_progress")
      const progress = events[0]! as any
      expect(progress.output).toContain("--- a//project/src/b.ts")
      expect(progress.output).toContain("+++ b//project/src/b.ts")
      expect(progress.output).toContain("@@ -1,1 +1,1 @@")
      expect(progress.output).toContain("-x")
      expect(progress.output).toContain("+y")
    })

    it("in_progress with text + diff produces single progress with combined output", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-43",
          status: "in_progress",
          content: [
            {
              type: "content",
              content: { type: "text", text: "Applying edit" },
            },
            {
              type: "diff",
              path: "/project/src/c.ts",
              oldText: "a",
              newText: "b",
            },
          ],
        }),
      )

      // Single tool_use_progress with combined text + unified diff
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("tool_use_progress")
      const progress = events[0]! as any
      expect(progress.output).toContain("Applying edit")
      expect(progress.output).toContain("--- a//project/src/c.ts")
      expect(progress.output).toContain("+++ b//project/src/c.ts")
    })

    it("in_progress with content that has non-text inner type returns no progress", () => {
      // content.type === "content" but inner content is image, not text
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-44",
          status: "in_progress",
          content: [
            {
              type: "content",
              content: {
                type: "image",
                mimeType: "image/png",
                data: "abc=",
              },
            },
          ],
        }),
      )

      // extractToolContentText returns "" for image content → no progress event
      // No diff/terminal → no backend_specific
      expect(events).toHaveLength(0)
    })

    it("diff format includes markers recognized by tool-view for rendering", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-50",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "src/utils/helper.ts",
              oldText: "function foo() {\n  return 1\n}",
              newText: "function foo() {\n  return 2\n}",
            },
          ],
        }),
      )

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      // tool-view.tsx detects unified diff by looking for these three markers
      expect(end.output).toMatch(/^--- a\//)
      expect(end.output).toContain("+++ b/")
      expect(end.output).toContain("@@ -1,3 +1,3 @@")
    })

    it("multiple diff blocks are separated by blank lines", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-51",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "a.ts",
              oldText: "x",
              newText: "y",
            },
            {
              type: "diff",
              path: "b.ts",
              oldText: "1",
              newText: "2",
            },
          ],
        }),
      )

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      // Both diffs present
      expect(end.output).toContain("--- a/a.ts")
      expect(end.output).toContain("--- a/b.ts")
      // Separated by double newline
      expect(end.output).toContain("+y\n\n--- a/b.ts")
    })

    it("failed status with diff content includes diff in error", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-52",
          status: "failed",
          content: [
            {
              type: "diff",
              path: "broken.ts",
              oldText: "old code",
              newText: "new code",
            },
          ],
        }),
      )

      expect(events).toHaveLength(1)
      const end = events[0]! as any
      expect(end.type).toBe("tool_use_end")
      expect(end.output).toContain("--- a/broken.ts")
      expect(end.error).toContain("--- a/broken.ts")
    })

    it("terminal-only content still emits backend_specific without diff interference", () => {
      const events = mapAcpUpdate(
        makeParams({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-53",
          status: "in_progress",
          content: [
            { type: "terminal", terminalId: "term-5" },
          ],
        }),
      )

      // No text or diff → no tool_use_progress, just backend_specific for terminal
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe("backend_specific")
      const bs = events[0]! as any
      expect(bs.data.type).toBe("tool_call_rich_content")
      expect(bs.data.content).toHaveLength(1)
      expect(bs.data.content[0].type).toBe("terminal")
    })

    it("preserves sessionId through params but does not appear in events", () => {
      const events = mapAcpUpdate({
        sessionId: "specific-session-123",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        } as any,
      })

      expect(events).toHaveLength(1)
      // AgentEvent does not carry sessionId
      expect((events[0]! as any).sessionId).toBeUndefined()
    })
  })
})
