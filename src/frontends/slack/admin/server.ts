/**
 * Admin HTTP + WebSocket server.
 *
 * Standalone Bun.serve() that runs alongside (never inside) the Bolt
 * Socket-Mode app. Consumers — the `bantai slack monitor` TUI today, a
 * browser viewer tomorrow, curl always — attach here instead of poking
 * into the Slack frontend's internals.
 *
 * Split of concerns:
 *   - REST (state-of-the-world snapshots, request/response actions)
 *   - WebSocket (live stream + filter commands)
 *   - Auth (single bearer token, loaded from disk at startup)
 *
 * Deliberately frontend-agnostic: takes a `SessionRegistry`, an
 * `ApprovalCoordinator`, and an `AdminBus` as dependencies. The launcher
 * (item 8) wires these together and hands back a handle with `.stop()`.
 *
 * Read-only mode: when `readOnly` is true, every mutating route (POST
 * approve / deny / interrupt) returns 403 with code "read_only". GETs
 * and the WebSocket stream keep working. This is the "give the ops
 * channel visibility without the foot-gun" knob.
 */

import type { Server, ServerWebSocket } from "bun"
import { log } from "../../../utils/logger"
import type { AdminBus, AdminSubscriber } from "./bus"
import type { AttachedRingBuffer } from "./ring"
import type {
  SessionEntry,
  SessionRegistry,
} from "../router/registry"
import { buildSummary } from "../router/registry"
import type { ApprovalCoordinator } from "../approvals/coordinator"
import type { ResolvedSlackConfig } from "../config/schema"
import type { PendingApprovalRecord } from "../view/approvals"
import {
  ADMIN_PROTOCOL_VERSION,
  AdminApproveBodySchema,
  AdminCommandSchema,
  AdminDenyBodySchema,
  type AdminCommand,
  type AdminConfigSnapshot,
  type AdminErrorBody,
  type AdminFrame,
  type AdminHealthResponse,
  type AdminProjectSnapshot,
  type AdminSessionEventsResponse,
  type AdminSessionsResponse,
  type AdminApprovalsResponse,
  type AdminVersionResponse,
  type PendingApproval,
  type SessionDetail,
  type SessionSummary,
} from "./protocol"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AdminServerOpts {
  /** The AdminBus every mutator publishes to; we fan to WebSocket clients. */
  bus: AdminBus
  /** Per-session ring buffer for back-fill on connect / REST. */
  ring: AttachedRingBuffer
  /** Source of session summaries + interrupt plumbing. */
  registry: SessionRegistry
  /** Approval list + REST decision handling. */
  approvals: ApprovalCoordinator
  /** Full resolved slack.json, used ONLY to build the scrubbed config snapshot. */
  config: ResolvedSlackConfig
  /** Bearer token (already read from tokenPath + trimmed). */
  token: string
  /** `package.json` version string — rendered into `hello` + `/admin/version`. */
  serverVersion: string
  /** Cached boot-time IDs for `/admin/health`. Empty strings acceptable. */
  botUserId: string
  workspaceId: string
  /** Bind host (usually "127.0.0.1"). */
  host: string
  /** Bind port (0 = ask the OS for a free one). */
  port: number
  /** When true, every POST route returns 403. */
  readOnly: boolean
}

export interface AdminServer {
  /** Actual listening port (useful when `port: 0` was requested). */
  port(): number
  /** Bind host as reported by Bun. */
  hostname(): string
  /** Graceful shutdown — unsubscribes the bus + closes every WS. */
  stop(): Promise<void>
}

// ---------------------------------------------------------------------------
// WebSocket client state
// ---------------------------------------------------------------------------

interface ClientFilter {
  /** null = all sessions; Set = only these session keys. */
  keys: Set<string> | null
  /** null = all AgentEvent types; Set = only these on session_event frames. */
  eventTypes: Set<string> | null
}

