import { describe, expect, it } from "bun:test"
import {
  CodexAdapter,
  toCodexApprovalPolicy,
  toCodexSandboxPolicy,
} from "../../src/backends/codex/adapter"

describe("CodexAdapter", () => {
  describe("capabilities", () => {
    it("reports codex capabilities", () => {
      const adapter = new CodexAdapter()
      const caps = adapter.capabilities()

      expect(caps.name).toBe("codex")
      expect(caps.supportsThinking).toBe(true)
      expect(caps.supportsToolApproval).toBe(true)
      expect(caps.supportsResume).toBe(true)
      expect(caps.supportsFork).toBe(true)
      expect(caps.supportsStreaming).toBe(true)
      expect(caps.supportsSubagents).toBe(false)
      expect(caps.supportedPermissionModes).toContain("default")
      expect(caps.supportedPermissionModes).toContain("bypassPermissions")
    })
  })

  describe("permission mode mapping", () => {
    it("maps bypassPermissions to never approval + dangerFullAccess sandbox", () => {
      expect(toCodexApprovalPolicy("bypassPermissions")).toBe("never")
      expect(toCodexSandboxPolicy("bypassPermissions")).toEqual({
        type: "dangerFullAccess",
      })
    })

    it("maps default to on-request approval without sandbox override", () => {
      expect(toCodexApprovalPolicy("default")).toBe("on-request")
      expect(toCodexSandboxPolicy("default")).toBeUndefined()
    })

    // Audit §F-17 (P0): plan used to map to on-request + workspaceWrite, so
    // a single accidental Allow would let codex write the file. The fix
    // tightens this on three axes:
    //   1. Approval policy → "untrusted" (codex auto-runs only its read-only
    //      trusted set; anything else escalates to a permission request the
    //      adapter then auto-declines — see handleServerRequest).
    //   2. Sandbox → readOnly (defence-in-depth; best-effort on macOS).
    //   3. Plan-mode auto-decline guard in handleServerRequest (covers the
    //      python3/sed/awk fallbacks that bypass apply_patch).
    it("plan maps to untrusted approval + readOnly sandbox (F-17)", () => {
      expect(toCodexApprovalPolicy("plan")).toBe("untrusted")
      expect(toCodexSandboxPolicy("plan")).toEqual({ type: "readOnly" })
    })

    // Audit §F-7 (P0): dontAsk used to be byte-identical to bypassPermissions
    // (both "never" + dangerFullAccess), silently auto-approving everything
    // including out-of-cwd reads of /etc/hosts. dontAsk MUST be meaningfully
    // different from bypassPermissions on BOTH axes.
    it("dontAsk is not byte-identical to bypassPermissions (F-7)", () => {
      const dontAskApproval = toCodexApprovalPolicy("dontAsk")
      const bypassApproval = toCodexApprovalPolicy("bypassPermissions")
      const dontAskSandbox = toCodexSandboxPolicy("dontAsk")
      const bypassSandbox = toCodexSandboxPolicy("bypassPermissions")
      // Approvals must differ.
      expect(dontAskApproval).not.toBe(bypassApproval)
      // Sandboxes must differ — and dontAsk must NOT use dangerFullAccess.
      expect(dontAskSandbox).not.toEqual(bypassSandbox)
      expect(dontAskSandbox).not.toEqual({ type: "dangerFullAccess" })
    })

    it("dontAsk uses untrusted approval + workspaceWrite sandbox (F-7)", () => {
      // untrusted = codex auto-runs trusted set, escalates unknown commands.
      // workspaceWrite (undefined) = sandbox still protects .git.
      expect(toCodexApprovalPolicy("dontAsk")).toBe("untrusted")
      expect(toCodexSandboxPolicy("dontAsk")).toBeUndefined()
    })
  })

  describe("message queuing", () => {
    it("sendMessage queues messages without throwing", () => {
      const adapter = new CodexAdapter()
      adapter.sendMessage({ text: "hello" })
      adapter.sendMessage({ text: "world" })
      adapter.close()
    })
  })

  describe("approval bridge", () => {
    it("approveToolUse on unknown id is a no-op", () => {
      const adapter = new CodexAdapter()
      adapter.approveToolUse("nonexistent")
      adapter.close()
    })

    it("denyToolUse on unknown id is a no-op", () => {
      const adapter = new CodexAdapter()
      adapter.denyToolUse("nonexistent", "reason")
      adapter.close()
    })

    it("respondToElicitation on unknown id is a no-op", () => {
      const adapter = new CodexAdapter()
      adapter.respondToElicitation("nonexistent", { answer: "yes" })
      adapter.close()
    })

    it("cancelElicitation on unknown id is a no-op", () => {
      const adapter = new CodexAdapter()
      adapter.cancelElicitation("nonexistent")
      adapter.close()
    })
  })

  describe("interrupt", () => {
    it("interrupt without active session is safe", () => {
      const adapter = new CodexAdapter()
      adapter.interrupt() // no transport, no thread — should not throw
      adapter.close()
    })
  })

  describe("close", () => {
    it("close is idempotent", () => {
      const adapter = new CodexAdapter()
      adapter.close()
      adapter.close()
      adapter.close()
    })
  })

  describe("setModel / setPermissionMode", () => {
    it("setModel does not throw", async () => {
      const adapter = new CodexAdapter()
      await adapter.setModel("o3")
      adapter.close()
    })

    it("setPermissionMode does not throw", async () => {
      const adapter = new CodexAdapter()
      await adapter.setPermissionMode("default")
      adapter.close()
    })
  })

  describe("availableModels", () => {
    it("returns known Codex models", async () => {
      const adapter = new CodexAdapter()
      const models = await adapter.availableModels()
      expect(models.length).toBeGreaterThan(0)
      expect(models[0]!.provider).toBe("openai")
      adapter.close()
    })
  })

  describe("listSessions", () => {
    it("falls back to disk when transport is not connected", async () => {
      const adapter = new CodexAdapter()
      const sessions = await adapter.listSessions()
      // When transport is not alive, Codex reads from ~/.codex/sessions/ on disk.
      // The result is an array (empty if no local sessions exist).
      expect(Array.isArray(sessions)).toBe(true)
      adapter.close()
    })
  })

  describe("forkSession", () => {
    it("throws when transport is not connected", async () => {
      const adapter = new CodexAdapter()
      await expect(adapter.forkSession("some-id")).rejects.toThrow(
        "Transport not connected",
      )
      adapter.close()
    })
  })
})
