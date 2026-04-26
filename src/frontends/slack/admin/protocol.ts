/**
 * Admin surface — wire protocol.
 *
 * This module IS the spec. Both the Slack server (`./server.ts`) and every
 * monitor client (OpenTUI TUI, future browser viewer, curl) import the same
 * type + schema definitions here so drift becomes a compile-time error
 * rather than a runtime one.
 *
 * The protocol is JSON-first and framework-agnostic. Outbound frames
 * (server → client) are typed but NOT validated at runtime — we trust our
 * own producers. Inbound commands (client → server) ARE zod-validated
 * because clients can be buggy or malicious; every command the server
 * accepts goes through `AdminCommandSchema.safeParse`.
 *
 * See team/bantai-slack-monitor-tui.md §Admin surface — wire protocol.
 */

import { z } from "zod"
import type { AgentEvent, SessionState } from "../../../protocol/types"
import { knownSessionStateIds } from "../../../protocol/session-state"

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/**
 * Monotonically-increasing string. Adding fields to existing frames is
 * backward-compatible; renaming or removing fields bumps this value.
 * Monitors refuse to run against a mismatched major and print an upgrade
 * hint.
 */
export const ADMIN_PROTOCOL_VERSION = "1" as const
export type AdminProtocolVersion = typeof ADMIN_PROTOCOL_VERSION

// ---------------------------------------------------------------------------
// Session phase — exactly the state-machine states from protocol/types.ts,
// plus an `"UNKNOWN"` escape hatch for backends / events the reducer can't
// classify. Exporting SessionState directly would lock the admin protocol
// to whatever the state machine happens to call itself today; mirroring it
// explicitly gives us room to add admin-only phase labels later without
// touching the state machine.
// ---------------------------------------------------------------------------

export type SessionPhase = SessionState | "UNKNOWN"

/**
 * Closed list of admin-protocol session phases.
 *
 * Derived from `knownSessionStateIds()` (Cluster 6 / SessionState registry)
 * so adding a new state to the protocol registry automatically updates
 * this allowlist. The trailing "UNKNOWN" sentinel is monitor-specific —
 * it represents "no phase reported yet" and isn't part of the state
 * machine proper.
 */
export const SESSION_PHASES: readonly SessionPhase[] = [
  ...knownSessionStateIds(),
  "UNKNOWN",
] as const

// ---------------------------------------------------------------------------
// Session summary + detail
// ---------------------------------------------------------------------------

/**
 * Per-session token accounting, accumulated server-side from every
 * `turn_complete.usage` event. Every field defaults to 0 for backends
 * that don't report them; summing them is how the monitor's right-hand
 * pane renders the "input / output / cache read / cache write / cost"
 * breakdown, and how it validates that the individual counters add up
 * to the top-line cost.
 */
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalCostUsd: number
}

/**
 * Minimal per-session projection that the left-pane list renders. Keep
 * this tight — every summary ships on the initial snapshot AND on every
 * session_opened / session_phase / session_summary frame.
 */
export interface SessionSummary {
  /** Full session key (`slack:<workspace>:<channelId>:<threadTs|main>`). */
  key: string
  /** Slack channel id (e.g. "C01ABC"). */
  channelId: string
  /** "main" for top-level posts; a thread ts otherwise. */
  threadTs: string
  /** Backend id (claude / codex / gemini / acp / mock). */
  backend: string
  /** Project name as resolved by the router, empty string when unknown. */
  projectName: string
  /** Current phase. "UNKNOWN" until enough events have arrived to derive it. */
  phase: SessionPhase
  /** Turn count (cumulative across rehydration). */
  turns: number
  /** Cumulative cost in USD. */
  totalCostUsd: number
  /** Epoch ms of the last inbound event for this session. */
  lastEventAt: number
  /** True when this entry was rehydrated from the persistent store. */
  resumed: boolean
  /**
   * First user message for this session, truncated server-side. Drives
   * the "what is this thread about?" label in the monitor's session
   * list. Undefined until the first inbound user turn arrives.
   */
  firstUserMessage?: string
  /**
   * Cumulative token usage breakdown. Summed from every
   * `turn_complete.usage` event the backend emits. Zeroed on fresh
   * sessions; rehydrated entries inherit prior `totalCostUsd` + `turns`
   * from the persistent store but start at zero for the per-kind token
   * counters (the store doesn't persist them today).
   */
  usage: SessionUsage
  /**
   * Most recent per-API-call context window fill, in tokens. Populated
   * from `cost_update.contextTokens`. `undefined` when no call has
   * landed yet. More accurate than `usage.inputTokens` (cumulative
   * across API calls) for computing the "X% of the context window is
   * full" gauge.
   */
  contextTokens?: number
  /**
   * Model context-window size in tokens, when known. Sourced from the
   * first ModelInfo on session_init. Backends that don't advertise it
   * leave this undefined and the monitor renders a `—`.
   */
  contextWindow?: number
  /**
   * Currently-active model id. Populated from session_init.models[0]
   * and updated on `model_changed` events.
   */
  model?: string
}

/**
 * Session detail — returned from GET `/admin/sessions/:key`. Superset of
 * SessionSummary, plus fields that are too bulky for every summary push.
 *
 * `model` is intentionally re-declared here with `?:` so both the
 * summary-level (advertised by the backend) and the detail-level
 * (project-configured) views can coexist.
 */
export interface SessionDetail extends SessionSummary {
  /** Absolute working directory the backend is running against. */
  cwd: string
  /** Permission mode the session was opened with. */
  permissionMode?: string
  /** Epoch ms the session entry was first constructed in-process. */
  openedAt: number
}