interface ClientState {
  id: number
  filter: ClientFilter
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function startAdminServer(opts: AdminServerOpts): AdminServer {
  // Connected WebSocket clients. Bun's WebSocket carries `data`, which we
  // piggy-back on to store the per-client filter state.
  const clients = new Set<WebSocketWithState>()
  let nextClientId = 1

  // Every frame the bus emits fans out to every connected client — after
  // per-client filtering. Subscribing at `start()` time means the server
  // catches every frame published after launch, which is fine because
  // clients see the current state via the initial `snapshot` frame anyway.
  const unsubscribeBus = opts.bus.subscribe(makeBusFanOut(clients))

  const server: Server<ClientState> = Bun.serve<ClientState>({
    hostname: opts.host,
    port: opts.port,
    fetch(req, srv) {
      return handleFetch(req, srv, opts, clients, () => nextClientId++)
    },
    websocket: {
      open(ws) {
        clients.add(ws)
        sendFrame(ws, {
          type: "hello",
          protocol: ADMIN_PROTOCOL_VERSION,
          serverVersion: opts.serverVersion,
        })
        sendFrame(ws, buildSnapshotFrame(opts))
      },
      message(ws, raw) {
        handleWsMessage(ws, raw, opts)
      },
      close(ws) {
        clients.delete(ws)
      },
    },
  })

  return {
    port: () => server.port ?? opts.port,
    hostname: () => server.hostname ?? opts.host,
    async stop() {
      try {
        unsubscribeBus()
      } catch (err) {
        log.warn(`slack admin server: bus unsubscribe threw: ${String(err)}`)
      }
      // Close every live client cleanly before we stop accepting.
      for (const ws of Array.from(clients)) {
        try {
          ws.close(1001, "server shutting down")
        } catch {
          // ignore — we're tearing down anyway
        }
      }
      clients.clear()
      server.stop(true)
    },
  }
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

type WebSocketWithState = ServerWebSocket<ClientState>

function makeBusFanOut(clients: Set<WebSocketWithState>): AdminSubscriber {
  return (frame) => {
    // Copy the set so a `ws.close()` from a buggy client doesn't skew
    // iteration. One bad consumer must not stop fan-out to the others.
    for (const ws of Array.from(clients)) {
      if (!frameMatchesFilter(frame, ws.data.filter)) continue
      sendFrame(ws, frame)
    }
  }
}

/**
 * Apply a client's keys + eventTypes filter to a bus frame. Global frames
 * (hello, snapshot, approval_resolved, pong, config_changed, error) are
 * always delivered — clients can't meaningfully opt out of lifecycle.
 */
function frameMatchesFilter(frame: AdminFrame, filter: ClientFilter): boolean {
  // Determine the session key, if any, for this frame.
  let key: string | null = null
  switch (frame.type) {
    case "session_opened":
      key = frame.summary.key
      break
    case "session_closed":
    case "session_phase":
    case "session_event":
      key = frame.key
      break
    case "approval_requested":
      key = frame.approval.sessionKey
      break
    default:
      key = null
  }
  if (key !== null && filter.keys !== null && !filter.keys.has(key)) {
    return false
  }
  if (
    frame.type === "session_event" &&
    filter.eventTypes !== null &&
    !filter.eventTypes.has(frame.event.type)
  ) {
    return false
  }
  return true
}

function sendFrame(ws: WebSocketWithState, frame: AdminFrame): void {
  try {
    ws.send(JSON.stringify(frame))
  } catch (err) {
    log.warn(`slack admin server: ws.send threw: ${String(err)}`)
  }
}

function handleWsMessage(
  ws: WebSocketWithState,
  raw: string | Buffer,
  opts: AdminServerOpts,
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString())
  } catch {
    sendFrame(ws, { type: "error", code: "bad_json", message: "message was not valid JSON" })
    return
  }
  const result = AdminCommandSchema.safeParse(parsed)
  if (!result.success) {
    sendFrame(ws, {
      type: "error",
      code: "bad_command",
      message: result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; "),
    })
    return
  }
  applyCommand(ws, result.data, opts)
}

function applyCommand(
  ws: WebSocketWithState,
  cmd: AdminCommand,
  opts: AdminServerOpts,
): void {
  switch (cmd.op) {
    case "subscribe":
      ws.data.filter.keys =
        cmd.keys && cmd.keys.length > 0 ? new Set(cmd.keys) : null
      ws.data.filter.eventTypes =
        cmd.eventTypes && cmd.eventTypes.length > 0 ? new Set(cmd.eventTypes) : null
      // Reply with a fresh snapshot so the monitor sees the exact set of
      // sessions + approvals that its filter will admit going forward.
      sendFrame(ws, buildSnapshotFrame(opts))
      return
    case "unsubscribe": {
      if (!cmd.keys || cmd.keys.length === 0) {
        // No keys = unsubscribe everything; monitor explicitly said "I
        // want no sessions". We still deliver globals.
        ws.data.filter.keys = new Set()
      } else if (ws.data.filter.keys !== null) {
        for (const k of cmd.keys) ws.data.filter.keys.delete(k)
      }
      return
    }
    case "ping":
      sendFrame(ws, { type: "pong", at: cmd.at })
      return
  }
}

