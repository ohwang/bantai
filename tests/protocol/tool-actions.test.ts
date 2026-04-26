/**
 * Regression test for Cluster 13 — tool → file-action lookup.
 *
 * Pre-anti-drift, the mapping was three lines of inline ternary in
 * `protocol/reducer.ts`:
 *
 *     block.tool === "Write" ? "create"
 *     : block.tool === "Edit" ? "edit"
 *     : "read"
 *
 * This silently demoted `MultiEdit`, `NotebookEdit`, `Update` — every
 * Claude built-in tool that mutates a file but isn't named "Edit" —
 * to `"read"`. The test pins the central `TOOL_ACTION_MAP` so adding a
 * write-style tool only requires touching the registry.
 */

import { describe, it, expect } from "bun:test"
import { actionForTool, TOOL_ACTION_MAP } from "../../src/protocol/tool-actions"
import { reduce } from "../../src/protocol/reducer"
import { createInitialState } from "../../src/protocol/types"
import type { Block } from "../../src/protocol/types"

describe("tool-actions registry (Cluster 13)", () => {
  it("Write maps to 'create'", () => {
    expect(actionForTool("Write")).toBe("create")
  })

  it("Edit-family tools all map to 'edit'", () => {
    expect(actionForTool("Edit")).toBe("edit")
    expect(actionForTool("MultiEdit")).toBe("edit")
    expect(actionForTool("NotebookEdit")).toBe("edit")
    expect(actionForTool("Update")).toBe("edit")
  })

  it("Read-family tools map to 'read'", () => {
    expect(actionForTool("Read")).toBe("read")
    expect(actionForTool("NotebookRead")).toBe("read")
  })

  it("unknown tool names fall back to 'read'", () => {
    expect(actionForTool("Bash")).toBe("read")
    expect(actionForTool("mcp:server/tool")).toBe("read")
    expect(actionForTool("anything-else")).toBe("read")
  })

  it("TOOL_ACTION_MAP table is the source for actionForTool", () => {
    for (const [toolName, expectedAction] of Object.entries(TOOL_ACTION_MAP)) {
      expect(actionForTool(toolName)).toBe(expectedAction)
    }
  })
})

describe("reducer turn_complete file change synthesis (Cluster 13)", () => {
  // Build a state with a single completed turn whose tool block touched a
  // file, then drive turn_complete to capture the synthesised TurnFileChange.
  function turnFilesAfterTool(toolName: string): { action: string; tool: string } | null {
    const state = createInitialState()
    const userTurn: Block[] = [
      { type: "user", text: "do the thing" },
      {
        type: "tool",
        id: "t1",
        tool: toolName,
        input: { file_path: "/tmp/example.ts" },
        status: "done",
        output: "",
        startTime: 0,
      },
    ]
    const seeded = { ...state, blocks: userTurn, sessionState: "RUNNING" as const }
    const next = reduce(seeded, { type: "turn_complete" })
    return next.lastTurnFiles?.[0]
      ? { action: next.lastTurnFiles[0].action, tool: next.lastTurnFiles[0].tool }
      : null
  }

  it("Write tool yields a 'create' file change", () => {
    expect(turnFilesAfterTool("Write")).toEqual({ action: "create", tool: "Write" })
  })

  it("Edit tool yields an 'edit' file change", () => {
    expect(turnFilesAfterTool("Edit")).toEqual({ action: "edit", tool: "Edit" })
  })

  it("MultiEdit tool yields an 'edit' file change (would have been 'read' pre-Cluster-13)", () => {
    expect(turnFilesAfterTool("MultiEdit")).toEqual({ action: "edit", tool: "MultiEdit" })
  })

  it("NotebookEdit tool yields an 'edit' file change (would have been 'read' pre-Cluster-13)", () => {
    expect(turnFilesAfterTool("NotebookEdit")).toEqual({ action: "edit", tool: "NotebookEdit" })
  })

  it("Read tool yields a 'read' file change", () => {
    expect(turnFilesAfterTool("Read")).toEqual({ action: "read", tool: "Read" })
  })
})
