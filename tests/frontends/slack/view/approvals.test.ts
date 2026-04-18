import { describe, expect, it } from "bun:test"
import {
  createApprovalRegistry,
  DEFAULT_APPROVAL_TTL_MS,
  type PendingApprovalInput,
  type PendingApprovalRecord,
} from "../../../../src/frontends/slack/view/approvals"
import type { PermissionRequestEvent } from "../../../../src/protocol/types"

function mkInput(overrides: Partial<PendingApprovalInput> = {}): PendingApprovalInput {
  const { request: reqOverride, ...rest } = overrides
  const req: PermissionRequestEvent = {
    type: "permission_request",
    id: reqOverride?.id ?? "perm_1",
    tool: "Bash",
    input: { command: "ls" },
    ...reqOverride,
  }
  return {
    request: req,
    channel: "C01",
    threadTs: "100.001",
    messageTs: "100.002",
    sessionKey: "slack:T1:C01:100.001",
    approvers: [],
    ...rest,
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
      // Fire due timers in order.
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

describe("approval registry", () => {
  it("tracks an approval and allows peek/size", () => {
    const clock = makeFakeClock()
    const reg = createApprovalRegistry({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    expect(reg.size()).toBe(0)
    reg.track(mkInput())
    expect(reg.size()).toBe(1)
    const rec = reg.peek("perm_1")
    expect(rec?.request.tool).toBe("Bash")
    expect(rec?.ttlMs).toBe(DEFAULT_APPROVAL_TTL_MS)
  })

  it("atomically resolves: first resolve wins, second returns unknown", () => {
    const clock = makeFakeClock()
    const reg = createApprovalRegistry({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    reg.track(mkInput())
    const first = reg.resolve({ id: "perm_1", decision: "allow", userId: "U01" })
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.decision).toBe("allow")
      expect(first.resolverUserId).toBe("U01")
    }
    const second = reg.resolve({ id: "perm_1", decision: "deny", userId: "U02" })
    expect(second).toEqual({ ok: false, code: "unknown" })
    expect(reg.size()).toBe(0)
  })

  it("unknown id returns unknown without a record", () => {
    const reg = createApprovalRegistry()
    const res = reg.resolve({ id: "missing", decision: "allow", userId: "U01" })
    expect(res).toEqual({ ok: false, code: "unknown" })
  })

  it("enforces the approver allow-list (unauthorized)", () => {
    const clock = makeFakeClock()
    const reg = createApprovalRegistry({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    reg.track(mkInput({ approvers: ["U01", "U02"] }))

    const bad = reg.resolve({ id: "perm_1", decision: "allow", userId: "U99" })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.code).toBe("unauthorized")
      // Record preserved so callers can post an ephemeral "not authorised" note.
      expect(bad.record?.request.id).toBe("perm_1")
    }
    // Still pending — can be resolved by an authorised user.
    expect(reg.size()).toBe(1)
    const good = reg.resolve({ id: "perm_1", decision: "allow", userId: "U01" })
    expect(good.ok).toBe(true)
  })

  it("empty approvers list allows any user", () => {
    const reg = createApprovalRegistry()
    reg.track(mkInput({ approvers: [] }))
    const res = reg.resolve({ id: "perm_1", decision: "deny", userId: "anyone" })
    expect(res.ok).toBe(true)
  })

  it("fires onTimeout after TTL elapses and removes the record", () => {
    const clock = makeFakeClock()
    const timedOut: PendingApprovalRecord[] = []
    const reg = createApprovalRegistry({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onTimeout: (rec) => timedOut.push(rec),
    })
    reg.track(mkInput({ ttlMs: 1000 }))
    expect(reg.size()).toBe(1)

    clock.advance(999)
    expect(timedOut).toHaveLength(0)
    expect(reg.size()).toBe(1)

    clock.advance(2)
    expect(timedOut).toHaveLength(1)
    expect(timedOut[0]!.request.id).toBe("perm_1")
    expect(reg.size()).toBe(0)
  })

  it("resolve before TTL cancels the timer — no timeout ever fires", () => {
    const clock = makeFakeClock()
    const timedOut: PendingApprovalRecord[] = []
    const reg = createApprovalRegistry({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onTimeout: (rec) => timedOut.push(rec),
    })
    reg.track(mkInput({ ttlMs: 1000 }))

    clock.advance(200)
    const res = reg.resolve({ id: "perm_1", decision: "allow", userId: "U01" })
    expect(res.ok).toBe(true)

    clock.advance(5_000)
    expect(timedOut).toHaveLength(0)
  })

  it("duplicate track for the same id replaces the prior record", () => {
    const clock = makeFakeClock()
    const timedOut: PendingApprovalRecord[] = []
    const reg = createApprovalRegistry({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onTimeout: (rec) => timedOut.push(rec),
    })
    reg.track(mkInput({ ttlMs: 1000, channel: "C01" }))
    reg.track(mkInput({ ttlMs: 5000, channel: "C99" }))

    // Old timer is cancelled; only the new ttl fires.
    clock.advance(2000)
    expect(timedOut).toHaveLength(0)
    clock.advance(3500)
    expect(timedOut).toHaveLength(1)
    expect(timedOut[0]!.channel).toBe("C99")
  })

  it("closeAll returns outstanding records and clears the table", () => {
    const clock = makeFakeClock()
    const timedOut: PendingApprovalRecord[] = []
    const reg = createApprovalRegistry({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onTimeout: (rec) => timedOut.push(rec),
    })
    reg.track(
      mkInput({
        request: {
          type: "permission_request",
          id: "a",
          tool: "Bash",
          input: {},
        },
      }),
    )
    reg.track(
      mkInput({
        request: {
          type: "permission_request",
          id: "b",
          tool: "Write",
          input: {},
        },
      }),
    )

    const outstanding = reg.closeAll()
    expect(outstanding.map((r) => r.request.id).sort()).toEqual(["a", "b"])
    expect(reg.size()).toBe(0)

    // Timers cancelled — no timeout fires.
    clock.advance(DEFAULT_APPROVAL_TTL_MS * 2)
    expect(timedOut).toHaveLength(0)
  })
})
