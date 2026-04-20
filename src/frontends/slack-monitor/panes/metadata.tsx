/**
 * Session metadata — right pane.
 *
 * Shows the selected session's key + channel + thread + backend + model
 * + cwd + phase + turns + cost, plus a handful of banner flags that are
 * useful at a glance (`resumed`, `read-only`, and the server's
 * protocol / version strings from the `hello` frame).
 *
 * Detail fields beyond the summary (cwd, model, permissionMode, openedAt)
 * come from GET `/admin/sessions/:key`. We call that lazily from the app
 * shell when the selection changes — this pane just renders whatever
 * ends up in `store.state.sessions[selectedKey]` + an optional detail
 * record passed in from the shell.
 *
 * Implementation note: we deliberately avoid the `<Show>` render-prop
 * form (`{(s) => …}`) here. SolidJS types the render-prop parameter as
 * `Accessor<NonNullable<T>>`, and TypeScript's inference doesn't carry
 * the generic through OpenTUI's JSX runtime in practice — every use
 * tripped `TS7006: implicit any`. Using local `createMemo`s + an `&&`
 * guard is equivalent, keeps reactivity, and types cleanly.
 */

import { createMemo, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { phaseLabel, type MonitorStore } from "../context/store"
import type { SessionDetail } from "../../slack/admin/protocol"
import { mc } from "../theme"

export interface MetadataPaneProps {
  store: MonitorStore
  /** Optional enriched detail (from GET /admin/sessions/:key). */
  detail: SessionDetail | null
  /** Width hint from parent. */
  width: number
}

export function MetadataPane(props: MetadataPaneProps) {
  const summary = createMemo(() => {
    const key = props.store.state.selectedSessionKey
    if (!key) return null
    return props.store.state.sessions[key] ?? null
  })
  const config = createMemo(() => props.store.state.config)

  return (
    <box
      flexDirection="column"
      width={props.width}
      flexShrink={0}
      backgroundColor={mc.panelBg}
      padding={1}
    >
      <text fg={mc.text.primary} attributes={TextAttributes.BOLD}>
        Session
      </text>
      <Show
        when={summary() !== null}
        fallback={
          <text fg={mc.text.muted} attributes={TextAttributes.ITALIC} marginTop={1}>
            —
          </text>
        }
      >
        <box flexDirection="column" marginTop={1}>
          <KV label="project" value={summary()?.projectName || "(unknown)"} />
          <KV label="channel" value={`#${summary()?.channelId ?? ""}`} />
          <KV label="thread" value={summary()?.threadTs ?? ""} />
          <KV label="backend" value={summary()?.backend ?? ""} />
          <KV
            label="phase"
            value={phaseLabel(summary()?.phase ?? "UNKNOWN")}
            valueFg={
              (mc.phase as Record<string, string>)[
                summary()?.phase ?? "UNKNOWN"
              ] ?? mc.phase.UNKNOWN
            }
          />
          <KV label="turns" value={String(summary()?.turns ?? 0)} />
          <KV
            label="cost"
            value={`$${(summary()?.totalCostUsd ?? 0).toFixed(4)}`}
          />
          <Show when={props.detail?.model}>
            <KV label="model" value={props.detail?.model ?? ""} />
          </Show>
          <Show when={props.detail?.cwd}>
            <KV
              label="cwd"
              value={truncateMiddle(props.detail?.cwd ?? "", props.width - 10)}
            />
          </Show>
          <Show when={props.detail?.permissionMode}>
            <KV label="perm mode" value={props.detail?.permissionMode ?? ""} />
          </Show>
          <Show when={summary()?.resumed}>
            <KV label="resumed" value="yes" valueFg={mc.phase.IDLE} />
          </Show>
        </box>
      </Show>
      <Show when={config() !== null}>
        <box flexDirection="column" marginTop={2}>
          <text fg={mc.text.primary} attributes={TextAttributes.BOLD}>
            Server
          </text>
          <KV label="protocol" value={props.store.state.protocol || "?"} />
          <KV label="version" value={props.store.state.serverVersion || "?"} />
          <KV label="mode" value={config()?.mode ?? ""} />
          <KV
            label="read-only"
            value={config()?.admin.readOnly ? "yes" : "no"}
            valueFg={
              config()?.admin.readOnly
                ? mc.phase.WAITING_FOR_PERM
                : mc.phase.IDLE
            }
          />
          <KV
            label="ring size"
            value={String(config()?.admin.sessionRingSize ?? 0)}
          />
        </box>
      </Show>
    </box>
  )
}

function KV(props: { label: string; value: string; valueFg?: string }) {
  return (
    <box flexDirection="row">
      <text fg={mc.text.muted}>{padRight(props.label, 11)}</text>
      <text fg={props.valueFg ?? mc.text.primary}>{props.value}</text>
    </box>
  )
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s + " " : s + " ".repeat(n - s.length)
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max || max < 6) return s
  const keep = Math.floor((max - 1) / 2)
  return s.slice(0, keep) + "…" + s.slice(-keep)
}
