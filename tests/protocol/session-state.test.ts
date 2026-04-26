import { describe, expect, it } from "bun:test"
import {
  SESSION_STATES,
  STATE_GLYPHS,
  STATE_LABELS,
  STATE_SEVERITIES,
  isKnownSessionState,
  knownSessionStateIds,
} from "../../src/protocol/session-state"

describe("session state registry", () => {
  it("exposes the canonical 8 states", () => {
    const ids = knownSessionStateIds().sort()
    expect(ids).toEqual([
      "ERROR",
      "IDLE",
      "INITIALIZING",
      "INTERRUPTING",
      "RUNNING",
      "SHUTTING_DOWN",
      "WAITING_FOR_ELIC",
      "WAITING_FOR_PERM",
    ])
  })

  it("isKnownSessionState rejects unknown ids", () => {
    expect(isKnownSessionState("IDLE")).toBe(true)
    expect(isKnownSessionState("INITIALIZING")).toBe(true)
    expect(isKnownSessionState("SHUTTING_DOWN")).toBe(true)
    expect(isKnownSessionState("idle")).toBe(false) // case-sensitive
    expect(isKnownSessionState("nope")).toBe(false)
    expect(isKnownSessionState("")).toBe(false)
  })

  // L5 regression — diagnostics + status-bar handled INITIALIZING and
  // SHUTTING_DOWN inconsistently. The fix is `Record<SessionState, V>` —
  // any future addition to the registry is a compile-time error in every
  // consumer that builds a similar Record. These runtime assertions
  // validate the *current* state of the registry.
  describe("Cluster 6 / L5 regression — every state has every attribute", () => {
    it("STATE_LABELS covers every state", () => {
      for (const id of knownSessionStateIds()) {
        expect(STATE_LABELS[id]).toBeDefined()
        expect(STATE_LABELS[id].length).toBeGreaterThan(0)
      }
    })

    it("STATE_GLYPHS covers every state", () => {
      for (const id of knownSessionStateIds()) {
        expect(STATE_GLYPHS[id]).toBeDefined()
        expect(STATE_GLYPHS[id].length).toBeGreaterThan(0)
      }
    })

    it("STATE_SEVERITIES covers every state with a known severity", () => {
      const allowed = new Set(["neutral", "active", "blocked", "error"])
      for (const id of knownSessionStateIds()) {
        expect(allowed.has(STATE_SEVERITIES[id])).toBe(true)
      }
    })

    it("INITIALIZING is no longer missing — it has label, glyph, severity", () => {
      expect(STATE_LABELS["INITIALIZING"]).toBe("booting")
      expect(STATE_GLYPHS["INITIALIZING"]).toBe("\u25CC")
      expect(STATE_SEVERITIES["INITIALIZING"]).toBe("neutral")
    })

    it("SHUTTING_DOWN is no longer missing — it has label, glyph, severity", () => {
      expect(STATE_LABELS["SHUTTING_DOWN"]).toBe("shutting down")
      expect(STATE_GLYPHS["SHUTTING_DOWN"]).toBe("\u25CC")
      expect(STATE_SEVERITIES["SHUTTING_DOWN"]).toBe("neutral")
    })
  })

  it("registry order matches lifecycle progression", () => {
    const ids = SESSION_STATES.map((s) => s.id)
    // Loose ordering checks — INITIALIZING first, ERROR/SHUTTING_DOWN last.
    expect(ids[0]).toBe("INITIALIZING")
    expect(ids[ids.length - 1]).toBe("SHUTTING_DOWN")
    expect(ids).toContain("RUNNING")
    expect(ids.indexOf("RUNNING")).toBeGreaterThan(ids.indexOf("INITIALIZING"))
  })
})
