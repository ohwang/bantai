/**
 * Event dedup cache.
 *
 * Slack redelivers events under three conditions:
 *   1. HTTP Events API: when we don't 200 in 3s, or on periodic retries.
 *   2. Socket Mode: when we don't ack an envelope quickly enough.
 *   3. Double-post races between cluster nodes (future multi-instance).
 *
 * The dedup key is `<channel>:<ts>` for message-shaped events (Slack's own
 * `event_id` is also fine but we don't always have it for Bolt-normalised
 * events). Entries TTL-expire after 1h so the cache doesn't grow without
 * bound.
 */

export interface DedupOpts {
  ttlMs?: number
  /** Test hook: override Date.now. */
  now?: () => number
}

export interface DedupCache {
  /** Returns true if this key is new; false if already seen (i.e. should be dropped). */
  markFresh(key: string): boolean
  /** Drop expired entries (call occasionally). */
  prune(): void
  /** Entry count for tests / diagnostics. */
  size(): number
}

export function createDedupCache(opts: DedupOpts = {}): DedupCache {
  const ttl = opts.ttlMs ?? 60 * 60 * 1000
  const now = opts.now ?? Date.now
  const seen = new Map<string, number>() // key -> recorded-at
  return {
    markFresh(key) {
      const t = now()
      const prior = seen.get(key)
      if (prior !== undefined && t - prior < ttl) return false
      seen.set(key, t)
      return true
    },
    prune() {
      const cutoff = now() - ttl
      for (const [k, t] of seen) {
        if (t < cutoff) seen.delete(k)
      }
    },
    size() {
      return seen.size
    },
  }
}
