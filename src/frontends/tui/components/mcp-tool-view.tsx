/**
 * McpToolView — Specialized renderer for MCP (Model Context Protocol) tool blocks.
 *
 * MCP tools have a two-part identity: server name + tool name. The Claude SDK
 * uses `mcp__server__tool` naming; Codex adapters use `mcp:server/tool`.
 * This component parses both formats and renders them with distinct visual
 * treatment: server as context label, tool as the action.
 *
 * Uses cyan accent (accent.highlight) to visually distinguish from built-in
 * tools (orange) and Skill tools (soft blue).
 */

import { createSignal, createEffect, createMemo, onCleanup, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { Block } from "../../../protocol/types"
import { colors } from "../theme/tokens"
import { BlinkingDot } from "./primitives"
import { truncateToWidth } from "../../../utils/truncate"
import { formatDuration } from "../../../utils/format"
import { isUserDecline } from "./tool-view"
import { createThrottledValue } from "../../../utils/throttled-value"
import type { ViewLevel } from "./tool-view"
import { TOOL_MIN_BUDGET, TOOL_MAX_BUDGET, computeSummaryBudget, computeErrorBudget } from "./tool-view"

export type McpToolBlock = Extract<Block, { type: "tool" }>

// ---------------------------------------------------------------------------
// MCP tool name parsing
// ---------------------------------------------------------------------------

export interface McpToolName {
  server: string
  tool: string
}

/** Detect whether a tool name represents an MCP tool call */
export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith("mcp__") || toolName.startsWith("mcp:")
}

/**
 * Parse an MCP tool name into server and tool components.
 *
 * Handles both naming conventions:
 *   - Claude SDK:  "mcp__server-name__tool_name"
 *   - Codex:       "mcp:server-name/tool_name"
 */
export function parseMcpToolName(toolName: string): McpToolName {
  // Claude SDK format: mcp__server__tool
  if (toolName.startsWith("mcp__")) {
    const rest = toolName.slice(5) // strip "mcp__"
    const sepIdx = rest.indexOf("__")
    if (sepIdx !== -1) {
      return {
        server: rest.slice(0, sepIdx),
        tool: rest.slice(sepIdx + 2),
      }
    }
    // Fallback: single segment
    return { server: "unknown", tool: rest }
  }

  // Codex format: mcp:server/tool
  if (toolName.startsWith("mcp:")) {
    const rest = toolName.slice(4) // strip "mcp:"
    const slashIdx = rest.indexOf("/")
    if (slashIdx !== -1) {
      return {
        server: rest.slice(0, slashIdx),
        tool: rest.slice(slashIdx + 1),
      }
    }
    return { server: "unknown", tool: rest }
  }

  return { server: "unknown", tool: toolName }
}

/** Format tool name for display: strip common prefixes, replace underscores */
function formatToolName(tool: string): string {
  return tool.replace(/_/g, " ")
}

/** Get the last N non-empty lines from text */
function getLastNLines(text: string, n: number): string {
  const lines = text.split("\n").filter(l => l.trim())
  if (lines.length <= n) return lines.join("\n")
  return "...\n" + lines.slice(-n).join("\n")
}


// ---------------------------------------------------------------------------
// McpToolView — expanded / show_all view
// ---------------------------------------------------------------------------

