/**
 * Status-reaction state machine.
 *
 * Per plan §4, the bot communicates its live status via a single emoji
 * reaction on the triggering user message. Transitions remove the previous
 * emoji and add the next one; on error the reaction falls back to ❌.
 *
 * This module is pure of Bolt types — it uses a narrow `ReactionAdapter`
 * surface so tests wire in a fake (same pattern as the outbox).
 *
 * Mapping (Unicode emoji → Slack shortcode):
 *   🕐  :clock3:                  → queued
 *   🌀  :cyclone:                 → accepted, starting
 *   🧠  :brain:                   → thinking / first text
 *   👀  :eyes:                    → Read / Grep / Glob
 *   ✏️  :pencil2:                  → Edit / Write
 *   🛠️  :hammer_and_wrench:       → Bash / shell
 *   🌐  :globe_with_meridians:    → WebFetch / WebSearch
 *   🤖  :robot_face:              → subagent / task
 *   🔐  :lock:                    → permission_request
 *   ❓  :question:                → elicitation_request
 *   🧹  :broom:                   → compact
 *   ✅  :white_check_mark:         → turn_complete
 *   🛑  :octagonal_sign:          → interrupted
 *   ❌  :x:                       → error (fatal)
 *   ⏳  :hourglass_flowing_sand:  → rate-limited
 *
 * Callers instantiate one StatusReactionController per triggering message
 * and feed it AgentEvents. The controller debounces so a burst of
 * tool_use_start events doesn't thrash the reactions API.
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

export type ReactionState =
  | "queued"
  | "working"
  | "thinking"
  | "reading"
  | "editing"
  | "shell"
  | "web"
  | "subagent"
  | "awaiting_approval"
  | "awaiting_answer"
  | "compacting"
  | "rate_limited"
  | "done"
  | "interrupted"
  | "error"

export const STATE_TO_SHORTCODE: Record<ReactionState, string> = {
  queued: "clock3",
  working: "cyclone",
  thinking: "brain",
  reading: "eyes",
  editing: "pencil2",
  shell: "hammer_and_wrench",
  web: "globe_with_meridians",
  subagent: "robot_face",
  awaiting_approval: "lock",
  awaiting_answer: "question",
  compacting: "broom",
  rate_limited: "hourglass_flowing_sand",
  done: "white_check_mark",
  interrupted: "octagonal_sign",
  error: "x",
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"])
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"])
const SHELL_TOOLS = new Set(["Bash", "Shell", "KillBash", "BashOutput"])
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"])

/**
 * Pure state-transition function: given the current state and an AgentEvent,
 * return the next state (or `undefined` to leave unchanged). This lets the
 * controller decide whether to hit the API at all.
 */
export function nextReactionState(
  current: ReactionState,
  event: ConversationEvent,
): ReactionState | undefined {
  switch (event.type) {
    case "session_init":
      return current === "queued" ? "working" : undefined
    case "turn_start":
      // Reset to "working" for each new turn so tool-specific reactions apply
      // only to the current turn.
      return "working"
    case "thinking_delta":
      return current === "thinking" ? undefined : "thinking"
    case "text_delta":
    case "text_complete":
      // When the model starts producing text, we're in the "thinking → reply"
      // phase. Only flip from the prep states, not from tool states — we want
      // the tool emoji to persist while the user can still see its output.
      if (current === "working" || current === "thinking") return "thinking"
      return undefined
    case "tool_use_start": {
      const next = classifyTool(event.tool)
      return next === current ? undefined : next
    }
    case "permission_request":
      return "awaiting_approval"
    case "permission_response":
      return "working"
    case "elicitation_request":
      return "awaiting_answer"
    case "elicitation_response":
      return "working"
    case "compact":
      return "compacting"
    case "turn_complete":
      return "done"
    case "rate_limit_update":
      if ("blocked" in event && event.blocked === true) return "rate_limited"
      if (current === "rate_limited" && "blocked" in event && event.blocked === false) return "working"
      return undefined
    case "error":
      if (event.severity === "fatal") return "error"
      return undefined
    case "interrupt":
      return "interrupted"
    default:
      return undefined
  }
}

function classifyTool(tool: string): ReactionState {
  if (READ_TOOLS.has(tool)) return "reading"
  if (WRITE_TOOLS.has(tool)) return "editing"
  if (SHELL_TOOLS.has(tool)) return "shell"
  if (WEB_TOOLS.has(tool)) return "web"
  if (tool.startsWith("mcp__")) return "working" // MCP tools: keep generic
  return "working"
}

// ---------------------------------------------------------------------------
// Controller — applies transitions to the API.
// ---------------------------------------------------------------------------

export interface StatusReactionOpts {
  adapter: ReactionAdapter
  channel: string
  /** ts of the user message the reaction lives on. */
  triggerTs: string
  /** Initial state (default: "queued"). */
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
  let state: ReactionState = opts.initial ?? "queued"
  let applied: string | undefined = undefined // the emoji currently on the message
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
