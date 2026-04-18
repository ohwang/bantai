/**
 * Display-name cache keyed by Slack user id.
 *
 * The inbox turn-builder prefixes each inbound message with `@<displayName>:`
 * so the agent sees who's talking. We resolve display names lazily via
 * users.info (Slack) / minislack's equivalent and cache them in memory —
 * they rarely change over a single process lifetime, and the cost of the
 * call (~50ms on real Slack) is only paid once per user per process.
 */

import type { App } from "@slack/bolt"
import { log } from "../../../utils/logger"

export interface UserCache {
  displayName(userId: string): Promise<string | undefined>
  /** Test hook — seed a name so no API call is made. */
  seed(userId: string, name: string): void
  clear(): void
}

export function createUserCache(app: App): UserCache {
  const cache = new Map<string, string>()
  const pending = new Map<string, Promise<string | undefined>>()

  return {
    async displayName(userId) {
      const cached = cache.get(userId)
      if (cached !== undefined) return cached
      const inflight = pending.get(userId)
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
          if (display) cache.set(userId, display)
          return display
        } catch (err) {
          log.error(`slack: users.info threw for ${userId}: ${String(err)}`)
          return undefined
        } finally {
          pending.delete(userId)
        }
      })()
      pending.set(userId, fetchP)
      return fetchP
    },
    seed(userId, name) {
      cache.set(userId, name)
    },
    clear() {
      cache.clear()
    },
  }
}
