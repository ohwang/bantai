import { describe, expect, it } from "bun:test"
import {
  BACKEND_REGISTRY,
  getBackendDescriptor,
  instantiateBackend,
  listAvailableBackends,
  listBackends,
  listSessionFileBackends,
} from "../../src/protocol/registry"

describe("backend registry", () => {
  it("exposes the canonical backend ids", () => {
    const ids = listBackends().map((b) => b.id).sort()
    expect(ids).toEqual(["acp", "claude", "codex", "copilot", "gemini", "mock", "qwen"])
  })

  it("looks up descriptors by id", () => {
    const claude = getBackendDescriptor("claude")
    expect(claude?.displayName).toBe("Claude")
    expect(claude?.isAvailable()).toBe(true)
  })

  it("returns undefined for unknown ids", () => {
    expect(getBackendDescriptor("nope")).toBeUndefined()
  })

  it("always reports claude and mock as available (no external deps)", () => {
    const ids = listAvailableBackends().map((b) => b.id)
    expect(ids).toContain("claude")
    expect(ids).toContain("mock")
  })

  it("instantiates the mock backend without throwing", () => {
    const backend = instantiateBackend("mock")
    expect(backend.capabilities().name).toBe("mock")
    backend.close()
  })

  it("requires acpCommand for the generic acp backend", () => {
    expect(() => instantiateBackend("acp")).toThrow(/acpCommand/)
  })

  it("registry entries all carry a non-empty description", () => {
    for (const entry of BACKEND_REGISTRY) {
      expect(entry.description.length).toBeGreaterThan(0)
    }
  })

  // L1 regression — multi-backend session picker used to hardcode
  // [claude, codex, gemini] in three places (cross-backend.ts:32 union,
  // launcher.ts Promise.all, session-picker.tsx tabs+counts). Adding qwen
  // didn't update the trio, so qwen sessions silently disappeared from the
  // picker. Now the picker iterates the registry, so any backend that
  // registers `sessionFile.listFromDisk` is automatically included.
  describe("session-file backends (L1 regression)", () => {
    it("currently includes claude, codex, gemini", () => {
      const ids = listSessionFileBackends().map((b) => b.id).sort()
      expect(ids).toContain("claude")
      expect(ids).toContain("codex")
      expect(ids).toContain("gemini")
    })

    it("each session-file backend exposes the full handler trio", () => {
      for (const b of listSessionFileBackends()) {
        expect(typeof b.sessionFile?.listFromDisk).toBe("function")
        expect(typeof b.sessionFile?.parseSummary).toBe("function")
        expect(typeof b.sessionFile?.readBlocks).toBe("function")
      }
    })

    it("backends without sessionFile do not appear in the picker list", () => {
      const ids = new Set(listSessionFileBackends().map((b) => b.id))
      // Mock and the generic ACP backend are explicit non-participants.
      expect(ids.has("mock")).toBe(false)
      expect(ids.has("acp")).toBe(false)
    })
  })
})
