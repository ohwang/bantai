/**
 * Cumulative-usage helpers — pure functions shared by the launcher's
 * `/bantai cost` context builder and any other surface that merges
 * live in-memory usage with the persisted prior-session totals read
 * from the session store.
 *
 * Extracted from `launcher.ts` so the launcher stays near the project's
 * ~500-line file guideline and so the merge logic has a clean home for
 * unit tests to target (tests/frontends/slack/launcher.test.ts).
 */

import type { CumulativeUsage } from "./view/event-renderer"

/**
 * Merge the live (in-memory) renderer usage with the persisted prior usage
 * read from the session store. Cumulative turns + totalCostUsd span process
 * restarts; token breakdowns are in-process only (not persisted, so a
 * bounce resets them — documented tradeoff).
 */
export function mergeCumulativeUsage(
  live: CumulativeUsage | undefined,
  prior: { turns: number; totalCostUsd: number } | undefined,
): CumulativeUsage {
  const base = live ?? {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0,
  }
  const p = prior ?? { turns: 0, totalCostUsd: 0 }
  return {
    ...base,
    turns: base.turns + p.turns,
    totalCostUsd: base.totalCostUsd + p.totalCostUsd,
  }
}
