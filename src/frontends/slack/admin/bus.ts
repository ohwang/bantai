/**
 * AdminBus — in-memory pub/sub for admin frames.
 *
 * Multiple consumers want the same stream of AdminFrames:
 *
 *   1. The admin WebSocket layer pushes frames to every connected client.
 *   2. The per-session ring buffer accumulates a tail of events for
 *      back-fill when a client connects mid-session.
 *   3. Optional in-process subscribers (future metrics enrichment, an
 *      on-disk audit log, etc.).
 *
 * An in-memory bus with `publish` + `subscribe` + `subscribeKeyed` is the
 * smallest abstraction that keeps all three independent. The registry and
 * approval coordinator call `publish(frame)` when state changes; every
 * consumer subscribes and unsubscribes on its own schedule.
 *
 * Delivery guarantees: best-effort, in-order within a single process. The
 * bus does NOT queue for slow consumers; a consumer that can't keep up is
 * the consumer's problem (see `server.ts` backpressure handling).
 * Throwing subscribers are logged and isolated — one broken subscriber
 * never prevents fan-out to the others.
 *
 * A no-op variant is exported so code paths that always call `publish`
 * (the registry, the approval coordinator) don't need to branch on
 * whether admin is enabled: the launcher hands them the real bus when
 * `admin.enabled = true` and the no-op bus otherwise.
 */

import { log } from "../../../utils/logger"
import type { AdminFrame } from "./protocol"

export type AdminSubscriber = (frame: AdminFrame) => void

export interface AdminBus {
  /**
   * Publish a frame. Returns synchronously; every subscriber is invoked
   * synchronously too, so order within a single publish is preserved.
   * Subscribers that throw are caught + logged so one bad listener never
   * stops fan-out.
   */
  publish(frame: AdminFrame): void
  /** Subscribe to every frame. Returns an unsubscribe function. */
  subscribe(fn: AdminSubscriber): () => void
  /**
   * Subscribe to frames that belong to a specific session key. See
   * `frameKey(...)` for which frame types expose a session key. Frames
   * with no session key (hello, snapshot, config_changed, pong, error,
   * approval_resolved) are NOT delivered to keyed subscribers — use
   * `subscribe()` if you want those.
   */
  subscribeKeyed(key: string, fn: AdminSubscriber): () => void
}

/**
 * Extract the session key from a frame if the frame is session-scoped.
 * Returns `null` for global frames. Exported so the server + tests can
 * share the exact routing rule.
 */
export function frameKey(frame: AdminFrame): string | null {
  switch (frame.type) {
    case "session_opened":
      return frame.summary.key
    case "session_summary":
      return frame.summary.key
    case "session_closed":
    case "session_phase":
    case "session_event":
      return frame.key
    case "approval_requested":
      return frame.approval.sessionKey
    // Global frames — no session key.
    case "hello":
    case "snapshot":
    case "config_changed":
    case "error":
    case "pong":
    case "approval_resolved":
      return null
  }
}

/**
 * Build a real AdminBus. Callers that want the "admin disabled" path
 * should use `createNoopAdminBus()` below instead — both expose the same
 * interface so call sites don't have to branch.
 */
export function createAdminBus(): AdminBus {
  const all = new Set<AdminSubscriber>()
  const keyed = new Map<string, Set<AdminSubscriber>>()

  function deliver(fn: AdminSubscriber, frame: AdminFrame): void {
    try {
      fn(frame)
    } catch (err) {
      log.error(
        `slack admin bus: subscriber threw for ${frame.type}: ${String(err)}`,
      )
    }
  }

  return {
    publish(frame) {
      // Snapshot both sets so a subscriber that unsubscribes mid-fan-out
      // doesn't skew the iteration — same pattern the registry pump uses.
      for (const fn of Array.from(all)) {
        deliver(fn, frame)
      }
      const key = frameKey(frame)
      if (key === null) return
      const bucket = keyed.get(key)
      if (!bucket) return
      for (const fn of Array.from(bucket)) {
        deliver(fn, frame)
      }
    },
    subscribe(fn) {
      all.add(fn)
      return () => {
        all.delete(fn)
      }
    },
    subscribeKeyed(key, fn) {
      let bucket = keyed.get(key)
      if (!bucket) {
        bucket = new Set<AdminSubscriber>()
        keyed.set(key, bucket)
      }
      bucket.add(fn)
      return () => {
        const b = keyed.get(key)
        if (!b) return
        b.delete(fn)
        if (b.size === 0) keyed.delete(key)
      }
    },
  }
}

/**
 * No-op AdminBus — drop every publish, never invoke a subscriber. Used
 * when admin is disabled so the registry + approval coordinator can
 * unconditionally call `bus.publish(...)` without branching.
 */
export function createNoopAdminBus(): AdminBus {
  return {
    publish() {},
    subscribe() {
      return () => {}
    },
    subscribeKeyed() {
      return () => {}
    },
  }
}
