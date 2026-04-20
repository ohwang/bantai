import { beforeEach, describe, expect, it } from "bun:test"
import {
  createApprovalCoordinator,
  type ApprovalBackendCallbacks,
  type ApprovalCoordinator,
} from "../../../../src/frontends/slack/approvals/coordinator"
import type { SendAdapter } from "../../../../src/frontends/slack/view/outbox"
import type { PermissionRequestEvent } from "../../../../src/protocol/types"
import { encodeActionId } from "../../../../src/frontends/slack/view/blocks/approval"

interface PostCall {
  channel: string
  threadTs?: string
  text: string
  blocks?: unknown[]
}
interface UpdateCall {
  channel: string
  ts: string
  text: string
  blocks?: unknown[]
}

function makeAdapter() {
  const posts: PostCall[] = []
  const updates: UpdateCall[] = []
  let autoTs = 1000
  const adapter: SendAdapter = {
    async postMessage(args) {
      const body = args.markdownText ?? args.text ?? ""
      posts.push({
        channel: args.channel,
        ...(args.threadTs !== undefined ? { threadTs: args.threadTs } : {}),
        text: body,
        ...(args.blocks ? { blocks: args.blocks } : {}),
      })
      const ts = String(autoTs++)
      return { ts, channel: args.channel }
    },
    async updateMessage(args) {
      const body = args.markdownText ?? args.text ?? ""
      updates.push({
        channel: args.channel,
        ts: args.ts,
        text: body,
        ...(args.blocks ? { blocks: args.blocks } : {}),
      })
    },
  }
  return { adapter, posts, updates }
}

