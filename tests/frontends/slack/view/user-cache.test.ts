/**
 * Tests for the entity-name cache (Gap 7).
 *
 * The cache backs `users.info` + `conversations.info` lookups. Invariants:
 *   - cached lookups don't hit the API a second time
 *   - concurrent lookups coalesce to one in-flight fetch
 *   - entries expire after ttlMs
 *   - total entries are capped at maxSize with oldest-first eviction
 */

import { describe, expect, it } from "bun:test"
import type { App } from "@slack/bolt"
import { createUserCache } from "../../../../src/frontends/slack/view/user-cache"

interface StubCalls {
  users: number
  channels: number
}

function makeApp(
  opts: {
    users?: Record<string, { display_name?: string; real_name?: string }>
    channels?: Record<string, { name?: string }>
    failUsers?: boolean
    failChannels?: boolean
  } = {},
): { app: App; calls: StubCalls } {
  const calls: StubCalls = { users: 0, channels: 0 }
  const app = {
    client: {
      users: {
        async info(args: { user: string }) {
          calls.users++
          if (opts.failUsers) return { ok: false, error: "users_not_found" }
          const entry = opts.users?.[args.user]
          if (!entry) return { ok: false, error: "user_not_found" }
          return {
            ok: true,
            user: {
              profile: { display_name: entry.display_name, real_name: entry.real_name },
              real_name: entry.real_name,
              name: args.user,
            },
          }
        },
      },
      conversations: {
        async info(args: { channel: string }) {
          calls.channels++
          if (opts.failChannels) return { ok: false, error: "channel_not_found" }
          const entry = opts.channels?.[args.channel]
          if (!entry) return { ok: false, error: "channel_not_found" }
          return { ok: true, channel: { name: entry.name } }
        },
      },
    },
  } as unknown as App
  return { app, calls }
}

describe("UserCache — displayName", () => {
  it("caches on first hit, doesn't call users.info again", async () => {
    const { app, calls } = makeApp({
      users: { U1: { display_name: "alice" } },
    })
    const cache = createUserCache(app)
    expect(await cache.displayName("U1")).toBe("alice")
    expect(await cache.displayName("U1")).toBe("alice")
    expect(calls.users).toBe(1)
  })

  it("coalesces concurrent lookups to a single in-flight fetch", async () => {
    const { app, calls } = makeApp({ users: { U1: { display_name: "alice" } } })
    const cache = createUserCache(app)
    const [a, b] = await Promise.all([cache.displayName("U1"), cache.displayName("U1")])
    expect(a).toBe("alice")
    expect(b).toBe("alice")
    expect(calls.users).toBe(1)
  })

  it("falls back to real_name when display_name is empty", async () => {
    const { app } = makeApp({ users: { U2: { display_name: "", real_name: "Alice R." } } })
    const cache = createUserCache(app)
    expect(await cache.displayName("U2")).toBe("Alice R.")
  })

  it("returns undefined without caching on API failure", async () => {
    const { app, calls } = makeApp({ failUsers: true })
    const cache = createUserCache(app)
    expect(await cache.displayName("UX")).toBeUndefined()
    expect(await cache.displayName("UX")).toBeUndefined()
    // Both calls went to the API — we don't want to cache negatives.
    expect(calls.users).toBe(2)
  })
})

describe("UserCache — channelName", () => {
  it("caches channel names from conversations.info", async () => {
    const { app, calls } = makeApp({
      channels: { C1: { name: "eng-backend" } },
    })
    const cache = createUserCache(app)
    expect(await cache.channelName("C1")).toBe("eng-backend")
    expect(await cache.channelName("C1")).toBe("eng-backend")
    expect(calls.channels).toBe(1)
  })

  it("returns undefined for DMs / named-less channels", async () => {
    const { app } = makeApp({ channels: { D1: {} } })
    const cache = createUserCache(app)
    expect(await cache.channelName("D1")).toBeUndefined()
  })

  it("coalesces concurrent channel lookups", async () => {
    const { app, calls } = makeApp({ channels: { C1: { name: "eng" } } })
    const cache = createUserCache(app)
    const [a, b] = await Promise.all([cache.channelName("C1"), cache.channelName("C1")])
    expect(a).toBe("eng")
    expect(b).toBe("eng")
    expect(calls.channels).toBe(1)
  })
})

describe("UserCache — TTL expiry + LRU eviction", () => {
  it("drops entries whose ttl has elapsed", async () => {
    const { app, calls } = makeApp({
      users: { U1: { display_name: "alice" } },
    })
    let t = 0
    const cache = createUserCache(app, { ttlMs: 100, now: () => t })
    expect(await cache.displayName("U1")).toBe("alice")
    t = 50
    expect(await cache.displayName("U1")).toBe("alice")
    expect(calls.users).toBe(1)
    t = 150
    expect(await cache.displayName("U1")).toBe("alice")
    expect(calls.users).toBe(2) // refetched after expiry
  })

  it("evicts oldest entries when size exceeds maxSize", async () => {
    const { app, calls } = makeApp({
      users: {
        U1: { display_name: "a" },
        U2: { display_name: "b" },
        U3: { display_name: "c" },
      },
    })
    const cache = createUserCache(app, { maxSize: 2 })
    await cache.displayName("U1")
    await cache.displayName("U2")
    await cache.displayName("U3")
    // Third insertion evicted U1 — so U1 refetches, U2/U3 don't.
    expect(calls.users).toBe(3)
    await cache.displayName("U2")
    await cache.displayName("U3")
    expect(calls.users).toBe(3)
    await cache.displayName("U1")
    expect(calls.users).toBe(4)
  })

  it("bumps entry recency on read so frequently-read entries survive eviction", async () => {
    const { app, calls } = makeApp({
      users: {
        U1: { display_name: "a" },
        U2: { display_name: "b" },
        U3: { display_name: "c" },
      },
    })
    const cache = createUserCache(app, { maxSize: 2 })
    await cache.displayName("U1")
    await cache.displayName("U2")
    // Touch U1 — this should bump it ahead of U2 in the LRU order.
    await cache.displayName("U1")
    await cache.displayName("U3")
    // U2 is now the oldest, evicted. U1 stays.
    expect(calls.users).toBe(3)
    await cache.displayName("U1")
    expect(calls.users).toBe(3)
  })

  it("tracks users + channels toward the same per-sub-cache cap", async () => {
    const { app } = makeApp({
      users: { U1: { display_name: "u1" } },
      channels: { C1: { name: "c1" } },
    })
    const cache = createUserCache(app, { maxSize: 10 })
    await cache.displayName("U1")
    await cache.channelName("C1")
    expect(cache.size()).toBe(2)
    cache.clear()
    expect(cache.size()).toBe(0)
  })
})

describe("UserCache — test hooks", () => {
  it("seed() bypasses the API for the given user", async () => {
    const { app, calls } = makeApp()
    const cache = createUserCache(app)
    cache.seed("U1", "alice")
    expect(await cache.displayName("U1")).toBe("alice")
    expect(calls.users).toBe(0)
  })

  it("seedChannel() bypasses the API for the given channel", async () => {
    const { app, calls } = makeApp()
    const cache = createUserCache(app)
    cache.seedChannel("C1", "eng-backend")
    expect(await cache.channelName("C1")).toBe("eng-backend")
    expect(calls.channels).toBe(0)
  })
})
