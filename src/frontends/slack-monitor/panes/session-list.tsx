/**
 * Session list — left pane.
 *
 * Renders one row per live session, sorted by last-event time
 * descending. The selected row shows an accent bar + darker background;
 * `j` / `k` / arrows move the selection, `Enter` is idempotent (the
 * selection is already committed on every move).
 *
 * The list reads from the reactive store via a per-item createMemo so
 * OpenTUI's Zig engine gets stable object identity per row (see
 * AGENTS.md rule 10 — "Render callbacks must be pure functions of their
 * item").
 *
 * Time-since-last-event on each row is driven by a single pane-level
 * "now" signal that ticks every 10s — that granularity is enough for
 * the `3s` → `1m` → `1h` → `1d` ladder without re-rendering the list on
 * every frame. Each row re-reads `now()` via a `createMemo`, so rows
 * whose `lastEventAt` hasn't changed still get an updated label.
 */

import { For, createMemo, createSignal, onCleanup } from "solid-js"
import { TextAttributes } from "@opentui/core"
import {
  phaseLabel,
  sortSessionsByActivity,
  type MonitorStoreState,
} from "../context/store"
import type { MonitorStore } from "../context/store"
import { mc } from "../theme"

/** How often the "2m ago" labels re-tick. 10s is the smallest step in
 * the ladder so we refresh at that rate to avoid visible lag crossing a
 * bucket boundary. */
const TICK_MS = 10_000

export interface SessionListProps {
  store: MonitorStore
  /** Width hint from the parent layout — used for row truncation. */
  width: number
}

export function SessionList(props: SessionListProps) {
  const sorted = createMemo(() => sortSessionsByActivity(props.store.state))
  const selected = createMemo(() => props.store.state.selectedSessionKey)

  // Pane-level clock. Cheap — one signal, one setInterval, used to
  // re-derive every row's "Nm ago" label. Guarded by onCleanup so
  // remounts don't leak timers.
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), TICK_MS)
  onCleanup(() => clearInterval(tick))

  return (
    <box
      flexDirection="column"
      width={props.width}
      flexShrink={0}
      backgroundColor={mc.panelBg}
      padding={1}
    >
      <text fg={mc.text.primary} attributes={TextAttributes.BOLD}>
        Sessions ({sorted().length})
      </text>
      <box flexDirection="column" marginTop={1}>
        <For
          each={sorted()}
          fallback={
            <text fg={mc.text.muted} attributes={TextAttributes.ITALIC}>
              No active sessions. Waiting for Slack traffic…
            </text>
          }
        >
          {(s) => {
            const isSelected = createMemo(() => selected() === s.key)
            const since = createMemo(() => formatSince(now(), s.lastEventAt))
            return <SessionRow summary={s} selected={isSelected()} since={since()} />
          }}
        </For>
      </box>
    </box>
  )
}

interface SessionRowProps {
  summary: MonitorStoreState["sessions"][string]
  selected: boolean
  /** Pre-formatted "2m ago" string driven by the pane-level clock. */
  since: string
}

function SessionRow(props: SessionRowProps) {
  const s = props.summary
  const phaseHex = () => phaseColor(s.phase)
  // The first-user-message line is the row's visual anchor — if the
  // capture missed the message (resume before the new pump landed), we
  // still want the row to be three lines tall so clicking / highlighting
  // doesn't jitter by a row-height as sessions acquire their preview.
  const preview = () => s.firstUserMessage?.trim() || "(waiting for first message…)"
  return (
    <box
      flexDirection="row"
      backgroundColor={props.selected ? mc.selection.rowBg : mc.panelBg}
      paddingLeft={props.selected ? 0 : 1}
      marginBottom={1}
    >
      {props.selected ? (
        <text fg={mc.selection.accent} attributes={TextAttributes.BOLD}>
          ▎
        </text>
      ) : null}
      <box flexDirection="column" flexGrow={1}>
        {/*
          Line 1: project / channel (bold, left) + time-since-last-event
          (hint, right). The trailing time mirrors what Slack does in its
          own thread list — it gives the row a "freshness" signal without
          eating space on the status line. `flexShrink={0}` on the time
          keeps it right-anchored even as the project name grows.
        */}
        <box flexDirection="row">
          <text fg={mc.text.primary} attributes={TextAttributes.BOLD}>
            {displayName(s.projectName, s.channelId)}
          </text>
          <box flexGrow={1} />
          <text fg={mc.text.hint} flexShrink={0}>
            {props.since}
          </text>
        </box>
        {/* Line 2: first user message (italic, dim) — gives the row context. */}
        <text
          fg={s.firstUserMessage ? mc.text.secondary : mc.text.muted}
          attributes={TextAttributes.ITALIC}
        >
          {preview()}
        </text>
        {/* Line 3: status · backend · turns · cost. */}
        <box flexDirection="row">
          <text fg={phaseHex()}>{phaseLabel(s.phase)}</text>
          <text fg={mc.text.muted}> · </text>
          <text fg={mc.text.secondary}>{s.backend}</text>
          <text fg={mc.text.muted}> · </text>
          <text fg={mc.text.secondary}>{s.turns} turns</text>
          {s.totalCostUsd > 0 ? (
            <>
              <text fg={mc.text.muted}> · </text>
              <text fg={mc.text.secondary}>${s.totalCostUsd.toFixed(3)}</text>
            </>
          ) : null}
        </box>
      </box>
    </box>
  )
}

function phaseColor(phase: string): string {
  return (mc.phase as Record<string, string>)[phase] ?? mc.phase.UNKNOWN
}

function displayName(projectName: string, channelId: string): string {
  if (projectName && projectName.length > 0) return projectName
  return `#${channelId}`
}

/**
 * Compact "time since" label for a session row. Buckets:
 *
 *   < 5s        → "just now"
 *   < 60s       → "Ns ago"
 *   < 60m       → "Nm ago"
 *   < 24h       → "Nh ago"
 *   else        → "Nd ago"
 *
 * Guards against negative values (clock drift / snapshot-from-future)
 * by clamping to 0, so a row never shows "-3s ago" after a bad resume.
 */
export function formatSince(now: number, ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—"
  const diff = Math.max(0, now - ts)
  const s = Math.floor(diff / 1000)
  if (s < 5) return "just now"
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
