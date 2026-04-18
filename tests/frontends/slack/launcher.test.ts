/**
 * Unit tests for the launcher's pure helpers. The launcher itself is
 * integration-tested in tests/frontends/slack/integration/*; this file
 * covers the small bits of logic that don't need a live Bolt + registry.
 */

import { describe, expect, it } from "bun:test"
import { mergeCumulativeUsage } from "../../../src/frontends/slack/launcher"

describe("mergeCumulativeUsage", () => {
  it("returns zeroes when both live and prior are undefined", () => {
    const out = mergeCumulativeUsage(undefined, undefined)
    expect(out).toEqual({
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
    })
  })

  it("passes through live when prior is absent (fresh session)", () => {
    const live = {
      turns: 2,
      inputTokens: 500,
      outputTokens: 1200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0.12,
    }
    expect(mergeCumulativeUsage(live, undefined)).toEqual(live)
  })

  it("adds prior turns + cost on top of live (post-restart session)", () => {
    const live = {
      turns: 1,
      inputTokens: 500,
      outputTokens: 800,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0.04,
    }
    const prior = { turns: 3, totalCostUsd: 0.25 }
    const out = mergeCumulativeUsage(live, prior)
    expect(out.turns).toBe(4)
    expect(out.totalCostUsd).toBeCloseTo(0.29, 5)
    // Token breakdowns do NOT fold prior — tokens don't persist, by design.
    expect(out.inputTokens).toBe(500)
    expect(out.outputTokens).toBe(800)
  })

  it("reports prior-only totals when renderer is absent (post-restart, pre-first-turn)", () => {
    const out = mergeCumulativeUsage(undefined, { turns: 7, totalCostUsd: 0.4 })
    expect(out.turns).toBe(7)
    expect(out.totalCostUsd).toBeCloseTo(0.4, 5)
    expect(out.inputTokens).toBe(0)
  })
})
