/**
 * Regression test for Cluster 7 — ACP permission-mode bidirectional table.
 *
 * Pre-anti-drift, the bantai ↔ ACP permission-mode mapping lived in three
 * inline tables inside `acp/adapter.ts`:
 *
 *   1. `reverseMap`     (ACP id → bantai)               — used by deriveSupportedPermissionModes
 *   2. `fragmentMap`    (URI fragment → bantai)          — used by deriveSupportedPermissionModes
 *   3. `targetName`     (bantai → URI fragment / config) — used by setPermissionMode strategy 1
 *   4. `modeMap`        (bantai → Gemini direct id)      — used by setPermissionMode strategy 2
 *
 * They drifted: `auto` / `dontAsk` / `bypassPermissions` were each present
 * in some tables and missing from others, and Copilot's "agent" / "autopilot"
 * names appeared as inline string literals.
 *
 * The new central table (`backends/acp/permission-mode-map.ts`) exposes a
 * `Record<PermissionMode, AcpPermissionModeMapping>` that drives every
 * direction. These tests pin:
 *
 *   - the table covers every bantai PermissionMode (exhaustive Record)
 *   - every Gemini-style ACP id round-trips back to its bantai mode
 *   - every Copilot URI fragment round-trips back via the URI form
 *   - bantai → ACP-id and bantai → fragment both prefer the first entry
 *   - `auto` / `dontAsk` correctly return null today (no ACP support yet)
 */

import { describe, it, expect } from "bun:test"
import {
  ACP_PERMISSION_MODE_MAP,
  acpIdToBantai,
  acpFragmentToBantai,
  bantaiToAcpId,
  bantaiToAcpFragment,
} from "../../../src/backends/acp/permission-mode-map"
import { knownPermissionModeIds } from "../../../src/protocol/permission-modes"

describe("ACP permission-mode map (Cluster 7)", () => {
  it("covers every bantai PermissionMode exhaustively", () => {
    for (const mode of knownPermissionModeIds()) {
      // The Record type requires this at compile time; the runtime check
      // here protects against accidentally typing a key as `string` later.
      expect(ACP_PERMISSION_MODE_MAP[mode]).toBeDefined()
    }
  })

  it("every Gemini-style ACP id maps back to its bantai mode", () => {
    // Gemini direct ids: default / autoEdit / yolo / plan
    expect(acpIdToBantai("default")).toBe("default")
    expect(acpIdToBantai("autoEdit")).toBe("acceptEdits")
    expect(acpIdToBantai("yolo")).toBe("bypassPermissions")
    expect(acpIdToBantai("plan")).toBe("plan")
  })

  it("every Copilot URI fragment maps back via the full URI form", () => {
    expect(acpIdToBantai("https://example.com/copilot#agent")).toBe("default")
    expect(acpIdToBantai("https://example.com/copilot#autopilot")).toBe("bypassPermissions")
    expect(acpIdToBantai("https://example.com/copilot#plan")).toBe("plan")
  })

  it("acpFragmentToBantai matches bare fragment names case-insensitively", () => {
    // Used by the Copilot config-option matcher when the option name (not
    // the URI) carries the mode label.
    expect(acpFragmentToBantai("agent")).toBe("default")
    expect(acpFragmentToBantai("AUTOPILOT")).toBe("bypassPermissions")
    expect(acpFragmentToBantai("Plan")).toBe("plan")
  })

  it("returns the preferred ACP id for a bantai mode (Gemini path)", () => {
    expect(bantaiToAcpId("default")).toBe("default")
    expect(bantaiToAcpId("acceptEdits")).toBe("autoEdit")
    expect(bantaiToAcpId("bypassPermissions")).toBe("yolo")
    expect(bantaiToAcpId("plan")).toBe("plan")
  })

  it("returns the preferred URI fragment for a bantai mode (Copilot path)", () => {
    expect(bantaiToAcpFragment("default")).toBe("agent")
    expect(bantaiToAcpFragment("bypassPermissions")).toBe("autopilot")
    expect(bantaiToAcpFragment("plan")).toBe("plan")
    // No Copilot URI for acceptEdits today — confirm it stays null instead
    // of being silently mapped to something nearby.
    expect(bantaiToAcpFragment("acceptEdits")).toBeNull()
  })

  it("`auto` and `dontAsk` are bantai-only modes with no ACP entry today", () => {
    // These are expected to return null on every ACP-side translation
    // because no known ACP agent supports them. If a future agent adds
    // either, both tests will need to flip — that's the intended signal
    // that the table is changing meaningfully.
    expect(bantaiToAcpId("auto")).toBeNull()
    expect(bantaiToAcpFragment("auto")).toBeNull()
    expect(bantaiToAcpId("dontAsk")).toBeNull()
    expect(bantaiToAcpFragment("dontAsk")).toBeNull()
  })

  it("rejects unknown ACP-side ids without throwing", () => {
    expect(acpIdToBantai("unknown-mode")).toBeUndefined()
    expect(acpIdToBantai("https://example.com/#nonsense")).toBeUndefined()
    expect(acpFragmentToBantai("nonsense")).toBeUndefined()
  })
})
