/**
 * Session phase reducer.
 *
 * The state machine described in AGENTS.md (INITIALIZING → IDLE → RUNNING →
 * WAITING_FOR_PERM / WAITING_FOR_ELIC → INTERRUPTING → ERROR /
 * SHUTTING_DOWN) lives inside SessionHost and the various adapters, but
 * is not currently exposed as a single value. Rather than plumb a
 * `host.phase` accessor through every backend, the admin surface derives
 * phase from the event stream that already flows through the registry.
 *
 * This is the same "reducer-is-the-authority" pattern the TUI uses for
 * ConversationState. It keeps Codex / ACP / mock / Gemini backends
 * untouched and makes any future state machine growth (e.g. a compaction
 * phase) a one-line change here rather than N parallel refactors.
 *
 * `UNKNOWN` is the initial value: a monitor that connects before the
 * first event has arrived sees "unknown" rather than a false "IDLE".
 * Any event that doesn't affect phase leaves `current` unchanged — so
 * streaming text deltas never flicker the label.
 */

import type { AgentEvent } from "../../../protocol/types"
import type { SessionPhase } from "./protocol"

/**
 * Pure event → phase projection. Returns the new phase given the current
 * one and the incoming event. Unknown / uninteresting events return the
 * input unchanged; never mutate in place.
 */
export function nextPhase(
  current: SessionPhase,
  event: AgentEvent,
): SessionPhase {
  switch (event.type) {
    case "session_init":
      // Backend has booted and announced its tools / models. The turn
      // machine is now idle waiting for the first user message.
      return "IDLE"
    case "turn_start":
      return "RUNNING"
    case "permission_request":
      return "WAITING_FOR_PERM"
    case "permission_response":
      // Permission was resolved by the Slack card or the admin — we flip
      // back to RUNNING and let the backend continue. A subsequent
      // turn_complete will move us to IDLE.
      return "RUNNING"
    case "elicitation_request":
      return "WAITING_FOR_ELIC"
    case "elicitation_response":
      return "RUNNING"
    case "turn_complete":
      return "IDLE"
    case "interrupt":
      // Synthetic event; may arrive before the backend acknowledges.
      return "INTERRUPTING"
    case "error":
      // Only fatal errors latch us into ERROR — recoverable errors (e.g.
      // a single tool_use rejection) leave the turn running.
      if (event.severity === "fatal") return "ERROR"
      return current
    case "shutdown":
      return "SHUTTING_DOWN"
    default:
      return current
  }
}

export interface PhaseObservation {
  prev: SessionPhase
  next: SessionPhase
  changed: boolean
}

/**
 * Stateful wrapper around `nextPhase`. The launcher (item 6) keeps one
 * per session and publishes a `session_phase` frame whenever
 * `observe(event).changed === true`. Starting phase is configurable so
 * a rehydrated session can begin at "IDLE" (the store already knows it
 * was past initialisation) rather than the default "UNKNOWN".
 */
export interface PhaseTracker {
  /** Current phase. */
  current(): SessionPhase
  /** Feed an event, return prev/next/changed. */
  observe(event: AgentEvent): PhaseObservation
  /** Force-set the phase (used when the registry is externally certain). */
  set(phase: SessionPhase): PhaseObservation
}

export function createPhaseTracker(
  initial: SessionPhase = "UNKNOWN",
): PhaseTracker {
  let phase: SessionPhase = initial
  return {
    current() {
      return phase
    },
    observe(event) {
      const prev = phase
      const next = nextPhase(prev, event)
      if (next === prev) return { prev, next, changed: false }
      phase = next
      return { prev, next, changed: true }
    },
    set(target) {
      const prev = phase
      if (target === prev) return { prev, next: target, changed: false }
      phase = target
      return { prev, next: target, changed: true }
    },
  }
}
