/**
 * AgentToolView — Specialized renderer for Agent/subagent tool blocks.
 *
 * Unlike generic ToolBlockView, this component renders subagent interactions
 * inline: description, current activity (last tool name), progress summary,
 * and completion output — all within the tool block's visual footprint.
 *
 * Correlates with TaskInfo from activeTasks via the tool block's id matching
 * the task's toolUseId.
 */

import { createSignal, createEffect, createMemo, onCleanup, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { Block, TaskInfo } from "../../../protocol/types"
import { colors } from "../theme/tokens"
import { BlinkingDot } from "./primitives"
import { truncateToWidth } from "../../../utils/truncate"
import { formatDuration } from "../../../utils/format"
import { useMessages } from "../context/messages"
import type { ViewLevel } from "./tool-view"
import { TOOL_MIN_BUDGET, TOOL_MAX_BUDGET, computeSummaryBudget, computeErrorBudget } from "./tool-view"
import { createThrottledValue } from "../../../utils/throttled-value"

export type AgentToolBlock = Extract<Block, { type: "tool" }>

/** Extract the subagent description from the Agent tool input.
 *  Returns the raw string — caller is responsible for terminal-aware
 *  truncation, since width depends on render context. */
function extractAgentDescription(input: unknown): string {
  const inp = input as Record<string, unknown> | null
  if (!inp) return ""
  if (inp.description && typeof inp.description === "string") return inp.description
  if (inp.prompt && typeof inp.prompt === "string") return inp.prompt
  return ""
}

/** Extract the full subagent prompt from the Agent tool input */
function extractAgentPrompt(input: unknown): string {
  const inp = input as Record<string, unknown> | null
  if (!inp) return ""
  if (inp.prompt && typeof inp.prompt === "string") return inp.prompt
  return ""
}

/** Extract the subagent type from the Agent tool input */
function extractAgentType(input: unknown): string | undefined {
  const inp = input as Record<string, unknown> | null
  if (!inp) return undefined
  if (inp.subagent_type && typeof inp.subagent_type === "string") return inp.subagent_type
  return undefined
}

/** Find the TaskInfo that corresponds to an Agent tool block via toolUseId. */
function findMatchingTask(
  activeTasks: [string, TaskInfo][],
  block: AgentToolBlock,
): TaskInfo | undefined {
  for (const [, task] of activeTasks) {
    if (task.toolUseId === block.id) return task
  }
  return undefined
}

export function AgentToolView(props: {
  block: AgentToolBlock
  viewLevel: ViewLevel
}) {
  const b = () => props.block
  const status = createThrottledValue(() => b().status)
  const { state } = useMessages()
  const task = createMemo(() => findMatchingTask(state.activeTasks, b()))

  // Live terminal width — drives all per-line truncation budgets so the
  // header, progress, completion, and error lines fill wide terminals
  // instead of capping at fixed 70/100/120 chars.
  const dims = useTerminalDimensions()
  const termWidth = createMemo(() => dims()?.width ?? 80)
  const summaryBudget = createMemo(() => computeSummaryBudget(termWidth()))
  const errorBudget = createMemo(() => computeErrorBudget(termWidth()))
  // Header is `<dot-2> <typeLabel> <description> <duration>`. typeLabel is
  // typically short (~10 chars). Reserve room for both label and duration.
  const headerArgBudget = createMemo(() => {
    const overhead = 2 + 12 + 1 + 12 + 2
    return Math.max(TOOL_MIN_BUDGET, Math.min(TOOL_MAX_BUDGET, termWidth() - overhead))
  })

  // Elapsed time for running agents
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

  const description = createMemo(() => extractAgentDescription(b().input))
  const prompt = createMemo(() => extractAgentPrompt(b().input))
  const agentType = createMemo(() => {
    // Prefer task's taskType (from SDK), fall back to input.subagent_type
    return task()?.taskType ?? extractAgentType(b().input)
  })

  // Status indicator
  const dotStatus = (): "active" | "success" | "error" => {
    if (status() === "running") return "active"
    if (status() === "error" || b().error) return "error"
    return "success"
  }

  // Activity line: what the subagent is currently doing
  const activityText = createMemo(() => {
    const t = task()
    if (!t || t.status !== "running") return ""
    if (t.lastToolName) return `Running ${t.lastToolName}...`
    return "Thinking..."
  })

  // Progress summary: AI-generated or last output snippet.
  // Indented 4 chars under the header, so budget = termWidth - 4 - buffer.
  const progressText = createMemo(() => {
    const t = task()
    if (!t) return ""
    const max = Math.max(TOOL_MIN_BUDGET, Math.min(TOOL_MAX_BUDGET, termWidth() - 6))
    if (t.summary) return truncateToWidth(t.summary, max)
    if (t.output && t.status === "running") {
      return truncateToWidth(t.output, max)
    }
    return ""
  })

  // Completion summary for done agents — single line under `⎿  `.
  const completionSummary = createMemo(() => {
    if (status() === "running") return ""
    const out = b().output ?? ""
    if (!out) return ""
    // Show first meaningful line, truncated to fit terminal
    const firstLine = out.split("\n").find(l => l.trim()) ?? ""
    return truncateToWidth(firstLine, summaryBudget())
  })

  // Agent type label for display
  const typeLabel = createMemo(() => {
    const t = agentType()
    if (!t) return "Agent"
    // Capitalize first letter
    return t.charAt(0).toUpperCase() + t.slice(1)
  })

  return (
    <box flexDirection="column">
      {/* Header: ● Agent(description) — elapsed */}
      <box flexDirection="row">
        <box width={2} flexShrink={0}>
          <BlinkingDot status={dotStatus()} />
        </box>
        <text fg={colors.accent.secondary} attributes={TextAttributes.BOLD}>
          {typeLabel()}
        </text>
        <Show when={description()}>
          <text fg={colors.text.secondary}>
            {" " + truncateToWidth(description(), headerArgBudget())}
          </text>
        </Show>
        <Show when={status() === "running" && elapsed() > 0}>
          <text fg={colors.text.secondary}>
            {" " + formatDuration(elapsed() * 1000, { hideTrailingZeros: true })}
          </text>
        </Show>
        <Show when={status() !== "running" && b().duration !== undefined && b().duration! >= 1000}>
          <text fg={colors.text.secondary}>
            {" " + formatDuration(b().duration!, { hideTrailingZeros: true })}
          </text>
        </Show>
      </box>

      {/* Subagent prompt — the full instructions sent from parent to child agent.
            Visible in expanded/show_all so users can inspect what the agent was asked to do.
            This replaces the raw user-message block that would otherwise appear confusingly
            styled as if the human typed it. */}
      <Show when={props.viewLevel !== "collapsed" && prompt()}>
        <box paddingLeft={4} marginTop={0}>
          <text fg={colors.text.muted}>
            {prompt()}
          </text>
        </box>
      </Show>

      {/* Activity line: what the subagent is currently doing (running only) */}
      <Show when={status() === "running" && activityText()}>
        <box flexDirection="row" paddingLeft={4}>
          <text fg={colors.text.muted}>
            {activityText()}
          </text>
        </box>
      </Show>

      {/* Progress: AI summary or output snippet (expanded/show_all, running only) */}
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
      <Show when={b().error}>
        <box paddingLeft={2}>
          <text fg={colors.status.error}>
            {"\u23BF  \u2717 " + truncateToWidth(b().error!.split("\n")[0]!, errorBudget())}
          </text>
        </box>
      </Show>
    </box>
  )
}

/** Collapsed single-line view for Agent tool blocks */
export function CollapsedAgentLine(props: {
  block: AgentToolBlock
}) {
  const b = () => props.block
  const status = createThrottledValue(() => b().status)
  const { state } = useMessages()
  const task = createMemo(() => findMatchingTask(state.activeTasks, b()))

  // Live terminal width — drives label/hint truncation so the collapsed
  // line uses available width on wide terminals.
  const dims = useTerminalDimensions()
  const termWidth = createMemo(() => dims()?.width ?? 80)
  // Layout: `<dot-2> <label> <hint>`. Reserve ~30 chars for hint.
  const labelBudget = createMemo(() => {
    const overhead = 2 + 30 + 2
    return Math.max(TOOL_MIN_BUDGET, Math.min(TOOL_MAX_BUDGET, termWidth() - overhead))
  })
  // Hint truncation is for the inline output snippet `— foo bar baz`. Use
  // about half the labelBudget so neither side dominates the line.
  const hintBudget = createMemo(() => Math.max(TOOL_MIN_BUDGET, Math.floor(labelBudget() / 2)))

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

  const description = createMemo(() => extractAgentDescription(b().input))

  const dotStatus = (): "active" | "success" | "error" | "declined" => {
    if (status() === "running") return "active"
    if (b().error) return "error"
    return "success"
  }

  const hint = createMemo(() => {
    if (status() === "running") {
      const t = task()
      const parts: string[] = []
      if (t?.lastToolName) parts.push(t.lastToolName)
      if (elapsed() > 0) parts.push(`${elapsed()}s`)
      return parts.length > 0 ? ` (${parts.join(", ")})` : ""
    }
    if (b().error) return " — failed"
    const out = b().output ?? ""
    if (out) {
      const firstLine = out.split("\n").find(l => l.trim()) ?? ""
      const truncated = truncateToWidth(firstLine, hintBudget())
      return truncated ? ` — ${truncated}` : ""
    }
    return ""
  })

  const agentType = createMemo(() => {
    return task()?.taskType ?? extractAgentType(b().input)
  })

  const label = createMemo(() => {
    const t = agentType()
    const prefix = t ? `${t.charAt(0).toUpperCase() + t.slice(1)}` : "Agent"
    const desc = description()
    return desc ? `${prefix} ${truncateToWidth(desc, labelBudget())}` : prefix
  })

  return (
    <box flexDirection="row">
      <box width={2} flexShrink={0}>
        <BlinkingDot status={dotStatus()} />
      </box>
      <text
        fg={b().error ? colors.status.error : colors.accent.secondary}
        attributes={TextAttributes.DIM}
      >
        {label() + hint()}
      </text>
    </box>
  )
}
