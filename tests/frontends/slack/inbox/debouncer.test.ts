import { describe, expect, it } from "bun:test"
import { createInboundDebouncer } from "../../../../src/frontends/slack/inbox/debouncer"

// Minimal fake timer that runs nothing until `advance()` is called.
function makeFakeTimers() {
  const scheduled: Array<{ id: number; at: number; fn: () => void; alive: boolean }> = []
  let now = 0
  let nextId = 1
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
      for (const t of scheduled) {
        if (t.alive && t.at <= now) {
          t.alive = false
          t.fn()
        }
      }
    },
    api: {
      setTimer(fn: () => void, ms: number) {
        const id = nextId++
        scheduled.push({ id, at: now + ms, fn, alive: true })
        return id as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer(handle: ReturnType<typeof setTimeout>) {
        const id = handle as unknown as number
        for (const t of scheduled) if (t.id === id) t.alive = false
      },
    },
  }
}

type Entry = { key: string; text: string }

describe("createInboundDebouncer", () => {
  it("flushes a single entry after debounceMs", async () => {
    const fake = makeFakeTimers()
    const flushed: Entry[][] = []
    const d = createInboundDebouncer<Entry>({
      debounceMs: 50,
      buildKey: (e) => e.key,
      onFlush: (entries) => {
        flushed.push(entries)
      },
      timers: fake.api,
    })
    await d.enqueue({ key: "k1", text: "hi" })
    expect(flushed).toHaveLength(0)
    fake.advance(49)
    expect(flushed).toHaveLength(0)
    fake.advance(1)
    // queued microtask inside timer — await a tick
    await Promise.resolve()
    expect(flushed).toEqual([[{ key: "k1", text: "hi" }]])
    expect(d.pendingKeys()).toBe(0)
  })

  it("batches rapid enqueues on the same key", async () => {
    const fake = makeFakeTimers()
    const flushed: Entry[][] = []
    const d = createInboundDebouncer<Entry>({
      debounceMs: 50,
      buildKey: (e) => e.key,
      onFlush: (entries) => {
        flushed.push(entries)
      },
      timers: fake.api,
    })
    await d.enqueue({ key: "k1", text: "first" })
    fake.advance(30)
    await d.enqueue({ key: "k1", text: "second" })
    fake.advance(30) // resets, 30 out of new 50 — no flush yet
    expect(flushed).toHaveLength(0)
    await d.enqueue({ key: "k1", text: "third" })
    fake.advance(50)
    await Promise.resolve()
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toEqual([
      { key: "k1", text: "first" },
      { key: "k1", text: "second" },
      { key: "k1", text: "third" },
    ])
  })

  it("keeps distinct keys in separate buckets", async () => {
    const fake = makeFakeTimers()
    const flushed: Entry[][] = []
    const d = createInboundDebouncer<Entry>({
      debounceMs: 50,
      buildKey: (e) => e.key,
      onFlush: (entries) => {
        flushed.push([...entries])
      },
      timers: fake.api,
    })
    await d.enqueue({ key: "a", text: "one" })
    await d.enqueue({ key: "b", text: "two" })
    expect(d.pendingKeys()).toBe(2)
    fake.advance(50)
    await Promise.resolve()
    await Promise.resolve()
    expect(flushed).toHaveLength(2)
    expect(flushed.flat().map((e) => e.text).sort()).toEqual(["one", "two"])
  })

  it("bypass path when debounceMs <= 0", async () => {
    const flushed: Entry[][] = []
    const d = createInboundDebouncer<Entry>({
      debounceMs: 0,
      buildKey: (e) => e.key,
      onFlush: (entries) => {
        flushed.push(entries)
      },
    })
    await d.enqueue({ key: "k1", text: "immediate" })
    expect(flushed).toEqual([[{ key: "k1", text: "immediate" }]])
  })

  it("bypasses batching when shouldDebounce returns false", async () => {
    const flushed: Entry[][] = []
    const d = createInboundDebouncer<Entry>({
      debounceMs: 50,
      buildKey: (e) => e.key,
      shouldDebounce: (e) => !e.text.startsWith("!"),
      onFlush: (entries) => {
        flushed.push(entries)
      },
    })
    await d.enqueue({ key: "k", text: "!bantai status" })
    expect(flushed).toEqual([[{ key: "k", text: "!bantai status" }]])
  })

  it("flushKey forces an immediate flush", async () => {
    const fake = makeFakeTimers()
    const flushed: Entry[][] = []
    const d = createInboundDebouncer<Entry>({
      debounceMs: 5000,
      buildKey: (e) => e.key,
      onFlush: (entries) => {
        flushed.push(entries)
      },
      timers: fake.api,
    })
    await d.enqueue({ key: "k", text: "queued" })
    expect(flushed).toHaveLength(0)
    await d.flushKey("k")
    expect(flushed).toEqual([[{ key: "k", text: "queued" }]])
  })

  it("flushAll flushes every bucket", async () => {
    const fake = makeFakeTimers()
    const flushed: Entry[][] = []
    const d = createInboundDebouncer<Entry>({
      debounceMs: 5000,
      buildKey: (e) => e.key,
      onFlush: (entries) => {
        flushed.push([...entries])
      },
      timers: fake.api,
    })
    await d.enqueue({ key: "a", text: "1" })
    await d.enqueue({ key: "b", text: "2" })
    await d.enqueue({ key: "a", text: "3" })
    expect(d.pendingKeys()).toBe(2)
    await d.flushAll()
    expect(d.pendingKeys()).toBe(0)
    expect(flushed.flat().map((e) => e.text).sort()).toEqual(["1", "2", "3"])
  })

  it("routes flush errors to onError when provided", async () => {
    const errors: unknown[] = []
    const d = createInboundDebouncer<Entry>({
      debounceMs: 0,
      buildKey: (e) => e.key,
      onFlush: () => {
        throw new Error("flush boom")
      },
      onError: (err) => {
        errors.push(err)
      },
    })
    await d.enqueue({ key: "k", text: "hi" })
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain("flush boom")
  })
})
