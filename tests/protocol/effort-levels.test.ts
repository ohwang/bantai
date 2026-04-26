import { describe, expect, it } from "bun:test"
import {
  EFFORT_LEVELS,
  RUNTIME_EFFORT_LEVELS,
  isKnownEffortLevel,
  isRuntimeEffortLevel,
  knownEffortLevelIds,
  listEffortLevelsForCli,
  listRuntimeEffortLevelsForCli,
} from "../../src/protocol/effort-levels"
import { CodexAdapter, toCodexApprovalPolicy } from "../../src/backends/codex/adapter"

describe("effort level registry", () => {
  it("exposes the canonical 5 levels", () => {
    const ids = knownEffortLevelIds().sort()
    expect(ids).toEqual(["high", "low", "max", "medium", "xhigh"])
  })

  it("isKnownEffortLevel rejects unknown ids", () => {
    expect(isKnownEffortLevel("low")).toBe(true)
    expect(isKnownEffortLevel("medium")).toBe(true)
    expect(isKnownEffortLevel("max")).toBe(true)
    expect(isKnownEffortLevel("nope")).toBe(false)
    expect(isKnownEffortLevel("LOW")).toBe(false)
    expect(isKnownEffortLevel("")).toBe(false)
  })

  it("RUNTIME_EFFORT_LEVELS excludes start-up-only entries", () => {
    expect(RUNTIME_EFFORT_LEVELS).toContain("low")
    expect(RUNTIME_EFFORT_LEVELS).toContain("medium")
    expect(RUNTIME_EFFORT_LEVELS).toContain("high")
    expect(RUNTIME_EFFORT_LEVELS).not.toContain("xhigh")
    expect(RUNTIME_EFFORT_LEVELS).not.toContain("max")
  })

  // Cluster 5 regression — thinking.ts had TWO local arrays, VALID_LEVELS
  // (3 entries) and VALID_LEVELS_WITH_MAX (5 entries), that already
  // disagreed about whether xhigh/max were "valid" — so an older bug let
  // `/thinking max` pass the validator before hitting the start-up-only
  // guard, while the help text said only low/medium/high were valid. The
  // registry split below makes that distinction load-bearing instead of
  // implicit.
  it("isRuntimeEffortLevel mirrors RUNTIME_EFFORT_LEVELS", () => {
    expect(isRuntimeEffortLevel("low")).toBe(true)
    expect(isRuntimeEffortLevel("xhigh")).toBe(false)
    expect(isRuntimeEffortLevel("max")).toBe(false)
    expect(isRuntimeEffortLevel("nope")).toBe(false)
  })

  it("CLI help lists every level", () => {
    const help = listEffortLevelsForCli()
    for (const id of knownEffortLevelIds()) {
      expect(help).toContain(id)
    }
  })

  it("/thinking help lists only runtime-switchable levels", () => {
    const help = listRuntimeEffortLevelsForCli()
    expect(help).toContain("low")
    expect(help).toContain("medium")
    expect(help).toContain("high")
    expect(help).not.toContain("xhigh")
    expect(help).not.toContain("max")
  })

  it("every entry has a non-empty description", () => {
    for (const entry of EFFORT_LEVELS) {
      expect(entry.description.length).toBeGreaterThan(0)
    }
  })
})

// L6 regression — Codex's approval-policy switch and capabilities()
// matrix used to disagree about which permission modes were supported.
// `auto` was missing from both, `plan` was in the switch but not in
// supportedPermissionModes. The fix derives caps from a Record keyed
// by every PermissionMode, so the two cannot drift.
describe("Codex capabilities reconciliation (L6)", () => {
  it("supportedPermissionModes includes every mode the approval policy maps", () => {
    const codex = new CodexAdapter()
    const supported = codex.capabilities().supportedPermissionModes
    expect(supported).toContain("default")
    expect(supported).toContain("acceptEdits")
    expect(supported).toContain("plan")
    expect(supported).toContain("auto")
    expect(supported).toContain("bypassPermissions")
    expect(supported).toContain("dontAsk")
    codex.close()
  })

  it("toCodexApprovalPolicy returns a real policy for every PermissionMode", () => {
    expect(toCodexApprovalPolicy("default")).toBe("on-request")
    expect(toCodexApprovalPolicy("acceptEdits")).toBe("on-request")
    expect(toCodexApprovalPolicy("plan")).toBe("on-request")
    expect(toCodexApprovalPolicy("auto")).toBe("on-request")
    expect(toCodexApprovalPolicy("bypassPermissions")).toBe("never")
    expect(toCodexApprovalPolicy("dontAsk")).toBe("never")
  })
})
