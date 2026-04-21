/**
 * Root component for `bantai slack monitor`.
 *
 * Composes two columns — the session list on the left, a tabbed
 * events/details pane plus a persistent approvals pane on the right —
 * over a thin top-of-screen banner + status bar. Handles cross-cutting
 * keyboard shortcuts per AGENTS.md rule — `q`, `?`, `R`, and Tab sit at
 * the top of the root `useKeyboard` so they always win over pane-local
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
import { sortSessionsByActivity, type MonitorStore } from "./context/store"
import { SessionList } from "./panes/session-list"
import { EventStream } from "./panes/event-stream"
import { MetadataPane } from "./panes/metadata"
import { ApprovalsPane } from "./panes/approvals"
import type { SessionDetail } from "../slack/admin/protocol"
import { mc } from "./theme"
import { log } from "../../utils/logger"
import { openSlackThread } from "./utils/open-in-slack"

type Feedback = { tone: "info" | "warn" | "error"; message: string } | null

export interface MonitorAppProps {
  ctx: AdminContext
  /** Server base URL — shown in the top banner. */
  baseUrl: string
  /** Optional exit hook (wired by the launcher). */
  onExit?: () => void
}

// The left pane width is fixed so session-list rows don't reflow as
// the terminal resizes; the right column (tabbed events/details +
// persistent approvals) stretches to fill. We cap the monitor to a
// minimum usable terminal width (80c) — narrower than that the layout
// is unreadable anyway.
const LEFT_WIDTH = 34

/** Which tab the right-hand pane is currently showing. */
type RightTab = "events" | "details"
const TAB_ORDER: ReadonlyArray<RightTab> = ["events", "details"]

