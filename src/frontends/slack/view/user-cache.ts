/**
 * Entity-name cache keyed by Slack user id + channel id (plan §S7).
 *
 * Bantai resolves two kinds of names on demand:
 *   - **User display names.** The inbox turn-builder prefixes each
 *     inbound message with `@<displayName>:` so the agent knows who's
 *     talking. The approval / elicitation surfaces use `<@U…>` native
 *     mentions which Slack renders for us, so they don't hit the cache.
 *   - **Channel names.** The banner + `!bantai status` surfaces want a
 *     human-readable `#channel-name` when the channel isn't declared in
 *     `slack.json` (so no static `name:` override exists).
 *
 * Entries expire after `ttlMs` (default 15 min — profile data drifts but
 * rarely within a single run) and total size is capped at `maxSize`
 * (default 1000) with oldest-first eviction. That matches the shape of
 * openclaw's `monitor/context.ts` name cache, and keeps memory flat for
 * workspaces with thousands of users even when the bot sits in many
 * channels.
 *
 * Ported from openclaw/extensions/slack/src/monitor/context.ts (MIT).
 */

import type { App } from "@slack/bolt"
import { log } from "../../../utils/logger"

export interface UserCache {
  displayName(userId: string): Promise<string | undefined>
  /**
   * Resolve a Slack channel id to a human-friendly name (without the `#`).
   * Returns undefined when `conversations.info` fails or the channel is
   * a DM / private group with no name. Callers should keep the raw id
   * in structured metadata and use the resolved name for display only.
   */
  channelName(channelId: string): Promise<string | undefined>
  /** Test hook — seed a user display name so no API call is made. */
  seed(userId: string, name: string): void
  /** Test hook — seed a channel name. */
  seedChannel(channelId: string, name: string): void
  /** Clear every cache (users + channels). */
  clear(): void
  /** For tests + diagnostics — total entries across both caches. */
  size(): number
}

export interface UserCacheOpts {
  /** Entry lifetime in ms. Default 15 min. */
  ttlMs?: number
  /**
   * Max entries per sub-cache (users + channels tracked separately).
   * Default 1000 — Slack workspaces rarely hit this during a session,
   * and the cap just prevents runaway growth if something loops.
   */
  maxSize?: number
  /** Test hook — override Date.now for deterministic TTL expiry. */
  now?: () => number
}

interface CacheEntry<V> {
  value: V
  expiresAt: number
}

/**
 * Bounded cache with TTL + insertion-order eviction. `Map`'s
 * insertion-order iteration makes "evict the oldest key" an O(1)
 * single-iteration, which is good enough for a 1000-entry cap — no
 * need to reach for a full doubly-linked LRU implementation.
 *
 * On every lookup we re-insert the key to bump its position; that
 * turns the Map into an LRU rather than FIFO. OpenClaw does the same.
 */
function createBoundedTtlCache<V>(opts: {
  ttlMs: number
  maxSize: number
  now: () => number
}): {
  get(key: string): V | undefined
  set(key: string, value: V): void
  clear(): void
  size(): number
} {
  const entries = new Map<string, CacheEntry<V>>()
  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (opts.now() > entry.expiresAt) {
        entries.delete(key)
        return undefined
      }
      // LRU bump: re-insert at the tail.
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value) {
      if (entries.has(key)) entries.delete(key)
      entries.set(key, {
        value,
        expiresAt: opts.now() + opts.ttlMs,
      })
      if (entries.size > opts.maxSize) {
        // Evict the oldest surviving entry (first one iteration yields).
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
    },
    clear() {
      entries.clear()
    },
    size() {
      return entries.size
    },
  }
}

export function createUserCache(
  app: App,
  opts: UserCacheOpts = {},
): UserCache {
  const ttlMs = opts.ttlMs ?? 15 * 60 * 1000
  const maxSize = opts.maxSize ?? 1000
  const now = opts.now ?? Date.now
  const users = createBoundedTtlCache<string>({ ttlMs, maxSize, now })
  const channels = createBoundedTtlCache<string>({ ttlMs, maxSize, now })
  const pendingUsers = new Map<string, Promise<string | undefined>>()
  const pendingChannels = new Map<string, Promise<string | undefined>>()

  return {
    async displayName(userId) {
      const cached = users.get(userId)
      if (cached !== undefined) return cached
      const inflight = pendingUsers.get(userId)
      if (inflight) return inflight

      const fetchP = (async () => {
        try {
          const res = await app.client.users.info({ user: userId })
          if (!res.ok || !res.user) {
            log.warn(`slack: users.info returned no user for ${userId}: ${res.error ?? "unknown"}`)
            return undefined
          }
          const profile = res.user.profile
          const display = profile?.display_name && profile.display_name.length > 0
            ? profile.display_name
            : profile?.real_name ?? res.user.real_name ?? res.user.name ?? undefined
          if (display) users.set(userId, display)
          return display
        } catch (err) {
          log.error(`slack: users.info threw for ${userId}: ${String(err)}`)
          return undefined
        } finally {
          pendingUsers.delete(userId)
        }
      })()
      pendingUsers.set(userId, fetchP)
      return fetchP
    },
    async channelName(channelId) {
      const cached = channels.get(channelId)
      if (cached !== undefined) return cached
      const inflight = pendingChannels.get(channelId)
      if (inflight) return inflight

      const fetchP = (async () => {
        try {
          const res = await app.client.conversations.info({ channel: channelId })
          if (!res.ok || !res.channel) {
            log.warn(
              `slack: conversations.info returned no channel for ${channelId}: ${res.error ?? "unknown"}`,
            )
            return undefined
          }
          // Slack's typed response narrows `channel` to a union covering
          // public channels / IMs / MPIMs / private groups. `name` only
          // exists on the channel-like variants — we duck-type it.
          const name = (res.channel as { name?: string }).name
          if (name && name.length > 0) {
            channels.set(channelId, name)
            return name
          }
          return undefined
        } catch (err) {
          log.error(`slack: conversations.info threw for ${channelId}: ${String(err)}`)
          return undefined
        } finally {
          pendingChannels.delete(channelId)
        }
      })()
      pendingChannels.set(channelId, fetchP)
      return fetchP
    },
    seed(userId, name) {
      users.set(userId, name)
    },
    seedChannel(channelId, name) {
      channels.set(channelId, name)
    },
    clear() {
      users.clear()
      channels.clear()
    },
    size() {
      return users.size() + channels.size()
    },
  }
}
