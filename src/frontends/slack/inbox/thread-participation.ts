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
 * Ported from OpenClaw's `extensions/slack/src/sent-thread-cache.ts` (MIT).
 * Adjusted to drop the global Symbol indirection — in bantai the cache is
 * owned by the launcher and handed to `buildRoutingHandler` via
 * `RoutingCtx.threadParticipation`, which keeps tests isolated.
 *
 * Semantics:
 *   - `record(channel, threadTs)` — idempotent. Call after every successful
 *     outbound `chat.postMessage` / `chat.update` on the (channel, thread)
 *     pair. Safe on no-op threads (threadTs missing) — silently skips.
 *   - `has(channel, threadTs)` — pure query. Does not refresh the entry's
 *     age. Returns false for unknown or expired entries.
 *   - `prune()` — drop expired entries. Called lazily from `record`/`has`
 *     so memory stays bounded without a background timer.
 *   - TTL default 24h, capacity default 5000 — same as OpenClaw.
 */

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
}

export function createThreadParticipationCache(
  opts: ThreadParticipationOpts = {},
): ThreadParticipationCache {
  const ttl = opts.ttlMs ?? 24 * 60 * 60 * 1000
  const maxSize = Math.max(1, opts.maxSize ?? 5000)
  const now = opts.now ?? Date.now
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
