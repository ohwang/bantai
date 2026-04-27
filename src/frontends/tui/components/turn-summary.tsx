import { Show, For } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { colors } from "../theme/tokens"
import { truncatePathMiddle } from "../../../utils/truncate"
import { formatDuration, formatTokens } from "../../../utils/format"
import type { TurnFileChange, TurnSummaryInfo } from "../../../protocol/types"

const ACTION_ICONS: Record<string, string> = {
  create: "+",
  edit: "~",
  read: " ",
  write: "+",
}

function actionColor(action: string): string {
  switch (action) {
    case "create": return colors.diff.added
    case "edit":   return colors.accent.primary
    case "read":   return colors.text.muted
    case "write":  return colors.diff.added
    default:       return colors.text.muted
  }
}

/** Format cost: matches session-picker formatting convention. */
function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1)    return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/** Build the "Baked for X · Y tokens · $Z" text. Skips fields the backend
 *  didn't report so partial data still produces a useful line. Returns null
 *  when the summary has nothing worth showing. */
function formatBakedFor(summary: TurnSummaryInfo): string | null {
  const parts: string[] = []

  if (summary.durationMs != null && summary.durationMs > 0) {
    parts.push(formatDuration(summary.durationMs, { hideTrailingZeros: true }))
  }

  if (summary.usage) {
    const u = summary.usage
    // Total tokens = input + output + cache, summed across every API call
    // in the turn (reducer feeds this from per-call cost_update events).
    // Lines up with the cumulative costUsd below — single-call result.usage
    // would not.
    const total =
      (u.inputTokens ?? 0) +
      (u.outputTokens ?? 0) +
      (u.cacheReadTokens ?? 0) +
      (u.cacheWriteTokens ?? 0)
    if (total > 0) {
      parts.push(`${formatTokens(total)} tokens`)
    }
  }

  // Surface the multiplier behind a high cost — a $100 turn that did one
  // model call vs. forty looks identical without these.
  if (summary.apiTurns != null && summary.apiTurns > 0) {
    parts.push(`${summary.apiTurns} ${summary.apiTurns === 1 ? "turn" : "turns"}`)
  }

  if (summary.toolCalls != null && summary.toolCalls > 0) {
    parts.push(`${summary.toolCalls} ${summary.toolCalls === 1 ? "tool" : "tools"}`)
  }

  if (summary.costUsd != null && summary.costUsd > 0) {
    parts.push(formatCost(summary.costUsd))
  }

  if (parts.length === 0) return null
  return `Baked for ${parts.join(" \u00B7 ")}`
}

export function TurnSummary(props: {
  files?: TurnFileChange[]
  summary?: TurnSummaryInfo | null
}) {
  // Deduplicate by path (keep most significant action: create > edit > read)
  const deduped = () => {
    const files = props.files
    if (!files || files.length === 0) return []
    const map = new Map<string, TurnFileChange>()
    const priority: Record<string, number> = { create: 3, edit: 2, write: 2, read: 1 }
    for (const f of files) {
      const existing = map.get(f.path)
      if (!existing || (priority[f.action] ?? 0) > (priority[existing.action] ?? 0)) {
        map.set(f.path, f)
      }
    }
    return [...map.values()].filter(f => f.action !== "read") // Only show writes/edits
  }

  const bakedText = () => {
    const s = props.summary
    return s ? formatBakedFor(s) : null
  }

  const hasFiles = () => deduped().length > 0
  const hasBaked = () => bakedText() !== null

  return (
    <Show when={hasFiles() || hasBaked()}>
      <box flexDirection="column" paddingLeft={2} marginTop={1}>
        <Show when={hasFiles()}>
          <text fg={colors.text.muted}>
            {"Files changed:"}
          </text>
          <For each={deduped()}>
            {(file) => {
              const icon = ACTION_ICONS[file.action] ?? " "
              const color = actionColor(file.action)
              const rel = file.path.startsWith(process.cwd() + "/")
                ? file.path.slice(process.cwd().length + 1)
                : file.path
              return (
                <text fg={color} attributes={TextAttributes.DIM}>
                  {"  " + icon + " " + truncatePathMiddle(rel, 70)}
                </text>
              )
            }}
          </For>
        </Show>
        <Show when={hasBaked()}>
          <text fg={colors.text.muted} attributes={TextAttributes.DIM}>
            {bakedText()}
          </text>
        </Show>
      </box>
    </Show>
  )
}
