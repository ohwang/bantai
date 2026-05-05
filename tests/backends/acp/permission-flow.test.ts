import { describe, expect, it } from "bun:test"
import { AcpAdapter } from "../../../src/backends/acp/adapter"
import { EventChannel } from "../../../src/utils/event-channel"
import type { AgentEvent } from "../../../src/protocol/types"
import type {
  AcpPermissionRequestParams,
  AcpPermissionOption,
} from "../../../src/backends/acp/types"

// ---------------------------------------------------------------------------
// Helpers: Access private internals for testing
// ---------------------------------------------------------------------------

/** Create an AcpAdapter with an eventChannel wired up (no real transport). */
function createTestAdapter(): {
  adapter: AcpAdapter
  events: AgentEvent[]
  responses: { rpcId: number | string; payload: unknown }[]
  errorResponses: { rpcId: number | string; code: number; message: string }[]
} {
  const adapter = new AcpAdapter({
    command: "echo",
    args: [],
    displayName: "Test ACP Agent",
    presetName: "test-acp",
  })

  // Wire up an eventChannel so events can be pushed without start()
  const channel = new EventChannel<AgentEvent>()
  const events: AgentEvent[] = []

  const originalPush = channel.push.bind(channel)
  channel.push = (item: AgentEvent) => {
    events.push(item)
    originalPush(item)
  }
  ;(adapter as any).eventChannel = channel

  // Mock transport that captures responses
  const responses: { rpcId: number | string; payload: unknown }[] = []
  const errorResponses: { rpcId: number | string; code: number; message: string }[] = []
  ;(adapter as any).transport = {
    isAlive: true,
    respond(rpcId: number | string, payload: unknown) {
      responses.push({ rpcId, payload })
    },
    respondError(rpcId: number | string, code: number, message: string) {
      errorResponses.push({ rpcId, code, message })
    },
    notify(_method: string, _params?: unknown) {},
    close() {},
  }
  ;(adapter as any).sessionId = "test-session-001"

  return { adapter, events, responses, errorResponses }
}

/** Call the private handleServerRequest method */
function callHandleServerRequest(
  adapter: AcpAdapter,
  rpcId: number | string,
  method: string,
  params: unknown,
): void {
  ;(adapter as any).handleServerRequest(rpcId, method, params)
}

/** Get pending approvals map */
function getPendingApprovals(adapter: AcpAdapter): Map<string, unknown> {
  return (adapter as any).pendingApprovals
}

// ---------------------------------------------------------------------------
// Standard ACP permission request params
// ---------------------------------------------------------------------------

