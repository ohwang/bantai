import { describe, expect, it } from "bun:test"
import { createThreadParticipationCache } from "../../../../src/frontends/slack/inbox/thread-participation"
import { createSessionStore } from "../../../../src/frontends/slack/store/sessions"

describe("createThreadParticipationCache", () => {
  it("returns false for unknown (channel, thread)", () => {
    const cache = createThreadParticipationCache()
    expect(cache.has("C1", "1.000")).toBe(false)
  })

  it("records and recalls a (channel, thread) pair", () => {
    const cache = createThreadParticipationCache()
    cache.record("C1", "1.000")
    expect(cache.has("C1", "1.000")).toBe(true)
    expect(cache.has("C1", "2.000")).toBe(false)
    expect(cache.has("C2", "1.000")).toBe(false)
  })

  it("is idempotent — recording twice doesn't duplicate entries", () => {
    const cache = createThreadParticipationCache()
    cache.record("C1", "1.000")
    cache.record("C1", "1.000")
    expect(cache.size()).toBe(1)
  })

  it("silently ignores missing threadTs (top-level message)", () => {
    const cache = createThreadParticipationCache()
    cache.record("C1", undefined)
    expect(cache.size()).toBe(0)
    expect(cache.has("C1", undefined)).toBe(false)
  })

  it("expires entries after ttlMs", () => {
    let t = 1000
    const cache = createThreadParticipationCache({
      ttlMs: 100,
      now: () => t,
    })
    cache.record("C1", "1.000")
    expect(cache.has("C1", "1.000")).toBe(true)
    t += 50
    expect(cache.has("C1", "1.000")).toBe(true)
    t += 51
    expect(cache.has("C1", "1.000")).toBe(false)
    expect(cache.size()).toBe(0)
  })

  it("re-recording refreshes the TTL", () => {
    let t = 1000
    const cache = createThreadParticipationCache({
      ttlMs: 100,
      now: () => t,
    })
    cache.record("C1", "1.000")
    t += 80
    cache.record("C1", "1.000")
    t += 80
    expect(cache.has("C1", "1.000")).toBe(true)
  })

  it("evicts the oldest entry once maxSize is exceeded", () => {
    let t = 1000
    const cache = createThreadParticipationCache({
      maxSize: 2,
      ttlMs: 60_000,
      now: () => t,
    })
    cache.record("C1", "a")
    t += 1
    cache.record("C1", "b")
    t += 1
    cache.record("C1", "c")
    expect(cache.size()).toBe(2)
    expect(cache.has("C1", "a")).toBe(false)
    expect(cache.has("C1", "b")).toBe(true)
    expect(cache.has("C1", "c")).toBe(true)
  })

  it("clear drops everything", () => {
    const cache = createThreadParticipationCache()
    cache.record("C1", "1.000")
    cache.record("C2", "2.000")
    cache.clear()
    expect(cache.size()).toBe(0)
    expect(cache.has("C1", "1.000")).toBe(false)
  })
})

describe("createThreadParticipationCache — store-backed", () => {
  it("record writes through to the store; has reads through it", () => {
    const store = createSessionStore({ path: ":memory:" })
    const cache = createThreadParticipationCache({ store })
    cache.record("C1", "1.000")
    expect(cache.has("C1", "1.000")).toBe(true)
    expect(cache.has("C1", "2.000")).toBe(false)
    store.close()
  })

  it("participation survives 'restart' — a fresh cache on the same store sees prior writes", () => {
    const store = createSessionStore({ path: ":memory:" })
    const first = createThreadParticipationCache({ store })
    first.record("C1", "1.000")
    // Simulate restart by dropping the cache instance; the store persists.
    const second = createThreadParticipationCache({ store })
    expect(second.has("C1", "1.000")).toBe(true)
    store.close()
  })

  it("store-backed has() has no TTL — row exists forever until explicitly pruned", () => {
    // The store-backed variant is a pure existence query. The in-memory
    // variant keeps its own TTL to bound Map size (tested above); the
    // store path intentionally skips that — SQLite rows are cheap, and
    // "forget after N hours" is a UX policy that didn't earn its complexity
    // in practice. Operators can run `pruneThreadPosts(cutoffMs)` via
    // admin tooling when they actually want to forget.
    const store = createSessionStore({ path: ":memory:" })
    const cache = createThreadParticipationCache({
      store,
      // Even when ttlMs/now are provided, the store-backed path ignores
      // them — make sure this never regresses.
      ttlMs: 1,
      now: () => Date.now() + 1_000_000,
    })
    cache.record("C1", "1.000")
    expect(cache.has("C1", "1.000")).toBe(true)
    store.close()
  })

  it("silently skips missing channel / thread", () => {
    const store = createSessionStore({ path: ":memory:" })
    const cache = createThreadParticipationCache({ store })
    // No throws.
    cache.record("C1", undefined)
    expect(cache.has("C1", undefined)).toBe(false)
    store.close()
  })
})
