/**
 * Event stream — centre pane.
 *
 * Renders the AgentEvent tail for the selected session, newest-last, in
 * a scrollbox with sticky-bottom scroll so live deltas auto-follow. One
 * row per event, formatted by `formatEvent` — the goal isn't
 * pixel-perfect replay of the Slack UI, it's "I can see what the agent
 * is doing right now" at a glance.
 *
 * Rendering note: we deliberately use `<scrollbox stickyScroll stickyStart="bottom">`
 * per AGENTS.md guidance so we don't have to manage scroll-to-end state
 * by hand. For large backlogs we cap the rendered count at 500 entries
 * (UI-side only; the store caps at 1000) — more than that is shown as a
 * "…N earlier events elided…" stub at the top.
 */

import { For, createMemo, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { AgentEvent } from "../../../protocol/types"
import type { MonitorStore } from "../context/store"
import { mc } from "../theme"

const MAX_RENDERED = 500

export interface EventStreamProps {
  store: MonitorStore
}

export function EventStream(props: EventStreamProps) {
  const events = createMemo(() => {
    const key = props.store.state.selectedSessionKey
    if (!key) return [] as AgentEvent[]
    return props.store.state.events[key] ?? []
  })
  const rendered = createMemo(() => events().slice(-MAX_RENDERED))
  const elided = createMemo(() => Math.max(0, events().length - rendered().length))

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      backgroundColor={mc.bg}
      padding={1}
    >
      <box flexDirection="row">
        <text fg={mc.text.primary} attributes={TextAttributes.BOLD}>
          Events
        </text>
        <text fg={mc.text.muted}> ({events().length})</text>
      </box>
      <Show
        when={props.store.state.selectedSessionKey}
        fallback={
          <text fg={mc.text.muted} attributes={TextAttributes.ITALIC}>
            Select a session on the left to see its events.
          </text>
        }
      >
        <scrollbox
          flexGrow={1}
          marginTop={1}
          stickyScroll={true}
          stickyStart="bottom"
        >
          <Show when={elided() > 0}>
            <text fg={mc.text.hint} attributes={TextAttributes.ITALIC}>
              … {elided()} earlier events elided …
            </text>
          </Show>
          <For each={rendered()}>{(ev) => <EventRow event={ev} />}</For>
        </scrollbox>
      </Show>
    </box>
  )
}

function EventRow(props: { event: AgentEvent }) {
  const parts = () => formatEvent(props.event)
  return (
    <box flexDirection="row">
      <text fg={mc.text.hint}>{parts().prefix}</text>
      <text fg={parts().color}> {parts().kind}</text>
      <text fg={mc.text.secondary}>: {parts().body}</text>
    </box>
  )
}

interface Formatted {
  prefix: string
  kind: string
  body: string
  color: string
}

/**
 * Compact one-line formatting for an AgentEvent. The monitor is a
 * skim-the-stream pane; we intentionally truncate hard and don't try to
 * re-render tool cards / thinking / mcp payloads — the full rendering
 * lives in the Slack UI, not here.
 *
 * We treat the event as `Record<string, unknown>` inside the formatter
 * on purpose: the AgentEvent union is broad (40+ variants) and each has
 * a subtly different shape. The monitor doesn't need to follow every
 * one; it's a read-only pane. Property-driven formatting with safe
 * fallbacks keeps the code small and means new event types render
 * reasonably out of the box (`type: body`) instead of throwing.
 */
export function formatEvent(ev: AgentEvent): Formatted {
  const raw = ev as unknown as Record<string, unknown>
  const kind = String(raw.type ?? "?")
  const pickStr = (key: string): string | undefined => {
    const v = raw[key]
    return typeof v === "string" ? v : undefined
  }
  const pickNum = (key: string): number | undefined => {
    const v = raw[key]
    return typeof v === "number" ? v : undefined
  }
  switch (kind) {
    case "session_init": {
      const sid = pickStr("sessionId") ?? ""
      const model =
        pickStr("model") ??
        (Array.isArray(raw.models) && typeof raw.models[0] === "string"
          ? (raw.models[0] as string)
          : "?")
      return {
        prefix: "◇",
        kind,
        body: `session ${sid} (${model})`,
        color: mc.text.secondary,
      }
    }
    case "turn_start":
      return {
        prefix: "▶",
        kind,
        body: `turn ${pickStr("turnId") ?? pickStr("id") ?? ""}`,
        color: mc.phase.RUNNING,
      }
    case "turn_complete": {
      const turnId = pickStr("turnId") ?? pickStr("id") ?? ""
      const cost = pickNum("costUsd")
      return {
        prefix: "■",
        kind,
        body: `turn ${turnId}${cost !== undefined ? ` · $${cost.toFixed(3)}` : ""}`,
        color: mc.phase.IDLE,
      }
    }
    case "text_delta":
      return {
        prefix: "·",
        kind: "text",
        body: truncate(pickStr("text") ?? "", 120),
        color: mc.text.primary,
      }
    case "text_complete":
      return {
        prefix: "★",
        kind: "text_complete",
        body: truncate(pickStr("text") ?? "", 160),
        color: mc.text.primary,
      }
    case "permission_request":
      return {
        prefix: "?",
        kind,
        body: `${pickStr("tool") ?? "?"} — ${pickStr("id") ?? ""}`,
        color: mc.phase.WAITING_FOR_PERM,
      }
    case "permission_response":
      return {
        prefix: "✓",
        kind,
        body: `${pickStr("id") ?? ""} → ${pickStr("decision") ?? "?"}`,
        color: mc.phase.IDLE,
      }
    case "error":
      return {
        prefix: "✕",
        kind,
        body: truncate(pickStr("message") ?? safeStringify(raw.error ?? raw), 160),
        color: mc.phase.ERROR,
      }
    default:
      return {
        prefix: "·",
        kind,
        body: truncate(safeStringify(ev), 120),
        color: mc.text.secondary,
      }
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
