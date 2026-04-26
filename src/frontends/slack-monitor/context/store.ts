/**
 * Monitor-side state store — the single source of truth the UI reads from.
 *
 * Driven by:
 *   - Initial REST snapshot (`/admin/sessions`, `/admin/approvals`,
 *     `/admin/sessions/:key/events`).
 *   - Live AdminFrames from the WebSocket transport.
 *
 * Architecture:
 *   - SolidJS createStore for fine-grained reactivity. `sessions` is a
 *     keyed record; `approvals` is keyed by id; `events` is keyed by
 *     session key.
 *   - A pure `applyFrame(draft, frame)` reducer that mutates a draft
 *     view of the store. Kept separate from the reactive store so the
 *     tests can verify frame-by-frame behaviour without spinning up
 *     SolidJS.
 *   - `createMonitorStore()` wires the reducer into a `setStore` call
 *     via `produce`, so the UI sees one atomic update per frame.
 *
 * The reducer NEVER silently drops a frame — unrecognised frame types
 * log.warn (invariant: if a new frame type lands on the wire we notice
 * at runtime instead of showing stale state).
 */

import { createStore, produce } from "solid-js/store"
import type { AgentEvent } from "../../../protocol/types"
import { STATE_LABELS, isKnownSessionState } from "../../../protocol/session-state"
import type {
  AdminFrame,
  AdminConfigSnapshot,
  PendingApproval,
  SessionPhase,
  SessionSummary,
} from "../../slack/admin/protocol"
import { log } from "../../../utils/logger"

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface MonitorStoreState {
  /** True after the initial REST snapshot has been applied. */
  loaded: boolean
  /** Server protocol version (from `hello`). Empty until the socket opens. */
  protocol: string
  /** Server package version (from `hello`). Empty until the socket opens. */
  serverVersion: string
  /**
   * Transient banner shown at the top of the UI — set on error frames,
   * auth failures, and reconnect transitions. `null` = no banner.
   */
  banner: { tone: "info" | "warn" | "error"; message: string } | null
  /** Sessions keyed by their full slack:... key. Render-order is `sessionOrder`. */
  sessions: Record<string, SessionSummary>
  /** Stable insertion order — updated on session_opened / session_closed. */
  sessionOrder: string[]
  /**
   * Per-session event backlog + live tail. Bounded at `maxEventsPerSession`
   * (FIFO eviction). Empty until the ring buffer is fetched via REST or
   * the first `session_event` arrives.
   */
  events: Record<string, AgentEvent[]>
  /** Pending approvals keyed by id. `approvalOrder` holds the render order. */
  approvals: Record<string, PendingApproval>
  approvalOrder: string[]
  /** Scrubbed config snapshot — null until /admin/config returns. */
  config: AdminConfigSnapshot | null
  /**
   * Currently-selected session key in the UI. null = no session selected
   * (the right-hand panes show a placeholder). Auto-advances to the newest
   * session when the selection is closed.
   */
  selectedSessionKey: string | null
}

export interface MonitorStore {
  state: MonitorStoreState
  applyFrame(frame: AdminFrame): void
  applySnapshot(snapshot: {
    sessions: SessionSummary[]
    approvals: PendingApproval[]
    config?: AdminConfigSnapshot | null
  }): void
  setSessionEvents(key: string, events: AgentEvent[]): void
  setBanner(banner: MonitorStoreState["banner"]): void
  selectSession(key: string | null): void
  setConfig(config: AdminConfigSnapshot | null): void
}

export interface CreateStoreOpts {
  /** Cap the per-session event tail. Default 1000 — tests pass smaller. */
  maxEventsPerSession?: number
}

// ---------------------------------------------------------------------------
// Pure reducer (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Apply a single AdminFrame to a draft state, in-place. `maxEvents` caps
 * the per-session event tail to keep long-running sessions from eating
 * memory. Exported so `applyFrame.test.ts` can exercise every branch
 * without a render tree.
 *
 * The function is total over AdminFrame — every branch either mutates
 * the draft or logs and returns. A new frame type added to the protocol
 * that isn't handled here surfaces as a log.warn at runtime, which is
 * the signal that the monitor is stale and needs an update. Never a
 * silent drop.
 */
