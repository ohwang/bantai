/**
 * Thread-participation cache.
 *
 * Tracks Slack threads the bot has posted in so that follow-up user
 * messages in those threads can bypass the `requireMention` gate without
 * needing `@bantai` on every reply. Survives session eviction — the live
 * `SessionRegistry` may already have dropped the thread's SessionEntry
 * (eviction, restart, crash-then-recover), but the user's next message
 * should still drive a turn.
 *
 * Originally ported from OpenClaw's `extensions/slack/src/sent-thread-cache.ts`
 * (MIT) as an in-memory LRU. In bantai the cache is owned by the launcher
 * and handed to `buildRoutingHandler` via `RoutingCtx.threadParticipation`,
 * which keeps tests isolated.
 *
 * Backing: when a `SessionStore` is provided (production path), `record`
 * and `has` delegate to the store's `thread_participation` table so
 * participation survives process restart. The store read is a single
 * indexed SQLite lookup per inbound message — cheap, and we pay that cost
 * ONLY when the gate actually needs the fallback signal. When no store is
 * provided (tests, operators who opt out of persistence via empty
 * `store_path`), the cache falls back to the original in-memory LRU.
 *
 * Semantics (both backings):
 *   - `record(channel, threadTs)` — idempotent. Call after every successful
 *     outbound `chat.postMessage` on the (channel, thread) pair. Safe on
 *     no-op threads (threadTs missing) — silently skips.
 *   - `has(channel, threadTs)` — pure query. Returns false for unknown
 *     entries or entries whose last post is older than `ttlMs`.
 *   - TTL default 24h, capacity default 5000 — same as OpenClaw.
 */

import type { SessionStore } from "../store/sessions"

export interface ThreadParticipationCache {
  record(channel: string, threadTs: string | undefined): void
  has(channel: string, threadTs: string | undefined): boolean
  size(): number
  clear(): void
}

export interface ThreadParticipationOpts {
  ttlMs?: number
  maxSize?: number
  /** Test hook: override Date.now for deterministic TTL behaviour. */
  now?: () => number
  /**
   * Optional persistent backing. When provided, `record` writes through
   * to `store.recordThreadPost` and `has` delegates to
   * `store.hasThreadPost` with a `now - ttlMs` cutoff — participation
   * then survives restart. When omitted, behaves as an in-memory LRU.
   */
  store?: SessionStore
}

export function createThreadParticipationCache(
  opts: ThreadParticipationOpts = {},
): ThreadParticipationCache {
  const ttl = opts.ttlMs ?? 24 * 60 * 60 * 1000
  const maxSize = Math.max(1, opts.maxSize ?? 5000)
  const now = opts.now ?? Date.now
  const store = opts.store

  if (store) {
    return {
      record(channel, threadTs) {
        if (!channel || !threadTs) return
        store.recordThreadPost(channel, threadTs)
      },
      has(channel, threadTs) {
        if (!channel || !threadTs) return false
        return store.hasThreadPost(channel, threadTs, now() - ttl)
      },
      // Store-backed modes don't track size / clear locally — these remain
      // for interface parity. Tests that care about size/clear use the
      // in-memory variant (no store).
      size() {
        return 0
      },
      clear() {
        // Intentionally a no-op for the store-backed variant: `clear()` is
        // used only from tests of the in-memory LRU. Wiping persisted
        // participation as a side effect of a test hook would be surprising.
      },
    }
  }
  // Map preserves insertion order — used as a cheap LRU: re-record moves
  // the entry to the tail by delete+set, prune-by-age sweeps the head.
  const entries = new Map<string, number>()

  function key(channel: string, threadTs: string): string {
    return `${channel}:${threadTs}`
  }

  function pruneExpired(t: number): void {
    const cutoff = t - ttl
    for (const [k, recordedAt] of entries) {
      if (recordedAt > cutoff) break
      entries.delete(k)
    }
  }

  function enforceCapacity(): void {
    while (entries.size > maxSize) {
      // Map iteration is insertion-ordered — first entry is the oldest.
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  return {
    record(channel, threadTs) {
      if (!channel || !threadTs) return
      const t = now()
      pruneExpired(t)
      const k = key(channel, threadTs)
      // Bump recency — delete first so the new entry lands at the tail.
      entries.delete(k)
      entries.set(k, t)
      enforceCapacity()
    },
    has(channel, threadTs) {
      if (!channel || !threadTs) return false
      const t = now()
      pruneExpired(t)
      return entries.has(key(channel, threadTs))
    },
    size() {
      pruneExpired(now())
      return entries.size
    },
    clear() {
      entries.clear()
    },
  }
}
