/**
 * Block Kit builder for thinking breakouts (plan §3.3 "Thinking" row).
 *
 * Only rendered at verbosity ≥ verbose. Posted as a "context" section —
 * italicised, subtle, distinct from the assistant body. Updated in place
 * as thinking_delta accumulates, so long reasoning chains stay in a
 * single message rather than spamming the thread.
 *
 * No interactivity today. A future S5+ polish pass could add a "Show all"
 * button once the cumulative thinking passes a threshold; deferred.
 *
 * Pure of IO.
 */

import type { KnownBlock } from "@slack/types"
import type { VerbosityLevel } from "../../config/schema"

export interface ThinkingBlockInput {
  /** Accumulated thinking text for the current turn. */
  text: string
  verbosity: VerbosityLevel
}

export interface RenderedThinking {
  text: string
  blocks: KnownBlock[]
}

/**
 * Slack mrkdwn caps a single block at 3000 chars. We keep 400 chars of
 * headroom for surrounding context + format overhead.
 */
const MAX_THINKING_CHARS = 2600

/**
 * Returns null when the thinking block shouldn't be rendered (verbosity
 * below verbose, or empty text).
 */
export function buildThinkingBlocks(input: ThinkingBlockInput): RenderedThinking | null {
  if (input.verbosity !== "verbose" && input.verbosity !== "debug") return null
  const text = input.text.trim()
  if (text.length === 0) return null

  const display = truncate(text, MAX_THINKING_CHARS)

  const blocks: KnownBlock[] = [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `:thought_balloon: _thinking…_` }],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `> _${escapeMrkdwn(display)}_` },
    },
  ]

  return {
    text: "thinking…",
    blocks,
  }
}

/**
 * Escape Slack mrkdwn control chars that could be misinterpreted inside
 * the italic wrapper (`*`, `_`, backtick). Conservative — we don't try to
 * preserve intentional markdown inside a thinking trace.
 */
function escapeMrkdwn(s: string): string {
  return s.replace(/([_*`])/g, "\\$1")
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return `${s.slice(0, Math.max(1, maxLen - 1))}…`
}
