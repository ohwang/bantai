/**
 * Admin HTTP + WebSocket client — used by the `bantai slack monitor`
 * OpenTUI frontend (and any other future monitor that wants to watch a
 * bantai-slack process).
 *
 * Three concerns live here:
 *
 *   1. REST helpers — typed GETs + POSTs against `/admin/*`, with a
 *      single Bearer token attached to every request and a uniform error
 *      shape (`AdminErrorBody`).
 *   2. WebSocket client — `connect()` returns a live client that emits
 *      frames via a subscriber callback + reconnects with exponential
 *      backoff on unexpected close.
 *   3. A tiny `Frame` type re-export so the UI never has to import from
 *      the slack admin protocol module directly.
 *
 * Nothing in this file knows about OpenTUI / SolidJS — it's pure
 * fetch+WebSocket plumbing, so the admin surface can be driven from a
 * test, a browser, or curl with the same types.
 */

import {
  type AdminApproveBody,
  type AdminApprovalsResponse,
  type AdminConfigSnapshot,
  type AdminCommand,
  type AdminDenyBody,
  type AdminErrorBody,
  type AdminFrame,
  type AdminHealthResponse,
  type AdminSessionEventsResponse,
  type AdminSessionsResponse,
  type AdminVersionResponse,
  type PendingApproval,
  type SessionDetail,
} from "../../slack/admin/protocol"
import { log } from "../../../utils/logger"

// ---------------------------------------------------------------------------
// REST surface
// ---------------------------------------------------------------------------

export interface AdminClientOpts {
  /** Base URL — e.g. `http://127.0.0.1:8787`. No trailing slash required. */
  baseUrl: string
  /** Bearer token loaded from the server's tokenPath file. */
  token: string
  /**
   * Override for fetch — tests inject a stub; production uses the global.
   * Defaults to `globalThis.fetch`.
   */
  fetch?: typeof fetch
}

export interface AdminClientError extends Error {
  /** HTTP status (0 when the request never reached a response). */
  status: number
  /** Parsed `error.code` from the server's uniform error body, when present. */
  code?: string
}

