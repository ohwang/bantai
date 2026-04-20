import { describe, it, expect } from "bun:test"
import {
  groupConsecutiveTools,
  isCollapsibleTool,
  isToolGroup,
  computeGroupStatus,
  computeToolCounts,
  computeTotalDuration,
  formatGroupSummary,
  formatDuration,
  filterTodoWriteBlocks,
  type ToolGroup,
} from "../../src/frontends/tui/utils/tool-grouping"
import type { Block } from "../../src/protocol/types"

// ---------------------------------------------------------------------------
// Test helpers — create minimal block fixtures
// ---------------------------------------------------------------------------

function toolBlock(
  tool: string,
  opts: { status?: "running" | "done" | "error"; duration?: number; error?: string } = {},
): Extract<Block, { type: "tool" }> {
  return {
    type: "tool",
    id: `tool-${Math.random().toString(36).slice(2)}`,
    tool,
    input: {},
    status: opts.status ?? "done",
    startTime: Date.now(),
    duration: opts.duration,
    error: opts.error,
  }
}

function assistantBlock(text = "hello"): Block {
  return { type: "assistant", text }
}

function userBlock(text = "test"): Block {
  return { type: "user", text }
}

// ---------------------------------------------------------------------------
// isCollapsibleTool
// ---------------------------------------------------------------------------