export function applyFrame(
  draft: MonitorStoreState,
  frame: AdminFrame,
  maxEvents: number,
): void {
  switch (frame.type) {
    case "hello":
      draft.protocol = frame.protocol
      draft.serverVersion = frame.serverVersion
      return
    case "snapshot":
      // Full snapshot from the server's `ws.open` — replaces any existing
      // session/approval state so mid-stream reconnects don't leave
      // phantom entries around.
      draft.sessions = {}
      draft.sessionOrder = []
      for (const s of frame.sessions) {
        draft.sessions[s.key] = s
        draft.sessionOrder.push(s.key)
      }
      draft.approvals = {}
      draft.approvalOrder = []
      for (const a of frame.pendingApprovals) {
        draft.approvals[a.id] = a
        draft.approvalOrder.push(a.id)
      }
      draft.loaded = true
      return
    case "session_opened": {
      const key = frame.summary.key
      draft.sessions[key] = frame.summary
      if (!draft.sessionOrder.includes(key)) {
        draft.sessionOrder.push(key)
      }
      // Auto-select the first session we see if the user hasn't picked one.
      if (draft.selectedSessionKey === null) {
        draft.selectedSessionKey = key
      }
      return
    }
    case "session_summary": {
      // Live summary refresh — first user message capture, cumulative
      // usage + cost roll-up, context-window fill, model_changed. We
      // tolerate the case where `session_opened` hasn't landed yet (a
      // monitor that reconnects mid-session can race frames) by
      // registering the key lazily.
      const key = frame.summary.key
      draft.sessions[key] = frame.summary
      if (!draft.sessionOrder.includes(key)) {
        draft.sessionOrder.push(key)
      }
      return
    }
    case "session_closed": {
      delete draft.sessions[frame.key]
      delete draft.events[frame.key]
      const idx = draft.sessionOrder.indexOf(frame.key)
      if (idx >= 0) draft.sessionOrder.splice(idx, 1)
      // If the closed session was selected, snap to the next-newest.
      if (draft.selectedSessionKey === frame.key) {
        draft.selectedSessionKey =
          draft.sessionOrder[draft.sessionOrder.length - 1] ?? null
      }
      return
    }
    case "session_phase": {
      const s = draft.sessions[frame.key]
      if (!s) {
        log.debug(
          `monitor: session_phase for unknown key ${frame.key} — waiting for session_opened`,
        )
        return
      }
      s.phase = frame.phase
      return
    }
    case "session_event": {
      let tail = draft.events[frame.key]
      if (!tail) {
        tail = []
        draft.events[frame.key] = tail
      }
      tail.push(frame.event)
      // FIFO eviction — keep the tail bounded.
      while (tail.length > maxEvents) tail.shift()
      // Keep lastEventAt fresh on the summary so the session list sorts
      // correctly without having to wait for a separate phase frame.
      const s = draft.sessions[frame.key]
      if (s) s.lastEventAt = Date.now()
      return
    }
    case "approval_requested": {
      const a = frame.approval
      draft.approvals[a.id] = a
      if (!draft.approvalOrder.includes(a.id)) draft.approvalOrder.push(a.id)
      return
    }
    case "approval_resolved": {
      delete draft.approvals[frame.id]
      const idx = draft.approvalOrder.indexOf(frame.id)
      if (idx >= 0) draft.approvalOrder.splice(idx, 1)
      return
    }
    case "config_changed":
      draft.config = frame.config
      return
    case "error":
      draft.banner = { tone: "error", message: `${frame.code}: ${frame.message}` }
      return
    case "pong":
      // Keepalive only — nothing observable.
      return
    default: {
      // Exhaustiveness guard. `frame` is typed as `never` here if every
      // case is handled; if a new frame type lands, this branch surfaces
      // as a loud runtime warning instead of a silent drop.
      const unhandled = frame as { type?: string }
      log.warn(
        `slack-monitor: unhandled admin frame type ${String(unhandled.type)} — UI may be stale until updated`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Reactive wrapper
// ---------------------------------------------------------------------------

/**
 * Build a reactive monitor store. The returned object carries both the
 * reactive `state` (bindable in JSX) and mutator methods; every mutator
 * wraps the reducer in a single `produce()` call so the UI sees one
 * atomic reactive update per frame.
 */
export function createMonitorStore(opts: CreateStoreOpts = {}): MonitorStore {
  const maxEvents = opts.maxEventsPerSession ?? 1000
  const [state, setState] = createStore<MonitorStoreState>({
    loaded: false,
    protocol: "",
    serverVersion: "",
    banner: null,
    sessions: {},
    sessionOrder: [],
    events: {},
    approvals: {},
    approvalOrder: [],
    config: null,
    selectedSessionKey: null,
  })
  return {
    state,
    applyFrame(frame) {
      setState(produce((draft) => applyFrame(draft, frame, maxEvents)))
    },
    applySnapshot(snapshot) {
      setState(
        produce((draft) => {
          draft.sessions = {}
          draft.sessionOrder = []
          for (const s of snapshot.sessions) {
            draft.sessions[s.key] = s
            draft.sessionOrder.push(s.key)
          }
          draft.approvals = {}
          draft.approvalOrder = []
          for (const a of snapshot.approvals) {
            draft.approvals[a.id] = a
            draft.approvalOrder.push(a.id)
          }
          if (snapshot.config !== undefined) draft.config = snapshot.config
          draft.loaded = true
          // Auto-select the newest session if the user hasn't chosen one.
          if (draft.selectedSessionKey === null && draft.sessionOrder.length > 0) {
            draft.selectedSessionKey =
              draft.sessionOrder[draft.sessionOrder.length - 1] ?? null
          }
        }),
      )
    },
    setSessionEvents(key, events) {
      setState(
        produce((draft) => {
          const bounded = events.slice(-maxEvents)
          draft.events[key] = bounded
        }),
      )
    },
    setBanner(banner) {
      setState("banner", banner)
    },
    selectSession(key) {
      setState("selectedSessionKey", key)
    },
    setConfig(config) {
      setState("config", config)
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers the UI reaches for
// ---------------------------------------------------------------------------

/**
 * Sort sessions for the list pane: newest-last-event first, then by key for
 * a stable tiebreaker. Exported so the pane can re-derive instead of
 * maintaining a parallel array.
 */
export function sortSessionsByActivity(
  state: MonitorStoreState,
): SessionSummary[] {
  return state.sessionOrder
    .map((k) => state.sessions[k])
    .filter((s): s is SessionSummary => s !== undefined)
    .slice()
    .sort((a, b) => {
      if (a.lastEventAt !== b.lastEventAt) return b.lastEventAt - a.lastEventAt
      return a.key.localeCompare(b.key)
    })
}

/**
 * Human-friendly label for a phase — used by the list + metadata panes.
 *
 * For real `SessionState`s the label comes from the SessionState registry
 * (Cluster 6); this used to be a hand-rolled switch that diverged from
 * `frontends/tui/status-bar/data.ts` and `frontends/tui/components/diagnostics.tsx`.
 * "UNKNOWN" is monitor-specific (the admin protocol's "no phase reported
 * yet" sentinel) — handled inline.
 */
export function phaseLabel(phase: SessionPhase): string {
  if (phase === "UNKNOWN") return "—"
  if (isKnownSessionState(phase)) return STATE_LABELS[phase]
  // Should be unreachable — `SessionPhase = SessionState | "UNKNOWN"`.
  log.warn("phaseLabel called with unknown phase", { phase })
  return phase
}
