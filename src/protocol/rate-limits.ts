/**
 * Rate-limit bucket registry — single source of truth for the closed set of
 * rate-limit "windows" backends report.
 *
 * Drift-contract recipe (see CLAUDE.md → "The drift-contract recipe"):
 *   - typed array of descriptors          → RATE_LIMIT_BUCKETS
 *   - derived id type                     → RateLimitBucket
 *   - validators / iterators next to it   → isKnownRateLimitBucket(),
 *                                           knownRateLimitBucketIds()
 *   - exhaustive Record for routing       → BUCKET_SLOT_STRATEGY
 *
 * Anti-drift sprint, Cluster 9: this collapses three previous copies of the
 * "which buckets exist" set:
 *   1. The string-literal union on `RateLimitUpdateEvent.rateLimitType`
 *      (protocol/types.ts) — was 7 members.
 *   2. The hand-rolled `||` validation chain in claude/event-mapper.ts —
 *      listed only 5 members (deliberately omitted `primary` / `secondary`
 *      because the Claude SDK doesn't emit them, but the gap was a silent
 *      "if SDK adds them tomorrow, we drop them") and forced the noisy
 *      cast `(info.status as any)`.
 *   3. The switch over `event.rateLimitType` in protocol/reducer.ts that
 *      routed each bucket into one of four `RateLimits` slots.
 *
 * Adding a new bucket now means appending one entry to RATE_LIMIT_BUCKETS
 * and one entry to BUCKET_SLOT_STRATEGY. Both are typed against the derived
 * `RateLimitBucket`, so missing either side is a compile error.
 */

import type { RateLimits } from "./types"

/**
 * Strategy describing how a single bucket's update folds into the
 * `RateLimits` aggregate. Two modes today:
 *   - "set"            — overwrite the named slot every time.
 *   - "set-if-empty"   — only fill the slot if it's currently empty
 *                        (used by the Claude `overage` window, which is a
 *                        secondary indicator on top of an existing primary
 *                        and shouldn't clobber a real reading).
 */
export type RateLimitSlotStrategy =
  | { slot: keyof RateLimits; mode: "set" }
  | { slot: keyof RateLimits; mode: "set-if-empty" }

export interface RateLimitBucketDescriptor {
  /** Wire-level bucket id (matches what backends emit). */
  id: string
  /** Origin backend (for documentation; not enforced at runtime). */
  source: "claude" | "codex"
  /** How the reducer folds an update for this bucket into RateLimits. */
  strategy: RateLimitSlotStrategy
  /** Short human-readable description for documentation. */
  description: string
}

export const RATE_LIMIT_BUCKETS = [
  {
    id: "five_hour",
    source: "claude",
    strategy: { slot: "fiveHour", mode: "set" },
    description: "Claude five-hour subscription window",
  },
  {
    id: "seven_day",
    source: "claude",
    strategy: { slot: "sevenDay", mode: "set" },
    description: "Claude generic seven-day subscription window",
  },
  {
    id: "seven_day_opus",
    source: "claude",
    strategy: { slot: "sevenDay", mode: "set" },
    description: "Claude seven-day Opus-specific window",
  },
  {
    id: "seven_day_sonnet",
    source: "claude",
    strategy: { slot: "sevenDay", mode: "set" },
    description: "Claude seven-day Sonnet-specific window",
  },
  {
    id: "overage",
    source: "claude",
    // Overage credits are a secondary signal layered on top of the primary
    // 5h / 7d window — when a real primary entry is already present we keep
    // it, otherwise the overage utilisation gives us *something* to render.
    strategy: { slot: "primary", mode: "set-if-empty" },
    description: "Claude overage pool (claude.ai overage credits)",
  },
  {
    id: "primary",
    source: "codex",
    strategy: { slot: "primary", mode: "set" },
    description: "Codex generic primary window (used when duration ≠ 5h/7d)",
  },
  {
    id: "secondary",
    source: "codex",
    strategy: { slot: "secondary", mode: "set" },
    description: "Codex generic secondary window",
  },
] as const satisfies readonly RateLimitBucketDescriptor[]

export type RateLimitBucket = typeof RATE_LIMIT_BUCKETS[number]["id"]

/** True if `id` is a known rate-limit bucket. Use this in event mappers'
 *  validation paths instead of hand-rolled `||` chains. */
export function isKnownRateLimitBucket(id: unknown): id is RateLimitBucket {
  if (typeof id !== "string") return false
  return RATE_LIMIT_BUCKETS.some((b) => b.id === id)
}

/** Iterable list of bucket ids — used by tests / debug surfaces. */
export function knownRateLimitBucketIds(): readonly RateLimitBucket[] {
  return RATE_LIMIT_BUCKETS.map((b) => b.id)
}

/**
 * Exhaustive bucket → slot strategy map, derived from RATE_LIMIT_BUCKETS so
 * the reducer can route a `rate_limit_update` to the correct `RateLimits`
 * field without a switch. Typed as `Record<RateLimitBucket, …>` so adding a
 * new bucket without a strategy is a compile error.
 */
export const BUCKET_SLOT_STRATEGY: Record<RateLimitBucket, RateLimitSlotStrategy> =
  Object.fromEntries(
    RATE_LIMIT_BUCKETS.map((b) => [b.id, b.strategy as RateLimitSlotStrategy]),
  ) as Record<RateLimitBucket, RateLimitSlotStrategy>
