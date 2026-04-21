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
 */

import { For, createMemo } from "solid-js"
import { TextAttributes } from "@opentui/core"
import {
  phaseLabel,
  sortSessionsByActivity,
  type MonitorStoreState,
} from "../context/store"
import type { MonitorStore } from "../context/store"
import { mc } from "../theme"

export interface SessionListProps {
  store: MonitorStore
  /** Width hint from the parent layout — used for row truncation. */
  width: number
}

export function SessionList(props: SessionListProps) {
  const sorted = createMemo(() => sortSessionsByActivity(props.store.state))
  const selected = createMemo(() => props.store.state.selectedSessionKey)

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
            return <SessionRow summary={s} selected={isSelected()} />
          }}
        </For>
      </box>
    </box>
  )
}

interface SessionRowProps {
  summary: MonitorStoreState["sessions"][string]
  selected: boolean
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
        {/* Line 1: project / channel — the human-meaningful row label. */}
        <text fg={mc.text.primary} attributes={TextAttributes.BOLD}>
          {displayName(s.projectName, s.channelId)}
        </text>
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
