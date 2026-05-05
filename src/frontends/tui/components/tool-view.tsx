/**
 * Tool Views — renders individual tool blocks and collapsed tool summaries.
 *
 * ToolBlockView: single tool invocation with status, output, error display.
 * ToolSummaryView: collapsed aggregation of consecutive tool blocks.
 */

import { createSignal, createEffect, createMemo, onCleanup, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { Block } from "../../../protocol/types"
import { colors } from "../theme/tokens"
import { formatDuration } from "../../../utils/format"
import { getSyntaxStyle } from "../theme/syntax"
import { getStatusConfig } from "./primitives"
import { truncatePathMiddle, truncateToWidth } from "../../../utils/truncate"
import { createThrottledValue } from "../../../utils/throttled-value"
import { isMcpTool, parseMcpToolName } from "./mcp-tool-view"
import { buildUnifiedDiff, looksLikeUnifiedDiff } from "../../../utils/format-diff"
import { useAgent } from "../context/agent"

export type ViewLevel = "collapsed" | "expanded" | "show_all"

// ---------------------------------------------------------------------------
// Truncation budgets — sized off the live terminal width so tool-call lines
// fill the screen on wide terminals instead of getting cropped at a fixed
// 60/80/100/120-char point. Kept on a single line in all cases (tool-call
// details are low-importance — wrapping them would burn vertical space).
// ---------------------------------------------------------------------------

/** Floor: never go narrower than this. Below this we'd just show ellipses. */
export const TOOL_MIN_BUDGET = 20
/** Ceiling: don't expand past this even on ultra-wide terminals — printing
 *  200+ chars of a shell command isn't useful information. */
export const TOOL_MAX_BUDGET = 200
/** Reserved trailing chars for the optional " 1234.5ms" duration suffix. */
const DURATION_RESERVE = 12

/** Budget for the primary-arg slot inside `<icon>  <Tool>(<arg>) <duration>`. */
export function computeArgBudget(termWidth: number, toolNameLen: number): number {
  // 2 (icon column) + toolName + 2 (parens) + DURATION_RESERVE + 2 (safety)
  const overhead = 2 + toolNameLen + 2 + DURATION_RESERVE + 2
  return Math.max(TOOL_MIN_BUDGET, Math.min(TOOL_MAX_BUDGET, termWidth - overhead))
}

/** Budget for the result line `  ⎿  <text>`. */
export function computeSummaryBudget(termWidth: number): number {
  // 2 (paddingLeft) + 4 ("⎿  ") + 2 (safety)
  const overhead = 8
  return Math.max(TOOL_MIN_BUDGET, Math.min(TOOL_MAX_BUDGET, termWidth - overhead))
}

/** Budget for the error line `  ⎿  ✗ <text>`. */
export function computeErrorBudget(termWidth: number): number {
  // 2 (paddingLeft) + 6 ("⎿  ✗ ") + 2 (safety)
  const overhead = 10
  return Math.max(TOOL_MIN_BUDGET, Math.min(TOOL_MAX_BUDGET, termWidth - overhead))
}

// ---------------------------------------------------------------------------
// ToolBlockView — renders a single tool block
// ---------------------------------------------------------------------------

/** User-initiated cancellation messages that shouldn't render as errors */
export function isUserDecline(error: string): boolean {
  return error.includes("User declined to answer") || error.includes("Interrupted by user")
}

/** Detect whether a tool produces code-like output that benefits from syntax highlighting */
function isCodeOutput(tool: string): boolean {
  return tool === "Read" || tool === "Grep"
}

/**
 * Decide what diff text (if any) to render for a tool block.
 *
 * Priority:
 * 1. If the `output` string already contains unified-diff markers, use it
 *    as-is. ACP backends embed a unified diff inside the tool_use_end
 *    output via `formatDiffContent()`, and some tools (like MultiEdit
 *    aggregators or custom MCP tools) may also emit pre-formatted diffs.
 * 2. Otherwise, for Edit / Write / MultiEdit / NotebookEdit on a known
 *    `file_path`, synthesize a unified diff from the tool *input*. This
 *    covers Claude's SDK — which returns a prose success message for
 *    these tools, not a diff — and any future backend that plumbs
 *    `old_string`/`new_string`/`content` through as input.
 * 3. Returns `undefined` when no diff can be constructed. Callers should
 *    fall back to code / plain rendering.
 */
export function resolveDiffText(
  tool: string,
  input: unknown,
  output: string | undefined,
): string | undefined {
  if (output && looksLikeUnifiedDiff(output)) {
    return output
  }

  if (tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit" && tool !== "NotebookEdit") {
    return undefined
  }

  const inp = input as Record<string, unknown> | null
  if (!inp) return undefined
  const path = typeof inp.file_path === "string" ? inp.file_path : undefined
  if (!path) return undefined

  // Write: full-file replacement. No prior content known.
  if (tool === "Write" && typeof inp.content === "string") {
    return buildUnifiedDiff({ path, oldText: "", newText: inp.content })
  }

  // Edit: single replacement.
  if (tool === "Edit" && typeof inp.old_string === "string" && typeof inp.new_string === "string") {
    return buildUnifiedDiff({ path, oldText: inp.old_string, newText: inp.new_string })
  }

  // MultiEdit: array of { old_string, new_string }. Concatenate hunks into one diff.
  if (tool === "MultiEdit" && Array.isArray(inp.edits)) {
    const parts: string[] = []
    for (const edit of inp.edits as unknown[]) {
      const e = edit as Record<string, unknown> | null
      if (!e) continue
      if (typeof e.old_string === "string" && typeof e.new_string === "string") {
        parts.push(buildUnifiedDiff({ path, oldText: e.old_string, newText: e.new_string }))
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined
  }

  // NotebookEdit: new_source replaces old_source for a single cell.
  if (
    tool === "NotebookEdit"
    && typeof inp.new_source === "string"
  ) {
    const oldSource = typeof inp.old_source === "string" ? inp.old_source : ""
    return buildUnifiedDiff({ path, oldText: oldSource, newText: inp.new_source })
  }

  return undefined
}

/** Extract a filetype hint from a file path for syntax highlighting */
function filetypeFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined
  const dot = filePath.lastIndexOf(".")
  if (dot === -1) return undefined
  const ext = filePath.slice(dot + 1).toLowerCase()
  // Map common extensions to tree-sitter language names
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rs: "rust", go: "go", rb: "ruby",
    java: "java", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    css: "css", html: "html", json: "json", yaml: "yaml", yml: "yaml",
    md: "markdown", sh: "bash", bash: "bash", zsh: "bash",
    toml: "toml", zig: "zig", swift: "swift", kt: "kotlin",
  }
  return map[ext] ?? ext
}

/** Threshold in seconds before showing a critical "may be stuck" warning */
export const TOOL_CRITICAL_THRESHOLD = 300 // 5 minutes

export type ToolBlock = Extract<Block, { type: "tool" }>

/** Extract the last N non-empty lines from text, prefixed with "..." if truncated */
function getLastNLines(text: string, n: number): string {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length <= n) return lines.join('\n')
  return '...\n' + lines.slice(-n).join('\n')
}

