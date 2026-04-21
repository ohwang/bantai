import { describe, expect, it } from "bun:test"
import {
  createAdminBus,
  createNoopAdminBus,
  frameKey,
} from "../../../../src/frontends/slack/admin/bus"
import {
  ADMIN_PROTOCOL_VERSION,
  type AdminFrame,
  type PendingApproval,
  type SessionSummary,
} from "../../../../src/frontends/slack/admin/protocol"

const summary: SessionSummary = {
  key: "slack:T:C1:t1",
  channelId: "C1",
  threadTs: "t1",
  backend: "claude",
  projectName: "",
  phase: "IDLE",
  turns: 0,
  totalCostUsd: 0,
  lastEventAt: 0,
  resumed: false,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
  },
}

const approvalFor = (sessionKey: string): PendingApproval => ({
  id: `perm-${sessionKey}`,
  sessionKey,
  channelId: "C1",
  threadTs: "t1",
  tool: "Bash",
  input: {},
  approvers: [],
  requestedAt: 0,
  ttlMs: 60_000,
})

describe("frameKey", () => {
  it("returns the session key from every session-scoped frame type", () => {
    expect(frameKey({ type: "session_opened", summary })).toBe(summary.key)
    expect(
      frameKey({ type: "session_closed", key: summary.key, reason: "idle" }),
    ).toBe(summary.key)
    expect(
      frameKey({ type: "session_phase", key: summary.key, phase: "RUNNING" }),
    ).toBe(summary.key)
    expect(
      frameKey({
        type: "session_event",
        key: summary.key,
        event: { type: "text_delta", text: "x" },
      }),
    ).toBe(summary.key)
    expect(
      frameKey({ type: "approval_requested", approval: approvalFor(summary.key) }),
    ).toBe(summary.key)
  })

  it("returns null for global frames", () => {
    expect(
      frameKey({
        type: "hello",
        protocol: ADMIN_PROTOCOL_VERSION,
        serverVersion: "0.1.0",
      }),
    ).toBeNull()
    expect(
      frameKey({ type: "snapshot", sessions: [], pendingApprovals: [] }),
    ).toBeNull()
    expect(
      frameKey({
        type: "approval_resolved",
        id: "x",
        decision: "allow",
        by: "admin",
      }),
    ).toBeNull()
    expect(frameKey({ type: "pong", at: 0 })).toBeNull()
    expect(
      frameKey({ type: "error", code: "boom", message: "" }),
    ).toBeNull()
  })
})

describe("createAdminBus — subscribe/publish", () => {
  it("delivers every frame to every global subscriber", () => {
    const bus = createAdminBus()
    const a: AdminFrame[] = []
    const b: AdminFrame[] = []
    bus.subscribe((f) => a.push(f))
    bus.subscribe((f) => b.push(f))
    const frame: AdminFrame = { type: "pong", at: 1 }
    bus.publish(frame)
    expect(a).toEqual([frame])
    expect(b).toEqual([frame])
  })

  it("preserves publish order across multiple frames", () => {
    const bus = createAdminBus()
    const received: AdminFrame[] = []
    bus.subscribe((f) => received.push(f))
    const frames: AdminFrame[] = [
      { type: "pong", at: 1 },
      { type: "pong", at: 2 },
      { type: "pong", at: 3 },
    ]
    for (const f of frames) bus.publish(f)
    expect(received).toEqual(frames)
  })

  it("unsubscribe stops delivery to the removed fn only", () => {
    const bus = createAdminBus()
    const a: AdminFrame[] = []
    const b: AdminFrame[] = []
    const offA = bus.subscribe((f) => a.push(f))
    bus.subscribe((f) => b.push(f))
    bus.publish({ type: "pong", at: 1 })
    offA()
    bus.publish({ type: "pong", at: 2 })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(2)
  })

  it("isolates a throwing subscriber", () => {
    const bus = createAdminBus()
    const good: AdminFrame[] = []
    bus.subscribe(() => {
      throw new Error("boom")
    })
    bus.subscribe((f) => good.push(f))
    bus.publish({ type: "pong", at: 1 })
    expect(good).toHaveLength(1)
  })

  it("lets a subscriber unsubscribe mid-fan-out safely", () => {
    const bus = createAdminBus()
    const received: string[] = []
    const offA = bus.subscribe(() => {
      received.push("a")
      offA()
    })
    bus.subscribe(() => {
      received.push("b")
    })
    bus.publish({ type: "pong", at: 1 })
    bus.publish({ type: "pong", at: 2 })
    // "a" fires once (unsubscribes during fan-out); "b" fires twice.
    expect(received).toEqual(["a", "b", "b"])
  })
})

describe("createAdminBus — subscribeKeyed", () => {
  it("delivers session-scoped frames only to the matching key", () => {
    const bus = createAdminBus()
    const forA: AdminFrame[] = []
    const forB: AdminFrame[] = []
    bus.subscribeKeyed("slack:T:C1:t1", (f) => forA.push(f))
    bus.subscribeKeyed("slack:T:C2:t1", (f) => forB.push(f))
    bus.publish({
      type: "session_event",
      key: "slack:T:C1:t1",
      event: { type: "text_delta", text: "x" },
    })
    bus.publish({
      type: "session_event",
      key: "slack:T:C2:t1",
      event: { type: "text_delta", text: "y" },
    })
    expect(forA).toHaveLength(1)
    expect(forB).toHaveLength(1)
  })

  it("does not deliver global frames to keyed subscribers", () => {
    const bus = createAdminBus()
    const keyed: AdminFrame[] = []
    bus.subscribeKeyed("slack:T:C1:t1", (f) => keyed.push(f))
    bus.publish({ type: "pong", at: 1 })
    bus.publish({
      type: "approval_resolved",
      id: "x",
      decision: "allow",
      by: "admin",
    })
    expect(keyed).toEqual([])
  })

  it("global subscribe still sees session-scoped frames", () => {
    const bus = createAdminBus()
    const global: AdminFrame[] = []
    bus.subscribe((f) => global.push(f))
    bus.publish({
      type: "session_phase",
      key: "slack:T:C1:t1",
      phase: "RUNNING",
    })
    expect(global).toHaveLength(1)
  })

  it("unsubscribe drops the fn and reaps empty buckets", () => {
    const bus = createAdminBus()
    const received: AdminFrame[] = []
    const off = bus.subscribeKeyed("k", (f) => received.push(f))
    bus.publish({
      type: "session_phase",
      key: "k",
      phase: "IDLE",
    })
    off()
    bus.publish({
      type: "session_phase",
      key: "k",
      phase: "RUNNING",
    })
    expect(received).toHaveLength(1)
  })
})

describe("createNoopAdminBus", () => {
  it("drops every publish and returns idempotent unsubs", () => {
    const bus = createNoopAdminBus()
    let called = 0
    const off = bus.subscribe(() => {
      called++
    })
    bus.publish({ type: "pong", at: 1 })
    off()
    off()
    expect(called).toBe(0)
  })
})
