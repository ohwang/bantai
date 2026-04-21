/**
 * Session metadata — right pane (details tab).
 *
 * Shows the selected session's key + channel + thread + backend + model
 * + cwd + phase + turns + cost, a context-window utilisation bar, a
 * token-usage breakdown (input / output / cache read / cache write), and
 * a handful of banner flags that are useful at a glance (`resumed`,
 * `read-only`, and the server's protocol / version strings from the
 * `hello` frame).
 *
 * Detail fields beyond the summary (cwd, permissionMode, openedAt) come
 * from GET `/admin/sessions/:key`. We call that lazily from the app
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
import type { SessionDetail, SessionSummary } from "../../slack/admin/protocol"
import { mc } from "../theme"

export interface MetadataPaneProps {
  store: MonitorStore
  /** Optional enriched detail (from GET /admin/sessions/:key). */
  detail: SessionDetail | null
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
      flexGrow={1}
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
          <Show when={summary()?.model || props.detail?.model}>
            <KV
              label="model"
              value={summary()?.model ?? props.detail?.model ?? ""}
            />
          </Show>
          <Show when={props.detail?.cwd}>
            <KV
              label="cwd"
              value={truncateMiddle(props.detail?.cwd ?? "", 48)}
            />
          </Show>
          <Show when={props.detail?.permissionMode}>
            <KV label="perm mode" value={props.detail?.permissionMode ?? ""} />
          </Show>
          <Show when={summary()?.resumed}>
            <KV label="resumed" value="yes" valueFg={mc.phase.IDLE} />
          </Show>
        </box>

        {/*
          Context window — only render when the backend provided a window
          size (claude reports one via session_init, other backends may
          not). `contextTokens` is the last-seen prompt-fill snapshot from
          cost_update; it lags a tick behind turn_complete but is the
          closest thing we have to "how full is the context right now".
        */}
        <Show when={hasContextWindow(summary())}>
          <ContextWindowSection summary={summary() as SessionSummary} />
        </Show>

        {/*
          Token usage — cumulative across turns. Always rendered once we
          have a summary; zeros show for brand-new sessions. Cost is shown
          alongside the breakdown so the numbers roll up visibly to the
          $-total above.
        */}
        <Show when={summary() !== null}>
          <TokenUsageSection summary={summary() as SessionSummary} />
        </Show>
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

// ---------------------------------------------------------------------------
// Context window + token usage sections.
// ---------------------------------------------------------------------------

function hasContextWindow(s: SessionSummary | null): boolean {
  return s !== null && typeof s.contextWindow === "number" && s.contextWindow > 0
}

/**
 * Context-window utilisation — a text-only progress bar + the raw
 * tokens-used / window size. The bar is 24 cells wide; the filled count
 * rounds to the nearest cell so a 0-token session shows empty and a
 * maxed-out session shows full.
 */
function ContextWindowSection(props: { summary: SessionSummary }) {
  const window = () => props.summary.contextWindow ?? 0
  const used = () => props.summary.contextTokens ?? 0
  const ratio = () => {
    const w = window()
    if (w <= 0) return 0
    return Math.min(1, Math.max(0, used() / w))
  }
  const pct = () => Math.round(ratio() * 100)
  const barFg = () => {
    // Warn past 75%, error past 90% — matches the ramp you get used to
    // staring at when you're about to blow the window.
    if (ratio() >= 0.9) return mc.phase.ERROR
    if (ratio() >= 0.75) return mc.phase.WAITING_FOR_PERM
    return mc.phase.IDLE
  }
  return (
    <box flexDirection="column" marginTop={2}>
      <text fg={mc.text.primary} attributes={TextAttributes.BOLD}>
        Context window
      </text>
      <box flexDirection="row" marginTop={1}>
        <text fg={barFg()}>{buildBar(ratio(), 24)}</text>
        <text fg={mc.text.muted}>  </text>
        <text fg={mc.text.primary}>{pct()}%</text>
      </box>
      <box flexDirection="row" marginTop={0}>
        <text fg={mc.text.muted}>{padRight("used", 11)}</text>
        <text fg={mc.text.primary}>{formatTokens(used())}</text>
        <text fg={mc.text.muted}> / </text>
        <text fg={mc.text.secondary}>{formatTokens(window())}</text>
      </box>
    </box>
  )
}

/**
 * Cumulative token breakdown across every turn on the session. The four
 * components + cost come straight off the summary's `usage` roll-up that
 * the registry builds from `turn_complete.usage` events, so the numbers
 * here tie back to the `cost` KV above (same source, same counter) and
 * to whatever cost Slack shows for the same thread.
 */
function TokenUsageSection(props: { summary: SessionSummary }) {
  const u = () => props.summary.usage
  const total = () => {
    const x = u()
    return x.inputTokens + x.outputTokens + x.cacheReadTokens + x.cacheWriteTokens
  }
  return (
    <box flexDirection="column" marginTop={2}>
      <text fg={mc.text.primary} attributes={TextAttributes.BOLD}>
        Token usage (cumulative)
      </text>
      <box flexDirection="column" marginTop={1}>
        <KV label="input" value={formatTokens(u().inputTokens)} />
        <KV label="output" value={formatTokens(u().outputTokens)} />
        <KV label="cache read" value={formatTokens(u().cacheReadTokens)} />
        <KV label="cache write" value={formatTokens(u().cacheWriteTokens)} />
        <KV label="total" value={formatTokens(total())} />
        <KV
          label="cost"
          value={`$${(u().totalCostUsd ?? 0).toFixed(4)}`}
        />
      </box>
    </box>
  )
}

/**
 * Text-only progress bar — 24 cells by default. Uses the solid block
 * glyph for filled cells and a light shade for empty, so the bar reads
 * at a glance even on monochrome terminals.
 */
function buildBar(ratio: number, width: number): string {
  const filled = Math.round(ratio * width)
  const empty = Math.max(0, width - filled)
  return "█".repeat(filled) + "░".repeat(empty)
}

/**
 * Compact token count for the dense metadata pane: straight integers up
 * to 9_999, then K/M with one decimal. Picked for readability at a
 * glance, not for precision — the raw numbers are on the wire if a
 * caller needs them.
 */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—"
  if (n < 10_000) return n.toLocaleString("en-US")
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}
