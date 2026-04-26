import { describe, expect, it } from "bun:test"
import { DEFAULT_CAPABILITIES } from "../../src/protocol/capabilities"
import { knownPermissionModeIds } from "../../src/protocol/permission-modes"
import { MockAdapter } from "../../src/backends/mock/adapter"

describe("BackendCapabilities defaults (Cluster 3)", () => {
  it("DEFAULT_CAPABILITIES exposes every required supports* flag", () => {
    // Snapshot every required field — TS checks the type, this assertion
    // ensures the runtime object actually has each key (since `Omit` only
    // checks the type, not runtime presence).
    expect(typeof DEFAULT_CAPABILITIES.supportsThinking).toBe("boolean")
    expect(typeof DEFAULT_CAPABILITIES.supportsToolApproval).toBe("boolean")
    expect(typeof DEFAULT_CAPABILITIES.supportsResume).toBe("boolean")
    expect(typeof DEFAULT_CAPABILITIES.supportsContinue).toBe("boolean")
    expect(typeof DEFAULT_CAPABILITIES.supportsFork).toBe("boolean")
    expect(typeof DEFAULT_CAPABILITIES.supportsStreaming).toBe("boolean")
    expect(typeof DEFAULT_CAPABILITIES.supportsSubagents).toBe("boolean")
    expect(typeof DEFAULT_CAPABILITIES.supportsCompact).toBe("boolean")
    expect(Array.isArray(DEFAULT_CAPABILITIES.supportedPermissionModes)).toBe(true)
  })

  it("default supportedPermissionModes covers the full registry", () => {
    expect(DEFAULT_CAPABILITIES.supportedPermissionModes).toEqual(
      knownPermissionModeIds(),
    )
  })

  // Cluster 3 regression — mock used to declare
  //   `supportedPermissionModes: ["default"]`
  // even though it has no policy that would reject the other modes. The
  // TUI cycler intersects backend caps with its cycle list, so this
  // silently disabled `auto`, `dontAsk`, `plan`, etc. for mock sessions.
  describe("mock backend caps no longer drop modes", () => {
    it("includes every PermissionMode (the mock enforces nothing)", () => {
      const mock = new MockAdapter()
      const caps = mock.capabilities()
      const supported = caps.supportedPermissionModes.sort()
      expect(supported).toEqual([...knownPermissionModeIds()].sort())
      mock.close()
    })

    it("name is set to 'mock'", () => {
      const mock = new MockAdapter()
      expect(mock.capabilities().name).toBe("mock")
      mock.close()
    })
  })
})
