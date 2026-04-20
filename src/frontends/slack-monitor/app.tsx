/**
 * Root component for `bantai slack monitor`.
 *
 * Composes the three panes (session list / event stream / metadata) over
 * a thin top-of-screen banner + status bar. Handles cross-cutting
 * keyboard shortcuts per AGENTS.md rule — `q`, `?`, and `R` sit at the
 * top of the root `useKeyboard` so they always win over pane-local
 * handlers. Navigation (`j` / `k` / ↑ / ↓) runs after that and only
 * mutates the selection when there's something to select.
 *
 * The selection effect fetches ring-buffer history on demand: whenever
 * `selectedSessionKey` changes and the event tail is empty, we kick off
 * GET `/admin/sessions/:key/events` through the admin context. That
 * keeps the initial snapshot small (no bulk events) but gives the user
 * a backlog the moment they pick a row.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Show,
} from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { TextAttributes, type KeyEvent } from "@opentui/core"
import type { AdminContext } from "./context/admin-context"
import { sortSessionsByActivity } from "./context/store"
import { SessionList } from "./panes/session-list"
import { EventStream } from "./panes/event-stream"
import { MetadataPane } from "./panes/metadata"
import type { SessionDetail } from "../slack/admin/protocol"
import { mc } from "./theme"
import { log } from "../../utils/logger"

export interface MonitorAppProps {
  ctx: AdminContext
  /** Server base URL — shown in the top banner. */
  baseUrl: string
  /** Optional exit hook (wired by the launcher). */
  onExit?: () => void
}

// The left / right pane widths are fixed so pane rows don't reflow as
// the terminal resizes; only the centre stream stretches. We cap the
// monitor to a minimum usable terminal width (80c) — narrower than that
// the layout is unreadable anyway.
const LEFT_WIDTH = 34
const RIGHT_WIDTH = 40

