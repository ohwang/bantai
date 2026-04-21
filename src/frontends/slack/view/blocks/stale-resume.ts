/**
 * Block Kit builder for the stale-resume recovery prompt.
 *
 * Posted when the router detects that a thread's persisted backend-session id
 * is unlikely to resolve on the currently-configured backend (either the
 * session file is gone from disk, or the channel's backend was swapped and
 * we'd be feeding a foreign id into `session/load`). The user picks one of
 * three strategies; the coordinator in `recovery/coordinator.ts` then
 * routes the queued turn accordingly.
 *
 *   - `fresh`   — start a new session on the current backend. Turn + cost
 *                 counters stay, but prior conversation history is gone.
 *   - `inject`  — start a new session, but inject the old session's
 *                 rendered history as a replayContext into the first turn.
 *                 Only offered when we're confident we can actually read
 *                 the foreign session (wiring lives in commit 5).
 *   - `cancel`  — drop the queued turn. The user can type again whenever.
 *
 * action_id encoding: `bantai:stale_resume:<promptId>:<decision>`
 *
 * Pure of IO — callers pass the message to `SendAdapter.postMessage` /
 * `updateMessage`.
 */

import type { KnownBlock } from "@slack/types"

export type StaleResumeDecision = "fresh" | "inject" | "cancel"

export type StaleResumeReason = "backend_mismatch" | "session_file_missing"

export interface StaleResumeCardInput {
  /**
   * Internal uuid — the SQLite `pending_resume_prompts.id` the coordinator
   * uses to look this up when the user clicks.
   */
  id: string
  /** Human-readable backend name (e.g. "Gemini", "Codex"). */
  currentBackendName: string
  /**
   * The *prior* backend we would have asked to resume. Only shown when
   * different from `currentBackendName` — i.e. the `backend_mismatch`
   * reason. Empty string / undefined for the `session_file_missing` case.
   */
  priorBackendName?: string
  /**
   * The `queued_turn.text` snippet so the approver remembers what they
   * typed. Truncated; stored verbatim in SQLite as `queued_turn_json`.
   */
  queuedTurnPreview: string
  /** Which branch of detection fired. */
  reason: StaleResumeReason
  /**
   * `true` when `inject` is actually wired for the current backend. We
   * gate the button on this so the UI never offers an option that will
   * error on click. Commit 5 flips it to `true` for the supported
   * preset(s); commit 4 leaves it `false` by default.
   */
  canInjectHistory: boolean
}

const MAX_PREVIEW_CHARS = 220

export function buildStaleResumeBlocks(input: StaleResumeCardInput): {
  text: string
  blocks: KnownBlock[]
} {
  const preview = truncate(input.queuedTurnPreview, MAX_PREVIEW_CHARS)

  const headline =
    input.reason === "backend_mismatch"
      ? ":warning: Previous session was on a different backend"
      : ":warning: Previous session is no longer available"

  const body =
    input.reason === "backend_mismatch"
      ? [
          `This thread's last session ran on *${input.priorBackendName ?? "a different backend"}*,`,
          `but the channel is now configured to use *${input.currentBackendName}*.`,
          "Carrying the prior session id into the new backend will fail,",
          "so I need to know how you want to recover.",
        ].join(" ")
      : [
          `I couldn't find this thread's prior *${input.currentBackendName}* session on disk —`,
          "the session file was deleted or moved. Your next message can't resume it,",
          "so I need to know how you want to recover.",
        ].join(" ")

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: headline, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: body },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Queued message*\n> ${escapeMrkdwn(preview)}`,
      },
    },
  ]

  const actions: KnownBlock = {
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "Start fresh", emoji: true },
        action_id: encodeActionId(input.id, "fresh"),
        value: input.id,
      },
      // The inject button is only added when the coordinator knows it can
      // actually read the prior session. When it can't, leaving the button
      // out keeps the UI honest — the user shouldn't see a choice that
      // errors on click.
      ...(input.canInjectHistory
        ? [
            {
              type: "button" as const,
              text: {
                type: "plain_text" as const,
                text: "Resume with history",
                emoji: true,
              },
              action_id: encodeActionId(input.id, "inject"),
              value: input.id,
            },
          ]
        : []),
      {
        type: "button",
        style: "danger",
        text: { type: "plain_text", text: "Cancel turn", emoji: true },
        action_id: encodeActionId(input.id, "cancel"),
        value: input.id,
      },
    ],
  }
  blocks.push(actions)

  const text = `stale session — pick a recovery strategy for ${input.currentBackendName}`
  return { text, blocks }
}

export function buildResolvedStaleResumeBlocks(args: {
  previous: StaleResumeCardInput
  resolver: { userId: string }
  decision: StaleResumeDecision
}): {
  text: string
  blocks: KnownBlock[]
} {
  const { previous, resolver, decision } = args
  const preview = truncate(previous.queuedTurnPreview, MAX_PREVIEW_CHARS)

  const badge = decision === "cancel" ? ":no_entry_sign:" : ":arrows_counterclockwise:"
  const outcome = outcomeText(decision, resolver.userId)

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${badge} Session recovery — ${outcome}`, emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          decision === "cancel"
            ? "The queued message was discarded; send a new one when you're ready."
            : decision === "inject"
              ? "Starting a new session and replaying the prior history as context…"
              : "Starting a new session — prior history is not being replayed.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Queued message*\n> ${escapeMrkdwn(preview)}`,
      },
    },
  ]
  return { text: `session recovery ${outcome}`, blocks }
}

// ---------------------------------------------------------------------------
// action_id codec
// ---------------------------------------------------------------------------

export function encodeActionId(
  id: string,
  decision: StaleResumeDecision,
): string {
  return `bantai:stale_resume:${id}:${decision}`
}

export interface ParsedStaleResumeAction {
  id: string
  decision: StaleResumeDecision
}

export function parseStaleResumeActionId(
  actionId: string,
): ParsedStaleResumeAction | null {
  const parts = actionId.split(":")
  if (parts.length !== 4) return null
  if (parts[0] !== "bantai" || parts[1] !== "stale_resume") return null
  const decision = parts[3] as StaleResumeDecision
  if (decision !== "fresh" && decision !== "inject" && decision !== "cancel") {
    return null
  }
  return { id: parts[2]!, decision }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  if (!s) return ""
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}

// Minimal escape — Slack mrkdwn treats &, <, > as the three entities that
// can break a section block. The leading `>` we use for the blockquote is
// on its own line so it doesn't collide.
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function outcomeText(decision: StaleResumeDecision, userId: string): string {
  switch (decision) {
    case "fresh":
      return `started fresh by <@${userId}>`
    case "inject":
      return `replayed with history by <@${userId}>`
    case "cancel":
      return `cancelled by <@${userId}>`
  }
}
