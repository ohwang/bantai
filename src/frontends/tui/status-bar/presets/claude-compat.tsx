/**
 * Claude-compat status bar preset — visually identical to the external Bash
 * statusline that Claude Code ships (a `statusLine.command` shell snippet
 * that consumes the SDK's stdin JSON and prints two lines of dir / model /
 * cost / rate-limit info).
 *
 * The goal is pixel-for-pixel parity with that script so users can drop the
 * external command (no more jq + subshell per refresh) without any visual
 * regression. All colors resolve to theme tokens — nothing is hardcoded —
 * so the preset inherits the active theme's palette (snazzy by default).
 *
 * Layout:
 *
 *   Line 1:
 *     <dir>  [<branch><upstream><@worktree> <idx> <wt>]  <session_age #turn>
 *
 *   Line 2:
 *     <model> <effort>  ctx:NN%  $cost (+$delta)  tokens (+delta)  5h:NN% (…) 7d:NN% (…)
 *
 * Rate-limit rendering matches the bash script's logic:
 *   - 5h hidden when < 50% used (too noisy otherwise)
 *   - 7d always visible when present
 *   - Colour derived from pace (tokens_left / time_left) when a reset time is
 *     known; falls back to used% thresholds otherwise
 *   - Multi-day windows also show `%/d` burn rate, colored by how aggressive
 *     the consumption rate is relative to a "normal" 14%/d 7d budget
 */

import { createMemo, Show, type JSX } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { colors } from "../../theme/tokens"
import type { StatusBarPreset, StatusBarPresetProps } from "../types"
import type { RateLimitEntry } from "../../../../protocol/types"
import { formatDuration, type GitInfo } from "../data"

// ---------------------------------------------------------------------------
// Branch color + upstream indicator (matches ohw zsh theme + bash script)
// ---------------------------------------------------------------------------

function branchColor(info: GitInfo): string {
  if (!info.hasUpstream) return colors.status.info
  if (info.ahead > 0 && info.behind > 0) return colors.status.warning
  if (info.ahead > 0) return colors.status.success
  if (info.behind > 0) return colors.status.error
  return colors.status.info
}

function upstreamStr(info: GitInfo): string {
  if (!info.hasUpstream) return ""
  if (info.ahead === 0 && info.behind === 0) return " \u2261"
  if (info.ahead > 0 && info.behind > 0) return ` \u2191${info.ahead}\u2193${info.behind}`
  if (info.ahead > 0) return ` \u2191${info.ahead}`
  return ` \u2193${info.behind}`
}

function stagedStr(info: GitInfo): string {
  const parts: string[] = []
  if (info.staged.added > 0) parts.push(`+${info.staged.added}`)
  if (info.staged.modified > 0) parts.push(`~${info.staged.modified}`)
  if (info.staged.deleted > 0) parts.push(`-${info.staged.deleted}`)
  return parts.join(" ")
}

function workingStr(info: GitInfo): string {
  const parts: string[] = []
  if (info.working.modified > 0) parts.push(`~${info.working.modified}`)
  if (info.working.deleted > 0) parts.push(`-${info.working.deleted}`)
  if (info.working.untracked > 0) parts.push(`+${info.working.untracked}`)
  if (info.working.conflict > 0) parts.push(`!${info.working.conflict}`)
  return parts.join(" ")
}

// ---------------------------------------------------------------------------
// Rate-limit rendering (matches `render_rate_entry` in the bash script)
// ---------------------------------------------------------------------------

interface RatePace {
  color: string
  tokensLeft: number
  timeLeftStr: string
  pctPerDayStr: string
  pctPerDayColor: string
  backgroundColor?: string
  hasTime: boolean
  isMultiDay: boolean
}

function computeRatePace(
  entry: RateLimitEntry,
  windowMinsOverride?: number,
): RatePace {
  const windowMins = entry.windowDurationMins ?? windowMinsOverride ?? 0
  const valInt = Math.round(entry.usedPercentage)
  const tokensLeft = Math.max(0, 100 - valInt)

  const resetsAt = entry.resetsAt
  if (resetsAt && windowMins > 0) {
    const now = Math.floor(Date.now() / 1000)
    const timeLeftS = Math.max(0, resetsAt - now)
    const windowSecs = windowMins * 60
    const timeLeftPct = Math.floor((timeLeftS * 100) / windowSecs)

    let color: string
    if (tokensLeft <= 0) {
      color = colors.status.error
    } else if (timeLeftPct <= 0) {
      color = colors.status.success
    } else {
      const ratioX100 = Math.floor((tokensLeft * 100) / timeLeftPct)
      if (ratioX100 >= 80) color = colors.status.success
      else if (ratioX100 >= 50) color = colors.status.warning
      else color = colors.status.error
    }

    const timeLeftStr = formatDuration(timeLeftS)
    const isMultiDay = windowMins >= 1440

    let pctPerDayStr = ""
    let pctPerDayColor = colors.text.muted
    let backgroundColor: string | undefined
    if (timeLeftS > 0 && isMultiDay) {
      const pctPerDay = Math.round(tokensLeft / (timeLeftS / 86400))
      pctPerDayStr = `~${pctPerDay}%/d`
      if (pctPerDay < 8) {
        // Burning too fast — rationing needed. Bash script uses an
        // inverse white-on-red badge; we use the error color with BOLD
        // so the alert reads as loud without requiring bg support.
        pctPerDayColor = colors.status.error
        backgroundColor = undefined
      } else if (pctPerDay >= 20) {
        pctPerDayColor = colors.status.error
      } else if (pctPerDay >= 15) {
        pctPerDayColor = colors.status.warning
      }
    }

    return {
      color,
      tokensLeft,
      timeLeftStr,
      pctPerDayStr,
      pctPerDayColor,
      backgroundColor,
      hasTime: true,
      isMultiDay,
    }
  }

  // Fallback: no reset time known — color by used% thresholds.
  let color: string
  if (valInt >= 80) color = colors.status.error
  else if (valInt >= 50) color = colors.status.warning
  else color = colors.status.success
  return {
    color,
    tokensLeft: valInt, // we'll display used% instead of remaining%
    timeLeftStr: "",
    pctPerDayStr: "",
    pctPerDayColor: colors.text.muted,
    hasTime: false,
    isMultiDay: false,
  }
}