function makeBackendCallbacks() {
  const approved: Array<{ id: string; alwaysAllow?: boolean }> = []
  const denied: Array<{ id: string; reason?: string }> = []
  const cb: ApprovalBackendCallbacks = {
    approve(id, opts) {
      approved.push({
        id,
        ...(opts?.alwaysAllow ? { alwaysAllow: true } : {}),
      })
    },
    deny(id, reason) {
      denied.push({ id, ...(reason ? { reason } : {}) })
    },
  }
  return { cb, approved, denied }
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
  // Let the coordinator's void-ified post/update promises settle.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe("approval coordinator — hook + block-action round-trip", () => {
  let coord: ApprovalCoordinator
  let adapter: ReturnType<typeof makeAdapter>
  let backend: ReturnType<typeof makeBackendCallbacks>

  beforeEach(() => {
    adapter = makeAdapter()
    backend = makeBackendCallbacks()
    coord = createApprovalCoordinator({
      adapter: adapter.adapter,
      lookupSession: () => backend.cb,
    })
  })

  it("posts a card on permission_request and tracks it", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req(), channel: "C01", threadTs: "100.001" })
    await tick()

    expect(adapter.posts).toHaveLength(1)
    expect(adapter.posts[0]!.channel).toBe("C01")
    expect(adapter.posts[0]!.threadTs).toBe("100.001")
    expect(adapter.posts[0]!.blocks?.length).toBeGreaterThan(0)
    expect(coord.registry.size()).toBe(1)
  })

  it("allow-click updates the card, calls backend.approve, removes from registry", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "p1" }), channel: "C01", threadTs: "100.001" })
    await tick()

    const res = await coord.handleBlockAction({
      actionId: encodeActionId("p1", "allow"),
      userId: "U_click",
      channel: "C01",
    })
    expect(res.kind).toBe("resolved")

    expect(adapter.updates).toHaveLength(1)
    const u = adapter.updates[0]!
    expect(u.channel).toBe("C01")
    expect(u.text).toContain("allowed")
    // Block content reflects the resolved card
    expect(JSON.stringify(u.blocks)).toContain("heavy_check_mark")

    expect(backend.approved).toEqual([{ id: "p1" }])
    expect(backend.denied).toEqual([])
    expect(coord.registry.size()).toBe(0)
  })

  it("allowAlways-click passes alwaysAllow to backend.approve", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "p2" }), channel: "C01", threadTs: "100.001" })
    await tick()

    await coord.handleBlockAction({
      actionId: encodeActionId("p2", "allowAlways"),
      userId: "U_click",
    })
    expect(backend.approved).toEqual([{ id: "p2", alwaysAllow: true }])
  })

  it("deny-click calls backend.deny", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "p3" }), channel: "C01", threadTs: "100.001" })
    await tick()

    await coord.handleBlockAction({
      actionId: encodeActionId("p3", "deny"),
      userId: "U_click",
    })
    expect(backend.denied).toEqual([{ id: "p3" }])
    expect(adapter.updates[0]!.text).toContain("denied")
  })

  it("unauthorized click does not touch the backend or update the card", async () => {
    const hook = coord.bindSession({
      sessionKey: "slack:T1:C01:100.001",
      approvers: ["U_ok"],
    })
    hook.onRequest({ request: req({ id: "p4" }), channel: "C01", threadTs: "100.001" })
    await tick()

    const res = await coord.handleBlockAction({
      actionId: encodeActionId("p4", "allow"),
      userId: "U_bad",
    })
    expect(res.kind).toBe("unauthorized")
    expect(adapter.updates).toHaveLength(0)
    expect(backend.approved).toEqual([])
    expect(coord.registry.size()).toBe(1)

    // Authorised user can still resolve.
    const res2 = await coord.handleBlockAction({
      actionId: encodeActionId("p4", "allow"),
      userId: "U_ok",
    })
    expect(res2.kind).toBe("resolved")
    expect(backend.approved).toEqual([{ id: "p4" }])
  })

  it("concurrent clicks — exactly one resolution wins", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "race" }), channel: "C01", threadTs: "100.001" })
    await tick()

    const [r1, r2] = await Promise.all([
      coord.handleBlockAction({ actionId: encodeActionId("race", "allow"), userId: "U1" }),
      coord.handleBlockAction({ actionId: encodeActionId("race", "deny"), userId: "U2" }),
    ])
    const kinds = [r1.kind, r2.kind].sort()
    expect(kinds).toEqual(["resolved", "unknown"])
    // Exactly one backend call, one card update.
    expect(backend.approved.length + backend.denied.length).toBe(1)
    expect(adapter.updates).toHaveLength(1)
  })

  it("unknown action_id returns malformed", async () => {
    const res = await coord.handleBlockAction({
      actionId: "some:other:thing",
      userId: "U1",
    })
    expect(res.kind).toBe("malformed")
  })

  it("TTL fires an auto-deny that updates the card and calls backend.deny", async () => {
    const clock = makeFakeClock()
    const adapter2 = makeAdapter()
    const backend2 = makeBackendCallbacks()
    const coord2 = createApprovalCoordinator({
      adapter: adapter2.adapter,
      lookupSession: () => backend2.cb,
      clock: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    })
    const hook = coord2.bindSession({
      sessionKey: "slack:T1:C01:100.001",
      approvers: [],
      ttlMs: 1000,
    })
    hook.onRequest({ request: req({ id: "p_ttl" }), channel: "C01", threadTs: "100.001" })
    await tick()

    // Nothing happens before the TTL.
    clock.advance(999)
    await tick()
    expect(backend2.denied).toEqual([])
    expect(adapter2.updates).toHaveLength(0)

    // TTL elapses → card updates, backend denied.
    clock.advance(2)
    await tick()
    expect(adapter2.updates.length).toBeGreaterThanOrEqual(1)
    expect(adapter2.updates[0]!.text).toContain("timed out")
    expect(backend2.denied).toEqual([{ id: "p_ttl", reason: "timed out, auto-denied" }])
  })

  it("closeAll on launcher shutdown auto-denies every outstanding approval", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "a" }), channel: "C01", threadTs: "100.001" })
    hook.onRequest({ request: req({ id: "b" }), channel: "C01", threadTs: "100.001" })
    await tick()

    coord.closeAll()
    await tick()
    expect(backend.denied.map((d) => d.id).sort()).toEqual(["a", "b"])
    expect(coord.registry.size()).toBe(0)
  })

  it("onCancel from renderer auto-denies the backend + updates the card", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "p_cancel" }), channel: "C01", threadTs: "100.001" })
    await tick()

    hook.onCancel("p_cancel")
    await tick()
    expect(backend.denied).toEqual([{ id: "p_cancel", reason: "timed out, auto-denied" }])
    expect(adapter.updates[0]!.text).toContain("timed out")
    expect(coord.registry.size()).toBe(0)
  })

  it("onCancel for an unknown id is a silent no-op", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onCancel("never_posted")
    await tick()
    expect(backend.denied).toEqual([])
    expect(adapter.updates).toHaveLength(0)
  })

  it("missing session at resolve-time updates the card but logs + skips backend call", async () => {
    const coord2 = createApprovalCoordinator({
      adapter: adapter.adapter,
      lookupSession: () => undefined,
    })
    const hook = coord2.bindSession({ sessionKey: "slack:T1:C01:100.001", approvers: [] })
    hook.onRequest({ request: req({ id: "p_orphan" }), channel: "C01", threadTs: "100.001" })
    await tick()
    const res = await coord2.handleBlockAction({
      actionId: encodeActionId("p_orphan", "allow"),
      userId: "U1",
    })
    expect(res.kind).toBe("resolved")
    // Card still updates visually so the approver sees the outcome.
    expect(adapter.updates.length).toBeGreaterThanOrEqual(1)
    // But no backend call — the session is gone.
    expect(backend.approved).toEqual([])
    expect(backend.denied).toEqual([])
  })
})
