/**
 * Status-reaction state machine.
 *
 * Per-turn lifecycle, deliberately small (prior revisions tracked 15 states
 * and burned reactions.add / reactions.remove on every tool, thinking pulse,
 * and permission request — we consistently hit Slack's reaction rate limit).
 * The contract now is:
 *
 *   1. Four states, one emoji each:
 *        working      💬 :speech_balloon:   — agent is actively processing
 *        waiting      📍 :round_pushpin:    — agent is done OR waiting on
 *                                             the user (permission / answer)
 *        interrupted  🍉 :watermelon:       — `interrupt` event (user stop /
 *                                             turn timeout / budget cap)
 *        error        🛑 :octagonal_sign:   — fatal error (session state
 *                                             compromised — connection lost,
 *                                             protocol fault, backend crash)
 *   2. Intermediate events do NOT retouch the reaction: tool_use_*,
 *      thinking_delta, text_delta, compact, rate_limit_update, and
 *      recoverable errors. The thread-status banner (view/thread-status.ts)
 *      carries that detail via `assistant.threads.setStatus` — no need to
 *      double up on the reactions API.
 *   3. permission_request / elicitation_request flip to `waiting`; the
 *      matching _response flips back to `working`. If both land in the
 *      same event batch (auto-approve policy), the coalescer collapses
 *      them to zero API calls.
 *   4. :white_check_mark: is NEVER emitted — reserved for humans marking
 *      work as reviewed. Humans remain free to add ✅ themselves; the bot
 *      simply doesn't use that emoji anywhere.
 *
 * This module is pure of Bolt types — it uses a narrow `ReactionAdapter`
 * surface so tests wire in a fake (same pattern as the outbox).
 */

import type { ConversationEvent } from "../../../protocol/types"
import { log } from "../../../utils/logger"

// ---------------------------------------------------------------------------
// Adapter — narrow surface for reactions.add / reactions.remove.
// ---------------------------------------------------------------------------

export interface ReactionAdapter {
  addReaction(args: { channel: string; timestamp: string; name: string }): Promise<void>
  removeReaction(args: { channel: string; timestamp: string; name: string }): Promise<void>
}

// ---------------------------------------------------------------------------
// State derivation
// ---------------------------------------------------------------------------

export type ReactionState = "working" | "waiting" | "interrupted" | "error"

export const STATE_TO_SHORTCODE: Record<ReactionState, string> = {
  working: "speech_balloon",
  waiting: "round_pushpin",
  interrupted: "watermelon",
  error: "octagonal_sign",
}

/**
 * Pure state-transition function: given the current state and an AgentEvent,
 * return the next state (or `undefined` to leave unchanged).
 */