/**
 * Debug-mode placeholder rendered in place of a `RateEntry` when the SDK
 * hasn't emitted a `rate_limit_event` for that bucket yet. Format:
 *
 *   5h:—   7d:—
 *
 * The em-dash signals "no data" without pretending we have a 0% reading.
 * Once we trust the SDK is reliably emitting non-zero utilization, the
 * preset's `showFiveHour` / `showSevenDay` memos can revert to the
 * data-gated form and this component becomes unreachable.
 */
function RatePlaceholder(props: { label: string }): JSX.Element {
  return (
    <box flexDirection="row">
      <text fg={colors.text.muted} attributes={TextAttributes.DIM}>{`${props.label}:`}</text>
      <text fg={colors.text.muted} attributes={TextAttributes.DIM}>{"—"}</text>
    </box>
  )
}

function RateEntry(props: {
  label: string
  entry: RateLimitEntry
  windowMinsOverride?: number
}): JSX.Element {
  const pace = createMemo(() => computeRatePace(props.entry, props.windowMinsOverride))
  return (
    <box flexDirection="row">
      <text fg={colors.text.muted} attributes={TextAttributes.DIM}>{`${props.label}:`}</text>
      {pace().hasTime ? (
        <>
          <text fg={pace().color}>{`~${pace().tokensLeft}%`}</text>
          <text fg={colors.text.muted} attributes={TextAttributes.DIM}>{" ("}</text>
          <text fg={colors.text.muted} attributes={TextAttributes.DIM}>{pace().timeLeftStr}</text>
          <Show when={pace().isMultiDay && !!pace().pctPerDayStr}>
            <text fg={colors.text.muted} attributes={TextAttributes.DIM}>{" "}</text>
            <text fg={pace().pctPerDayColor} attributes={TextAttributes.BOLD}>
              {pace().pctPerDayStr}
            </text>
          </Show>
          <text fg={colors.text.muted} attributes={TextAttributes.DIM}>{")"}</text>
        </>
      ) : (
        <text fg={pace().color}>{`${pace().tokensLeft}%`}</text>
      )}
    </box>
  )
}

// ---------------------------------------------------------------------------
// The preset
// ---------------------------------------------------------------------------