export function McpToolView(props: {
  block: McpToolBlock
  viewLevel: ViewLevel
}) {
  const b = () => props.block
  const status = createThrottledValue(() => b().status)

  // Live terminal width — drives all per-line truncation budgets.
  const dims = useTerminalDimensions()
  const termWidth = createMemo(() => dims()?.width ?? 80)
  const summaryBudget = createMemo(() => computeSummaryBudget(termWidth()))
  const errorBudget = createMemo(() => computeErrorBudget(termWidth()))
  // Header `<dot-2> <server> › <tool>(<arg>) <duration>`. Server + tool +
  // separator can be ~30 chars, plus ~12 for duration, plus parens/buffer.
  const argBudget = createMemo(() => {
    const overhead = 2 + 30 + 4 + 12 + 2
    return Math.max(TOOL_MIN_BUDGET, Math.min(TOOL_MAX_BUDGET, termWidth() - overhead))
  })

  // Elapsed time for running tools
  const [elapsed, setElapsed] = createSignal(0)
  let elapsedTimer: ReturnType<typeof setInterval> | undefined

  createEffect(() => {
    if (status() === "running") {
      setElapsed(Math.floor((Date.now() - b().startTime) / 1000))
      elapsedTimer = setInterval(() => {
        setElapsed(Math.floor((Date.now() - b().startTime) / 1000))
      }, 1000)
    } else {
      if (elapsedTimer) {
        clearInterval(elapsedTimer)
        elapsedTimer = undefined
      }
    }
  })
  onCleanup(() => { if (elapsedTimer) clearInterval(elapsedTimer) })

  const parsed = createMemo(() => parseMcpToolName(b().tool))
  const displayTool = createMemo(() => formatToolName(parsed().tool))

  /** Extract a primary argument hint from the MCP tool input.
   *  Budget tracks the live terminal width. */
  const primaryArg = createMemo(() => {
    const inp = b().input as Record<string, unknown> | null
    if (!inp) return ""
    const max = argBudget()
    // Common MCP tool input patterns
    if (inp.query && typeof inp.query === "string") return truncateToWidth(inp.query, max)
    if (inp.last_n) return `last ${inp.last_n}`
    if (inp.level && typeof inp.level === "string") return inp.level
    if (inp.pattern && typeof inp.pattern === "string") return truncateToWidth(inp.pattern, max)
    if (inp.url && typeof inp.url === "string") return truncateToWidth(inp.url, max)
    if (inp.path && typeof inp.path === "string") return truncateToWidth(inp.path, max)
    // Generic: show first string value that's short enough to be informative.
    // Use the same `max` budget so the line stays on a single row.
    for (const [, v] of Object.entries(inp)) {
      if (typeof v === "string" && v.length > 0 && v.length <= max) {
        return truncateToWidth(v, max)
      }
    }
    return ""
  })

  const dotStatus = (): "active" | "success" | "error" => {
    if (status() === "running") return "active"
    if (status() === "error" || b().error) return "error"
    return "success"
  }

  // Progress: last few lines of output while running
  const progressText = createMemo(() => {
    if (status() !== "running") return ""
    const out = b().output ?? ""
    if (!out) return ""
    return getLastNLines(out, 3)
  })

  // Completion summary: first meaningful line of output, sized to terminal.
  const completionSummary = createMemo(() => {
    if (status() === "running") return ""
    const out = b().output ?? ""
    if (!out) return ""
    const firstLine = out.split("\n").find(l => l.trim()) ?? ""
    return truncateToWidth(firstLine, summaryBudget())
  })

  return (
    <box flexDirection="column">
      {/* Header: ● server-name › tool_name (args) */}
      <box flexDirection="row">
        <box width={2} flexShrink={0}>
          <BlinkingDot status={dotStatus()} />
        </box>
        <text fg={colors.accent.highlight} attributes={TextAttributes.DIM}>
          {parsed().server}
        </text>
        <text fg={colors.text.muted}>
          {" \u203A "}
        </text>
        <text fg={colors.text.primary}>
          {displayTool()}
        </text>
        <Show when={primaryArg()}>
          <text fg={colors.text.secondary}>
            {"(" + primaryArg() + ")"}
          </text>
        </Show>
        <Show when={status() === "running" && elapsed() > 0}>
          <text fg={colors.text.muted}>
            {" " + formatDuration(elapsed() * 1000, { hideTrailingZeros: true })}
          </text>
        </Show>
        <Show when={status() !== "running" && b().duration !== undefined && b().duration! >= 1000}>
          <text fg={colors.text.muted}>
            {" " + formatDuration(b().duration!, { hideTrailingZeros: true })}
          </text>
        </Show>
      </box>

      {/* Progress output — last few lines while tool is running */}
      <Show when={props.viewLevel !== "collapsed" && status() === "running" && progressText()}>
        <box paddingLeft={4}>
          <text fg={colors.text.muted}>
            {progressText()}
          </text>
        </box>
      </Show>

      {/* Completion result (expanded/show_all, done only) */}
      <Show when={props.viewLevel !== "collapsed" && status() !== "running" && completionSummary()}>
        <box paddingLeft={2}>
          <text fg={colors.text.muted}>
            {"\u23BF  " + completionSummary()}
          </text>
        </box>
      </Show>

      {/* Full output (show_all mode) */}
      <Show when={props.viewLevel === "show_all" && b().output}>
        <box paddingLeft={4}>
          <text fg={colors.text.secondary}>
            {b().output}
          </text>
        </box>
      </Show>

      {/* Error display */}
      <Show when={b().error && !isUserDecline(b().error!)}>
        <box paddingLeft={2}>
          <text fg={colors.status.error}>
            {"\u23BF  \u2717 " + truncateToWidth(b().error!.split("\n")[0]!, errorBudget())}
          </text>
        </box>
      </Show>
      {/* User-initiated decline */}
      <Show when={b().error && isUserDecline(b().error!)}>
        <box paddingLeft={2}>
          <text fg={colors.text.muted}>
            {"\u21B3 " + b().error!.split("\n")[0]}
          </text>
        </box>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// CollapsedMcpLine — single-line collapsed view
// ---------------------------------------------------------------------------

export function CollapsedMcpLine(props: {
  block: McpToolBlock
}) {
  const b = () => props.block
  const status = createThrottledValue(() => b().status)

  // Live terminal width — drives hint truncation so the inline output
  // snippet fills wide terminals instead of capping at 50 chars.
  const dims = useTerminalDimensions()
  const termWidth = createMemo(() => dims()?.width ?? 80)
  const hintBudget = createMemo(() => {
    // `<dot-2> <server> › <tool> — <hint>`. Server + tool + separator ≈ 30.
    const overhead = 2 + 30 + 4 + 2
    return Math.max(TOOL_MIN_BUDGET, Math.min(TOOL_MAX_BUDGET, termWidth() - overhead))
  })

  // Elapsed time
  const [elapsed, setElapsed] = createSignal(0)
  let elapsedTimer: ReturnType<typeof setInterval> | undefined

  createEffect(() => {
    if (status() === "running") {
      setElapsed(Math.floor((Date.now() - b().startTime) / 1000))
      elapsedTimer = setInterval(() => {
        setElapsed(Math.floor((Date.now() - b().startTime) / 1000))
      }, 1000)
    } else {
      if (elapsedTimer) {
        clearInterval(elapsedTimer)
        elapsedTimer = undefined
      }
    }
  })
  onCleanup(() => { if (elapsedTimer) clearInterval(elapsedTimer) })

  const parsed = createMemo(() => parseMcpToolName(b().tool))
  const displayTool = createMemo(() => formatToolName(parsed().tool))

  const dotStatus = (): "active" | "success" | "error" | "declined" => {
    if (status() === "running") return "active"
    if (b().error) {
      if (isUserDecline(b().error!)) return "declined"
      return "error"
    }
    return "success"
  }

  const hint = createMemo(() => {
    if (status() === "running") {
      return elapsed() > 0 ? ` (${elapsed()}s)` : ""
    }
    if (b().error) {
      return isUserDecline(b().error!) ? " \u2014 declined" : " \u2014 failed"
    }
    const out = b().output ?? ""
    if (out) {
      const firstLine = out.split("\n").find(l => l.trim()) ?? ""
      const truncated = truncateToWidth(firstLine, hintBudget())
      return truncated ? ` \u2014 ${truncated}` : ""
    }
    return ""
  })

  return (
    <box flexDirection="row">
      <box width={2} flexShrink={0}>
        <BlinkingDot status={dotStatus()} />
      </box>
      <text fg={colors.accent.highlight} attributes={TextAttributes.DIM}>
        {parsed().server}
      </text>
      <text fg={colors.text.muted}>
        {" \u203A "}
      </text>
      <text
        fg={b().error && !isUserDecline(b().error!) ? colors.status.error : colors.text.muted}
      >
        {displayTool() + hint()}
      </text>
    </box>
  )
}
