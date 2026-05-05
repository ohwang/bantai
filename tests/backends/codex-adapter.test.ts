import { describe, expect, it } from "bun:test"
import {
  CodexAdapter,
  sessionDenyKey,
  toCodexApprovalPolicy,
  toCodexSandboxPolicy,
} from "../../src/backends/codex/adapter"
import { BACKEND_REGISTRY } from "../../src/protocol/registry"

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

    // F-24: codex has no native `acceptEdits` semantic — it would be
    // byte-identical to `default` on the wire ("on-request" approval, no
    // sandbox override). Exposing it in the cycler is a lying label, so
    // the mode is intentionally omitted from supportedPermissionModes and
    // from sandboxInfo.modeDetails. The to…Policy helpers fall back to the
    // `default` mapping when callers still pass it (legacy session configs).
    it("acceptEdits is omitted from supportedPermissionModes (F-24)", () => {
      const adapter = new CodexAdapter()
      const caps = adapter.capabilities()
      expect(caps.supportedPermissionModes).not.toContain("acceptEdits")
      expect(caps.sandboxInfo?.modeDetails.acceptEdits).toBeUndefined()
      adapter.close()
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

  // F-23: codex sends approval+sandbox policy per-turn via `turn/start` params.
  // A mid-turn `setPermissionMode()` only mutates `this.config.permissionMode`;
  // the in-flight turn keeps the policy it was started with. The TUI cycler
  // (Shift-Tab) reads `BackendDescriptor.permissionModeAppliesOnNextTurn` and
  // gates cycling during RUNNING for any backend that opts in. The cycler
  // gating itself is exercised in src/frontends/tui/components/status-bar.tsx —
  // here we just lock in the registry contract so the flag can't get dropped.
  describe("registry permissionModeAppliesOnNextTurn (F-23)", () => {
    it("BACKEND_REGISTRY codex entry has permissionModeAppliesOnNextTurn: true", () => {
      const codex = BACKEND_REGISTRY.find((b) => b.id === "codex")
      expect(codex).toBeDefined()
      expect(codex?.permissionModeAppliesOnNextTurn).toBe(true)
    })
  })

  // F-11: `denyToolUse(id, _, { denyForSession: true })` used to ignore the
  // option entirely on codex — the next request for the same tool would
  // re-open a fresh permission dialog. The fix tracks denied keys in
  // `sessionDeniedTools` and auto-declines matching requests in
  // `handleServerRequest` before queueing them as pending approvals.
  describe("session deny list (F-11)", () => {
    it("sessionDenyKey: command extracts head token", () => {
      expect(
        sessionDenyKey("item/commandExecution/requestApproval", { command: "git commit -m 'x'" }),
      ).toBe("cmd:git")
      expect(
        sessionDenyKey("item/commandExecution/requestApproval", { command: ["git", "push"] }),
      ).toBe("cmd:git")
      expect(
        sessionDenyKey("item/commandExecution/requestApproval", { command: "" }),
      ).toBeNull()
    })

    it("sessionDenyKey: fileChange + permissions are coarse-grained", () => {
      expect(
        sessionDenyKey("item/fileChange/requestApproval", { itemId: "abc" }),
      ).toBe("fileChange")
      expect(
        sessionDenyKey("item/permissions/requestApproval", { permissions: {} }),
      ).toBe("permissions")
    })

    it("sessionDenyKey: unhandled methods return null (not session-denyable)", () => {
      expect(sessionDenyKey("mcpServer/elicitation/request", {})).toBeNull()
      expect(sessionDenyKey("item/tool/call", {})).toBeNull()
    })

    // Contract: deny a tool with denyForSession; the next request for the
    // same tool key is auto-declined without a new permission_request event
    // ever firing. We exercise this by hand-installing a pending approval
    // (mimicking what handleServerRequest does for the FIRST request),
    // calling denyToolUse with denyForSession, then driving a second
    // request through handleServerRequest and asserting that no
    // permission_request event was emitted.
    it("denyToolUse(denyForSession) auto-declines the next matching request", async () => {
      const adapter = new CodexAdapter()

      // Wire a fake transport so `respond()` doesn't crash and we can
      // inspect what got declined.
      const declined: Array<{ rpcId: number | string; payload: unknown }> = []
      const fakeTransport = {
        isAlive: true,
        respond: (rpcId: number | string, payload: unknown) => {
          declined.push({ rpcId, payload })
        },
        respondError: () => {},
        request: async () => ({}),
        notify: () => {},
        close: () => {},
        onNotification: () => {},
        onRequest: () => {},
        start: async () => {},
      }
      // Inject — the adapter's transport field is private, so we cast.
      ;(adapter as any).transport = fakeTransport

      // Wire an event channel so we can detect any leaked permission_request
      // events on the second deny. BaseAdapter.close() calls
      // eventChannel.close() so a no-op stub is required to avoid a crash
      // in the test teardown — we don't care about the close behaviour here.
      const emitted: Array<{ type: string; id?: string }> = []
      ;(adapter as any).eventChannel = {
        push: (event: { type: string; id?: string }) => {
          emitted.push(event)
        },
        close: () => {},
      }

      // Step 1: simulate the FIRST approval arriving from codex.
      ;(adapter as any).handleServerRequest(101, "item/commandExecution/requestApproval", {
        itemId: "approval-1",
        command: "git commit -m hello",
      })
      // The adapter should have queued a pending approval and emitted a
      // permission_request event (the normal path, not the deny path).
      expect(emitted.some((e) => e.type === "permission_request" && e.id === "approval-1")).toBe(true)

      // Step 2: deny it with denyForSession.
      adapter.denyToolUse("approval-1", undefined, { denyForSession: true })
      // Decision was sent to transport.
      expect(declined.some((d) => d.rpcId === 101)).toBe(true)
      // The session deny set now includes the cmd:git key.
      expect((adapter as any).sessionDeniedTools.has("cmd:git")).toBe(true)

      // Step 3: codex sends ANOTHER request for `git push`. We expect
      // handleServerRequest to auto-decline immediately, with NO new
      // permission_request event and NO new entry in pendingApprovals.
      const emittedBefore = emitted.length
      const declinedBefore = declined.length
      ;(adapter as any).handleServerRequest(102, "item/commandExecution/requestApproval", {
        itemId: "approval-2",
        command: "git push origin main",
      })
      // No new permission_request event was emitted for approval-2.
      const newEvents = emitted.slice(emittedBefore)
      expect(newEvents.some((e) => e.type === "permission_request")).toBe(false)
      // The decline was sent to the transport.
      expect(declined.length).toBe(declinedBefore + 1)
      expect(declined[declined.length - 1]?.rpcId).toBe(102)
      // No pending approval was queued for approval-2.
      expect((adapter as any).pendingApprovals.has("approval-2")).toBe(false)

      adapter.close()
    })
  })
})
