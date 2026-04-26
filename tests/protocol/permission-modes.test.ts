import { describe, expect, it } from "bun:test"
import {
  PERMISSION_MODES,
  cyclerPermissionModeIds,
  getPermissionModeDescriptor,
  isKnownPermissionMode,
  knownPermissionModeIds,
  listPermissionModesForCli,
} from "../../src/protocol/permission-modes"

describe("permission mode registry", () => {
  it("exposes the canonical permission mode ids", () => {
    const ids = knownPermissionModeIds().sort()
    expect(ids).toEqual([
      "acceptEdits",
      "auto",
      "bypassPermissions",
      "default",
      "dontAsk",
      "plan",
    ])
  })

  it("isKnownPermissionMode rejects unknown ids", () => {
    expect(isKnownPermissionMode("default")).toBe(true)
    expect(isKnownPermissionMode("dontAsk")).toBe(true)
    expect(isKnownPermissionMode("nope")).toBe(false)
    expect(isKnownPermissionMode("")).toBe(false)
  })

  it("looks up descriptors by id", () => {
    const desc = getPermissionModeDescriptor("plan")
    expect(desc?.id).toBe("plan")
    expect(desc?.description.length).toBeGreaterThan(0)
  })

  it("listPermissionModesForCli returns a comma-separated string of all modes", () => {
    const help = listPermissionModesForCli()
    for (const id of knownPermissionModeIds()) {
      expect(help).toContain(id)
    }
  })

  it("every registry entry has a non-empty description", () => {
    for (const entry of PERMISSION_MODES) {
      expect(entry.description.length).toBeGreaterThan(0)
    }
  })

  // L3 regression — TUI status bar Shift-Tab cycler used to be a hand-rolled
  // 5-entry array (default, acceptEdits, auto, bypassPermissions, plan) which
  // silently dropped `dontAsk`. Promoting the cycle list onto the registry
  // with `inCycler: true` makes "is dontAsk reachable from Shift-Tab?" a
  // statically-checkable property.
  it("cycler includes every mode declared with inCycler=true (regression: L3)", () => {
    const cycle = cyclerPermissionModeIds()
    expect(cycle).toContain("dontAsk")
    // Every cycle entry corresponds to a real registry entry.
    for (const id of cycle) {
      expect(isKnownPermissionMode(id)).toBe(true)
    }
    // And every registry entry that says inCycler=true shows up in the cycle.
    const expected = PERMISSION_MODES.filter((m) => m.inCycler).map((m) => m.id)
    expect(cycle).toEqual(expected)
  })
})