function normalizeBase(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

/**
 * Raise a typed `AdminClientError`. Falls back gracefully when the body
 * isn't our uniform error shape (e.g. the server is behind a proxy that
 * rewrote the body).
 */
async function raiseFromResponse(
  res: Response,
  fallbackMessage: string,
): Promise<never> {
  let code: string | undefined
  let message = fallbackMessage
  try {
    const body = (await res.json()) as Partial<AdminErrorBody>
    if (body?.error?.code) code = body.error.code
    if (body?.error?.message) message = body.error.message
  } catch {
    // body wasn't JSON — use status-derived message
  }
  const err = new Error(`admin: ${message} (HTTP ${res.status})`) as AdminClientError
  err.status = res.status
  if (code !== undefined) err.code = code
  throw err
}

export interface AdminRestClient {
  getHealth(): Promise<AdminHealthResponse>
  getVersion(): Promise<AdminVersionResponse>
  getConfig(): Promise<AdminConfigSnapshot>
  listSessions(): Promise<AdminSessionsResponse>
  getSession(key: string): Promise<SessionDetail>
  getSessionEvents(key: string): Promise<AdminSessionEventsResponse>
  listApprovals(): Promise<AdminApprovalsResponse>
  interrupt(key: string): Promise<void>
  approve(id: string, body?: AdminApproveBody): Promise<void>
  deny(id: string, body?: AdminDenyBody): Promise<void>
}

/**
 * Build a typed REST client. Every method attaches the Bearer token,
 * converts non-2xx responses into `AdminClientError`, and returns the
 * parsed JSON body.
 */
export function createRestClient(opts: AdminClientOpts): AdminRestClient {
  const base = normalizeBase(opts.baseUrl)
  const fetchFn = opts.fetch ?? fetch.bind(globalThis)

  async function get<T>(path: string): Promise<T> {
    const res = await fetchFn(`${base}${path}`, {
      method: "GET",
      headers: authHeaders(opts.token),
    })
    if (!res.ok) await raiseFromResponse(res, `GET ${path} failed`)
    return (await res.json()) as T
  }

  async function post(path: string, body?: unknown): Promise<void> {
    const headers: Record<string, string> = { ...authHeaders(opts.token) }
    let serialised: string | undefined
    if (body !== undefined) {
      headers["content-type"] = "application/json"
      serialised = JSON.stringify(body)
    }
    const init: RequestInit = { method: "POST", headers }
    if (serialised !== undefined) init.body = serialised
    const res = await fetchFn(`${base}${path}`, init)
    if (!res.ok) await raiseFromResponse(res, `POST ${path} failed`)
  }

  return {
    getHealth: () => get<AdminHealthResponse>("/admin/health"),
    getVersion: () => get<AdminVersionResponse>("/admin/version"),
    getConfig: () => get<AdminConfigSnapshot>("/admin/config"),
    listSessions: () => get<AdminSessionsResponse>("/admin/sessions"),
    getSession: (key) => get<SessionDetail>(`/admin/sessions/${encodeURIComponent(key)}`),
    getSessionEvents: (key) =>
      get<AdminSessionEventsResponse>(`/admin/sessions/${encodeURIComponent(key)}/events`),
    listApprovals: () => get<AdminApprovalsResponse>("/admin/approvals"),
    interrupt: (key) =>
      post(`/admin/sessions/${encodeURIComponent(key)}/interrupt`),
    approve: (id, body) => post(`/admin/approvals/${encodeURIComponent(id)}/approve`, body),
    deny: (id, body) => post(`/admin/approvals/${encodeURIComponent(id)}/deny`, body),
  }
}

// ---------------------------------------------------------------------------
// WebSocket surface
// ---------------------------------------------------------------------------

export type AdminWsState =
  | "connecting"
  | "open"
  | "closed"
  | "reconnecting"
  | "error"

export interface AdminWsEvents {
  /** Every frame received from the server (including `hello` + `snapshot`). */
  onFrame(frame: AdminFrame): void
  /** Connection state transitions — UI uses this to show a banner. */
  onState?(state: AdminWsState, info?: { reason?: string; attempt?: number }): void
}

export interface AdminWsClient {
  /** Send a subscribe / unsubscribe / ping command. No-op if socket is closed. */
  send(cmd: AdminCommand): void
  /** Current connection state. */
  state(): AdminWsState
  /** Close the socket and stop reconnecting. */
  close(): void
}

export interface CreateWsClientOpts extends AdminClientOpts {
  /**
   * Subset of frame deliveries + state transitions the caller cares about.
   */
  events: AdminWsEvents
  /**
   * WebSocket factory — override for tests. Accepts `(url, protocols?)`
   * and returns a `WebSocket`-shaped object. Production uses the global.
   */
  wsFactory?: (url: string) => WebSocket
  /**
   * First reconnect delay in ms. Subsequent attempts double up to
   * `maxReconnectMs` (default 15_000). Zero disables reconnect entirely.
   */
  initialReconnectMs?: number
  /** Cap on reconnect backoff. Default 15_000. */
  maxReconnectMs?: number
  /**
   * Ping interval in ms — when >0 the client sends `{op: "ping"}` at this
   * cadence so the server gets a keepalive beat. Default 30_000. Set to 0
   * to disable (tests).
   */
  pingIntervalMs?: number
}

/**
 * Build the admin WebSocket URL from `baseUrl` + `?token=` query. The
 * server accepts the token via either header or query — we use the query
 * here because browsers can't set `Authorization` on a WebSocket
 * handshake, and the admin server itself binds to 127.0.0.1 by default so
 * the token isn't leaking across a hostile network.
 */
function buildWsUrl(baseUrl: string, token: string): string {
  const base = normalizeBase(baseUrl)
  const wsBase = base.replace(/^http/, "ws")
  const sep = wsBase.includes("?") ? "&" : "?"
  return `${wsBase}/admin/ws${sep}token=${encodeURIComponent(token)}`
}

/**
 * Connect to the admin WebSocket with automatic reconnection. Returns a
 * handle the caller uses to push subscribe / ping commands + inspect
 * connection state.
 *
 * Reconnection policy: exponential backoff, capped at `maxReconnectMs`,
 * never gives up on its own — only `close()` stops it. On each fresh
 * socket we re-emit `connecting` → `open` so the UI can reliably show a
 * "connecting…" banner.
 */
export function connectAdminWs(opts: CreateWsClientOpts): AdminWsClient {
  const wsFactory =
    opts.wsFactory ?? ((u: string) => new WebSocket(u))
  const initialReconnectMs = opts.initialReconnectMs ?? 500
  const maxReconnectMs = opts.maxReconnectMs ?? 15_000
  const pingIntervalMs = opts.pingIntervalMs ?? 30_000

  let socket: WebSocket | null = null
  let state: AdminWsState = "connecting"
  let closedByCaller = false
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null

  function setState(
    next: AdminWsState,
    info?: { reason?: string; attempt?: number },
  ): void {
    state = next
    opts.events.onState?.(next, info)
  }

  function clearTimers(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
  }

  function scheduleReconnect(reason: string): void {
    if (closedByCaller || initialReconnectMs === 0) return
    const delay = Math.min(
      initialReconnectMs * Math.pow(2, Math.max(0, attempt - 1)),
      maxReconnectMs,
    )
    setState("reconnecting", { reason, attempt })
    reconnectTimer = setTimeout(open, delay)
  }

  function open(): void {
    if (closedByCaller) return
    attempt += 1
    setState("connecting", { attempt })
    const url = buildWsUrl(opts.baseUrl, opts.token)
    let ws: WebSocket
    try {
      ws = wsFactory(url)
    } catch (err) {
      log.warn(`slack-monitor: ws factory threw: ${String(err)}`)
      scheduleReconnect(String(err))
      return
    }
    socket = ws
    ws.onopen = () => {
      attempt = 0
      setState("open")
      if (pingIntervalMs > 0) {
        pingTimer = setInterval(() => {
          try {
            ws.send(JSON.stringify({ op: "ping", at: Date.now() }))
          } catch (err) {
            log.debug(`slack-monitor: ws ping send failed: ${String(err)}`)
          }
        }, pingIntervalMs)
      }
    }
    ws.onmessage = (ev: MessageEvent) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data)
      let frame: AdminFrame
      try {
        frame = JSON.parse(raw) as AdminFrame
      } catch (err) {
        // A malformed frame is a server-side bug we can't recover from
        // inline — log loud and drop the message so the UI keeps its
        // invariant that every delivered frame is typed.
        log.warn(
          `slack-monitor: dropping unparseable ws frame (${String(err)}): ${raw.slice(0, 120)}`,
        )
        return
      }
      try {
        opts.events.onFrame(frame)
      } catch (err) {
        log.error(`slack-monitor: onFrame subscriber threw: ${String(err)}`)
      }
    }
    ws.onclose = (ev: CloseEvent) => {
      clearTimers()
      socket = null
      if (closedByCaller) {
        setState("closed", { reason: ev.reason || "closed" })
        return
      }
      scheduleReconnect(ev.reason || `code ${ev.code}`)
    }
    ws.onerror = (ev: Event) => {
      // The browser WebSocket spec is pretty opaque about `error` — we
      // can't tell whether a reconnect is worth trying without waiting
      // for `close`, which always fires right after. Just record the
      // transition; `close` will schedule the retry.
      setState("error", { reason: describeEvent(ev) })
    }
  }

  open()

  return {
    send(cmd) {
      const ws = socket
      if (!ws || ws.readyState !== 1 /* OPEN */) return
      try {
        ws.send(JSON.stringify(cmd))
      } catch (err) {
        log.debug(`slack-monitor: ws send failed: ${String(err)}`)
      }
    },
    state: () => state,
    close() {
      closedByCaller = true
      clearTimers()
      const ws = socket
      socket = null
      if (ws) {
        try {
          ws.close(1000, "client closed")
        } catch {
          // ignore — we're tearing down anyway
        }
      }
      setState("closed")
    },
  }
}

function describeEvent(ev: Event): string {
  const anyEv = ev as { message?: string }
  return anyEv.message ?? ev.type ?? "error"
}

// ---------------------------------------------------------------------------
// Re-exports so UI code only imports from one place
// ---------------------------------------------------------------------------

export type {
  AdminFrame,
  AdminHealthResponse,
  AdminVersionResponse,
  AdminConfigSnapshot,
  AdminSessionsResponse,
  AdminSessionEventsResponse,
  AdminApprovalsResponse,
  PendingApproval,
  SessionDetail,
}
