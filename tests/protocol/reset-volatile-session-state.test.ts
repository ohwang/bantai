/**
 * Unit tests for `resetVolatileSessionState()`.
 *
 * The helper's one job: on backend switch, reset the per-backend volatile
 * slice of `ConversationState` to the defaults from `createInitialState()`
 * while preserving `blocks` (conversation history) and cross-backend state.
 *
 * The backlog (reset-status-bar-on-backend-switch.md) calls out the exact
 * field list that must be reset — we assert each one matches the
 * initial-state factory so a drift between the two functions fails loudly.
 */

import { describe, expect, test } from "bun:test"
import {
  createInitialState,
  resetVolatileSessionState,
  type Block,
  type ConversationState,
} from "../../src/protocol/types"

/** Build a maximally "dirty" state — every field that status bar reads from
 *  has been populated by a prior turn on backend A. */
function dirtyState(): ConversationState {
  const blocks: Block[] = [
    { type: "user", text: "hello", images: undefined },
    { type: "assistant", text: "hi" },
  ]
  return {
    ...createInitialState(),
    sessionState: "IDLE",
    blocks,
    session: {
      sessionId: "old-sess",
      models: [{ name: "claude-opus-4", contextWindow: 200_000 }],
    } as ConversationState["session"],
    currentModel: "claude-opus-4",
    currentEffort: "high",
    cost: {
      inputTokens: 1234,
      outputTokens: 5678,
      cacheReadTokens: 10,
      cacheWriteTokens: 20,
      totalCostUsd: 0.42,
    },
    turnNumber: 3,
    lastTurnInputTokens: 42_000,
    lastTurnTtftMs: 250,
    _contextFromStream: true,
    streamingOutputTokens: 128,
    rateLimits: {
      primary: { usedPercentage: 40, resetsAt: Date.now() + 3600_000 },
      secondary: null,
      fiveHour: null,
      sevenDay: null,
    } as unknown as ConversationState["rateLimits"],
    lastTurnFiles: [
      { path: "/repo/a.ts", type: "modified", added: 3, removed: 1 } as any,
    ],
    agentCommands: [{ name: "/run", description: "run" } as any],
    configOptions: [{ id: "foo", name: "foo", type: "boolean", value: true } as any],
    supportedPermissionModes: ["default", "acceptEdits", "plan"],
    currentCwd: "/repo",
    worktree: { path: "/repo/.worktrees/x", name: "x" },
  }
}

describe("resetVolatileSessionState", () => {
  test("resets every field the backlog calls out to createInitialState() defaults", () => {
    const fresh = createInitialState()
    const after = resetVolatileSessionState(dirtyState())

    // Cost (all four sub-fields + totalCostUsd)
    expect(after.cost).toEqual(fresh.cost)
    // Rate limits
    expect(after.rateLimits).toEqual(fresh.rateLimits)
    // Context / token counters
    expect(after.lastTurnInputTokens).toBe(fresh.lastTurnInputTokens)
    expect(after.lastTurnTtftMs).toBe(fresh.lastTurnTtftMs)
    expect(after._contextFromStream).toBe(fresh._contextFromStream)
    expect(after.streamingOutputTokens).toBe(fresh.streamingOutputTokens)
    // Turn + file counters
    expect(after.turnNumber).toBe(fresh.turnNumber)
    expect(after.lastTurnFiles).toBe(fresh.lastTurnFiles)
    // Session identity — the header re-renders blank until session_init lands
    expect(after.session).toBe(fresh.session)
    expect(after.currentModel).toBe(fresh.currentModel)
    expect(after.currentEffort).toBe(fresh.currentEffort)
    expect(after.sessionState).toBe(fresh.sessionState)
    expect(after.agentCommands).toEqual(fresh.agentCommands)
    expect(after.configOptions).toEqual(fresh.configOptions)
    // F-13: per-backend permission-mode advertisement clears on switch so
    // the new adapter's capabilities_updated event fully owns the cycler.
    expect(after.supportedPermissionModes).toEqual(fresh.supportedPermissionModes)
  })

  test("preserves blocks (conversation history) across the reset", () => {
    const dirty = dirtyState()
    const after = resetVolatileSessionState(dirty)
    // Identity AND structure — we rely on blocks staying reference-stable so
    // `<For>` in the conversation view doesn't recycle every child node.
    expect(after.blocks).toBe(dirty.blocks)
    expect(after.blocks.length).toBe(2)
  })

  test("preserves cross-backend environment state (cwd, worktree)", () => {
    const dirty = dirtyState()
    const after = resetVolatileSessionState(dirty)
    expect(after.currentCwd).toBe(dirty.currentCwd)
    expect(after.worktree).toBe(dirty.worktree)
  })

  test("no-op on already-fresh state (idempotent with createInitialState)", () => {
    const fresh = createInitialState()
    const after = resetVolatileSessionState(fresh)
    expect(after).toEqual(fresh)
  })

  test("is immutable — input state is not mutated", () => {
    const dirty = dirtyState()
    const beforeCost = { ...dirty.cost }
    const beforeTurn = dirty.turnNumber
    resetVolatileSessionState(dirty)
    expect(dirty.cost).toEqual(beforeCost)
    expect(dirty.turnNumber).toBe(beforeTurn)
  })
})
