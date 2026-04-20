/**
 * Tool Grouping — groups consecutive collapsible tool blocks into a single
 * collapsed summary line, inspired by Claude Code's CollapsedReadSearchContent.
 *
 * Non-collapsible tools (Write, Edit, Agent) always render individually.
 * Groups of 2+ collapsible tools collapse into "N tool uses (X reads, Y searches)".
 */

import type { Block } from "../../../protocol/types"

export type ToolBlock = Extract<Block, { type: "tool" }>

/** Tools that can be collapsed into groups */
const COLLAPSIBLE_TOOLS = new Set(["Read", "Glob", "Grep", "Bash"])

export function isCollapsibleTool(toolName: string): boolean {
  return COLLAPSIBLE_TOOLS.has(toolName)
}

/**
 * Filter out TodoWrite tool blocks from the transcript. TodoWrite is rendered
 * as a standalone TaskChecklist panel driven by `ConversationState.todos`,
 * not inline — the event mapper still emits the tool block intentionally for
 * other consumers, so the UI layer is responsible for suppressing it here.
 */
export function filterTodoWriteBlocks(blocks: readonly Block[]): Block[] {
  return blocks.filter(b => !(b.type === "tool" && b.tool === "TodoWrite"))
}

export interface ToolGroup {
  type: "group"
  blocks: ToolBlock[]
  /** Total duration of all tools in group (ms) */
  totalDuration: number
  /** Counts by tool type: { Read: 3, Grep: 1 } */
  toolCounts: Record<string, number>
  /** Overall status: running if any is running, error if any errored, done otherwise */
  status: "running" | "done" | "error"
}

/** Items produced by groupConsecutiveTools — either an original block or a ToolGroup */
export type GroupedItem = Block | ToolGroup

/** Type guard to distinguish a ToolGroup from a Block */
export function isToolGroup(item: GroupedItem): item is ToolGroup {
  return "type" in item && item.type === "group"
}

/**
 * Compute the aggregate status for a set of tool blocks.
 * - running if any block is still running
 * - error if any block errored (and none are running)
 * - done otherwise
 */
export function computeGroupStatus(blocks: ToolBlock[]): "running" | "done" | "error" {
  let hasError = false
  for (const b of blocks) {
    if (b.status === "running") return "running"
    if (b.status === "error" || b.error) hasError = true
  }
  return hasError ? "error" : "done"
}

/**
 * Compute tool name counts: { Read: 3, Grep: 1 }
 */
export function computeToolCounts(blocks: ToolBlock[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const b of blocks) {
    counts[b.tool] = (counts[b.tool] ?? 0) + 1
  }
  return counts
}

/**
 * Sum durations of all tool blocks in the group (ms).
 * Only counts blocks that have a defined duration.
 */
export function computeTotalDuration(blocks: ToolBlock[]): number {
  let total = 0
  for (const b of blocks) {
    if (b.duration !== undefined) {
      total += b.duration
    }
  }
  return total
}

/**
 * Build a ToolGroup from an array of tool blocks.
 */
function buildToolGroup(blocks: ToolBlock[]): ToolGroup {
  return {
    type: "group",
    blocks,
    totalDuration: computeTotalDuration(blocks),
    toolCounts: computeToolCounts(blocks),
    status: computeGroupStatus(blocks),
  }
}

/**
 * Format a human-readable summary for a tool group.
 *
 * Rules:
 * - If all same tool: "4 reads" / "3 commands"
 * - Mixed tools: "4 tool uses (3 reads, 1 search)"
 */
export function formatGroupSummary(group: ToolGroup): string {
  const total = group.blocks.length
  const entries = Object.entries(group.toolCounts)

  // All same tool
  if (entries.length === 1) {
    const [tool, count] = entries[0]!
    return `${count} ${toolNounPlural(tool, count)}`
  }

  // Mixed tools
  const parts = entries.map(([tool, count]) => `${count} ${toolNounPlural(tool, count)}`)
  return `${total} tool uses (${parts.join(", ")})`
}

/**
 * Format duration as human-readable string.
 * Returns empty string if duration is 0 or negligible.
 */
export function formatDuration(ms: number): string {
  if (ms < 100) return ""
  const seconds = Math.round(ms / 1000)
  if (seconds < 1) return `0.${Math.round(ms / 100)}s`
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

/** Noun for a tool type (pluralized) */
function toolNounPlural(tool: string, count: number): string {
  const s = count === 1 ? "" : "s"
  switch (tool) {
    case "Read":  return `read${s}`
    case "Grep":  return `search${count === 1 ? "" : "es"}`
    case "Glob":  return `search${count === 1 ? "" : "es"}`
    case "Bash":  return `command${s}`
    default:      return `${tool.toLowerCase()}${s}`
  }
}

/**
 * Group consecutive collapsible tool blocks together.
 *
 * Non-collapsible tools (Write, Edit, Agent) always get their own entry.
 * A group ends when:
 * - A non-collapsible tool appears
 * - A non-tool block appears (assistant text, user message, etc.)
 *
 * Single collapsible tools are NOT grouped — they pass through as-is.
 * Only groups of 2+ tools produce a ToolGroup.
 */
export function groupConsecutiveTools(blocks: Block[]): GroupedItem[] {
  const result: GroupedItem[] = []
  let currentGroup: ToolBlock[] = []

  function flushGroup() {
    if (currentGroup.length === 0) return
    if (currentGroup.length === 1) {
      // Single tool — pass through as a regular block
      result.push(currentGroup[0]!)
    } else {
      // 2+ tools — create a group
      result.push(buildToolGroup(currentGroup))
    }
    currentGroup = []
  }

  for (const block of blocks) {
    if (block.type === "tool" && isCollapsibleTool(block.tool)) {
      currentGroup.push(block as ToolBlock)
    } else {
      flushGroup()
      result.push(block)
    }
  }

  flushGroup()
  return result
}
