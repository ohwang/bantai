/**
 * Approvals — right-column section below the session metadata pane.
 *
 * Lists pending permission requests across *every* live session — not
 * just the selected one — because the monitor's job is "see what needs
 * the operator's attention right now" independent of whatever session
 * happens to be focused on the left.
 *
 * Keyboard semantics live in the root app shell (`app.tsx`) so that
 * approvals shortcuts are centralised with the rest of the cross-cutting
 * keys. This pane just exposes the pending list + an internal cursor
 * for which approval is currently highlighted; the shell mutates the
 * cursor through the `selectedId` prop and the action keys fire against
 * that same id.
 */

import { For, Show, createMemo } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { MonitorStore } from "../context/store"
import type { PendingApproval } from "../../slack/admin/protocol"
import { mc } from "../theme"

export interface ApprovalsPaneProps {
  store: MonitorStore
  /** Which approval is currently highlighted. */
  selectedId: string | null
  /** True when admin is in read-only mode — disable action hints. */
  readOnly: boolean
  /** Transient feedback text (e.g. "approved p1" / "deny failed: …"). */
  feedback: { tone: "info" | "warn" | "error"; message: string } | null
}

export function ApprovalsPane(props: ApprovalsPaneProps) {
  const pending = createMemo(() => {
    const s = props.store.state
    return s.approvalOrder
      .map((id) => s.approvals[id])
      .filter((a): a is PendingApproval => a !== undefined)
  })

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={mc.panelBg}
      padding={1}
      marginTop={1}
    >
      <box flexDirection="row">
        <text fg={mc.text.primary} attributes={TextAttributes.BOLD}>
          Pending approvals
        </text>
        <text fg={mc.text.muted}> ({pending().length})</text>
      </box>
      <Show
        when={pending().length > 0}
        fallback={
          <text fg={mc.text.muted} attributes={TextAttributes.ITALIC} marginTop={1}>
            No pending approvals.
          </text>
        }
      >
        <box flexDirection="column" marginTop={1}>
          <For each={pending()}>
            {(a) => (
              <ApprovalRow approval={a} selected={a.id === props.selectedId} />
            )}
          </For>
          <Show when={!props.readOnly}>
            <text fg={mc.text.muted} attributes={TextAttributes.ITALIC} marginTop={1}>
              [a] approve  [A] allow always  [d] deny  [ ] [ ] cycle
            </text>
          </Show>
          <Show when={props.readOnly}>
            <text fg={mc.banner.warn.fg} attributes={TextAttributes.ITALIC} marginTop={1}>
              read-only mode — approval keys disabled
            </text>
          </Show>
        </box>
      </Show>
      <Show when={props.feedback}>
        <text
          fg={toneFg(props.feedback?.tone ?? "info")}
          attributes={TextAttributes.ITALIC}
          marginTop={1}
        >
          {props.feedback?.message ?? ""}
        </text>
      </Show>
    </box>
  )
}

function ApprovalRow(props: { approval: PendingApproval; selected: boolean }) {
  const a = props.approval
  return (
    <box
      flexDirection="column"
      backgroundColor={props.selected ? mc.selection.rowBg : mc.panelBg}
      paddingLeft={props.selected ? 0 : 1}
    >
      <box flexDirection="row">
        {props.selected ? (
          <text fg={mc.selection.accent} attributes={TextAttributes.BOLD}>
            ▎
          </text>
        ) : null}
        <text fg={mc.phase.WAITING_FOR_PERM} attributes={TextAttributes.BOLD}>
          {a.tool}
        </text>
        <text fg={mc.text.muted}> · </text>
        <text fg={mc.text.secondary}>{a.id}</text>
      </box>
      <text fg={mc.text.secondary}>{summariseInput(a)}</text>
      <text fg={mc.text.muted}>
        #{a.channelId} · {a.threadTs}
      </text>
    </box>
  )
}

/**
 * Tight one-line summary of the tool input. We intentionally don't try
 * to pretty-print every tool shape — the full rendering lives in the
 * Slack UI. Enough to tell two Bash calls apart at a glance.
 */
function summariseInput(a: PendingApproval): string {
  if (a.title) return truncate(a.title, 80)
  if (a.displayName) return truncate(a.displayName, 80)
  const input = a.input
  if (typeof input === "string") return truncate(input, 80)
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>
    // Common tool-input conventions — pick whatever's representative.
    const cmd = obj.command ?? obj.cmd ?? obj.query ?? obj.text
    if (typeof cmd === "string") return truncate(cmd, 80)
    try {
      return truncate(JSON.stringify(obj), 80)
    } catch {
      return "(unprintable)"
    }
  }
  return ""
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}

function toneFg(tone: "info" | "warn" | "error"): string {
  return mc.banner[tone].fg
}