// ---------------------------------------------------------------------------
// Pending approval (cross-session view for the admin's approvals pane)
// ---------------------------------------------------------------------------

export interface PendingApproval {
  /** Permission id from the originating `permission_request` event. */
  id: string
  /** Session this approval belongs to. */
  sessionKey: string
  /** Slack channel id (for display — the pane groups approvals per channel). */
  channelId: string
  /** Thread ts; "main" for top-level. */
  threadTs: string
  /** Tool identifier (e.g. "Bash"). */
  tool: string
  /** Tool input payload (unstructured — rendered as JSON in the client). */
  input: unknown
  /** Short noun phrase for the tool action (e.g. "Run shell command"). */
  displayName?: string
  /** Full permission prompt sentence. */
  title?: string
  /** Subtitle describing the scope of the permission. */
  description?: string
  /** Slack user ids allowed to approve/deny this request. */
  approvers: string[]
  /** Epoch ms when the request arrived. */
  requestedAt: number
  /** TTL in ms — auto-deny fires after this window. */
  ttlMs: number
}

// ---------------------------------------------------------------------------
// Config snapshot (GET /admin/config)
// ---------------------------------------------------------------------------

/**
 * Scrubbed view of the resolved slack.json — safe to serialise. Anything
 * matching /token|secret|signing/i has already been removed by the server
 * before this shape is produced.
 */
export interface AdminConfigSnapshot {
  mode: "socket" | "http"
  storePath: string
  admin: {
    host: string
    port: number
    readOnly: boolean
    sessionRingSize: number
  }
  projects: AdminProjectSnapshot[]
}

export interface AdminProjectSnapshot {
  channelId: string
  name?: string
  backend?: string
  model?: string
  projectDir?: string
}

// ---------------------------------------------------------------------------
// Frames: server → client
// ---------------------------------------------------------------------------

export type AdminFrame =
  | {
      type: "hello"
      protocol: AdminProtocolVersion
      serverVersion: string
    }
  | {
      type: "snapshot"
      sessions: SessionSummary[]
      pendingApprovals: PendingApproval[]
    }
  | { type: "session_opened"; summary: SessionSummary }
  | {
      type: "session_closed"
      key: string
      reason: "idle" | "reset" | "shutdown" | "error"
    }
  | { type: "session_phase"; key: string; phase: SessionPhase }
  /**
   * Live SessionSummary refresh. Emitted whenever a field that the
   * list pane / details tab renders changes — first user message,
   * turn count, cumulative cost / token breakdown, context fill, or
   * the active model. Kept separate from `session_phase` so clients
   * that only care about phase transitions don't have to parse the
   * whole summary on every cost_update.
   */
  | { type: "session_summary"; summary: SessionSummary }
  | { type: "session_event"; key: string; event: AgentEvent }
  | { type: "approval_requested"; approval: PendingApproval }
  | {
      type: "approval_resolved"
      id: string
      decision: "allow" | "deny" | "timeout"
      by: "admin" | "slack" | "timeout" | "shutdown"
    }
  | { type: "config_changed"; config: AdminConfigSnapshot }
  | { type: "error"; code: string; message: string }
  | { type: "pong"; at: number }

// ---------------------------------------------------------------------------
// Inbound commands: client → server (zod-validated)
// ---------------------------------------------------------------------------

/**
 * AgentEvent discriminator values, mirrored so clients can ask the server
 * to filter event types without the server having to enumerate the union
 * itself. Keep this list permissive — any value not in the set is simply
 * ignored by the server's event filter.
 */
const AgentEventTypeSchema = z.string().min(1)

export const AdminCommandSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("subscribe"),
      /** Limit frames to the given session keys; omit = all sessions. */
      keys: z.array(z.string().min(1)).optional(),
      /**
       * Limit `session_event` frames to these AgentEvent.type values.
       * Other frame types (session_phase, approval_*, etc.) are always
       * delivered regardless of this filter.
       */
      eventTypes: z.array(AgentEventTypeSchema).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("unsubscribe"),
      keys: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("ping"),
      at: z.number(),
    })
    .strict(),
])
export type AdminCommand = z.infer<typeof AdminCommandSchema>

// ---------------------------------------------------------------------------
// REST response bodies (for callers that want a typed client — the server
// hand-crafts these, the monitor imports them)
// ---------------------------------------------------------------------------

export interface AdminVersionResponse {
  protocol: AdminProtocolVersion
  server: string
}

export interface AdminHealthResponse {
  ok: true
  mode: "socket" | "http"
  botUserId: string
  workspaceId: string
}

export interface AdminSessionsResponse {
  sessions: SessionSummary[]
}

export interface AdminSessionEventsResponse {
  events: AgentEvent[]
}

export interface AdminApprovalsResponse {
  pending: PendingApproval[]
}

/**
 * Uniform error shape. Every non-2xx JSON response from the admin server
 * is this shape, so clients can switch on `error.code` without string-
 * matching HTTP status text.
 */
export interface AdminErrorBody {
  error: {
    code: string
    message: string
  }
}

/** Request body for POST /admin/approvals/:id/approve */
export const AdminApproveBodySchema = z
  .object({
    alwaysAllow: z.boolean().optional(),
  })
  .strict()
export type AdminApproveBody = z.infer<typeof AdminApproveBodySchema>

/** Request body for POST /admin/approvals/:id/deny */
export const AdminDenyBodySchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict()
export type AdminDenyBody = z.infer<typeof AdminDenyBodySchema>