export function MonitorApp(props: MonitorAppProps) {
  const dims = useTerminalDimensions()

  // Selected-session detail is fetched lazily from REST when the user
  // picks a row. We keep it in a local signal so the metadata pane can
  // render without dragging the store through another detail branch.
  const [detail, setDetail] = createSignal<SessionDetail | null>(null)
  const [showHelp, setShowHelp] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)
  // Which pending approval is highlighted — the action keys fire
  // against this id. Auto-tracks the approvalOrder so the cursor stays
  // on something valid without the user having to re-pick every time
  // an approval resolves.
  const [selectedApprovalId, setSelectedApprovalId] =
    createSignal<string | null>(null)
  const [approvalFeedback, setApprovalFeedback] = createSignal<Feedback>(null)
  let approvalFeedbackTimer: ReturnType<typeof setTimeout> | undefined

  // Which tab the right-hand pane is showing. Tab / Shift-Tab cycles;
  // clicking a tab header (handled in `RightPane`) jumps directly. The
  // events tab is the default because that's the monitor's core job.
  const [activeTab, setActiveTab] = createSignal<RightTab>("events")
  function cycleTab(delta: 1 | -1): void {
    const cur = activeTab()
    const idx = TAB_ORDER.indexOf(cur)
    const next =
      TAB_ORDER[(idx + delta + TAB_ORDER.length) % TAB_ORDER.length] ?? cur
    setActiveTab(next)
  }

  const sessions = createMemo(() => sortSessionsByActivity(props.ctx.store.state))
  const selectedKey = createMemo(() => props.ctx.store.state.selectedSessionKey)
  const selectedIndex = createMemo(() => {
    const key = selectedKey()
    if (!key) return -1
    return sessions().findIndex((s) => s.key === key)
  })
  const approvalOrder = createMemo(() => props.ctx.store.state.approvalOrder)
  const readOnly = createMemo(
    () => props.ctx.store.state.config?.admin.readOnly ?? false,
  )

  // Keep the approval cursor on a valid id whenever the list changes.
  createEffect(
    on(approvalOrder, (order) => {
      const current = selectedApprovalId()
      if (!current || !order.includes(current)) {
        setSelectedApprovalId(order[0] ?? null)
      }
    }),
  )

  function flashFeedback(tone: "info" | "warn" | "error", message: string) {
    setApprovalFeedback({ tone, message })
    if (approvalFeedbackTimer) clearTimeout(approvalFeedbackTimer)
    approvalFeedbackTimer = setTimeout(() => setApprovalFeedback(null), 3_000)
  }

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
    if (event.name === "tab") {
      cycleTab(event.shift ? -1 : 1)
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

    // --- Approvals + interrupt -----------------------------------------
    // Action-on-selection keys per AGENTS.md — they only fire when the
    // target the action operates on exists. Read-only mode short-circuits
    // write actions with a warning banner.
    if (event.name === "[") {
      cycleApproval(-1)
      return
    }
    if (event.name === "]") {
      cycleApproval(1)
      return
    }
    if (event.name === "a" && !event.shift && !event.ctrl) {
      void handleApprove(false)
      return
    }
    if (event.name === "A" || (event.shift && event.name === "a")) {
      void handleApprove(true)
      return
    }
    if (event.name === "d" && !event.shift && !event.ctrl) {
      void handleDeny()
      return
    }
    if (event.name === "i" && !event.shift && !event.ctrl) {
      void handleInterrupt()
      return
    }
    if (event.name === "o" && !event.shift && !event.ctrl) {
      void handleOpenInSlack()
      return
    }
  })

  function cycleApproval(delta: 1 | -1): void {
    const order = approvalOrder()
    if (order.length === 0) return
    const current = selectedApprovalId()
    const idx = current ? order.indexOf(current) : -1
    if (idx < 0) {
      setSelectedApprovalId(order[0] ?? null)
      return
    }
    const next = (idx + delta + order.length) % order.length
    setSelectedApprovalId(order[next] ?? null)
  }

  async function handleApprove(alwaysAllow: boolean): Promise<void> {
    const id = selectedApprovalId()
    if (!id) return
    if (readOnly()) {
      flashFeedback("warn", "approve blocked: admin is in read-only mode")
      return
    }
    try {
      await props.ctx.approve(id, alwaysAllow)
      flashFeedback(
        "info",
        alwaysAllow ? `approved ${id} (always allow)` : `approved ${id}`,
      )
    } catch (err) {
      flashFeedback("error", `approve ${id} failed: ${String(err)}`)
    }
  }

  async function handleDeny(): Promise<void> {
    const id = selectedApprovalId()
    if (!id) return
    if (readOnly()) {
      flashFeedback("warn", "deny blocked: admin is in read-only mode")
      return
    }
    try {
      await props.ctx.deny(id)
      flashFeedback("info", `denied ${id}`)
    } catch (err) {
      flashFeedback("error", `deny ${id} failed: ${String(err)}`)
    }
  }

  async function handleInterrupt(): Promise<void> {
    const key = selectedKey()
    if (!key) return
    if (readOnly()) {
      flashFeedback("warn", "interrupt blocked: admin is in read-only mode")
      return
    }
    try {
      await props.ctx.interrupt(key)
      flashFeedback("info", `interrupt sent to ${key}`)
    } catch (err) {
      flashFeedback("error", `interrupt ${key} failed: ${String(err)}`)
    }
  }

  // Client-side only — opens the native Slack app at the thread via the
  // `slack://` deep link. NOT gated by readOnly: it doesn't touch server
  // state, it just hands a URL to the OS opener. Silently a no-op if no
  // session is selected so stray `o` presses don't flash noisy banners.
  async function handleOpenInSlack(): Promise<void> {
    const key = selectedKey()
    if (!key) return
    const result = await openSlackThread(key)
    if (result.ok) {
      flashFeedback("info", `opened ${key} in Slack`)
      return
    }
    if (result.reason === "invalid-key") {
      flashFeedback("warn", `cannot open ${key} in Slack: unrecognised key shape`)
      return
    }
    log.warn(
      `slack-monitor: open-in-slack launch failed for ${key}: ${String(result.error)}`,
    )
    flashFeedback("error", `open in Slack failed: ${String(result.error)}`)
  }

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

  // Adaptive left-column width: on narrow terminals cede as much as
  // possible to the right pane, which now carries both the event stream
  // and the details tab.
  const leftWidth = () => Math.min(LEFT_WIDTH, Math.floor(dims().width * 0.35))

  return (
    <box flexDirection="column" backgroundColor={mc.bg} width={dims().width} height={dims().height}>
      <TopBanner baseUrl={props.baseUrl} ctx={props.ctx} refreshing={refreshing()} />
      <BannerBar ctx={props.ctx} />
      <box flexDirection="row" flexGrow={1}>
        <SessionList store={props.ctx.store} width={leftWidth()} />
        <RightPane
          store={props.ctx.store}
          detail={detail()}
          activeTab={activeTab()}
          onSelectTab={setActiveTab}
          selectedApprovalId={selectedApprovalId()}
          readOnly={readOnly()}
          approvalFeedback={approvalFeedback()}
        />
      </box>
      <StatusBar baseUrl={props.baseUrl} ctx={props.ctx} />
      <Show when={showHelp()}>
        <HelpOverlay onDismiss={() => setShowHelp(false)} />
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Right-hand pane — tabbed events / details + persistent approvals.
// ---------------------------------------------------------------------------

interface RightPaneProps {
  store: MonitorStore
  detail: SessionDetail | null
  activeTab: RightTab
  onSelectTab: (tab: RightTab) => void
  selectedApprovalId: string | null
  readOnly: boolean
  approvalFeedback: Feedback
}

function RightPane(props: RightPaneProps) {
  return (
    <box flexDirection="column" flexGrow={1}>
      <TabBar active={props.activeTab} onSelect={props.onSelectTab} />
      {/*
        Keep BOTH panes mounted and hide the inactive one via `visible` so
        the EventStream scrollbox keeps its scroll state across tab
        switches. The alternative — a `<Show>` that unmounts the tail —
        re-ran the sticky-bottom sync every time the user flipped back to
        the stream, which was janky when live deltas were flowing in.
      */}
      <box
        flexDirection="column"
        flexGrow={1}
        visible={props.activeTab === "events"}
      >
        <EventStream store={props.store} />
      </box>
      <box
        flexDirection="column"
        flexGrow={1}
        visible={props.activeTab === "details"}
      >
        <MetadataPane store={props.store} detail={props.detail} />
      </box>
      <ApprovalsPane
        store={props.store}
        selectedId={props.selectedApprovalId}
        readOnly={props.readOnly}
        feedback={props.approvalFeedback}
      />
    </box>
  )
}

interface TabBarProps {
  active: RightTab
  onSelect: (tab: RightTab) => void
}

function TabBar(props: TabBarProps) {
  return (
    <box
      flexDirection="row"
      backgroundColor={mc.panelBg}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <TabHeader
        label="Events"
        active={props.active === "events"}
        onClick={() => props.onSelect("events")}
      />
      <text fg={mc.text.muted}>  </text>
      <TabHeader
        label="Session details"
        active={props.active === "details"}
        onClick={() => props.onSelect("details")}
      />
      <box flexGrow={1} />
      <text fg={mc.text.muted} attributes={TextAttributes.ITALIC}>
        Tab ↹ switch
      </text>
    </box>
  )
}

function TabHeader(props: {
  label: string
  active: boolean
  onClick: () => void
}) {
  // Clickable header. The whole box is the hit-target — OpenTUI routes
  // the mouse event through the outer box, so putting `onMouseDown` on
  // the header box (not the text) means padding is clickable too.
  return (
    <box
      flexDirection="row"
      backgroundColor={props.active ? mc.selection.rowBg : mc.panelBg}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={() => props.onClick()}
    >
      <text
        fg={props.active ? mc.text.primary : mc.text.secondary}
        attributes={props.active ? TextAttributes.BOLD : undefined}
      >
        {props.label}
      </text>
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
      <text fg={mc.text.muted}>Tab switch pane  </text>
      <text fg={mc.text.muted}>a/d approve/deny  </text>
      <text fg={mc.text.muted}>i interrupt  </text>
      <text fg={mc.text.muted}>o open in Slack  </text>
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
      <text fg={mc.text.secondary}>Tab / S-Tab    switch events ↔ session details</text>
      <text fg={mc.text.secondary}>[ / ]          cycle approvals</text>
      <text fg={mc.text.secondary}>a              approve selected</text>
      <text fg={mc.text.secondary}>A              approve + allow always</text>
      <text fg={mc.text.secondary}>d              deny selected</text>
      <text fg={mc.text.secondary}>i              interrupt selected session</text>
      <text fg={mc.text.secondary}>o              open thread in Slack app</text>
      <text fg={mc.text.secondary}>R              refresh snapshot</text>
      <text fg={mc.text.secondary}>?              toggle this help</text>
      <text fg={mc.text.secondary}>q / Ctrl-C     quit</text>
      <text fg={mc.text.muted} attributes={TextAttributes.ITALIC} marginTop={1}>
        Press ? to dismiss.
      </text>
    </box>
  )
}
