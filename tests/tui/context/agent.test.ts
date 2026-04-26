/**
 * Tests for AgentContext — single reactive source of truth for the
 * permission mode.
 *
 * Backlog: permission-mode-diagnostics-out-of-sync
 *
 * Before the fix, the status bar held its own `permMode` signal while the
 * diagnostics panel read `agent.config.permissionMode` (the launch-time
 * snapshot), so cycling Shift+Tab updated the bar but not the panel.
 * These tests pin the new contract:
 *   - `permissionMode()` is seeded from `config.permissionMode`
 *   - `setPermissionMode(mode)` pushes to the backend AND updates the signal
 *   - on backend rejection, the signal stays on the previous mode
 *   - the latest mode is mirrored back onto `config.permissionMode` so a
 *     downstream `/switch` inherits it
 */

import { describe, test, expect } from "bun:test"
import { createRoot } from "solid-js"
import { createAgentContextValue } from "../../../src/frontends/tui/context/agent"
import type {
  AgentBackend,
  PermissionMode,
  SessionConfig,
} from "../../../src/protocol/types"

function makeBackend(overrides?: Partial<AgentBackend>): {
  backend: AgentBackend
  setPermissionModeCalls: PermissionMode[]
} {
  const setPermissionModeCalls: PermissionMode[] = []
  const backend: AgentBackend = {
    capabilities: () => ({
      name: "mock",
      supportsStreaming: true,
      supportsThinking: false,
      supportsResume: false,
      supportsSubagents: false,
      supportedPermissionModes: ["default", "acceptEdits", "plan"],
    }),
    start: async function* () {},
    sendMessage: async () => {},
    interrupt: async () => {},
    setModel: async () => {},
    setEffort: async () => {},
    setPermissionMode: async (mode: PermissionMode) => {
      setPermissionModeCalls.push(mode)
    },
    respondToPermission: async () => {},
    respondToElicitation: async () => {},
    listSessions: async () => [],
    close: async () => {},
    ...overrides,
  } as AgentBackend
  return { backend, setPermissionModeCalls }
}

describe("AgentContext.permissionMode", () => {
  test("seeds from config.permissionMode", () => {
    createRoot((dispose) => {
      const { backend } = makeBackend()
      const config: SessionConfig = { cwd: "/tmp", permissionMode: "plan" }
      const ctx = createAgentContextValue(backend, config)
      expect(ctx.permissionMode()).toBe("plan")
      dispose()
    })
  })

  test("falls back to 'default' when config.permissionMode is missing", () => {
    createRoot((dispose) => {
      const { backend } = makeBackend()
      const config: SessionConfig = { cwd: "/tmp" }
      const ctx = createAgentContextValue(backend, config)
      expect(ctx.permissionMode()).toBe("default")
      dispose()
    })
  })

  test("setPermissionMode pushes to backend and updates the signal", async () => {
    await createRoot(async (dispose) => {
      const { backend, setPermissionModeCalls } = makeBackend()
      const config: SessionConfig = { cwd: "/tmp", permissionMode: "default" }
      const ctx = createAgentContextValue(backend, config)

      const result = await ctx.setPermissionMode("acceptEdits")

      expect(result).toBe("acceptEdits")
      expect(setPermissionModeCalls).toEqual(["acceptEdits"])
      expect(ctx.permissionMode()).toBe("acceptEdits")
      // Mirrors back onto config so /switch inherits the live mode.
      expect(config.permissionMode).toBe("acceptEdits")

      dispose()
    })
  })

  test("setPermissionMode is a no-op when the mode is already active", async () => {
    await createRoot(async (dispose) => {
      const { backend, setPermissionModeCalls } = makeBackend()
      const config: SessionConfig = { cwd: "/tmp", permissionMode: "plan" }
      const ctx = createAgentContextValue(backend, config)

      const result = await ctx.setPermissionMode("plan")

      expect(result).toBe("plan")
      expect(setPermissionModeCalls).toEqual([])
      expect(ctx.permissionMode()).toBe("plan")

      dispose()
    })
  })

  test("setPermissionMode keeps previous mode when backend throws", async () => {
    await createRoot(async (dispose) => {
      const { backend } = makeBackend({
        setPermissionMode: async () => {
          throw new Error("not supported")
        },
      })
      const config: SessionConfig = { cwd: "/tmp", permissionMode: "default" }
      const ctx = createAgentContextValue(backend, config)

      const result = await ctx.setPermissionMode("plan")

      // Helper resolves to the previous mode rather than re-throwing — the
      // caller (status bar Shift+Tab handler) just discards the result.
      expect(result).toBe("default")
      expect(ctx.permissionMode()).toBe("default")
      // config.permissionMode is NOT mirrored when the backend rejected.
      expect(config.permissionMode).toBe("default")

      dispose()
    })
  })

  test("permissionMode signal triggers SolidJS reactivity", async () => {
    await createRoot(async (dispose) => {
      const { backend } = makeBackend()
      const config: SessionConfig = { cwd: "/tmp", permissionMode: "default" }
      const ctx = createAgentContextValue(backend, config)

      // Read once to subscribe; track subsequent values via an explicit
      // memo would also work, but reading the accessor twice is enough to
      // verify it returns the freshest value (Solid's runtime guarantees
      // accessor reads see the most recent set call).
      expect(ctx.permissionMode()).toBe("default")
      await ctx.setPermissionMode("acceptEdits")
      expect(ctx.permissionMode()).toBe("acceptEdits")
      await ctx.setPermissionMode("plan")
      expect(ctx.permissionMode()).toBe("plan")

      dispose()
    })
  })
})