/** Cap text to the first N lines, appending a truncation indicator if needed */
function truncateLines(text: string, n: number): string {
  const lines = text.split("\n")
  if (lines.length <= n) return text
  return lines.slice(0, n).join("\n") + `\n… (${lines.length - n} more lines)`
}

const BASH_MAX_LINES = 10

export function ToolBlockView(props: { block: Extract<Block, { type: "tool" }>; viewLevel: ViewLevel }) {
  const b = () => props.block

  // Path display roots at the active session's cwd, NOT process.cwd(). The
  // bantai launcher captures the user's launch dir into flags.config.cwd
  // but never process.chdir()s, so the two diverge any time the session
  // was launched with --cwd <somewhere-else>. See permission-audit.md §F-2.
  const agent = useAgent()
  const sessionCwd = () => agent.config.cwd ?? process.cwd()

  // Throttled status: prevents intermediate states that flash for <100ms
  // from being painted. The raw b().status updates at 16ms batch rate;
  // the throttled version updates at most every 100ms.
  const status = createThrottledValue(() => b().status)

  // Live terminal width — drives all per-line truncation budgets so tool
  // calls expand to fill wide terminals instead of capping at 60/80/100.
  const dims = useTerminalDimensions()
  const termWidth = createMemo(() => dims()?.width ?? 80)
  const argBudget = createMemo(() => computeArgBudget(termWidth(), b().tool.length))
  const summaryBudget = createMemo(() => computeSummaryBudget(termWidth()))
  const errorBudget = createMemo(() => computeErrorBudget(termWidth()))

  // Elapsed time signal for running tools — updates every second
  const [elapsed, setElapsed] = createSignal(0)
  let elapsedTimer: ReturnType<typeof setInterval> | undefined

  createEffect(() => {
    if (status() === "running") {
      // Start ticking
      setElapsed(Math.floor((Date.now() - b().startTime) / 1000))
      elapsedTimer = setInterval(() => {
        setElapsed(Math.floor((Date.now() - b().startTime) / 1000))
      }, 1000)
    } else {
      // Tool finished — clear timer
      if (elapsedTimer) {
        clearInterval(elapsedTimer)
        elapsedTimer = undefined
      }
    }
  })
  onCleanup(() => {
    if (elapsedTimer) clearInterval(elapsedTimer)
  })

  /** Primary arg for the tool invocation display: ToolName(arg).
   *  Budget scales with the live terminal width so the line uses available
   *  space on wide terminals instead of capping at a hard 60/80 chars. */
  const primaryArg = createMemo(() => {
    const inp = b().input as Record<string, unknown> | null
    if (!inp) return ""
    const max = argBudget()
    if (inp.file_path) {
      const raw = String(inp.file_path)
      const cwd = sessionCwd()
      const rel = raw.startsWith(cwd + "/") ? raw.slice(cwd.length + 1) : raw
      return truncatePathMiddle(rel, max)
    }
    if (inp.command) {
      return truncateToWidth(String(inp.command), max)
    }
    if (inp.pattern) {
      const p = String(inp.pattern)
      const path = inp.path ? ` in ${inp.path}` : ""
      return truncateToWidth(p + path, max)
    }
    if (inp.description) {
      return truncateToWidth(String(inp.description), max)
    }
    if (inp.query) {
      return truncateToWidth(String(inp.query), max)
    }
    return ""
  })

  // Status-aware prefix color: green for success, red for error, accent for running
  const prefixColor = () => {
    if (status() === "running") return colors.accent.primary
    if (b().error && !isUserDecline(b().error!)) return colors.status.error
    return colors.status.success
  }

  /** Brief result summary for the ⎿ line. Budget tracks terminal width. */
  const resultSummary = createMemo(() => {
    if (status() === "running") return ""
    if (b().error) return ""
    const out = b().output ?? ""
    if (!out) return ""

    const max = summaryBudget()
    // Generate summary based on tool type
    switch (b().tool) {
      case "Read": {
        const lines = out.split("\n").length
        return `Read ${lines} line${lines === 1 ? "" : "s"}`
      }
      case "Write":
        return `Wrote to ${primaryArg()}`
      case "Edit":
        return `Edited ${primaryArg()}`
      case "Bash": {
        // Show first line of output, truncated to fit terminal
        const firstLine = out.split("\n")[0] ?? ""
        return truncateToWidth(firstLine, max)
      }
      case "Glob":
      case "Grep": {
        const lines = out.trim().split("\n").filter(l => l.trim()).length
        return `${lines} result${lines === 1 ? "" : "s"}`
      }
      default: {
        const firstLine = out.split("\n")[0] ?? ""
        return truncateToWidth(firstLine, max)
      }
    }
  })

  return (
    <box flexDirection="column">
      {/* Invocation line: ⏺ ToolName(arg) */}
      <box flexDirection="row">
        <box width={2} flexShrink={0}>
          <text fg={prefixColor()}>{"\u23FA"}</text>
        </box>
        <text fg={colors.text.primary}>{b().tool}</text>
        <Show when={primaryArg()}>
          <text fg={colors.text.secondary}>{"(" + primaryArg() + ")"}</text>
        </Show>
        {/* Duration for completed tools (expanded/show_all views) */}
        <Show when={status() !== "running" && props.viewLevel !== "collapsed" && b().duration !== undefined && b().duration! >= 1000}>
          <text fg={colors.text.muted}>
            {" " + formatDuration(b().duration!, { hideTrailingZeros: true })}
          </text>
        </Show>
      </box>
      {/* Critical warning — only shown after 5 minutes (streaming spinner handles normal elapsed display) */}
      <Show when={status() === "running" && elapsed() >= TOOL_CRITICAL_THRESHOLD}>
        <box paddingLeft={2}>
          <text fg={colors.status.error} attributes={TextAttributes.DIM}>
            {"\u23BF  Tool may be stuck. Press Ctrl+C to interrupt."}
          </text>
        </box>
      </Show>
      {/* Progress output — last 5 lines shown while tool is running */}
      <Show when={props.viewLevel !== "collapsed" && status() === "running" && b().output}>
        <box paddingLeft={4} flexDirection="column">
          <text fg={colors.text.muted}>
            {getLastNLines(b().output!, 5)}
          </text>
        </box>
      </Show>
      {/* Result line: ⎿  summary */}
      <Show when={props.viewLevel !== "collapsed" && resultSummary()}>
        <box paddingLeft={2}>
          <text fg={colors.text.muted}>
            {"\u23BF  " + resultSummary()}
          </text>
        </box>
      </Show>
      {/* Full output (show_all mode) — syntax highlighted for code-producing tools */}
      <Show when={props.viewLevel === "show_all" && (b().output || resolveDiffText(b().tool, b().input, b().output))}>
        <box paddingLeft={4}>
          <Show
            when={resolveDiffText(b().tool, b().input, b().output)}
            fallback={
              <Show
                when={isCodeOutput(b().tool)}
                fallback={
                  <text fg={colors.text.muted}>
                    {b().tool === "Bash" ? truncateLines(b().output!, BASH_MAX_LINES) : b().output}
                  </text>
                }
              >
                <code
                  content={b().output ?? ""}
                  syntaxStyle={getSyntaxStyle()}
                  filetype={filetypeFromPath((b().input as Record<string, unknown> | null)?.file_path as string | undefined)}
                  fg={colors.text.primary}
                  bg={colors.bg.primary}
                />
              </Show>
            }
          >
            {(diffText: () => string) => (
              <diff
                diff={diffText()}
                view="unified"
                syntaxStyle={getSyntaxStyle()}
                filetype={filetypeFromPath((b().input as Record<string, unknown> | null)?.file_path as string | undefined)}
                addedSignColor={colors.diff.added}
                removedSignColor={colors.diff.removed}
                addedBg={colors.diff.addedBg}
                removedBg={colors.diff.removedBg}
                fg={colors.text.primary}
              />
            )}
          </Show>
        </box>
      </Show>
      {/* Error display — compact red text, no border */}
      <Show when={b().error && !isUserDecline(b().error!)}>
        <box paddingLeft={2}>
          <text fg={colors.status.error}>
            {"\u23BF  \u2717 " + truncateToWidth(b().error!.split("\n")[0]!, errorBudget())}
          </text>
        </box>
      </Show>
      {/* User-initiated decline — subtle dim text instead of red error box */}
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
// Tool summary — collapsed view aggregation (matches Claude Code)
// ---------------------------------------------------------------------------

/** Extract the primary argument from a tool block's input.
 *  `maxWidth` is the budget (chars). Sized off live terminal width by the
 *  caller — see `ToolSummaryView` below.
 *
 *  `cwd` is the active session's cwd (`agent.config.cwd`); used to render
 *  file paths relative to the session root rather than the bantai process
 *  cwd (see permission-audit.md §F-2). */
function extractPrimaryArg(_tool: string, input: unknown, maxWidth: number, cwd: string): string {
  const inp = input as Record<string, unknown> | null
  if (!inp) return ""
  if (inp.file_path && typeof inp.file_path === "string") {
    const raw = inp.file_path
    const rel = raw.startsWith(cwd + "/") ? raw.slice(cwd.length + 1) : raw
    return truncatePathMiddle(rel, maxWidth)
  }
  if (inp.command && typeof inp.command === "string") {
    return truncateToWidth(inp.command, maxWidth)
  }
  if (inp.pattern && typeof inp.pattern === "string") return truncateToWidth(inp.pattern, maxWidth)
  if (inp.query && typeof inp.query === "string") return truncateToWidth(inp.query, maxWidth)
  if (inp.description && typeof inp.description === "string") return truncateToWidth(inp.description, maxWidth)
  return ""
}

/** Present-tense verb for running tools, past-tense for completed.
 *  MCP tools are formatted as "server › tool_name" instead of the raw name. */
function toolVerb(tool: string, isRunning: boolean): string {
  if (isMcpTool(tool)) {
    const parsed = parseMcpToolName(tool)
    const display = `${parsed.server} \u203A ${parsed.tool.replace(/_/g, " ")}`
    return isRunning ? display : display
  }
  switch (tool) {
    case "Read":     return isRunning ? "Reading" : "Read"
    case "Write":    return isRunning ? "Writing" : "Wrote"
    case "Edit":     return isRunning ? "Editing" : "Edited"
    case "Bash":     return isRunning ? "Running" : "Ran"
    case "Glob":     return isRunning ? "Searching" : "Searched"
    case "Grep":     return isRunning ? "Searching" : "Searched"
    case "Agent":    return isRunning ? "Launching" : "Launched"
    case "WebFetch": return isRunning ? "Fetching" : "Fetched"
    case "WebSearch": return isRunning ? "Searching" : "Searched"
    default:         return isRunning ? `Running ${tool}` : tool
  }
}

/** Brief inline result for collapsed summary lines */
function collapsedResultHint(tool: ToolBlock): string {
  if (tool.status === "running") return ""
  if (tool.error) {
    if (isUserDecline(tool.error)) return "declined"
    return "failed"
  }
  const out = tool.output ?? ""
  if (!out) return ""
  switch (tool.tool) {
    case "Read": {
      const lines = out.split("\n").length
      return `${lines} line${lines === 1 ? "" : "s"}`
    }
    case "Glob":
    case "Grep": {
      const lines = out.trim().split("\n").filter(l => l.trim()).length
      return `${lines} result${lines === 1 ? "" : "s"}`
    }
    default:
      return ""
  }
}

/** Format elapsed seconds as a human-readable string */
function formatElapsed(seconds: number): string {
  return formatDuration(seconds * 1000, { hideTrailingZeros: true })
}

/** Collapsed tool summary view — shows each tool with its primary arg */
export function ToolSummaryView(props: { tools: ToolBlock[] }) {
  // Same F-2 fix as ToolBlockView above — root path display at the active
  // session's cwd, not the bantai process cwd.
  const agent = useAgent()
  const sessionCwd = () => agent.config.cwd ?? process.cwd()

  // Tick signal for running tool elapsed time — updates every second
  const [tick, setTick] = createSignal(Date.now())
  const hasRunning = createMemo(() => props.tools.some(t => t.status === "running"))
  let tickTimer: ReturnType<typeof setInterval> | undefined

  createEffect(() => {
    if (hasRunning()) {
      if (!tickTimer) {
        tickTimer = setInterval(() => setTick(Date.now()), 1000)
      }
    } else {
      if (tickTimer) {
        clearInterval(tickTimer)
        tickTimer = undefined
      }
    }
  })
  onCleanup(() => { if (tickTimer) clearInterval(tickTimer) })

  // Live terminal width — drives the per-line arg budget so summary lines
  // expand on wide terminals instead of cropping at 60 chars.
  const dims = useTerminalDimensions()
  const termWidth = createMemo(() => dims()?.width ?? 80)

  /** Build per-tool summary lines with status icon prefix for instant scannability.
   *  Each line: "checkmark ToolName arg -- hint" or "ellipsis ToolName arg... (5s)"
   *  Uses getStatusConfig() from design system primitives for consistent icon/color pairing. */
  const toolLines = createMemo(() => {
    const now = tick() // subscribe to tick for reactivity
    const w = termWidth()
    return props.tools.map(tool => {
      const verb = toolVerb(tool.tool, tool.status === "running")
      // Layout: `<padding-2> <icon-2> <verb> <arg> <suffix>`. Reserve
      // ~SUFFIX_RESERVE chars for the trailing hint / progress text so the
      // full line still fits on one row of the terminal.
      const SUFFIX_RESERVE = 30
      const overhead = 2 + 2 + verb.length + 1 + SUFFIX_RESERVE
      const argMax = Math.max(TOOL_MIN_BUDGET, Math.min(TOOL_MAX_BUDGET, w - overhead))
      const arg = extractPrimaryArg(tool.tool, tool.input, argMax, sessionCwd())
      const argSuffix = arg ? ` ${arg}` : ""

      if (tool.status === "running") {
        const elapsed = Math.floor((now - tool.startTime) / 1000)
        const cfg = getStatusConfig("running")
        const out = tool.output ?? ""
        const lineCount = out ? out.split('\n').filter(l => l.trim()).length : 0
        const progressHint = lineCount > 0
          ? `${lineCount} line${lineCount === 1 ? "" : "s"} (${formatElapsed(elapsed)})`
          : `(${formatElapsed(elapsed)})`
        return {
          text: `${verb}${argSuffix}... ${progressHint}`,
          isError: false,
          icon: cfg.icon,
          iconColor: cfg.color,
        }
      }

      const hint = collapsedResultHint(tool)
      const isError = tool.status === "error" || (!!tool.error && !isUserDecline(tool.error))
      const isDeclined = !!tool.error && isUserDecline(tool.error)
      const hintSuffix = hint ? ` \u2014 ${hint}` : ""

      const cfg = isError
        ? getStatusConfig("error")
        : isDeclined
          ? getStatusConfig("declined")
          : getStatusConfig("success")

      return { text: `${verb}${argSuffix}${hintSuffix}`, isError, icon: cfg.icon, iconColor: cfg.color }
    })
  })

  return (
    <box paddingLeft={2} flexDirection="column">
      {toolLines().map(line => (
        <box flexDirection="row">
          <text
            fg={line.iconColor}
            attributes={TextAttributes.DIM}
          >
            {line.icon + " "}
          </text>
          <text
            fg={line.isError ? colors.status.error : colors.text.muted}
          >
            {line.text}
          </text>
        </box>
      ))}
    </box>
  )
}

/** Render item: either a block or a tool summary */
export type RenderItem =
  | { kind: "block"; block: Block }
  | { kind: "tool-summary"; tools: ToolBlock[] }

/** Group consecutive tool blocks into summaries when in collapsed view */
export function groupBlocksForRendering(blocks: Block[], viewLevel: ViewLevel): RenderItem[] {
  if (viewLevel !== "collapsed") {
    return blocks.map(b => ({ kind: "block" as const, block: b }))
  }

  const items: RenderItem[] = []
  let toolGroup: ToolBlock[] = []

  for (const block of blocks) {
    if (block.type === "tool") {
      toolGroup.push(block as ToolBlock)
    } else {
      if (toolGroup.length > 0) {
        items.push({ kind: "tool-summary", tools: [...toolGroup] })
        toolGroup = []
      }
      items.push({ kind: "block", block })
    }
  }

  if (toolGroup.length > 0) {
    items.push({ kind: "tool-summary", tools: [...toolGroup] })
  }

  return items
}