// ---------------------------------------------------------------------------
// REST fetch handler
// ---------------------------------------------------------------------------

async function handleFetch(
  req: Request,
  srv: Server<ClientState>,
  opts: AdminServerOpts,
  clients: Set<WebSocketWithState>,
  nextClientId: () => number,
): Promise<Response | undefined> {
  const url = new URL(req.url)
  const path = url.pathname

  // WebSocket upgrade.
  if (path === "/admin/ws") {
    if (!authorizeWs(req, url, opts.token)) {
      return jsonError(401, "unauthorized", "invalid or missing bearer token")
    }
    const ok = srv.upgrade(req, {
      data: {
        id: nextClientId(),
        filter: { keys: null, eventTypes: null },
      } satisfies ClientState,
    })
    if (ok) return undefined
    return jsonError(500, "upgrade_failed", "websocket upgrade rejected by the runtime")
  }

  // REST — every endpoint requires the bearer token.
  if (!authorizeRest(req, opts.token)) {
    return jsonError(401, "unauthorized", "invalid or missing bearer token")
  }

  try {
    if (req.method === "GET" && path === "/admin/version") {
      const body: AdminVersionResponse = {
        protocol: ADMIN_PROTOCOL_VERSION,
        server: opts.serverVersion,
      }
      return json(200, body)
    }
    if (req.method === "GET" && path === "/admin/health") {
      const body: AdminHealthResponse = {
        ok: true,
        mode: opts.config.workspace.mode,
        botUserId: opts.botUserId,
        workspaceId: opts.workspaceId,
      }
      return json(200, body)
    }
    if (req.method === "GET" && path === "/admin/config") {
      return json(200, buildConfigSnapshot(opts.config))
    }
    if (req.method === "GET" && path === "/admin/sessions") {
      const body: AdminSessionsResponse = {
        sessions: opts.registry.entries().map(buildSummary),
      }
      return json(200, body)
    }
    const sessionMatch = path.match(/^\/admin\/sessions\/([^\/]+)$/)
    if (sessionMatch && req.method === "GET") {
      const key = decodeURIComponent(sessionMatch[1]!)
      const entry = findEntryByKey(opts.registry, key)
      if (!entry) return jsonError(404, "session_not_found", key)
      return json(200, buildDetail(entry))
    }
    const eventsMatch = path.match(/^\/admin\/sessions\/([^\/]+)\/events$/)
    if (eventsMatch && req.method === "GET") {
      const key = decodeURIComponent(eventsMatch[1]!)
      const body: AdminSessionEventsResponse = { events: opts.ring.snapshot(key) }
      return json(200, body)
    }
    const interruptMatch = path.match(/^\/admin\/sessions\/([^\/]+)\/interrupt$/)
    if (interruptMatch && req.method === "POST") {
      if (opts.readOnly) return jsonError(403, "read_only", "admin is read-only")
      const key = decodeURIComponent(interruptMatch[1]!)
      const entry = findEntryByKey(opts.registry, key)
      if (!entry) return jsonError(404, "session_not_found", key)
      try {
        entry.host.backend.interrupt()
      } catch (err) {
        return jsonError(500, "interrupt_failed", String(err))
      }
      return json(202, { accepted: true })
    }
    if (req.method === "GET" && path === "/admin/approvals") {
      const body: AdminApprovalsResponse = {
        pending: opts.approvals.registry.list().map(recordToPending),
      }
      return json(200, body)
    }
    const approveMatch = path.match(/^\/admin\/approvals\/([^\/]+)\/approve$/)
    if (approveMatch && req.method === "POST") {
      if (opts.readOnly) return jsonError(403, "read_only", "admin is read-only")
      const id = decodeURIComponent(approveMatch[1]!)
      const body = await readBody(req)
      const parsed = AdminApproveBodySchema.safeParse(body)
      if (!parsed.success) {
        return jsonError(400, "bad_body", parsed.error.issues.map((i) => i.message).join("; "))
      }
      const res = await opts.approvals.adminResolve({
        id,
        decision: "allow",
        ...(parsed.data.alwaysAllow ? { alwaysAllow: true } : {}),
      })
      if (res.kind === "unknown") return jsonError(404, "approval_not_found", id)
      return json(200, { resolved: true, id })
    }
    const denyMatch = path.match(/^\/admin\/approvals\/([^\/]+)\/deny$/)
    if (denyMatch && req.method === "POST") {
      if (opts.readOnly) return jsonError(403, "read_only", "admin is read-only")
      const id = decodeURIComponent(denyMatch[1]!)
      const body = await readBody(req)
      const parsed = AdminDenyBodySchema.safeParse(body)
      if (!parsed.success) {
        return jsonError(400, "bad_body", parsed.error.issues.map((i) => i.message).join("; "))
      }
      const res = await opts.approvals.adminResolve({
        id,
        decision: "deny",
        ...(parsed.data.reason ? { denyReason: parsed.data.reason } : {}),
      })
      if (res.kind === "unknown") return jsonError(404, "approval_not_found", id)
      return json(200, { resolved: true, id })
    }
    return jsonError(404, "not_found", `${req.method} ${path}`)
  } catch (err) {
    log.error(`slack admin server: handler threw on ${req.method} ${path}: ${String(err)}`)
    return jsonError(500, "internal_error", String(err))
  } finally {
    // `clients` + `nextClientId` are only used by the WS branch; this
    // keeps them referenced so eslint / tree-shaking doesn't mark them
    // unused when all the REST branches return. No-op otherwise.
    void clients
    void nextClientId
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function authorizeRest(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? ""
  return timingSafeEqual(header, `Bearer ${token}`)
}

function authorizeWs(req: Request, url: URL, token: string): boolean {
  // Headers first (proper clients), then `?token=` fallback (browsers).
  const header = req.headers.get("authorization") ?? ""
  if (timingSafeEqual(header, `Bearer ${token}`)) return true
  const qs = url.searchParams.get("token")
  if (qs && timingSafeEqual(qs, token)) return true
  return false
}

/** Length-first comparison that tolerates mismatched lengths in constant time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// ---------------------------------------------------------------------------
// Snapshot / config / detail helpers
// ---------------------------------------------------------------------------

function buildSnapshotFrame(opts: AdminServerOpts): AdminFrame {
  const sessions: SessionSummary[] = opts.registry.entries().map(buildSummary)
  const pendingApprovals: PendingApproval[] = opts.approvals.registry
    .list()
    .map(recordToPending)
  return { type: "snapshot", sessions, pendingApprovals }
}

function findEntryByKey(
  registry: SessionRegistry,
  key: string,
): SessionEntry | undefined {
  for (const e of registry.entries()) {
    if (e.key === key) return e
  }
  return undefined
}

function buildDetail(entry: SessionEntry): SessionDetail {
  const summary = buildSummary(entry)
  return {
    ...summary,
    cwd: entry.project.projectDir,
    ...(entry.project.model ? { model: entry.project.model } : {}),
    permissionMode: entry.project.permissionMode,
    openedAt: entry.openedAt,
  }
}

function recordToPending(r: PendingApprovalRecord): PendingApproval {
  return {
    id: r.request.id,
    sessionKey: r.sessionKey,
    channelId: r.channel,
    threadTs: r.threadTs,
    tool: r.request.tool,
    input: r.request.input,
    ...(r.request.title ? { title: r.request.title } : {}),
    ...(r.request.description ? { description: r.request.description } : {}),
    approvers: r.approvers,
    requestedAt: r.createdAt,
    ttlMs: r.ttlMs,
  }
}

/**
 * Build an `AdminConfigSnapshot` from the full resolved slack.json.
 * Every field carrying a secret (tokens, signing secrets, env expansions
 * of same) is dropped; what's left is safe to render to a monitor.
 */
export function buildConfigSnapshot(
  config: ResolvedSlackConfig,
): AdminConfigSnapshot {
  const projects: AdminProjectSnapshot[] = config.channels.map((c) => ({
    channelId: c.id,
    ...(c.name ? { name: c.name } : {}),
    ...(c.backend ? { backend: c.backend } : {}),
    ...(c.model ? { model: c.model } : {}),
    ...(c.project_dir ? { projectDir: c.project_dir } : {}),
  }))
  return {
    mode: config.workspace.mode,
    storePath: config.storePath,
    admin: {
      host: config.admin.host,
      port: config.admin.port,
      readOnly: config.admin.readOnly,
      sessionRingSize: config.admin.sessionRingSize,
    },
    projects,
  }
}

// ---------------------------------------------------------------------------
// HTTP response helpers
// ---------------------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function jsonError(status: number, code: string, message: string): Response {
  const body: AdminErrorBody = { error: { code, message } }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