export function MonitorApp(props: MonitorAppProps) {
  const dims = useTerminalDimensions()

  // Selected-session detail is fetched lazily from REST when the user
  // picks a row. We keep it in a local signal so the metadata pane can
  // render without dragging the store through another detail branch.
  const [detail, setDetail] = createSignal<SessionDetail | null>(null)
  const [showHelp, setShowHelp] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)

  const sessions = createMemo(() => sortSessionsByActivity(props.ctx.store.state))
  const selectedKey = createMemo(() => props.ctx.store.state.selectedSessionKey)
  const selectedIndex = createMemo(() => {
    const key = selectedKey()
    if (!key) return -1
    return sessions().findIndex((s) => s.key === key)
  })

  // Lazily pull the ring buffer + detail when the selection changes.
  createEffect(
    on(selectedKey, (key) => {
      if (!key) {
        setDetail(null)
        return
      }
      const tail = props.ctx.store.state.events[key]
      if (!tail || tail.length === 0) {
        void props.ctx.fetchSessionEvents(key).catch(() => {
          // fetchSessionEvents already sets a banner on failure.
        })
      }
      // Fire-and-forget detail fetch — tolerate failure silently, the
      // pane renders fine without it.
      void props.ctx.rest
        .getSession(key)
        .then((d: SessionDetail) => {
          if (selectedKey() === key) setDetail(d)
        })
        .catch((err: unknown) => {
          log.debug(
            `slack-monitor: detail fetch for ${key} failed: ${String(err)}`,
          )
        })
    }),
  )

  onCleanup(() => {
    props.ctx.close()
  })

  useKeyboard((event: KeyEvent) => {
    // --- Cross-cutting shortcuts run FIRST (AGENTS.md: global keys win). ---
    if (event.ctrl && (event.name === "c" || event.name === "d")) {
      props.onExit?.()
      return
    }
    if (event.name === "q" && !event.ctrl && !event.meta) {
      props.onExit?.()
      return
    }
    if (event.name === "?" || (event.shift && event.name === "/")) {
      setShowHelp((v) => !v)
      return
    }
    if (event.name === "R" || (event.shift && event.name === "r")) {
      void refreshSnapshot()
      return
    }
    // --- Help overlay eats the rest when open, so nav keys don't fire. ---
    if (showHelp()) return

    // --- Navigation ---
    const list = sessions()
    if (list.length === 0) return
    const idx = selectedIndex()
    if (event.name === "j" || event.name === "down") {
      const next = idx < 0 ? 0 : Math.min(list.length - 1, idx + 1)
      const nextKey = list[next]?.key ?? null
      if (nextKey) props.ctx.store.selectSession(nextKey)
      return
    }
    if (event.name === "k" || event.name === "up") {
      const next = idx < 0 ? 0 : Math.max(0, idx - 1)
      const nextKey = list[next]?.key ?? null
      if (nextKey) props.ctx.store.selectSession(nextKey)
      return
    }
    if (event.name === "g") {
      const first = list[0]?.key ?? null
      if (first) props.ctx.store.selectSession(first)
      return
    }
    if (event.name === "G" || (event.shift && event.name === "g")) {
      const last = list[list.length - 1]?.key ?? null
      if (last) props.ctx.store.selectSession(last)
      return
    }
  })

  async function refreshSnapshot(): Promise<void> {
    if (refreshing()) return
    setRefreshing(true)
    try {
      const [sessions, approvals, config] = await Promise.all([
        props.ctx.rest.listSessions(),
        props.ctx.rest.listApprovals(),
        props.ctx.rest.getConfig().catch(() => null),
      ])
      props.ctx.store.applySnapshot({
        sessions: sessions.sessions,
        approvals: approvals.pending,
        config: config,
      })
    } catch (err) {
      props.ctx.store.setBanner({
        tone: "error",
        message: `refresh failed: ${String(err)}`,
      })
    } finally {
      setRefreshing(false)
    }
  }

  // Adaptive widths: on narrow terminals give the centre all the slack.
  const leftWidth = () => Math.min(LEFT_WIDTH, Math.floor(dims().width * 0.35))
  const rightWidth = () => Math.min(RIGHT_WIDTH, Math.floor(dims().width * 0.4))

  return (
    <box flexDirection="column" backgroundColor={mc.bg} width={dims().width} height={dims().height}>
      <TopBanner baseUrl={props.baseUrl} ctx={props.ctx} refreshing={refreshing()} />
      <BannerBar ctx={props.ctx} />
      <box flexDirection="row" flexGrow={1}>
        <SessionList store={props.ctx.store} width={leftWidth()} />
        <EventStream store={props.ctx.store} />
        <MetadataPane store={props.ctx.store} detail={detail()} width={rightWidth()} />
      </box>
      <StatusBar baseUrl={props.baseUrl} ctx={props.ctx} />
      <Show when={showHelp()}>
        <HelpOverlay onDismiss={() => setShowHelp(false)} />
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Top banner — server URL + connection state.
// ---------------------------------------------------------------------------

function TopBanner(props: {
  baseUrl: string
  ctx: AdminContext
  refreshing: boolean
}) {
  const mode = () => props.ctx.store.state.config?.mode ?? "?"
  const protocol = () => props.ctx.store.state.protocol || "?"
  const version = () => props.ctx.store.state.serverVersion || "?"
  return (
    <box
      flexDirection="row"
      backgroundColor={mc.panelBg}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <text fg={mc.text.primary} attributes={TextAttributes.BOLD}>
        bantai slack monitor
      </text>
      <text fg={mc.text.muted}> · {props.baseUrl}</text>
      <text fg={mc.text.muted}> · mode=</text>
      <text fg={mc.text.secondary}>{mode()}</text>
      <text fg={mc.text.muted}> · v</text>
      <text fg={mc.text.secondary}>{version()}</text>
      <text fg={mc.text.muted}> · proto=</text>
      <text fg={mc.text.secondary}>{protocol()}</text>
      <Show when={props.refreshing}>
        <text fg={mc.banner.info.fg}> · refreshing…</text>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Transient banner — connection / error messages surfaced by the context.
// ---------------------------------------------------------------------------

function BannerBar(props: { ctx: AdminContext }) {
  const banner = () => props.ctx.store.state.banner
  return (
    <Show when={banner()}>
      <box
        flexDirection="row"
        backgroundColor={toneBg(banner()?.tone ?? "info")}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
      >
        <text fg={toneFg(banner()?.tone ?? "info")}>{banner()?.message ?? ""}</text>
      </box>
    </Show>
  )
}

function toneBg(tone: "info" | "warn" | "error"): string {
  return mc.banner[tone].bg
}
function toneFg(tone: "info" | "warn" | "error"): string {
  return mc.banner[tone].fg
}

// ---------------------------------------------------------------------------
// Bottom status bar — keybind hints + a compact connection state pill.
// ---------------------------------------------------------------------------

function StatusBar(props: { baseUrl: string; ctx: AdminContext }) {
  const wsState = () => props.ctx.state()
  return (
    <box
      flexDirection="row"
      backgroundColor={mc.panelBg}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <text fg={mc.text.muted}>↑/↓ nav  </text>
      <text fg={mc.text.muted}>R refresh  </text>
      <text fg={mc.text.muted}>? help  </text>
      <text fg={mc.text.muted}>q quit</text>
      <box flexGrow={1} />
      <text fg={stateColor(wsState())}>{stateLabel(wsState())}</text>
    </box>
  )
}

function stateLabel(s: ReturnType<AdminContext["state"]>): string {
  switch (s) {
    case "open":
      return "● connected"
    case "connecting":
      return "◌ connecting"
    case "reconnecting":
      return "◌ reconnecting"
    case "error":
      return "✕ error"
    case "closed":
      return "○ closed"
  }
}

function stateColor(s: ReturnType<AdminContext["state"]>): string {
  switch (s) {
    case "open":
      return mc.phase.IDLE
    case "connecting":
    case "reconnecting":
      return mc.phase.INITIALIZING
    case "error":
      return mc.phase.ERROR
    case "closed":
      return mc.text.muted
  }
}

// ---------------------------------------------------------------------------
// Help overlay — tiny centred panel. v1: static text, no scroll / sections.
// ---------------------------------------------------------------------------

function HelpOverlay(_props: { onDismiss: () => void }) {
  // `onDismiss` is wired by the root — `?` toggles the overlay. We don't
  // render a click target here because OpenTUI `<text>` has no onClick
  // prop (all input is keyboard). Kept in props for symmetry / future
  // close button.
  return (
    <box
      position="absolute"
      top={3}
      left={6}
      backgroundColor={mc.panelBg}
      padding={1}
      flexDirection="column"
    >
      <text fg={mc.text.primary} attributes={TextAttributes.BOLD}>
        Keyboard shortcuts
      </text>
      <text fg={mc.text.secondary}>j / ↓          next session</text>
      <text fg={mc.text.secondary}>k / ↑          previous session</text>
      <text fg={mc.text.secondary}>g              first session</text>
      <text fg={mc.text.secondary}>G              last session</text>
      <text fg={mc.text.secondary}>R              refresh snapshot</text>
      <text fg={mc.text.secondary}>?              toggle this help</text>
      <text fg={mc.text.secondary}>q / Ctrl-C     quit</text>
      <text fg={mc.text.muted} attributes={TextAttributes.ITALIC} marginTop={1}>
        Press ? to dismiss.
      </text>
    </box>
  )
}
