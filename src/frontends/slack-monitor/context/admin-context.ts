/**
 * Admin context — the glue that composes transport + store into one unit
 * the UI can consume. One object per `bantai slack monitor` process.
 *
 * Responsibilities:
 *   - Hold the REST client + WS client + monitor store.
 *   - Drive the initial bootstrap: GET /admin/sessions + /admin/approvals
 *     + /admin/config, then open the WebSocket and subscribe.
 *   - Forward every live AdminFrame into `store.applyFrame`.
 *   - Expose mutator helpers (`approve`, `deny`, `interrupt`,
 *     `fetchSessionEvents`) that close over the REST client so panes
 *     don't reach into `transport` themselves.
 *
 * Intentionally framework-agnostic — the module has zero OpenTUI /
 * SolidJS imports, so it can be exercised from a test that speaks the
 * admin server directly.
 */

import {
  connectAdminWs,
  createRestClient,
  type AdminRestClient,
  type AdminWsClient,
  type AdminWsState,
} from "../transport/client"
import {
  createMonitorStore,
  type MonitorStore,
  type MonitorStoreState,
} from "./store"
import { log } from "../../../utils/logger"

export interface AdminContextOpts {
  baseUrl: string
  token: string
  /** Optional fetch override — tests inject a stub. */
  fetch?: typeof fetch
  /** Optional WebSocket factory override — tests inject a double. */
  wsFactory?: (url: string) => WebSocket
  /** Cap the per-session event tail (reducer). Default 1000. */
  maxEventsPerSession?: number
  /** Backoff for reconnect (see transport/client). */
  initialReconnectMs?: number
  maxReconnectMs?: number
  /** Keepalive ping interval in ms — passed through. */
  pingIntervalMs?: number
}

export interface AdminContext {
  rest: AdminRestClient
  ws: AdminWsClient
  store: MonitorStore
  /** Fire off the initial REST bootstrap. Safe to call more than once. */
  bootstrap(): Promise<void>
  /**
   * Pull the ring buffer for a specific session — used when the user
   * selects a session that doesn't yet have events in the live tail.
   */
  fetchSessionEvents(key: string): Promise<void>
  /** Interrupt helper — throws on 4xx/5xx. */
  interrupt(key: string): Promise<void>
  /** Approve helper. `alwaysAllow` flattens to the `allowAlways` wire flag. */
  approve(id: string, alwaysAllow?: boolean): Promise<void>
  /** Deny helper — optional reason is sent through. */
  deny(id: string, reason?: string): Promise<void>
  /** Tear down the WS + any in-flight REST calls. */
  close(): void
  /** Current connection state — handy for the banner in tests. */
  state(): AdminWsState
}

/**
 * Create the admin context. The returned value wraps a live REST client
 * + a WebSocket client whose frames are piped straight into the store's
 * `applyFrame`. The bootstrap promise resolves after the first REST
 * pass; live frames begin arriving as soon as the WS handshake completes
 * (independent of the REST bootstrap).
 */
export function createAdminContext(opts: AdminContextOpts): AdminContext {
  const store = createMonitorStore({
    ...(opts.maxEventsPerSession !== undefined
      ? { maxEventsPerSession: opts.maxEventsPerSession }
      : {}),
  })
  const rest = createRestClient({
    baseUrl: opts.baseUrl,
    token: opts.token,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })
  const ws = connectAdminWs({
    baseUrl: opts.baseUrl,
    token: opts.token,
    ...(opts.wsFactory ? { wsFactory: opts.wsFactory } : {}),
    ...(opts.initialReconnectMs !== undefined
      ? { initialReconnectMs: opts.initialReconnectMs }
      : {}),
    ...(opts.maxReconnectMs !== undefined ? { maxReconnectMs: opts.maxReconnectMs } : {}),
    ...(opts.pingIntervalMs !== undefined ? { pingIntervalMs: opts.pingIntervalMs } : {}),
    events: {
      onFrame(frame) {
        // Let the reducer handle every branch — it's total over AdminFrame.
        store.applyFrame(frame)
      },
      onState(next, info) {
        switch (next) {
          case "open":
            store.setBanner(null)
            break
          case "connecting":
            store.setBanner({ tone: "info", message: "connecting to admin server…" })
            break
          case "reconnecting":
            store.setBanner({
              tone: "warn",
              message: `connection lost (${info?.reason ?? "unknown"}) — reconnecting…`,
            })
            break
          case "error":
            store.setBanner({
              tone: "error",
              message: `connection error: ${info?.reason ?? "unknown"}`,
            })
            break
          case "closed":
            // A caller-initiated close leaves any existing banner in
            // place — the UI usually tears down next anyway.
            break
        }
      },
    },
  })

  let bootstrapping = false
  async function bootstrap(): Promise<void> {
    if (bootstrapping || store.state.loaded) return
    bootstrapping = true
    try {
      const [sessions, approvals, config] = await Promise.all([
        rest.listSessions(),
        rest.listApprovals(),
        rest.getConfig().catch((err) => {
          // /admin/config can legitimately lag — log and fall through.
          log.warn(`slack-monitor: /admin/config fetch failed: ${String(err)}`)
          return null
        }),
      ])
      store.applySnapshot({
        sessions: sessions.sessions,
        approvals: approvals.pending,
        config: config ?? null,
      })
    } catch (err) {
      store.setBanner({
        tone: "error",
        message: `initial fetch failed: ${String(err)}`,
      })
      throw err
    } finally {
      bootstrapping = false
    }
  }

  async function fetchSessionEvents(key: string): Promise<void> {
    try {
      const res = await rest.getSessionEvents(key)
      store.setSessionEvents(key, res.events)
    } catch (err) {
      log.warn(`slack-monitor: /admin/sessions/${key}/events failed: ${String(err)}`)
      store.setBanner({
        tone: "warn",
        message: `could not load events for ${key}: ${String(err)}`,
      })
    }
  }

  return {
    rest,
    ws,
    store,
    bootstrap,
    fetchSessionEvents,
    async interrupt(key) {
      await rest.interrupt(key)
    },
    async approve(id, alwaysAllow) {
      await rest.approve(id, alwaysAllow ? { alwaysAllow: true } : undefined)
    },
    async deny(id, reason) {
      await rest.deny(id, reason !== undefined ? { reason } : undefined)
    },
    close() {
      ws.close()
    },
    state: () => ws.state(),
  }
}

// Re-export the store state type so the UI / tests only import from here.
export type { MonitorStoreState }
