/**
 * Regression test for Cluster 9 — RateLimitUpdateEvent bucket centralization.
 *
 * Pre-anti-drift, the closed set of rate-limit "buckets" lived in three places:
 *
 *   1. `RateLimitUpdateEvent.rateLimitType` union in protocol/types.ts (7 ids).
 *   2. A hand-rolled `||` validation chain in claude/event-mapper.ts (5 of 7).
 *   3. A switch in protocol/reducer.ts that routed each id into a RateLimits
 *      slot — silently dropping any bucket the switch hadn't been updated for.
 *
 * The recipe (CLAUDE.md → drift-contract recipe) collapses this onto a single
 * `RATE_LIMIT_BUCKETS` registry + `BUCKET_SLOT_STRATEGY` map. These tests pin
 * the invariants:
 *
 *   - The wire-level union and the registry are the same closed set.
 *   - Every registry entry has a slot strategy (exhaustive Record).
 *   - The Claude validator accepts every Claude-source bucket and rejects
 *     unknown ids.
 *   - The reducer routes every bucket into the slot the strategy declares.
 */

import { describe, it, expect } from "bun:test"
import {
  RATE_LIMIT_BUCKETS,
  BUCKET_SLOT_STRATEGY,
  isKnownRateLimitBucket,
  knownRateLimitBucketIds,
} from "../../src/protocol/rate-limits"
import type { RateLimitBucket } from "../../src/protocol/rate-limits"
import { reduce } from "../../src/protocol/reducer"
import { createInitialState } from "../../src/protocol/types"

describe("rate-limit bucket registry (Cluster 9)", () => {
  it("registers every bucket the wire-level union claims", () => {
    // If a new bucket id is added to RateLimitUpdateEvent.rateLimitType
    // without a corresponding registry entry, this list goes out of sync —
    // the test must be updated alongside the union, the same way `claude`
    // entered BACKEND_REGISTRY when it joined the protocol.
    const expected = [
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "seven_day_sonnet",
      "overage",
      "primary",
      "secondary",
    ]
    expect(knownRateLimitBucketIds()).toEqual(expected as readonly RateLimitBucket[])
  })

  it("has a slot strategy for every registered bucket", () => {
    for (const b of RATE_LIMIT_BUCKETS) {
      const strategy = BUCKET_SLOT_STRATEGY[b.id]
      expect(strategy).toBeDefined()
      expect(strategy.slot).toBe(b.strategy.slot)
      expect(strategy.mode).toBe(b.strategy.mode)
    }
  })

  it("isKnownRateLimitBucket accepts every registered id", () => {
    for (const b of RATE_LIMIT_BUCKETS) {
      expect(isKnownRateLimitBucket(b.id)).toBe(true)
    }
  })

  it("isKnownRateLimitBucket rejects unknown ids and non-strings", () => {
    expect(isKnownRateLimitBucket("nope")).toBe(false)
    expect(isKnownRateLimitBucket("")).toBe(false)
    expect(isKnownRateLimitBucket(undefined)).toBe(false)
    expect(isKnownRateLimitBucket(null)).toBe(false)
    expect(isKnownRateLimitBucket(42)).toBe(false)
  })

  it("reducer routes every bucket into the slot its strategy declares", () => {
    // For each bucket: emit a rate_limit_update with utilisation 0.5 and
    // confirm the slot the strategy points to is filled. This exercises the
    // full `BUCKET_SLOT_STRATEGY` table — replacing the previous hand-rolled
    // switch that silently dropped buckets in `default`.
    for (const bucket of knownRateLimitBucketIds()) {
      const state = createInitialState()
      const next = reduce(state, {
        type: "rate_limit_update",
        rateLimitType: bucket,
        utilization: 0.5,
        resetsAt: 1700000000,
        source: "claude",
      })
      const strategy = BUCKET_SLOT_STRATEGY[bucket]
      const slot = strategy.slot
      expect(next.rateLimits?.[slot]?.usedPercentage).toBe(50)
    }
  })

  it("'overage' bucket uses set-if-empty so it does not clobber a real primary reading", () => {
    // First push a real Codex `primary` reading at 80%.
    let state = createInitialState()
    state = reduce(state, {
      type: "rate_limit_update",
      rateLimitType: "primary",
      utilization: 0.8,
      source: "codex",
    })
    expect(state.rateLimits?.primary?.usedPercentage).toBe(80)

    // Then a Claude `overage` reading at 10% — should NOT overwrite the
    // primary slot because the strategy is `set-if-empty`.
    state = reduce(state, {
      type: "rate_limit_update",
      rateLimitType: "overage",
      utilization: 0.1,
      source: "claude",
    })
    expect(state.rateLimits?.primary?.usedPercentage).toBe(80)
  })

  it("'overage' bucket fills primary when no primary exists", () => {
    let state = createInitialState()
    state = reduce(state, {
      type: "rate_limit_update",
      rateLimitType: "overage",
      utilization: 0.25,
      source: "claude",
    })
    expect(state.rateLimits?.primary?.usedPercentage).toBe(25)
  })
})