describe("isCollapsibleTool", () => {
  it("returns true for collapsible tools", () => {
    expect(isCollapsibleTool("Read")).toBe(true)
    expect(isCollapsibleTool("Grep")).toBe(true)
    expect(isCollapsibleTool("Glob")).toBe(true)
    expect(isCollapsibleTool("Bash")).toBe(true)
  })

  it("returns false for non-collapsible tools", () => {
    expect(isCollapsibleTool("Write")).toBe(false)
    expect(isCollapsibleTool("Edit")).toBe(false)
    expect(isCollapsibleTool("Agent")).toBe(false)
    expect(isCollapsibleTool("WebFetch")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeGroupStatus
// ---------------------------------------------------------------------------

describe("computeGroupStatus", () => {
  it("returns running if any block is running", () => {
    const blocks = [toolBlock("Read", { status: "done" }), toolBlock("Read", { status: "running" })]
    expect(computeGroupStatus(blocks)).toBe("running")
  })

  it("returns error if any block has error and none running", () => {
    const blocks = [toolBlock("Read", { status: "done" }), toolBlock("Read", { status: "error", error: "fail" })]
    expect(computeGroupStatus(blocks)).toBe("error")
  })

  it("returns running over error when both present", () => {
    const blocks = [toolBlock("Read", { status: "running" }), toolBlock("Read", { status: "error", error: "fail" })]
    expect(computeGroupStatus(blocks)).toBe("running")
  })

  it("returns done when all blocks are done", () => {
    const blocks = [toolBlock("Read", { status: "done" }), toolBlock("Grep", { status: "done" })]
    expect(computeGroupStatus(blocks)).toBe("done")
  })

  it("detects error from error field even if status is done", () => {
    const blocks = [toolBlock("Read", { status: "done", error: "something went wrong" })]
    expect(computeGroupStatus(blocks)).toBe("error")
  })
})

// ---------------------------------------------------------------------------
// computeToolCounts
// ---------------------------------------------------------------------------

describe("computeToolCounts", () => {
  it("counts tools by name", () => {
    const blocks = [toolBlock("Read"), toolBlock("Read"), toolBlock("Grep")]
    expect(computeToolCounts(blocks)).toEqual({ Read: 2, Grep: 1 })
  })

  it("handles single tool", () => {
    const blocks = [toolBlock("Bash")]
    expect(computeToolCounts(blocks)).toEqual({ Bash: 1 })
  })

  it("handles all different tools", () => {
    const blocks = [toolBlock("Read"), toolBlock("Grep"), toolBlock("Glob"), toolBlock("Bash")]
    expect(computeToolCounts(blocks)).toEqual({ Read: 1, Grep: 1, Glob: 1, Bash: 1 })
  })
})

// ---------------------------------------------------------------------------
// computeTotalDuration
// ---------------------------------------------------------------------------

describe("computeTotalDuration", () => {
  it("sums durations of blocks with defined duration", () => {
    const blocks = [
      toolBlock("Read", { duration: 1000 }),
      toolBlock("Grep", { duration: 2000 }),
    ]
    expect(computeTotalDuration(blocks)).toBe(3000)
  })

  it("ignores blocks without duration", () => {
    const blocks = [
      toolBlock("Read", { duration: 1500 }),
      toolBlock("Read"),
      toolBlock("Grep", { duration: 500 }),
    ]
    expect(computeTotalDuration(blocks)).toBe(2000)
  })

  it("returns 0 when no blocks have duration", () => {
    const blocks = [toolBlock("Read"), toolBlock("Grep")]
    expect(computeTotalDuration(blocks)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// formatGroupSummary
// ---------------------------------------------------------------------------

describe("formatGroupSummary", () => {
  it("shows plural noun for all-same-tool groups", () => {
    const group: ToolGroup = {
      type: "group",
      blocks: [toolBlock("Read"), toolBlock("Read"), toolBlock("Read")],
      totalDuration: 3000,
      toolCounts: { Read: 3 },
      status: "done",
    }
    expect(formatGroupSummary(group)).toBe("3 reads")
  })

  it("shows singular noun for single-tool group", () => {
    const group: ToolGroup = {
      type: "group",
      blocks: [toolBlock("Read"), toolBlock("Read")],
      totalDuration: 0,
      toolCounts: { Read: 1 },
      status: "done",
    }
    expect(formatGroupSummary(group)).toBe("1 read")
  })

  it("shows commands for Bash tools", () => {
    const group: ToolGroup = {
      type: "group",
      blocks: [toolBlock("Bash"), toolBlock("Bash")],
      totalDuration: 0,
      toolCounts: { Bash: 2 },
      status: "done",
    }
    expect(formatGroupSummary(group)).toBe("2 commands")
  })

  it("shows searches for Grep and Glob", () => {
    const group: ToolGroup = {
      type: "group",
      blocks: [toolBlock("Grep"), toolBlock("Glob")],
      totalDuration: 0,
      toolCounts: { Grep: 1, Glob: 1 },
      status: "done",
    }
    expect(formatGroupSummary(group)).toBe("2 tool uses (1 search, 1 search)")
  })

  it("shows mixed breakdown for different tool types", () => {
    const group: ToolGroup = {
      type: "group",
      blocks: [toolBlock("Read"), toolBlock("Read"), toolBlock("Read"), toolBlock("Grep")],
      totalDuration: 5000,
      toolCounts: { Read: 3, Grep: 1 },
      status: "done",
    }
    expect(formatGroupSummary(group)).toBe("4 tool uses (3 reads, 1 search)")
  })
})

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("returns empty for negligible durations", () => {
    expect(formatDuration(0)).toBe("")
    expect(formatDuration(50)).toBe("")
    expect(formatDuration(99)).toBe("")
  })

  it("formats seconds", () => {
    expect(formatDuration(1000)).toBe("1s")
    expect(formatDuration(5500)).toBe("6s")
    expect(formatDuration(30000)).toBe("30s")
  })

  it("formats minutes and seconds", () => {
    expect(formatDuration(60000)).toBe("1m 0s")
    expect(formatDuration(90000)).toBe("1m 30s")
    expect(formatDuration(125000)).toBe("2m 5s")
  })
})

// ---------------------------------------------------------------------------
// groupConsecutiveTools
// ---------------------------------------------------------------------------

describe("groupConsecutiveTools", () => {
  it("passes through empty array", () => {
    expect(groupConsecutiveTools([])).toEqual([])
  })

  it("passes through non-tool blocks unchanged", () => {
    const blocks: Block[] = [userBlock(), assistantBlock()]
    const result = groupConsecutiveTools(blocks)
    expect(result).toHaveLength(2)
    expect(isToolGroup(result[0]!)).toBe(false)
    expect(isToolGroup(result[1]!)).toBe(false)
  })

  it("does not group a single collapsible tool", () => {
    const blocks: Block[] = [toolBlock("Read")]
    const result = groupConsecutiveTools(blocks)
    expect(result).toHaveLength(1)
    expect(isToolGroup(result[0]!)).toBe(false)
    expect((result[0] as Extract<Block, { type: "tool" }>).tool).toBe("Read")
  })

  it("groups two consecutive collapsible tools", () => {
    const blocks: Block[] = [toolBlock("Read"), toolBlock("Grep")]
    const result = groupConsecutiveTools(blocks)
    expect(result).toHaveLength(1)
    expect(isToolGroup(result[0]!)).toBe(true)
    const group = result[0] as ToolGroup
    expect(group.blocks).toHaveLength(2)
    expect(group.toolCounts).toEqual({ Read: 1, Grep: 1 })
  })

  it("groups three consecutive Reads", () => {
    const blocks: Block[] = [toolBlock("Read"), toolBlock("Read"), toolBlock("Read")]
    const result = groupConsecutiveTools(blocks)
    expect(result).toHaveLength(1)
    expect(isToolGroup(result[0]!)).toBe(true)
    const group = result[0] as ToolGroup
    expect(group.blocks).toHaveLength(3)
    expect(group.toolCounts).toEqual({ Read: 3 })
  })

  it("does not group non-collapsible tools", () => {
    const blocks: Block[] = [toolBlock("Write"), toolBlock("Edit")]
    const result = groupConsecutiveTools(blocks)
    expect(result).toHaveLength(2)
    expect(isToolGroup(result[0]!)).toBe(false)
    expect(isToolGroup(result[1]!)).toBe(false)
  })

  it("non-collapsible tool interrupts a group", () => {
    const blocks: Block[] = [
      toolBlock("Read"),
      toolBlock("Grep"),
      toolBlock("Write"),  // non-collapsible — interrupts
      toolBlock("Read"),
      toolBlock("Bash"),
    ]
    const result = groupConsecutiveTools(blocks)
    expect(result).toHaveLength(3)
    // First group: Read + Grep
    expect(isToolGroup(result[0]!)).toBe(true)
    expect((result[0] as ToolGroup).blocks).toHaveLength(2)
    // Write as individual
    expect(isToolGroup(result[1]!)).toBe(false)
    expect((result[1] as Extract<Block, { type: "tool" }>).tool).toBe("Write")
    // Second group: Read + Bash
    expect(isToolGroup(result[2]!)).toBe(true)
    expect((result[2] as ToolGroup).blocks).toHaveLength(2)
  })

  it("non-tool block interrupts a group", () => {
    const blocks: Block[] = [
      toolBlock("Read"),
      toolBlock("Read"),
      assistantBlock(),
      toolBlock("Grep"),
      toolBlock("Glob"),
    ]
    const result = groupConsecutiveTools(blocks)
    expect(result).toHaveLength(3)
    // First group: 2 Reads
    expect(isToolGroup(result[0]!)).toBe(true)
    expect((result[0] as ToolGroup).blocks).toHaveLength(2)
    // Assistant block
    expect(isToolGroup(result[1]!)).toBe(false)
    // Second group: Grep + Glob
    expect(isToolGroup(result[2]!)).toBe(true)
    expect((result[2] as ToolGroup).blocks).toHaveLength(2)
  })

  it("handles mixed collapsible and non-collapsible sequence", () => {
    const blocks: Block[] = [
      assistantBlock(),
      toolBlock("Read"),
      toolBlock("Grep"),
      toolBlock("Glob"),
      toolBlock("Read"),
      assistantBlock("response"),
    ]
    const result = groupConsecutiveTools(blocks)
    expect(result).toHaveLength(3)
    expect(isToolGroup(result[0]!)).toBe(false)  // assistant
    expect(isToolGroup(result[1]!)).toBe(true)    // group of 4
    expect((result[1] as ToolGroup).blocks).toHaveLength(4)
    expect(isToolGroup(result[2]!)).toBe(false)  // assistant
  })

  it("computes group status correctly", () => {
    const blocks: Block[] = [
      toolBlock("Read", { status: "done" }),
      toolBlock("Grep", { status: "running" }),
    ]
    const result = groupConsecutiveTools(blocks)
    expect((result[0] as ToolGroup).status).toBe("running")
  })

  it("computes group duration correctly", () => {
    const blocks: Block[] = [
      toolBlock("Read", { duration: 1000 }),
      toolBlock("Grep", { duration: 2500 }),
    ]
    const result = groupConsecutiveTools(blocks)
    expect((result[0] as ToolGroup).totalDuration).toBe(3500)
  })
})

// ---------------------------------------------------------------------------
// filterTodoWriteBlocks — TodoWrite is rendered as a standalone TaskChecklist
// panel, not inline; the helper suppresses its tool blocks from the transcript.
// ---------------------------------------------------------------------------

describe("filterTodoWriteBlocks", () => {
  it("passes transcripts without TodoWrite blocks through unchanged", () => {
    const blocks: Block[] = [
      userBlock("hi"),
      assistantBlock("hello"),
      toolBlock("Read"),
      toolBlock("Bash"),
    ]
    const result = filterTodoWriteBlocks(blocks)
    expect(result).toHaveLength(4)
    expect(result).toEqual(blocks)
  })

  it("removes TodoWrite tool blocks from the transcript", () => {
    const blocks: Block[] = [
      userBlock("plan"),
      toolBlock("TodoWrite"),
      assistantBlock("on it"),
      toolBlock("TodoWrite"),
      toolBlock("Read"),
    ]
    const result = filterTodoWriteBlocks(blocks)
    expect(result).toHaveLength(3)
    expect(result.some(b => b.type === "tool" && b.tool === "TodoWrite")).toBe(false)
    expect((result[0] as Extract<Block, { type: "user" }>).type).toBe("user")
    expect((result[1] as Extract<Block, { type: "assistant" }>).type).toBe("assistant")
    expect((result[2] as Extract<Block, { type: "tool" }>).tool).toBe("Read")
  })

  it("does not fold empty tool groups when all TodoWrites are removed", () => {
    // When three consecutive TodoWrites sit between a user and assistant
    // turn, filtering removes them first so groupConsecutiveTools does not
    // see a phantom group of zero or one remaining tools.
    const blocks: Block[] = [
      userBlock("plan"),
      toolBlock("TodoWrite"),
      toolBlock("TodoWrite"),
      toolBlock("TodoWrite"),
      assistantBlock("done"),
    ]
    const filtered = filterTodoWriteBlocks(blocks)
    expect(filtered).toHaveLength(2)
    const grouped = groupConsecutiveTools(filtered)
    expect(grouped).toHaveLength(2)
    expect(isToolGroup(grouped[0]!)).toBe(false)
    expect(isToolGroup(grouped[1]!)).toBe(false)
  })

  it("does not remove unrelated tool blocks", () => {
    const blocks: Block[] = [
      toolBlock("Read"),
      toolBlock("Write"),
      toolBlock("Edit"),
    ]
    const result = filterTodoWriteBlocks(blocks)
    expect(result).toHaveLength(3)
  })
})
