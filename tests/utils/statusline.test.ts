import { describe, expect, it } from "bun:test"
import { buildStatusLineInput } from "../../src/utils/statusline"
import type { SessionContextState } from "../../src/frontends/tui/context/session"

function baseSessionState(): SessionContextState {
  return {
    sessionState: "IDLE",
    session: null,
    cost: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0,
    },
    lastError: null,
    turnNumber: 0,
    lastTurnInputTokens: 0,
    lastTurnTtftMs: null,
    currentModel: "gpt-5",
    currentEffort: "",
    rateLimits: null,
    agentCommands: [],
    configOptions: [],
    supportedPermissionModes: [],
    resuming: false,
    currentCwd: null,
    worktree: null,
  }
}

describe("buildStatusLineInput", () => {
  it("synthesizes Codex backend_rate_limits from 5h/7d buckets", () => {
    const input = buildStatusLineInput({
      ...baseSessionState(),
      rateLimits: {
        fiveHour: {
          usedPercentage: 12,
          resetsAt: 1775019636,
          windowDurationMins: 300,
        },
        sevenDay: {
          usedPercentage: 8,
          resetsAt: 1775206513,
          windowDurationMins: 10080,
        },
      },
    }, {
      backendName: "codex",
    })

    expect(input.rate_limits).toEqual({
      five_hour: {
        used_percentage: 12,
        resets_at: 1775019636,
      },
      seven_day: {
        used_percentage: 8,
        resets_at: 1775206513,
      },
    })

    expect(input.backend_rate_limits).toEqual({
      primary: {
        used_percentage: 12,
        resets_at: 1775019636,
        window_duration_mins: 300,
      },
      secondary: {
        used_percentage: 8,
        resets_at: 1775206513,
        window_duration_mins: 10080,
      },
    })
  })

  it("preserves native Codex primary/secondary windows when present", () => {
    const input = buildStatusLineInput({
      ...baseSessionState(),
      rateLimits: {
        primary: {
          usedPercentage: 25,
          resetsAt: 1775019636,
          windowDurationMins: 15,
        },
        secondary: {
          usedPercentage: 40,
          resetsAt: 1775020236,
          windowDurationMins: 60,
        },
      },
    }, {
      backendName: "codex",
    })

    expect(input.rate_limits).toBeUndefined()
    expect(input.backend_rate_limits).toEqual({
      primary: {
        used_percentage: 25,
        resets_at: 1775019636,
        window_duration_mins: 15,
      },
      secondary: {
        used_percentage: 40,
        resets_at: 1775020236,
        window_duration_mins: 60,
      },
    })
  })
})
