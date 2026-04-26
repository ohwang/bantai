/**
 * Session State Registry — single source of truth for the closed
 * enumeration of `ConversationState.sessionState` values.
 *
 * Follows the drift-contract recipe in CLAUDE.md (Cluster 6):
 *
 *   1. Source of truth = a typed array of descriptors (this file).
 *   2. The `SessionState` type is derived from the array.
 *   3. Helpers (`STATE_LABELS`, `STATE_GLYPHS`, `isKnownSessionState`)
 *      replace every parallel switch / map across the codebase.
 *   4. Switches that need exhaustiveness become `Record<SessionState, V>`
 *      so adding a state is a compile-time error in every consumer that
 *      forgot to add a case (which is exactly how live bug L5 — diagnostics
 *      panel rendering wrong color for INITIALIZING / SHUTTING_DOWN —
 *      shipped: a hand-rolled switch missed two states with no signal).
 *
 * The state machine is documented in CLAUDE.md (§"State Machine"); this
 * file is the runtime mirror.
 */

/** Severity bucket — drives default color/glyph fallback chains. */
export type StateSeverity =
  | "neutral"   // INITIALIZING, IDLE, SHUTTING_DOWN
  | "active"    // RUNNING
  | "blocked"   // WAITING_FOR_PERM, WAITING_FOR_ELIC, INTERRUPTING
  | "error"     // ERROR

export interface SessionStateDescriptor {
  /** Stable id used at the AgentEvent boundary. */
  id: string
  /** Human-friendly label (lowercased; consumer can capitalise as needed). */
  label: string
  /** Single-glyph icon used by the status bar. */
  glyph: string
  /** Severity bucket that drives default color rendering. */
  severity: StateSeverity
}

/**
 * Canonical state list. Order matches the lifecycle progression documented
 * in CLAUDE.md (`INITIALIZING → IDLE → RUNNING → WAITING_FOR_* →
 * INTERRUPTING → ERROR / SHUTTING_DOWN`).
 *
 * Glyphs and labels come from the previously-duplicated `stateIcon` /
 * `stateColor` switches in `frontends/tui/status-bar/data.ts` and
 * `phaseLabel` in `frontends/slack-monitor/context/store.ts`.
 */
export const SESSION_STATES = [
  {
    id: "INITIALIZING",
    label: "booting",
    glyph: "\u25CC", // dotted circle
    severity: "neutral",
  },
  {
    id: "IDLE",
    label: "idle",
    glyph: "\u25CF", // filled circle
    severity: "neutral",
  },
  {
    id: "RUNNING",
    label: "running",
    glyph: "\u27F3", // anticlockwise gapped circle arrow
    severity: "active",
  },
  {
    id: "WAITING_FOR_PERM",
    label: "needs approval",
    glyph: "\u26A0", // warning sign
    severity: "blocked",
  },
  {
    id: "WAITING_FOR_ELIC",
    label: "needs input",
    glyph: "?",
    severity: "blocked",
  },
  {
    id: "INTERRUPTING",
    label: "interrupting",
    glyph: "\u23F8", // double vertical bar (pause)
    severity: "blocked",
  },
  {
    id: "ERROR",
    label: "error",
    glyph: "\u2717", // ballot x
    severity: "error",
  },
  {
    id: "SHUTTING_DOWN",
    label: "shutting down",
    glyph: "\u25CC", // dotted circle (same as INITIALIZING — fades to gray)
    severity: "neutral",
  },
] as const satisfies readonly SessionStateDescriptor[]

/** Closed string-literal type derived from the registry. */
export type SessionState = typeof SESSION_STATES[number]["id"]

/**
 * Label table keyed by `SessionState`. Using `Record<SessionState, ...>` is
 * load-bearing: TypeScript flags any case the consumer forgot when the
 * enumeration grows. This used to be three separate switches that
 * disagreed about INITIALIZING / SHUTTING_DOWN coverage (live bug L5).
 */
export const STATE_LABELS: Record<SessionState, string> = Object.fromEntries(
  SESSION_STATES.map((s) => [s.id, s.label]),
) as Record<SessionState, string>

/** Glyph table keyed by `SessionState`. See note on STATE_LABELS. */
export const STATE_GLYPHS: Record<SessionState, string> = Object.fromEntries(
  SESSION_STATES.map((s) => [s.id, s.glyph]),
) as Record<SessionState, string>

/** Severity table keyed by `SessionState`. */
export const STATE_SEVERITIES: Record<SessionState, StateSeverity> =
  Object.fromEntries(SESSION_STATES.map((s) => [s.id, s.severity])) as Record<
    SessionState,
    StateSeverity
  >

/** True if `id` matches a registered session state. */
export function isKnownSessionState(id: string): id is SessionState {
  return SESSION_STATES.some((s) => s.id === id)
}

/** All registered session state ids, in lifecycle order. */
export function knownSessionStateIds(): SessionState[] {
  return SESSION_STATES.map((s) => s.id)
}
