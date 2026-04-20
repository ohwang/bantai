import { describe, expect, it } from "bun:test"
import {
  attachRingBuffer,
  createRingBuffer,
} from "../../../../src/frontends/slack/admin/ring"
import { createAdminBus } from "../../../../src/frontends/slack/admin/bus"
import type { AgentEvent } from "../../../../src/protocol/types"

const ev = (i: number): AgentEvent => ({ type: "text_delta", text: `e${i}` })

describe("createRingBuffer", () => {
  it("stores events in push order and returns them oldest-first", () => {
    const ring = createRingBuffer({ capacity: 5 })
    for (let i = 0; i < 3; i++) ring.push("k1", ev(i))
    expect(ring.snapshot("k1")).toEqual([ev(0), ev(1), ev(2)])
    expect(ring.size()).toBe(1)
  })

  it("evicts oldest events when capacity is exceeded", () => {
    const ring = createRingBuffer({ capacity: 3 })
    for (let i = 0; i < 5; i++) ring.push("k1", ev(i))
    expect(ring.snapshot("k1")).toEqual([ev(2), ev(3), ev(4)])
  })

  it("keeps buffers per key isolated", () => {
    const ring = createRingBuffer({ capacity: 3 })
    ring.push("k1", ev(1))
    ring.push("k2", ev(2))
    ring.push("k1", ev(3))
    expect(ring.snapshot("k1")).toEqual([ev(1), ev(3)])
    expect(ring.snapshot("k2")).toEqual([ev(2)])
  })

  it("returns an empty snapshot for an unknown key", () => {
    const ring = createRingBuffer({ capacity: 3 })
    expect(ring.snapshot("missing")).toEqual([])
  })

  it("snapshot is a defensive copy (callers can mutate freely)", () => {
    const ring = createRingBuffer({ capacity: 3 })
    ring.push("k1", ev(1))
    const snap = ring.snapshot("k1")
    snap.push(ev(99))
    expect(ring.snapshot("k1")).toEqual([ev(1)])
  })

  it("drop() removes the key's deque entirely", () => {
    const ring = createRingBuffer({ capacity: 3 })
    ring.push("k1", ev(1))
    expect(ring.size()).toBe(1)
    ring.drop("k1")
    expect(ring.size()).toBe(0)
    expect(ring.snapshot("k1")).toEqual([])
  })

  it("clear() wipes every key", () => {
    const ring = createRingBuffer({ capacity: 3 })
    ring.push("k1", ev(1))
    ring.push("k2", ev(2))
    ring.clear()
    expect(ring.size()).toBe(0)
    expect(ring.snapshot("k1")).toEqual([])
    expect(ring.snapshot("k2")).toEqual([])
  })

  it("rejects non-positive capacity", () => {
    expect(() => createRingBuffer({ capacity: 0 })).toThrow(/positive/)
    expect(() => createRingBuffer({ capacity: -1 })).toThrow(/positive/)
  })
})

describe("attachRingBuffer", () => {
  it("captures events per session_event frame", () => {
    const bus = createAdminBus()
    const ring = attachRingBuffer(bus, { capacity: 10 })
    bus.publish({
      type: "session_event",
      key: "k1",
      event: ev(1),
    })
    bus.publish({
      type: "session_event",
      key: "k1",
      event: ev(2),
    })
    expect(ring.snapshot("k1")).toEqual([ev(1), ev(2)])
  })

  it("drops a key's buffer on session_closed", () => {
    const bus = createAdminBus()
    const ring = attachRingBuffer(bus, { capacity: 10 })
    bus.publish({ type: "session_event", key: "k1", event: ev(1) })
    expect(ring.size()).toBe(1)
    bus.publish({ type: "session_closed", key: "k1", reason: "idle" })
    expect(ring.size()).toBe(0)
    expect(ring.snapshot("k1")).toEqual([])
  })

  it("dispose() unsubscribes from the bus", () => {
    const bus = createAdminBus()
    const ring = attachRingBuffer(bus, { capacity: 10 })
    bus.publish({ type: "session_event", key: "k1", event: ev(1) })
    ring.dispose()
    bus.publish({ type: "session_event", key: "k1", event: ev(2) })
    expect(ring.snapshot("k1")).toEqual([ev(1)])
  })

  it("dispose() is idempotent", () => {
    const bus = createAdminBus()
    const ring = attachRingBuffer(bus, { capacity: 10 })
    ring.dispose()
    expect(() => ring.dispose()).not.toThrow()
  })

  it("ignores global frames (hello, pong, config_changed, ...)", () => {
    const bus = createAdminBus()
    const ring = attachRingBuffer(bus, { capacity: 10 })
    bus.publish({ type: "pong", at: 1 })
    bus.publish({
      type: "approval_resolved",
      id: "x",
      decision: "allow",
      by: "admin",
    })
    expect(ring.size()).toBe(0)
  })
})
