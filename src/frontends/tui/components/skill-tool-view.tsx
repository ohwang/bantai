/**
 * SkillToolView — Specialized renderer for Skill tool blocks.
 *
 * Unlike generic ToolBlockView, this component renders skill invocations
 * with the skill name as the prominent label, and groups the skill's
 * loading/progress messages under the block rather than in the top-level
 * conversation flow.
 */

import { createSignal, createEffect, createMemo, onCleanup, Show, For } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { Block, SkillToolUse } from "../../../protocol/types"
import { colors } from "../theme/tokens"
import { BlinkingDot } from "./primitives"
import { truncateToWidth } from "../../../utils/truncate"
import { formatDuration } from "../../../utils/format"
import { isUserDecline } from "./tool-view"
import type { ViewLevel } from "./tool-view"
import { TOOL_MIN_BUDGET, TOOL_MAX_BUDGET, computeSummaryBudget, computeErrorBudget } from "./tool-view"
import { createThrottledValue } from "../../../utils/throttled-value"

export type SkillToolBlock = Extract<Block, { type: "tool" }>

/** Extract the skill name from the Skill tool input */
function extractSkillName(input: unknown): string {
  const inp = input as Record<string, unknown> | null
  if (!inp) return ""
  if (inp.skill && typeof inp.skill === "string") return inp.skill
  return ""
}

/** Extract the skill args from the Skill tool input */
function extractSkillArgs(input: unknown): string {
  const inp = input as Record<string, unknown> | null
  if (!inp) return ""
  if (inp.args && typeof inp.args === "string") return inp.args
  return ""
}

/** Get the last N non-empty lines from text */
function getLastNLines(text: string, n: number): string {
  const lines = text.split("\n").filter(l => l.trim())
  if (lines.length <= n) return lines.join("\n")
  return "...\n" + lines.slice(-n).join("\n")
}

export function SkillToolView(props: {
  block: SkillToolBlock
  viewLevel: ViewLevel
}) {
  const b = () => props.block
  const status = createThrottledValue(() => b().status)

  // Live terminal width — drives all per-line truncation budgets.
  const dims = useTerminalDimensions()
  const termWidth = createMemo(() => dims()?.width ?? 80)
  const summaryBudget = createMemo(() => computeSummaryBudget(termWidth()))
  const errorBudget = createMemo(() => computeErrorBudget(termWidth()))
  // Header `<dot-2> Skill <name> <args> <duration>`. Reserve room for the
  // skill name (~20 chars) and duration (~12 chars).
  const headerArgsBudget = createMemo(() => {
    const overhead = 2 + 5 + 1 + 20 + 1 + 12 + 2
    return Math.max(TOOL_MIN_BUDGET, Math.min(TOOL_MAX_BUDGET, termWidth() - overhead))
  })

  // Elapsed time for running skills
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

  const skillName = createMemo(() => extractSkillName(b().input))
  const skillArgs = createMemo(() => extractSkillArgs(b().input))

  const dotStatus = (): "active" | "success" | "error" => {
    if (status() === "running") return "active"
    if (status() === "error" || b().error) return "error"
    return "success"
  }

  // Skill sub-agent activity (populated by skill_tool_activity events)
  const activity = createMemo(() => b().skillActivity ?? [])

  const MAX_VISIBLE_TOOLS = 3
  const visibleTools = createMemo((): SkillToolUse[] => {
    const all = activity()
    if (all.length <= MAX_VISIBLE_TOOLS) return all
    return all.slice(-MAX_VISIBLE_TOOLS)
  })
  const hiddenCount = createMemo(() => Math.max(0, activity().length - MAX_VISIBLE_TOOLS))

  // Progress: last few lines of output while running (fallback when no skillActivity)
  const progressText = createMemo(() => {
    if (status() !== "running") return ""
    if (activity().length > 0) return "" // activity list replaces raw output
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
      {/* Header: ● Skill — skill-name */}
      <box flexDirection="row">
        <box width={2} flexShrink={0}>
          <BlinkingDot status={dotStatus()} />
        </box>
        <text fg={colors.accent.suggestion} attributes={TextAttributes.BOLD}>
          {"Skill"}
        </text>
        <Show when={skillName()}>
          <text fg={colors.text.secondary}>
            {" " + skillName()}
          </text>
        </Show>
        <Show when={skillArgs()}>
          <text fg={colors.text.muted}>
            {" " + truncateToWidth(skillArgs(), headerArgsBudget())}
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

      {/* Sub-agent tool activity — last 3 tool uses with status indicators */}
      <Show when={props.viewLevel !== "collapsed" && activity().length > 0}>
        <box flexDirection="column" paddingLeft={4}>
          <Show when={hiddenCount() > 0}>
            <text fg={colors.text.muted}>
              {`+${hiddenCount()} more tool use${hiddenCount() === 1 ? "" : "s"}`}
            </text>
          </Show>
          <For each={visibleTools()}>
            {(toolUse) => {
              const icon = createMemo(() => {
                switch (toolUse.status) {
                  case "running": return "\u22EF" // ⋯
                  case "done": return "\u2713"    // ✓
                  case "error": return "\u2717"   // ✗
                }
              })
              const fg = createMemo(() => {
                switch (toolUse.status) {
                  case "running": return colors.accent.suggestion
                  case "done": return colors.status.success
                  case "error": return colors.status.error
                }
              })
              return (
                <box flexDirection="row">
                  <text fg={fg()}>{icon()}</text>
                  <text fg={colors.text.secondary}>{" " + toolUse.toolName}</text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>

      {/* Progress output — last few lines while skill is loading (fallback) */}
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

/** Collapsed single-line view for Skill tool blocks */
export function CollapsedSkillLine(props: {
  block: SkillToolBlock
}) {
  const b = () => props.block
  const status = createThrottledValue(() => b().status)

  // Live terminal width — drives label/hint truncation.
  const dims = useTerminalDimensions()
  const termWidth = createMemo(() => dims()?.width ?? 80)
  const labelBudget = createMemo(() => {
    // `<dot-2> Skill <name> <hint>`. Reserve ~30 for hint.
    const overhead = 2 + 6 + 30 + 2
    return Math.max(TOOL_MIN_BUDGET, Math.min(TOOL_MAX_BUDGET, termWidth() - overhead))
  })
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

  const skillName = createMemo(() => extractSkillName(b().input))

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
      // Show last active tool from skillActivity if available
      const lastTool = b().skillActivity?.findLast(a => a.status === "running")
      if (lastTool) {
        return elapsed() > 0
          ? ` (${lastTool.toolName}, ${elapsed()}s)`
          : ` (${lastTool.toolName})`
      }
      return elapsed() > 0 ? ` (${elapsed()}s)` : ""
    }
    if (b().error) {
      return isUserDecline(b().error!) ? " — declined" : " — failed"
    }
    const out = b().output ?? ""
    if (out) {
      const firstLine = out.split("\n").find(l => l.trim()) ?? ""
      const truncated = truncateToWidth(firstLine, hintBudget())
      return truncated ? ` — ${truncated}` : ""
    }
    return ""
  })

  const label = createMemo(() => {
    const name = skillName()
    return name ? `Skill ${truncateToWidth(name, labelBudget())}` : "Skill"
  })

  return (
    <box flexDirection="row">
      <box width={2} flexShrink={0}>
        <BlinkingDot status={dotStatus()} />
      </box>
      <text
        fg={b().error && !isUserDecline(b().error!) ? colors.status.error : colors.accent.suggestion}
        attributes={TextAttributes.DIM}
      >
        {label() + hint()}
      </text>
    </box>
  )
}
