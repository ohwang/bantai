import { describe, expect, it } from "bun:test"
import { createThreadParticipationCache } from "../../../../src/frontends/slack/inbox/thread-participation"

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
