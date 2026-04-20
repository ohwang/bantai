/**
 * Block Kit builder for ACP plan_update (plan §8.3).
 *
 * The agent emits a `plan_update` event with a list of `PlanEntry`. We
 * render it as a single Block Kit message: header + one bulleted line per
 * entry with status emoji (⏳ pending / 🔄 in_progress / ✅ completed /
 * ⛔ failed). A priority tag is appended in parentheses when present.
 *
 * On subsequent plan_updates the launcher reuses the same message ts and
 * calls chat.update — the event-renderer tracks the ts for us.
 *
 * Pure of IO. Verbosity gating stays in the renderer; at concise / silent
 * we simply don't post this block at all.
 */

import type { KnownBlock } from "@slack/types"
import type { PlanEntry } from "../../../../protocol/types"

export interface PlanCardInput {
  entries: PlanEntry[]
}

export interface RenderedPlan {
  text: string
  blocks: KnownBlock[]
}

// :heavy_check_mark: (not :white_check_mark:) for completed — ✅ is
// reserved for humans marking work as reviewed.
const STATUS_EMOJI: Record<NonNullable<PlanEntry["status"]>, string> = {
  pending: ":hourglass_flowing_sand:",
  in_progress: ":arrows_counterclockwise:",
  completed: ":heavy_check_mark:",
}

const PRIORITY_TAG: Record<NonNullable<PlanEntry["priority"]>, string> = {
  high: "high",
  medium: "medium",
  low: "low",
}

const MAX_LINE_CHARS = 220
const MAX_ENTRIES_RENDERED = 40

/**
 * Build the Block Kit payload for a plan. Returns `null` when there are no
 * entries — the launcher treats null as "nothing to render" so the update
 * path short-circuits cleanly.
 */
export function buildPlanBlocks(input: PlanCardInput): RenderedPlan | null {
  if (!input.entries || input.entries.length === 0) return null
  const visible = input.entries.slice(0, MAX_ENTRIES_RENDERED)
  const overflow = input.entries.length - visible.length

  const lines = visible.map(renderEntry)
  if (overflow > 0) lines.push(`_… +${overflow} more step${overflow === 1 ? "" : "s"}_`)

  const doneCount = visible.filter((e) => e.status === "completed").length
  const totalCount = input.entries.length
  const summary = `:clipboard: *Plan* — ${doneCount} of ${totalCount} done`

  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: summary } },
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
  ]
  return {
    text: `plan: ${doneCount}/${totalCount} done`,
    blocks,
  }
}

function renderEntry(entry: PlanEntry): string {
  const emoji = entry.status ? STATUS_EMOJI[entry.status] : ":white_small_square:"
  const priority = entry.priority ? ` _(${PRIORITY_TAG[entry.priority]})_` : ""
  const text = truncate(entry.content, MAX_LINE_CHARS)
  const strike = entry.status === "completed" ? `~${text}~` : text
  return `${emoji} ${strike}${priority}`
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return `${s.slice(0, Math.max(1, maxLen - 1))}…`
}
