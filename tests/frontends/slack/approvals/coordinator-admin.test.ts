import { beforeEach, describe, expect, it } from "bun:test"
import {
  createApprovalCoordinator,
  type ApprovalAdminHook,
  type ApprovalBackendCallbacks,
  type ApprovalCoordinator,
} from "../../../../src/frontends/slack/approvals/coordinator"
import type { SendAdapter } from "../../../../src/frontends/slack/view/outbox"
import type { PermissionRequestEvent } from "../../../../src/protocol/types"
import { encodeActionId } from "../../../../src/frontends/slack/view/blocks/approval"
import type { PendingApproval } from "../../../../src/frontends/slack/admin/protocol"

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeAdapter() {
  let autoTs = 1000
  const adapter: SendAdapter = {
    async postMessage({ channel }) {
      return { ts: String(autoTs++), channel }
    },
    async updateMessage() {},
  }
  return adapter
}

function makeBackendCallbacks(): ApprovalBackendCallbacks {
  return {
    approve() {},
    deny() {},
  }
}

function makeFakeClock() {
  let nowMs = 1_000_000
  const timers: Array<{ id: number; at: number; fn: () => void; cancelled?: boolean }> = []
  let nextId = 1
  return {
    now: () => nowMs,
    advance(ms: number): void {
      nowMs += ms
      const due = timers
        .filter((t) => !t.cancelled && t.at <= nowMs)
        .sort((a, b) => a.at - b.at)
      for (const t of due) {
        t.cancelled = true
        t.fn()
      }
    },
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++
      timers.push({ id, at: nowMs + ms, fn })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (t: ReturnType<typeof setTimeout>) => {
      const id = t as unknown as number
      const found = timers.find((x) => x.id === id)
      if (found) found.cancelled = true
    },
  }
}

