/**
 * Default status bar preset — the original bantai layout.
 *
 * Line 1:
 *   project  model (ctx)  [effort]  ●state  $cost  [branch ~M +U]  ctx:NN% ▰▰▱▱▱▱  [hint | tok/s]
 *
 * Responsive: cost hidden < 60 cols, git hidden < 80 cols, ctx hidden < 100 cols.
 */
import { TextAttributes } from "@opentui/core"
import { colors } from "../../theme/tokens"
import type { StatusBarPreset, StatusBarPresetProps } from "../types"

function DefaultStatusBar(props: StatusBarPresetProps) {
  const { data } = props
  return (
    <box height={1} flexDirection="row" paddingLeft={2} paddingRight={1}>
      {/* Left: project name + model */}
      <text fg={colors.text.secondary}>{data.projectName}</text>

      <text fg={colors.text.secondary}>{"  "}</text>

      <text fg={colors.text.primary} attributes={TextAttributes.BOLD}>
        {data.modelDisplay()}
      </text>

      {/* Effort level (hidden when default/high) */}
      {data.effortBadge() && (
        <box flexDirection="row">
          <text fg={colors.text.secondary}>{" "}</text>
          <text fg={colors.status.warning} attributes={TextAttributes.DIM}>
            {data.effortBadge()}
          </text>
        </box>
      )}

      {/* State icon + backgrounded label */}
      <text fg={colors.text.secondary}>{"  "}</text>
      <text fg={data.stateColor()}>{data.stateIcon()}</text>
      {data.backgrounded() && (
        <text fg={colors.status.warning}>{" Backgrounded"}</text>
      )}

      {/* Cost (hidden below 60 cols) */}
      {data.showCost() && data.costStr() && (
        <box flexDirection="row">
          <text fg={colors.text.secondary}>{"  "}</text>
          <text fg={colors.status.success}>{data.costStr()}</text>
        </box>
      )}

      {/* Git branch + status (hidden below 80 cols) */}
      {data.showGit() && data.gitStr() && (
        <box flexDirection="row">
          <text fg={colors.text.secondary}>{"  "}</text>
          <text fg={colors.status.info}>{data.gitStr()}</text>
        </box>
      )}

      {/* Context window usage (hidden below 100 cols) */}
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

      {/* Spacer */}
      <box flexGrow={1} />

      {/* Right: exit hint (transient) OR normal right-side info.
          When IDLE and the last turn reported TTFT, show it; otherwise
          fall back to tok/s (which only appears while running). The two
          never collide — `tokPerSecStr` returns "" when not RUNNING and
          `ttftStr` returns "" when RUNNING. */}
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
  )
}

export const defaultPreset: StatusBarPreset = {
  id: "default",
  name: "Default",
  description: "Standard layout — project, model, state, cost, git, context, tok/s.",
  render: DefaultStatusBar,
}
