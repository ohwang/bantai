/**
 * Status-reaction state machine.
 *
 * Per-turn lifecycle, drastically simplified (prior revisions tracked 15
 * states and burned reactions.add / reactions.remove on every tool, thinking
 * pulse, and permission request — we consistently hit Slack's reaction
 * rate limit). The contract now is:
 *
 *   1. On the first event of a turn we react with a single "working" emoji
 *      (:cyclone:) on the user's trigger message.
 *   2. Intermediate state changes (tool calls, thinking, permission /
 *      elicitation waits, compaction, rate-limit blips) do NOT retouch the
 *      reaction. The thread-status banner (view/thread-status.ts) already
 *      carries that detail via `assistant.threads.setStatus` — no reason
 *      to double up on the reaction API.
 *   3. On `turn_complete` we REMOVE the working emoji and add nothing —
 *      :white_check_mark: is reserved for humans marking work as reviewed,
 *      not for the bot announcing its own completion. A clean trigger
 *      message signals "done" implicitly.
 *   4. On interrupt / fatal error we swap to :octagonal_sign: / :x:.
 *
 * Budget: at most 2 emoji-surface transitions per turn (add + remove on
 * happy path; add + remove + add on interrupt/error). Never :white_check_mark:.
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

export type ReactionState = "working" | "done" | "interrupted" | "error"

/**
 * Map from state → Slack shortcode. An empty string means "no emoji" — the
 * controller clears the prior reaction without adding a new one. We use
 * this for `done` so the happy path ends with a clean trigger message
 * (never :white_check_mark: — reserved for humans).
 */
export const STATE_TO_SHORTCODE: Record<ReactionState, string> = {
  working: "cyclone",
  done: "",
  interrupted: "octagonal_sign",
  error: "x",
}

/**
 * Pure state-transition function: given the current state and an AgentEvent,
 * return the next state (or `undefined` to leave unchanged).
 *
 * The machine intentionally ignores tool_use_*, thinking_delta, text_delta,
 * permission_*, elicitation_*, compact, and rate_limit_update. Those used
 * to flip the emoji in older revisions and were the primary cause of
 * rate-limit pain on long turns.
 */
export function nextReactionState(
  current: ReactionState,
  event: ConversationEvent,
): ReactionState | undefined {
  switch (event.type) {
    case "session_init":
    case "turn_start":
      // Reset to working at the start of every turn (also handles a fresh
      // controller whose initial state is something other than "working").
      return current === "working" ? undefined : "working"
    case "turn_complete":
      return "done"
    case "interrupt":
      return "interrupted"
    case "error":
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
  /** Force a terminal state (e.g. on process shutdown) and flush. */
  terminate(state: "done" | "interrupted" | "error"): Promise<void>
  /** Current reaction state (read-only). */
  current(): ReactionState
}

export function createStatusReactionController(
  opts: StatusReactionOpts,
): StatusReactionController {
  let state: ReactionState = opts.initial ?? "working"
  /**
   * The shortcode currently attached to the trigger message. `""` means
   * no emoji is applied — either we haven't added one yet or the `done`
   * state cleared it.
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
      // Terminal clear (e.g. `done`) — nothing to add, just stamp the clock
      // so a follow-on throttled call still waits the right amount.
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
      state = terminal
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
