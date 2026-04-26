import { describe, expect, it } from "bun:test"
import {
  BACKEND_REGISTRY,
  getBackendDescriptor,
  instantiateBackend,
  listAvailableBackends,
  listBackends,
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
})
