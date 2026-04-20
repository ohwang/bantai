/**
 * Detailed status bar preset — dense two-row layout for power users.
 *
 * Line 1:
 *   project  model  [effort]  ●state  turn:N  $cost  [branch ~M +U]  ctx:NN% ▰▰▱▱▱▱  [hint | tok/s]
 * Line 2 (preset-owned — renders BELOW the preset header but ABOVE the
 *   permission-mode row owned by the outer StatusBar):
 *   backend · session ⏱ Hh Mm Ss · rate limits: 5h NN% | 7d NN% …
 *
 * Responsive: hides the same way the default preset hides, plus the extra
 * line is suppressed when terminal width < 80 cols to avoid ugly wrap.
 */
import { createMemo, createSignal, onCleanup } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { colors } from "../../theme/tokens"
import type { StatusBarPreset, StatusBarPresetProps } from "../types"
import { rateLimitColor } from "../data"

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function DetailedStatusBar(props: StatusBarPresetProps) {
  const { data } = props

  // Session uptime — monotonic, starts at first render.
  const startMs = Date.now()
  const [nowMs, setNowMs] = createSignal(Date.now())
  const tickerHandle = setInterval(() => setNowMs(Date.now()), 1000)
  onCleanup(() => clearInterval(tickerHandle))

  const sessionDuration = createMemo(() => formatDuration(nowMs() - startMs))

  // Extra line is space-constrained — only render when we have room.
  const showExtraLine = () => data.termWidth() >= 80

  const turnStr = createMemo(() => {
    const n = data.turnNumber()
    return n > 0 ? `turn:${n}` : ""
  })

  return (
    <box flexDirection="column">
      {/* Line 1: same as default, plus turn number */}
      <box height={1} flexDirection="row" paddingLeft={2} paddingRight={1}>
        <text fg={colors.text.secondary}>{data.projectName}</text>
        <text fg={colors.text.secondary}>{"  "}</text>
        <text fg={colors.text.primary} attributes={TextAttributes.BOLD}>
          {data.modelDisplay()}
        </text>

        {data.effortBadge() && (
          <box flexDirection="row">
            <text fg={colors.text.secondary}>{" "}</text>
            <text fg={colors.status.warning} attributes={TextAttributes.DIM}>
              {data.effortBadge()}
            </text>
          </box>
        )}

        <text fg={colors.text.secondary}>{"  "}</text>
        <text fg={data.stateColor()}>{data.stateIcon()}</text>
        {data.backgrounded() && (
          <text fg={colors.status.warning}>{" Backgrounded"}</text>
        )}

        {turnStr() && (
          <box flexDirection="row">
            <text fg={colors.text.secondary}>{"  "}</text>
            <text fg={colors.text.muted}>{turnStr()}</text>
          </box>
        )}

        {data.showCost() && data.costStr() && (
          <box flexDirection="row">
            <text fg={colors.text.secondary}>{"  "}</text>
            <text fg={colors.status.success}>{data.costStr()}</text>
          </box>
        )}

        {data.showGit() && data.gitStr() && (
          <box flexDirection="row">
            <text fg={colors.text.secondary}>{"  "}</text>
            <text fg={colors.status.info}>{data.gitStr()}</text>
          </box>
        )}

        {data.showCtx() && data.ctxStr() && (
          <box flexDirection="row">
            <text fg={colors.text.secondary}>{"  "}</text>
            <text fg={data.ctxColor()}>{data.ctxStr()}</text>
            {data.ctxBar() && (
              <>
                <text fg={colors.text.secondary}>{" "}</text>
                <text fg={data.ctxColor()}>{data.ctxBar()}</text>
              </>
            )}
          </box>
        )}

        <box flexGrow={1} />

        {props.hint ? (
          <text fg={colors.status.warning}>{props.hint}</text>
        ) : (
          <>
            <box flexDirection="row" visible={!!data.tokPerSecStr()}>
              <text fg={colors.status.info}>{data.tokPerSecStr()}</text>
            </box>
            <box flexDirection="row" visible={!!data.ttftStr()}>
              <text fg={data.ttftColor()}>{data.ttftStr()}</text>
            </box>
          </>
        )}
      </box>

      {/* Extra line: backend · uptime · rate limits (suppressed below 80 cols) */}
      {showExtraLine() && (
        <box height={1} flexDirection="row" paddingLeft={2} paddingRight={1}>
          <text fg={colors.text.muted}>{data.backendName()}</text>
          <text fg={colors.text.muted}>{"  \u00B7  "}</text>
          <text fg={colors.text.muted}>{`\u23F1 ${sessionDuration()}`}</text>

          <box flexGrow={1} />

          <box flexDirection="row" visible={data.rateLimits().length > 0}>
            <text fg={colors.text.muted}>{"rate: "}</text>
            {data.rateLimits().map((entry, index) => (
              <>
                {index > 0 && <text fg={colors.text.secondary}>{"  "}</text>}
                <text fg={colors.text.muted}>{`${entry.label}:`}</text>
                <text fg={rateLimitColor(entry.usedPercentage)}>{`${Math.round(entry.usedPercentage)}%`}</text>
              </>
            ))}
          </box>
        </box>
      )}
    </box>
  )
}

export const detailedPreset: StatusBarPreset = {
  id: "detailed",
  name: "Detailed",
  description: "Everything in default, plus turn counter, uptime, and inline rate limits.",
  render: DetailedStatusBar,
}