function makePermissionParams(overrides?: {
  toolCallId?: string
  kind?: string | null    // null = omit entirely, undefined = use default "read"
  title?: string | null   // null = omit entirely, undefined = use default "Read file"
  locations?: { path: string }[]
  rawInput?: unknown
  options?: AcpPermissionOption[]
}): AcpPermissionRequestParams {
  return {
    sessionId: "test-session-001",
    toolCall: {
      toolCallId: overrides?.toolCallId ?? "tc-001",
      ...(overrides?.kind === null ? {} : { kind: overrides?.kind ?? "read" }),
      ...(overrides?.title === null ? {} : { title: overrides?.title ?? "Read file" }),
      ...(overrides?.locations ? { locations: overrides.locations } : {}),
      ...(overrides?.rawInput !== undefined ? { rawInput: overrides.rawInput } : {}),
    } as AcpPermissionRequestParams["toolCall"],
    options: overrides?.options ?? [
      { optionId: "opt-allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "opt-allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "opt-reject-once", name: "Reject once", kind: "reject_once" },
      { optionId: "opt-reject-always", name: "Reject always", kind: "reject_always" },
    ],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// F-13 — capabilities_updated emission
//
// Live repro: Gemini's `session/new` returns four `availableModes` (default,
// autoEdit, yolo, plan), but the TUI's Shift+Tab cycler only ever offered
// two of them. Root cause: `availableModes` was a `createMemo` that called
// `agent.backend.capabilities()` — a plain method call SolidJS can't track,
// so the memo captured the empty pre-handshake fallback at mount time and
// never recomputed.
//
// Fix: the adapter emits a `capabilities_updated` AgentEvent with the freshly
// derived `supportedPermissionModes`; the reducer mirrors them onto
// `ConversationState.supportedPermissionModes`; the cycler memoises against
// state. These tests pin the adapter half of that contract.
// ---------------------------------------------------------------------------

describe("ACP Adapter — capabilities_updated emission (F-13)", () => {
  it("emitCapabilitiesUpdated publishes the four Gemini modes", () => {
    const { adapter, events } = createTestAdapter()

    // Simulate Gemini's session/new shape: 4 modes that the central ACP
    // permission-mode table maps to default/acceptEdits/bypassPermissions/plan.
    ;(adapter as any).discoveredModes = [
      { id: "default", name: "Default" },
      { id: "autoEdit", name: "Auto edit" },
      { id: "yolo", name: "YOLO" },
      { id: "plan", name: "Plan" },
    ]

    ;(adapter as any).emitCapabilitiesUpdated()

    expect(events).toHaveLength(1)
    const evt = events[0]!
    expect(evt.type).toBe("capabilities_updated")
    if (evt.type !== "capabilities_updated") throw new Error("unreachable")
    expect(new Set(evt.supportedPermissionModes)).toEqual(
      new Set(["default", "acceptEdits", "bypassPermissions", "plan"]),
    )

    adapter.close()
  })

  it("falls back to the [default, bypassPermissions] pair when no modes are discovered", () => {
    const { adapter, events } = createTestAdapter()
    ;(adapter as any).discoveredModes = []

    ;(adapter as any).emitCapabilitiesUpdated()

    expect(events).toHaveLength(1)
    const evt = events[0]!
    if (evt.type !== "capabilities_updated") throw new Error("unreachable")
    // deriveSupportedPermissionModes() returns the bantai fallback in this
    // case — see acp/adapter.ts.
    expect(new Set(evt.supportedPermissionModes)).toEqual(
      new Set(["default", "bypassPermissions"]),
    )

    adapter.close()
  })
})

describe("ACP Permission Flow", () => {
  // -------------------------------------------------------------------------
  // 1. Permission Request Metadata
  // -------------------------------------------------------------------------
  describe("permission request metadata", () => {
    it("emits permission_request with tool derived from kind='read'", () => {
      const { adapter, events } = createTestAdapter()

      callHandleServerRequest(adapter, 1, "session/request_permission", makePermissionParams({
        kind: "read",
        title: "Read file",
      }))

      expect(events).toHaveLength(1)
      const evt = events[0]!
      expect(evt.type).toBe("permission_request")
      if (evt.type !== "permission_request") throw new Error("unreachable")
      expect(evt.tool).toBe("Read")

      adapter.close()
    })

    it("emits permission_request with tool derived from kind='execute'", () => {
      const { adapter, events } = createTestAdapter()

      callHandleServerRequest(adapter, 2, "session/request_permission", makePermissionParams({
        kind: "execute",
        title: "Run command",
      }))

      expect(events).toHaveLength(1)
      const evt = events[0]!
      expect(evt.type).toBe("permission_request")
      if (evt.type !== "permission_request") throw new Error("unreachable")
      expect(evt.tool).toBe("Bash")

      adapter.close()
    })

    it("emits permission_request with tool derived from kind='edit'", () => {
      const { adapter, events } = createTestAdapter()

      callHandleServerRequest(adapter, 3, "session/request_permission", makePermissionParams({
        kind: "edit",
        title: "Edit file",
      }))

      expect(events).toHaveLength(1)
      const evt = events[0]!
      expect(evt.type).toBe("permission_request")
      if (evt.type !== "permission_request") throw new Error("unreachable")
      expect(evt.tool).toBe("Edit")

      adapter.close()
    })

    it("title is the toolCall title without an agent-name prefix (F-13b)", () => {
      // F-13b: title used to be "${agentName}: ${title}" → "Gemini CLI: Read
      // foo.txt", which double-stamped the agent name (the conversation
      // header already shows it). The new shape passes the toolCall title
      // through verbatim so the dialog header stays clean.
      const { adapter, events } = createTestAdapter()

      callHandleServerRequest(adapter, 4, "session/request_permission", makePermissionParams({
        title: "Read foo.txt",
      }))

      expect(events).toHaveLength(1)
      const evt = events[0]!
      if (evt.type !== "permission_request") throw new Error("unreachable")
      expect(evt.title).toBe("Read foo.txt")
      expect(evt.title).not.toMatch(/Test ACP Agent:/)

      adapter.close()
    })

    it("displayName mirrors toolCall.title so the dialog action label is set (F-13b)", () => {
      // F-13b: displayName was never populated even though
      // PermissionRequestEvent ships the field. The dialog renders this
      // as its bold action-label header (permission-dialog.tsx:533).
      const { adapter, events } = createTestAdapter()

      callHandleServerRequest(adapter, 4, "session/request_permission", makePermissionParams({
        title: "Read foo.txt",
      }))

      const evt = events[0]!
      if (evt.type !== "permission_request") throw new Error("unreachable")
      expect(evt.displayName).toBe("Read foo.txt")

      adapter.close()
    })

    it("blockedPath is NOT set from toolCall.locations[0].path (F-13b)", () => {
      // F-13b: blockedPath used to be set to locations[0].path — the file
      // the agent WANTS to access. The dialog renders blockedPath with a
      // ⚠ + warning colour, implying "the sandbox refused you", which is
      // the wrong semantics for a normal "ask first" prompt. The location
      // path now flows through `input.rawInput` and surfaces neutrally
      // via the dialog's `pathStr`.
      const { adapter, events } = createTestAdapter()

      callHandleServerRequest(adapter, 5, "session/request_permission", makePermissionParams({
        locations: [{ path: "/home/user/secrets.txt" }],
        rawInput: { file_path: "/home/user/secrets.txt" },
      }))

      expect(events).toHaveLength(1)
      const evt = events[0]!
      if (evt.type !== "permission_request") throw new Error("unreachable")
      expect(evt.blockedPath).toBeUndefined()
      // The path lives on `input` instead so extractPath() in the dialog
      // can render it neutrally.
      expect(evt.input).toEqual({ file_path: "/home/user/secrets.txt" })

      adapter.close()
    })

    it("input is toolCall.rawInput when present so extractPath() finds file_path (F-13b)", () => {
      const { adapter, events } = createTestAdapter()

      callHandleServerRequest(adapter, 51, "session/request_permission", makePermissionParams({
        kind: "edit",
        title: "Edit foo.txt",
        rawInput: { file_path: "/repo/foo.txt", content: "new" },
      }))

      const evt = events[0]!
      if (evt.type !== "permission_request") throw new Error("unreachable")
      expect(evt.input).toEqual({ file_path: "/repo/foo.txt", content: "new" })

      adapter.close()
    })

    it("input falls back to toolCall when rawInput is missing (F-13b)", () => {
      const { adapter, events } = createTestAdapter()

      callHandleServerRequest(adapter, 52, "session/request_permission", makePermissionParams({
        toolCallId: "tc-no-raw",
        kind: "execute",
        title: "Run a command",
      }))

      const evt = events[0]!
      if (evt.type !== "permission_request") throw new Error("unreachable")
      // No rawInput → input is the whole toolCall object so dialog still
      // has SOMETHING to introspect (better than `undefined`).
      expect(evt.input).toEqual(expect.objectContaining({
        toolCallId: "tc-no-raw",
        kind: "execute",
        title: "Run a command",
      }) as unknown as object)

      adapter.close()
    })

    it("id comes from toolCallId", () => {
      const { adapter, events } = createTestAdapter()

      callHandleServerRequest(adapter, 6, "session/request_permission", makePermissionParams({
        toolCallId: "my-tool-call-42",
      }))

      expect(events).toHaveLength(1)
      const evt = events[0]!
      if (evt.type !== "permission_request") throw new Error("unreachable")
      expect(evt.id).toBe("my-tool-call-42")

      adapter.close()
    })

    it("falls back to 'Tool' when kind is missing", () => {
      const { adapter, events } = createTestAdapter()

      callHandleServerRequest(adapter, 7, "session/request_permission", makePermissionParams({
        kind: null,
        title: null,
      }))

      expect(events).toHaveLength(1)
      const evt = events[0]!
      if (evt.type !== "permission_request") throw new Error("unreachable")
      expect(evt.tool).toBe("Tool")

      adapter.close()
    })

    it("falls back to title when kind is unknown", () => {
      const { adapter, events } = createTestAdapter()

      callHandleServerRequest(adapter, 8, "session/request_permission", makePermissionParams({
        kind: "custom_widget",
        title: "Widget action",
      }))

      expect(events).toHaveLength(1)
      const evt = events[0]!
      if (evt.type !== "permission_request") throw new Error("unreachable")
      // deriveToolName returns title for unknown kinds
      expect(evt.tool).toBe("Widget action")

      adapter.close()
    })

    it("description does NOT duplicate the option-label list (F-13b)", () => {
      // F-13b: description used to be the option-label list joined by
      // ' / ' ("Allow / Always allow / Reject"), which duplicates the
      // radio-button row directly underneath. Now intentionally undefined
      // — the action label and path already convey what the tool will do.
      const { adapter, events } = createTestAdapter()

      callHandleServerRequest(adapter, 9, "session/request_permission", makePermissionParams({
        options: [
          { optionId: "a", name: "Allow", kind: "allow_once" },
          { optionId: "b", name: "Deny", kind: "reject_once" },
        ],
      }))

      expect(events).toHaveLength(1)
      const evt = events[0]!
      if (evt.type !== "permission_request") throw new Error("unreachable")
      expect(evt.description).toBeUndefined()

      adapter.close()
    })

    it("stores the pending approval with rpcId and params", () => {
      const { adapter } = createTestAdapter()

      const params = makePermissionParams({ toolCallId: "tc-stored" })
      callHandleServerRequest(adapter, 99, "session/request_permission", params)

      const pending = getPendingApprovals(adapter)
      expect(pending.size).toBe(1)
      expect(pending.has("tc-stored")).toBe(true)

      const entry = pending.get("tc-stored") as { rpcId: number; params: AcpPermissionRequestParams }
      expect(entry.rpcId).toBe(99)
      expect(entry.params.sessionId).toBe("test-session-001")

      adapter.close()
    })
  })

  // -------------------------------------------------------------------------
  // 2. Approve Once
  // -------------------------------------------------------------------------
  describe("approveToolUse — allow once", () => {
    it("finds allow_once option and sends correct response", () => {
      const { adapter, events, responses } = createTestAdapter()

      callHandleServerRequest(adapter, 10, "session/request_permission", makePermissionParams({
        toolCallId: "tc-approve-once",
      }))
      events.length = 0 // clear the permission_request event

      adapter.approveToolUse("tc-approve-once")

      // Should send JSON-RPC response
      expect(responses).toHaveLength(1)
      expect(responses[0]!.rpcId).toBe(10)
      expect(responses[0]!.payload).toEqual({
        outcome: { outcome: "selected", optionId: "opt-allow-once" },
      })

      // Should emit permission_response
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "permission_response",
        id: "tc-approve-once",
        behavior: "allow",
      })

      // Should remove from pending
      expect(getPendingApprovals(adapter).size).toBe(0)

      adapter.close()
    })
  })

  // -------------------------------------------------------------------------
  // 3. Approve Always
  // -------------------------------------------------------------------------
  describe("approveToolUse — allow always", () => {
    it("prefers allow_always option over allow_once", () => {
      const { adapter, responses } = createTestAdapter()

      callHandleServerRequest(adapter, 11, "session/request_permission", makePermissionParams({
        toolCallId: "tc-approve-always",
      }))

      adapter.approveToolUse("tc-approve-always", { alwaysAllow: true })

      expect(responses).toHaveLength(1)
      expect(responses[0]!.payload).toEqual({
        outcome: { outcome: "selected", optionId: "opt-allow-always" },
      })

      adapter.close()
    })

    it("falls back to allow_once if no allow_always option available", () => {
      const { adapter, responses } = createTestAdapter()

      callHandleServerRequest(adapter, 12, "session/request_permission", makePermissionParams({
        toolCallId: "tc-approve-fallback",
        options: [
          { optionId: "opt-only-once", name: "Allow once", kind: "allow_once" },
          { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
        ],
      }))

      adapter.approveToolUse("tc-approve-fallback", { alwaysAllow: true })

      expect(responses).toHaveLength(1)
      expect(responses[0]!.payload).toEqual({
        outcome: { outcome: "selected", optionId: "opt-only-once" },
      })

      adapter.close()
    })
  })

  // -------------------------------------------------------------------------
  // 4. Deny Once
  // -------------------------------------------------------------------------
  describe("denyToolUse — reject once", () => {
    it("prefers reject_once option and sends correct response", () => {
      const { adapter, events, responses } = createTestAdapter()

      callHandleServerRequest(adapter, 13, "session/request_permission", makePermissionParams({
        toolCallId: "tc-deny-once",
      }))
      events.length = 0

      adapter.denyToolUse("tc-deny-once")

      // Should send JSON-RPC response with reject_once
      expect(responses).toHaveLength(1)
      expect(responses[0]!.rpcId).toBe(13)
      expect(responses[0]!.payload).toEqual({
        outcome: { outcome: "selected", optionId: "opt-reject-once" },
      })

      // Should emit permission_response with deny
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: "permission_response",
        id: "tc-deny-once",
        behavior: "deny",
      })

      // Should remove from pending
      expect(getPendingApprovals(adapter).size).toBe(0)

      adapter.close()
    })

    it("falls back to reject_always if no reject_once available", () => {
      const { adapter, responses } = createTestAdapter()

      callHandleServerRequest(adapter, 14, "session/request_permission", makePermissionParams({
        toolCallId: "tc-deny-fallback",
        options: [
          { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
          { optionId: "opt-reject-always", name: "Reject always", kind: "reject_always" },
        ],
      }))

      adapter.denyToolUse("tc-deny-fallback")

      expect(responses).toHaveLength(1)
      expect(responses[0]!.payload).toEqual({
        outcome: { outcome: "selected", optionId: "opt-reject-always" },
      })

      adapter.close()
    })
  })

  // -------------------------------------------------------------------------
  // 5. Deny for Session
  // -------------------------------------------------------------------------
  describe("denyToolUse — reject always (denyForSession)", () => {
    it("prefers reject_always over reject_once", () => {
      const { adapter, responses } = createTestAdapter()

      callHandleServerRequest(adapter, 15, "session/request_permission", makePermissionParams({
        toolCallId: "tc-deny-session",
      }))

      adapter.denyToolUse("tc-deny-session", undefined, { denyForSession: true })

      expect(responses).toHaveLength(1)
      expect(responses[0]!.payload).toEqual({
        outcome: { outcome: "selected", optionId: "opt-reject-always" },
      })

      adapter.close()
    })

    it("falls back to reject_once if no reject_always available", () => {
      const { adapter, responses } = createTestAdapter()

      callHandleServerRequest(adapter, 16, "session/request_permission", makePermissionParams({
        toolCallId: "tc-deny-session-fb",
        options: [
          { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
          { optionId: "opt-reject-once", name: "Reject once", kind: "reject_once" },
        ],
      }))

      adapter.denyToolUse("tc-deny-session-fb", undefined, { denyForSession: true })

      expect(responses).toHaveLength(1)
      expect(responses[0]!.payload).toEqual({
        outcome: { outcome: "selected", optionId: "opt-reject-once" },
      })

      adapter.close()
    })
  })

  // -------------------------------------------------------------------------
  // 6. Cancel via Interrupt
  // -------------------------------------------------------------------------
  describe("interrupt — auto-deny pending approvals", () => {
    it("auto-denies all pending approvals with outcome 'cancelled'", () => {
      const { adapter, events, responses } = createTestAdapter()

      // Queue up two pending permission requests
      callHandleServerRequest(adapter, 20, "session/request_permission", makePermissionParams({
        toolCallId: "tc-int-1",
      }))
      callHandleServerRequest(adapter, 21, "session/request_permission", makePermissionParams({
        toolCallId: "tc-int-2",
      }))
      events.length = 0

      adapter.interrupt()

      // Should send cancelled response for each pending approval
      const cancelledResponses = responses.filter(
        r => (r.payload as any)?.outcome?.outcome === "cancelled",
      )
      expect(cancelledResponses).toHaveLength(2)
      const rpcIds = cancelledResponses.map(r => r.rpcId).sort()
      expect(rpcIds).toEqual([20, 21])

      // Each cancelled response should have outcome: "cancelled"
      for (const r of cancelledResponses) {
        expect(r.payload).toEqual({ outcome: { outcome: "cancelled" } })
      }

      adapter.close()
    })

    it("emits permission_response with behavior 'deny' for each", () => {
      const { adapter, events } = createTestAdapter()

      callHandleServerRequest(adapter, 22, "session/request_permission", makePermissionParams({
        toolCallId: "tc-int-a",
      }))
      callHandleServerRequest(adapter, 23, "session/request_permission", makePermissionParams({
        toolCallId: "tc-int-b",
      }))
      events.length = 0

      adapter.interrupt()

      const denyEvents = events.filter(e => e.type === "permission_response")
      expect(denyEvents).toHaveLength(2)
      for (const evt of denyEvents) {
        if (evt.type !== "permission_response") throw new Error("unreachable")
        expect(evt.behavior).toBe("deny")
      }
      const ids = denyEvents.map(e => (e as any).id).sort()
      expect(ids).toEqual(["tc-int-a", "tc-int-b"])

      adapter.close()
    })

    it("clears the pending approvals map", () => {
      const { adapter } = createTestAdapter()

      callHandleServerRequest(adapter, 24, "session/request_permission", makePermissionParams({
        toolCallId: "tc-int-clear",
      }))

      expect(getPendingApprovals(adapter).size).toBe(1)
      adapter.interrupt()
      expect(getPendingApprovals(adapter).size).toBe(0)

      adapter.close()
    })

    it("sends session/cancel notification", () => {
      const { adapter } = createTestAdapter()

      const notifications: { method: string; params: unknown }[] = []
      ;(adapter as any).transport.notify = (method: string, params?: unknown) => {
        notifications.push({ method, params })
      }

      callHandleServerRequest(adapter, 25, "session/request_permission", makePermissionParams({
        toolCallId: "tc-int-notify",
      }))

      adapter.interrupt()

      expect(notifications).toHaveLength(1)
      expect(notifications[0]!.method).toBe("session/cancel")
      expect(notifications[0]!.params).toEqual({ sessionId: "test-session-001" })

      adapter.close()
    })
  })

  // -------------------------------------------------------------------------
  // 7. Close with Pending Approvals
  // -------------------------------------------------------------------------
  describe("close — cancels pending approvals", () => {
    it("cancels all pending approvals on close", () => {
      const { adapter, responses } = createTestAdapter()

      callHandleServerRequest(adapter, 30, "session/request_permission", makePermissionParams({
        toolCallId: "tc-close-1",
      }))
      callHandleServerRequest(adapter, 31, "session/request_permission", makePermissionParams({
        toolCallId: "tc-close-2",
      }))

      expect(getPendingApprovals(adapter).size).toBe(2)

      adapter.close()

      // onClose sends cancelled responses for each pending approval
      const cancelledResponses = responses.filter(
        r => (r.payload as any)?.outcome?.outcome === "cancelled",
      )
      expect(cancelledResponses).toHaveLength(2)

      // Pending approvals map should be cleared
      expect(getPendingApprovals(adapter).size).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // 8. Non-existent Approval
  // -------------------------------------------------------------------------
  describe("non-existent approval IDs", () => {
    it("approveToolUse with nonexistent ID is a no-op", () => {
      const { adapter, events, responses } = createTestAdapter()

      adapter.approveToolUse("nonexistent")

      expect(events).toHaveLength(0)
      expect(responses).toHaveLength(0)

      adapter.close()
    })

    it("denyToolUse with nonexistent ID is a no-op", () => {
      const { adapter, events, responses } = createTestAdapter()

      adapter.denyToolUse("nonexistent")

      expect(events).toHaveLength(0)
      expect(responses).toHaveLength(0)

      adapter.close()
    })

    it("setPermissionMode throws on a mode the ACP table doesn't map (F-26)", async () => {
      // F-26: setPermissionMode used to silently `return` for modes the
      // ACP permission-mode table didn't carry an `acpId` for (today
      // `auto` and `dontAsk`). The TUI's status-bar cycler then updated
      // its label as if the request had succeeded, even though the agent
      // never actually changed mode. Throwing makes
      // AgentContext.setPermissionMode catch the error, leave the label
      // on the previous mode, and surface the failure to the user.
      const { adapter } = createTestAdapter()

      let threw = false
      try {
        await adapter.setPermissionMode("dontAsk")
      } catch (err) {
        threw = true
        expect(String(err)).toContain("does not support this permission mode")
        expect(String(err)).toContain("dontAsk")
      }
      expect(threw).toBe(true)

      // `auto` is the same shape — also unsupported by every ACP agent today.
      threw = false
      try {
        await adapter.setPermissionMode("auto")
      } catch {
        threw = true
      }
      expect(threw).toBe(true)

      adapter.close()
    })

    it("approveToolUse after already approved is a no-op (idempotent)", () => {
      const { adapter, events, responses } = createTestAdapter()

      callHandleServerRequest(adapter, 40, "session/request_permission", makePermissionParams({
        toolCallId: "tc-double",
      }))
      events.length = 0

      adapter.approveToolUse("tc-double")
      expect(responses).toHaveLength(1)
      events.length = 0
      responses.length = 0

      // Second approval should be a no-op — ID already removed
      adapter.approveToolUse("tc-double")
      expect(responses).toHaveLength(0)
      expect(events).toHaveLength(0)

      adapter.close()
    })
  })
})