export function nextReactionState(
  current: ReactionState,
  event: ConversationEvent,
): ReactionState | undefined {
  switch (event.type) {
    case "session_init":
    case "turn_start":
      // Starting (or re-entering) a turn. No-op if we're already working —
      // keeps the :speech_balloon: stable and avoids a redundant API flip.
      return current === "working" ? undefined : "working"
    case "permission_request":
    case "elicitation_request":
      // Agent is blocked waiting on user input. Same surface as turn_complete:
      // ball is in the user's court.
      return current === "waiting" ? undefined : "waiting"
    case "permission_response":
    case "elicitation_response":
      // User answered; agent resumes work.
      return current === "working" ? undefined : "working"
    case "turn_complete":
      return "waiting"
    case "interrupt":
      return "interrupted"
    case "error":
      // Only fatal errors mean "session state is compromised." Recoverable
      // errors surface as inline [warn] posts — the reaction stays put.
      if (event.severity === "fatal") return "error"
      return undefined
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Controller — applies transitions to the API.
// ---------------------------------------------------------------------------

export interface StatusReactionOpts {
  adapter: ReactionAdapter
  channel: string
  /** ts of the user message the reaction lives on. */
  triggerTs: string
  /** Initial state (default: "working"). */
  initial?: ReactionState
  /** Minimum ms between reaction transitions — throttles flapping. */
  minTransitionMs?: number
  /** Test hook: override Date.now. */
  now?: () => number
}

export interface StatusReactionController {
  /** Drive the state machine with one event. */
  apply(event: ConversationEvent): void
  /**
   * Force a terminal state (e.g. on process shutdown) and flush.
   * "done" maps to the `waiting` state — the agent finished and the
   * ball is back in the user's court.
   */
  terminate(state: "done" | "interrupted" | "error"): Promise<void>
  /** Current reaction state (read-only). */
  current(): ReactionState
}

/**
 * Translate the terminate() keyword into an internal state. "done" is
 * the public name for the normal-completion case; internally the
 * controller treats it as `waiting` (📍 — agent is idle, user's turn).
 */
function terminalToState(terminal: "done" | "interrupted" | "error"): ReactionState {
  if (terminal === "done") return "waiting"
  return terminal
}

export function createStatusReactionController(
  opts: StatusReactionOpts,
): StatusReactionController {
  let state: ReactionState = opts.initial ?? "working"
  /**
   * The shortcode currently attached to the trigger message. `""` means
   * no emoji is applied — either we haven't added one yet or a prior
   * removal failed to re-add anything (shouldn't happen with the new
   * design, but the code still handles it safely).
   */
  let applied = ""
  let inflight: Promise<void> = Promise.resolve()
  // When true, exactly one syncReaction call is already queued on `inflight`.
  // Further state changes just update `state`; the pending call will read
  // the latest value when it runs, collapsing all intermediate transitions.
  let flushScheduled = false
  const minMs = opts.minTransitionMs ?? 0
  const now = opts.now ?? Date.now
  let lastTransitionAt = 0

  // Reads `state` at execution time — NOT the value captured at schedule time.
  // This is intentional: if multiple apply() calls fire before this runs, they
  // all update `state` but only one API round-trip is made for the final value.
  async function syncReaction(): Promise<void> {
    flushScheduled = false
    const shortcode = STATE_TO_SHORTCODE[state]
    if (shortcode === applied) return
    const elapsed = now() - lastTransitionAt
    if (elapsed < minMs) {
      await new Promise((r) => setTimeout(r, minMs - elapsed))
    }
    // Remove the previous before adding the new so Slack doesn't end up with
    // both simultaneously if a caller is watching the reaction list.
    if (applied) {
      try {
        await opts.adapter.removeReaction({
          channel: opts.channel,
          timestamp: opts.triggerTs,
          name: applied,
        })
      } catch (err) {
        log.warn(`slack reactions: removeReaction(${applied}) failed: ${String(err)}`)
      }
      applied = ""
    }
    if (!shortcode) {
      // Defensive: no state currently maps to the empty string, but if a
      // future state ever does we still stamp the clock so the next
      // throttled call waits the right amount.
      lastTransitionAt = now()
      return
    }
    try {
      await opts.adapter.addReaction({
        channel: opts.channel,
        timestamp: opts.triggerTs,
        name: shortcode,
      })
      applied = shortcode
      lastTransitionAt = now()
    } catch (err) {
      log.warn(`slack reactions: addReaction(${shortcode}) failed: ${String(err)}`)
    }
  }

  // Enqueue a single syncReaction if one isn't already pending. Multiple
  // state changes before the flush runs will all be collapsed into one call.
  function scheduleFlush(): void {
    if (flushScheduled) return
    flushScheduled = true
    inflight = inflight.then(syncReaction)
  }

  // Prime the initial reaction asynchronously — callers don't need to await.
  scheduleFlush()

  return {
    apply(event) {
      const next = nextReactionState(state, event)
      if (next === undefined || next === state) return
      state = next
      scheduleFlush()
    },
    async terminate(terminal) {
      state = terminalToState(terminal)
      // scheduleFlush is a no-op if a flush is already queued; that flush will
      // read `state = terminal` when it executes, so the terminal state is
      // guaranteed to be applied before the await resolves.
      scheduleFlush()
      await inflight
    },
    current() {
      return state
    },
  }
}