function ClaudeCompatStatusBar(props: StatusBarPresetProps) {
  const { data } = props

  // Suppress line 2 only on terminals too narrow for the full 2-line layout
  // so the dense right-hand segments don't wrap mid-word.
  const showLine2 = () => data.termWidth() >= 60

  const gitAvailable = () => data.gitInfo() !== null

  // Rate-limit visibility:
  //   - 5h: ALWAYS shown (debug mode) — when no data has arrived yet, render
  //         a placeholder so it's obvious at a glance whether the SDK has
  //         emitted any `rate_limit_event` for this session. Once we trust
  //         the SDK is reliably emitting non-zero utilization, restore the
  //         original "≥ 50% used" gate (see commit history).
  //   - 7d: shown whenever the SDK reports it.
  //
  // (Original behaviour matched the external bash statusline's
  // `render_rate_entry` wiring, which hid 5h below 50% to keep the status
  // line short. Bantai is debugging whether the event arrives at all, so
  // we want the segment present even at 0% / unknown.)
  const showFiveHour = createMemo(() => true)
  const showSevenDay = createMemo(() => true)

  return (
    <box flexDirection="column">
      {/* ---- Line 1: dir, git, session age + turn count ----
          Laid out left-to-right with 2-space separators, matching the bash
          script's simple line concatenation. No flexGrow — extra terminal
          width is just padding on the right. A transient exit hint, if
          present, is right-aligned per bantai convention. */}
      <box height={1} flexDirection="row" paddingLeft={2} paddingRight={1}>
        {/* Directory (yellow analog → status.warning) */}
        <text fg={colors.status.warning}>{data.projectName}</text>

        {/* Git segment: [branch upstream @worktree idx wt] */}
        <Show when={gitAvailable() && data.gitInfo()} keyed>
          {(info: GitInfo) => {
            const idx = stagedStr(info)
            const wt = workingStr(info)
            return (
              <box flexDirection="row">
                <text fg={colors.text.secondary}>{"  "}</text>
                <text fg={colors.text.muted}>{"["}</text>
                <text fg={branchColor(info)}>{info.branch + upstreamStr(info)}</text>
                <Show when={!!data.worktreeName()}>
                  <text fg={colors.text.muted}>{" "}</text>
                  <text fg={colors.agents.purple}>{`@${data.worktreeName()}`}</text>
                </Show>
                <Show when={!!idx}>
                  <text fg={colors.text.muted}>{" "}</text>
                  <text fg={colors.status.success}>{idx}</text>
                </Show>
                <Show when={!!wt}>
                  <text fg={colors.text.muted}>{" "}</text>
                  <text fg={colors.status.error}>{wt}</text>
                </Show>
                <text fg={colors.text.muted}>{"]"}</text>
              </box>
            )
          }}
        </Show>

        {/* Session age + turn count (light-gray analog → text.muted) */}
        <box flexDirection="row">
          <text fg={colors.text.secondary}>{"  "}</text>
          <text fg={colors.text.muted}>{data.sessionAgeStr()}</text>
          <Show when={data.turnNumber() > 0}>
            <text fg={colors.text.muted}>{` #${data.turnNumber()}`}</text>
          </Show>
        </box>

        {/* Right-align: transient exit hint (when present) */}
        <box flexGrow={1} />
        <Show when={!!props.hint}>
          <text fg={colors.status.warning}>{props.hint}</text>
        </Show>
      </box>

      {/* ---- Line 2: model, effort, ctx, cost, tokens, rate limits ----
          Same left-aligned concatenation rule. */}
      <Show when={showLine2()}>
        <box height={1} flexDirection="row" paddingLeft={2} paddingRight={1}>
          {/* Model (cyan analog → status.info) */}
          <text fg={colors.status.info}>{data.modelDisplay()}</text>

          {/* Effort badge (bright magenta analog → accent.secondary) */}
          <Show when={!!data.effortBadge()}>
            <text fg={colors.text.secondary}>{" "}</text>
            <text fg={colors.accent.secondary} attributes={TextAttributes.BOLD}>
              {data.effortBadge()}
            </text>
          </Show>

          {/* Context usage */}
          <Show when={!!data.ctxStr()}>
            <text fg={colors.text.secondary}>{"  "}</text>
            <text fg={data.ctxColor()}>{data.ctxStr()}</text>
          </Show>

          {/* Session cost (warm-gold analog → status.warning) + turn delta */}
          <text fg={colors.text.secondary}>{"  "}</text>
          <text fg={colors.status.warning}>{data.costShortStr()}</text>
          <Show when={!!data.turnCostStr()}>
            <text fg={colors.text.muted} attributes={TextAttributes.DIM}>
              {` (+$${data.turnCostStr()})`}
            </text>
          </Show>

          {/* Total tokens (light-blue analog → status.info) + turn delta */}
          <Show when={!!data.totalTokensStr()}>
            <text fg={colors.text.secondary}>{"  "}</text>
            <text fg={colors.status.info}>{data.totalTokensStr()}</text>
            <Show when={!!data.turnTokensStr()}>
              <text fg={colors.text.muted} attributes={TextAttributes.DIM}>
                {` (+${data.turnTokensStr()})`}
              </text>
            </Show>
          </Show>

          {/* Rate limits — both 5h and 7d always rendered (debug mode);
              when no data has arrived yet for a slot we show "—" so it's
              obvious whether the SDK has emitted any rate_limit_event. */}
          <Show when={showFiveHour() || showSevenDay()}>
            <text fg={colors.text.secondary}>{"  "}</text>
            <Show when={showFiveHour()}>
              <Show
                when={data.rawRateLimits()?.fiveHour}
                keyed
                fallback={<RatePlaceholder label="5h" />}
              >
                {(fh: RateLimitEntry) => (
                  <RateEntry
                    label="5h"
                    entry={fh}
                    windowMinsOverride={300}
                  />
                )}
              </Show>
            </Show>
            <Show when={showFiveHour() && showSevenDay()}>
              <text fg={colors.text.secondary}>{" "}</text>
            </Show>
            <Show when={showSevenDay()}>
              <Show
                when={data.rawRateLimits()?.sevenDay}
                keyed
                fallback={<RatePlaceholder label="7d" />}
              >
                {(sd: RateLimitEntry) => (
                  <RateEntry
                    label="7d"
                    entry={sd}
                    windowMinsOverride={10080}
                  />
                )}
              </Show>
            </Show>
          </Show>
        </box>
      </Show>
    </box>
  )
}

export const claudeCompatPreset: StatusBarPreset = {
  id: "claude-compat",
  name: "Claude-compat",
  description:
    "Pixel-compatible port of the external Claude Code bash statusline (two rows, posh-git segment, pace-colored rate limits).",
  render: ClaudeCompatStatusBar,
}