function req(overrides: Partial<PermissionRequestEvent> = {}): PermissionRequestEvent {
  return {
    type: "permission_request",
    id: "perm_1",
    tool: "Bash",
    input: { command: "ls -la" },
    ...overrides,
  }
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

interface RecordedAdmin extends ApprovalAdminHook {
  requested: PendingApproval[]
  resolved: Array<{
    id: string
    decision: "allow" | "deny" | "timeout"
    by: "admin" | "slack" | "timeout" | "shutdown"
  }>
}

function makeRecordingAdmin(): RecordedAdmin {
  const rec = {
    requested: [] as PendingApproval[],
    resolved: [] as Array<{
      id: string
      decision: "allow" | "deny" | "timeout"
      by: "admin" | "slack" | "timeout" | "shutdown"
    }>,
    onRequested(approval: PendingApproval) {
      rec.requested.push(approval)
    },
    onResolved(args: {
      id: string
      decision: "allow" | "deny" | "timeout"
      by: "admin" | "slack" | "timeout" | "shutdown"
    }) {
      rec.resolved.push(args)
    },
  }
  return rec
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("approval coordinator — admin hook wiring", () => {
  let coord: ApprovalCoordinator
  let admin: RecordedAdmin
  let adapter: SendAdapter

  beforeEach(() => {
    adapter = makeAdapter()
    admin = makeRecordingAdmin()
    coord = createApprovalCoordinator({
      adapter,
      lookupSession: () => makeBackendCallbacks(),
      admin,
      now: () => 1_700_000_000_000,
    })
  })

  it("onRequested fires with a full PendingApproval after track() succeeds", async () => {
    const hook = coord.bindSession({
      sessionKey: "slack:T1:C01:100.001",
      approvers: ["U_ok"],
    })
    hook.onRequest({
      request: req({ id: "p1", title: "Run Bash", description: "ls -la" }),
      channel: "C01",
      threadTs: "100.001",
    })
    await tick()

    expect(admin.requested).toHaveLength(1)
    const a = admin.requested[0]!
    expect(a.id).toBe("p1")
    expect(a.sessionKey).toBe("slack:T1:C01:100.001")
    expect(a.channelId).toBe("C01")
    expect(a.threadTs).toBe("100.001")
    expect(a.tool).toBe("Bash")
    expect(a.approvers).toEqual(["U_ok"])
    expect(a.title).toBe("Run Bash")
    expect(a.description).toBe("ls -la")
    expect(a.requestedAt).toBe(1_700_000_000_000)
    expect(a.ttlMs).toBeGreaterThan(0)
  })

  it("allow-click emits onResolved with by='slack' and decision='allow'", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "p2" }), channel: "C01", threadTs: "100.001" })
    await tick()

    await coord.handleBlockAction({
      actionId: encodeActionId("p2", "allow"),
      userId: "U_click",
    })
    expect(admin.resolved).toEqual([{ id: "p2", decision: "allow", by: "slack" }])
  })

  it("allowAlways flattens to decision='allow' on the wire", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "p3" }), channel: "C01", threadTs: "100.001" })
    await tick()

    await coord.handleBlockAction({
      actionId: encodeActionId("p3", "allowAlways"),
      userId: "U_click",
    })
    expect(admin.resolved).toEqual([{ id: "p3", decision: "allow", by: "slack" }])
  })

  it("deny-click emits onResolved with decision='deny'", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "p4" }), channel: "C01", threadTs: "100.001" })
    await tick()

    await coord.handleBlockAction({
      actionId: encodeActionId("p4", "deny"),
      userId: "U_click",
    })
    expect(admin.resolved).toEqual([{ id: "p4", decision: "deny", by: "slack" }])
  })

  it("TTL timeout emits onResolved with decision='timeout' and by='timeout'", async () => {
    const clock = makeFakeClock()
    const admin2 = makeRecordingAdmin()
    const coord2 = createApprovalCoordinator({
      adapter: makeAdapter(),
      lookupSession: () => makeBackendCallbacks(),
      admin: admin2,
      clock: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    })
    const hook = coord2.bindSession({
      sessionKey: "slack:T1:C01:100.001",
      approvers: [],
      ttlMs: 500,
    })
    hook.onRequest({ request: req({ id: "p_ttl" }), channel: "C01", threadTs: "100.001" })
    await tick()

    clock.advance(600)
    await tick()
    expect(admin2.resolved).toEqual([{ id: "p_ttl", decision: "timeout", by: "timeout" }])
  })

  it("closeAll() emits by='shutdown' for every outstanding approval", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "a" }), channel: "C01", threadTs: "100.001" })
    hook.onRequest({ request: req({ id: "b" }), channel: "C01", threadTs: "100.001" })
    await tick()

    coord.closeAll()
    await tick()
    const bySet = new Set(admin.resolved.map((r) => r.by))
    expect(bySet).toEqual(new Set(["shutdown"]))
    expect(admin.resolved.map((r) => r.id).sort()).toEqual(["a", "b"])
    // All close-driven resolutions report "timeout" as the wire decision
    // (they're auto-denies, which map to the same wire label as TTL expiry).
    expect(new Set(admin.resolved.map((r) => r.decision))).toEqual(new Set(["timeout"]))
  })

  it("onCancel (interrupt / renderer destroy) emits by='shutdown'", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "cancel" }), channel: "C01", threadTs: "100.001" })
    await tick()

    hook.onCancel("cancel")
    await tick()
    expect(admin.resolved).toEqual([
      { id: "cancel", decision: "timeout", by: "shutdown" },
    ])
  })

  it("unauthorized click does not emit onResolved", async () => {
    const hook = coord.bindSession({
      sessionKey: "slack:T1:C01:100.001",
      approvers: ["U_ok"],
    })
    hook.onRequest({ request: req({ id: "p_un" }), channel: "C01", threadTs: "100.001" })
    await tick()

    await coord.handleBlockAction({
      actionId: encodeActionId("p_un", "allow"),
      userId: "U_bad",
    })
    expect(admin.resolved).toEqual([])
  })

  it("malformed / unknown actionId does not emit onResolved", async () => {
    await coord.handleBlockAction({ actionId: "garbage", userId: "U1" })
    await coord.handleBlockAction({
      actionId: encodeActionId("never_requested", "allow"),
      userId: "U1",
    })
    expect(admin.resolved).toEqual([])
  })

  it("adminResolve(allow) approves the backend and emits by='admin'", async () => {
    const approved: Array<{ id: string; alwaysAllow?: boolean }> = []
    const denied: Array<{ id: string; reason?: string }> = []
    const admin2 = makeRecordingAdmin()
    const coord2 = createApprovalCoordinator({
      adapter: makeAdapter(),
      lookupSession: () => ({
        approve(id, opts) {
          approved.push({
            id,
            ...(opts?.alwaysAllow ? { alwaysAllow: true } : {}),
          })
        },
        deny(id, reason) {
          denied.push({ id, ...(reason ? { reason } : {}) })
        },
      }),
      admin: admin2,
    })
    const hook = coord2.bindSession({
      sessionKey: "slack:T1:C01:100.001",
      approvers: ["U_ok"],
    })
    hook.onRequest({ request: req({ id: "adm1" }), channel: "C01", threadTs: "100.001" })
    await tick()

    const res = await coord2.adminResolve({ id: "adm1", decision: "allow" })
    expect(res).toEqual({ kind: "resolved", permissionId: "adm1" })
    expect(approved).toEqual([{ id: "adm1" }])
    expect(denied).toEqual([])
    expect(admin2.resolved).toEqual([{ id: "adm1", decision: "allow", by: "admin" }])
  })

  it("adminResolve(allow, alwaysAllow) forwards alwaysAllow to the backend", async () => {
    const approved: Array<{ id: string; alwaysAllow?: boolean }> = []
    const coord2 = createApprovalCoordinator({
      adapter: makeAdapter(),
      lookupSession: () => ({
        approve(id, opts) {
          approved.push({
            id,
            ...(opts?.alwaysAllow ? { alwaysAllow: true } : {}),
          })
        },
        deny() {},
      }),
      admin: makeRecordingAdmin(),
    })
    const hook = coord2.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "adm2" }), channel: "C01", threadTs: "100.001" })
    await tick()
    await coord2.adminResolve({ id: "adm2", decision: "allow", alwaysAllow: true })
    expect(approved).toEqual([{ id: "adm2", alwaysAllow: true }])
  })

  it("adminResolve(deny, reason) passes the reason to backend.deny", async () => {
    const denied: Array<{ id: string; reason?: string }> = []
    const coord2 = createApprovalCoordinator({
      adapter: makeAdapter(),
      lookupSession: () => ({
        approve() {},
        deny(id, reason) {
          denied.push({ id, ...(reason ? { reason } : {}) })
        },
      }),
      admin: makeRecordingAdmin(),
    })
    const hook = coord2.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "adm3" }), channel: "C01", threadTs: "100.001" })
    await tick()
    await coord2.adminResolve({
      id: "adm3",
      decision: "deny",
      denyReason: "not on my watch",
    })
    expect(denied).toEqual([{ id: "adm3", reason: "not on my watch" }])
  })

  it("adminResolve bypasses the Slack approvers allow-list", async () => {
    const approved: Array<{ id: string }> = []
    const coord2 = createApprovalCoordinator({
      adapter: makeAdapter(),
      lookupSession: () => ({
        approve(id) {
          approved.push({ id })
        },
        deny() {},
      }),
      admin: makeRecordingAdmin(),
    })
    const hook = coord2.bindSession({
      sessionKey: "slack:T1:C01:100.001",
      approvers: ["only_this_user"], // admin token holder is not on this list
    })
    hook.onRequest({ request: req({ id: "adm4" }), channel: "C01", threadTs: "100.001" })
    await tick()
    const res = await coord2.adminResolve({ id: "adm4", decision: "allow" })
    expect(res.kind).toBe("resolved")
    expect(approved).toEqual([{ id: "adm4" }])
  })

  it("adminResolve returns { kind: 'unknown' } for a missing id", async () => {
    const res = await coord.adminResolve({ id: "never_requested", decision: "allow" })
    expect(res).toEqual({ kind: "unknown", permissionId: "never_requested" })
  })

  it("throwing admin hook is isolated — decisions still land", async () => {
    const exploding: ApprovalAdminHook = {
      onRequested() {
        throw new Error("boom-req")
      },
      onResolved() {
        throw new Error("boom-res")
      },
    }
    const approved: string[] = []
    const coordX = createApprovalCoordinator({
      adapter: makeAdapter(),
      lookupSession: () => ({
        approve(id) {
          approved.push(id)
        },
        deny() {},
      }),
      admin: exploding,
    })
    const hook = coordX.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "boomy" }), channel: "C01", threadTs: "100.001" })
    await tick()

    const res = await coordX.handleBlockAction({
      actionId: encodeActionId("boomy", "allow"),
      userId: "U1",
    })
    expect(res.kind).toBe("resolved")
    expect(approved).toEqual(["boomy"])
  })
})
