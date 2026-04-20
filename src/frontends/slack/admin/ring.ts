/**
 * Per-session event ring buffer.
 *
 * A monitor connecting mid-session (5 minutes after the bot booted, say)
 * still wants to see what just happened on each thread. Each session gets
 * a bounded deque of the most recent `AgentEvent`s; the admin server's
 * `/admin/sessions/:key/events` endpoint returns a snapshot of it, and
 * the monitor replays those before switching to live frames.
 *
 * Populated from the AdminBus — one subscription, the same fan-out every
 * other consumer uses. On `session_closed` the key's buffer is dropped so
 * a short-lived thread that churns open-close-open-close doesn't leak
 * memory.
 *
 * Capacity is configurable via `admin.session_ring_size` (schema) and
 * defaults to 200. At roughly 1 KB per event × 200 events × 200 sessions
 * that's ~40 MB worst case — fine for v0, tightened if it ever matters.
 */

import type { AgentEvent } from "../../../protocol/types"
import type { AdminBus } from "./bus"

export interface SessionRingBuffer {
  /**
   * Return the tail of stored events for `key`, oldest first. Empty array
   * when the key has no entry (either never seen or closed).
   */
  snapshot(key: string): AgentEvent[]
  /** Number of keys currently tracked. */
  size(): number
  /** Drop every stored key — used on shutdown + tests. */
  clear(): void
}

export interface AttachedRingBuffer extends SessionRingBuffer {
  /** Unsubscribe the underlying bus subscription. Safe to call twice. */
  dispose(): void
}

export interface CreateRingBufferOpts {
  /**
   * Max events kept per session. Oldest-first eviction when full. Must be
   * positive; values outside the config schema's [10, 5000] band will work
   * but the schema prevents them from reaching here in normal config.
   */
  capacity: number
}

/**
 * Build a ring buffer that isn't wired to a bus — used by tests that want
 * to drive events manually. Production code uses `attachRingBuffer(bus, opts)`.
 */
export function createRingBuffer(opts: CreateRingBufferOpts): SessionRingBuffer & {
  /** Append an event to the key's deque (creating it if needed). */
  push(key: string, event: AgentEvent): void
  /** Drop the key's deque — called on session_closed. */
  drop(key: string): void
} {
  if (opts.capacity <= 0) {
    throw new Error(`SessionRingBuffer: capacity must be positive (got ${opts.capacity})`)
  }
  // Map preserves insertion order, which doesn't matter here but keeps
  // deterministic iteration for tests.
  const buffers = new Map<string, AgentEvent[]>()

  return {
    push(key, event) {
      let buf = buffers.get(key)
      if (!buf) {
        buf = []
        buffers.set(key, buf)
      }
      buf.push(event)
      // Evict from the front until we're at capacity. In practice we only
      // overflow by one per push, but a loop keeps the invariant regardless
      // of how a future caller uses the ring.
      while (buf.length > opts.capacity) {
        buf.shift()
      }
    },
    drop(key) {
      buffers.delete(key)
    },
    snapshot(key) {
      const buf = buffers.get(key)
      // Return a defensive copy — callers (the HTTP server) serialise this
      // directly, and we don't want a concurrent push to mutate the array
      // mid-JSON-stringify.
      return buf ? buf.slice() : []
    },
    size() {
      return buffers.size
    },
    clear() {
      buffers.clear()
    },
  }
}

/**
 * Attach a ring buffer to an AdminBus. Returns a handle that exposes
 * `snapshot(key)` + `dispose()`. The buffer subscribes globally so it
 * catches every session's event stream with a single listener, rather
 * than one per session.
 */
export function attachRingBuffer(
  bus: AdminBus,
  opts: CreateRingBufferOpts,
): AttachedRingBuffer {
  const ring = createRingBuffer(opts)
  const unsub = bus.subscribe((frame) => {
    if (frame.type === "session_event") {
      ring.push(frame.key, frame.event)
    } else if (frame.type === "session_closed") {
      ring.drop(frame.key)
    }
  })
  let disposed = false
  return {
    snapshot: (key) => ring.snapshot(key),
    size: () => ring.size(),
    clear: () => ring.clear(),
    dispose() {
      if (disposed) return
      disposed = true
      unsub()
    },
  }
}
