/**
 * Inbound debouncer.
 *
 * Groups rapid messages from the same (channel, thread, sender) triple
 * into one agent turn. Without this, three lines typed in quick
 * succession trigger three independent `entry.send()` calls — three
 * separate agent turns with interleaved output, and a sliced message
 * budget across what the user thought was one ask.
 *
 * Core contract:
 *   - `enqueue(entry)` buffers the entry under `buildKey(entry)`. Any
 *     prior pending flush for that key is cancelled and re-scheduled,
 *     so rapid enqueues on the same key keep pushing the flush forward
 *     (like a trailing-edge debounce).
 *   - When `debounceMs` elapses with no new enqueue for the key, the
 *     buffered entries are handed to `onFlush(entries)` in arrival
 *     order.
 *   - `flushKey(key)` forces an immediate flush. `flushAll()` flushes
 *     every pending key — used on launcher shutdown.
 *   - Setting `debounceMs <= 0` disables batching: every enqueue flushes
 *     synchronously with exactly one entry.
 *
 * Ported from openclaw's `createChannelInboundDebouncer` pattern
 * (MIT). Reimplemented from scratch to avoid pulling in the whole
 * plugin SDK — the API surface is small enough.
 */

export interface InboundDebouncerOpts<T> {
  /**
   * Delay between the last enqueue and the flush. 0 or negative
   * disables batching (every enqueue flushes synchronously).
   */
  debounceMs: number
  buildKey(entry: T): string
  onFlush(entries: T[]): void | Promise<void>
  /**
   * Per-entry gate. Returning false dispatches the entry immediately
   * (`onFlush([entry])`) without queueing. Useful for messages whose
   * shape shouldn't be batched (file-only uploads, slash-command
   * payloads). Default: always debounce when `debounceMs > 0`.
   */
  shouldDebounce?(entry: T): boolean
  onError?(err: unknown): void
  /** Test hook: override setTimeout / clearTimeout. */
  timers?: {
    setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>
    clearTimer(t: ReturnType<typeof setTimeout>): void
  }
}

export interface InboundDebouncer<T> {
  /** Queue an entry. Resolves when the enqueue side-effects settle. */
  enqueue(entry: T): Promise<void>
  /** Force-flush a specific key. No-op if nothing is queued. */
  flushKey(key: string): Promise<void>
  /** Force-flush every pending key. Returns when all flushes complete. */
  flushAll(): Promise<void>
  /** Number of distinct keys with buffered entries (for tests + diagnostics). */
  pendingKeys(): number
}

interface PendingBucket<T> {
  entries: T[]
  timer: ReturnType<typeof setTimeout> | undefined
}

export function createInboundDebouncer<T>(
  opts: InboundDebouncerOpts<T>,
): InboundDebouncer<T> {
  const {
    debounceMs,
    buildKey,
    onFlush,
    shouldDebounce = () => true,
    onError,
  } = opts
  const timers = opts.timers ?? {
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
  }

  const pending = new Map<string, PendingBucket<T>>()

  async function dispatchEntries(entries: T[]): Promise<void> {
    try {
      await onFlush(entries)
    } catch (err) {
      if (onError) onError(err)
      else throw err
    }
  }

  async function flushBucket(key: string): Promise<void> {
    const bucket = pending.get(key)
    if (!bucket) return
    pending.delete(key)
    if (bucket.timer) timers.clearTimer(bucket.timer)
    if (bucket.entries.length === 0) return
    await dispatchEntries(bucket.entries)
  }

  return {
    async enqueue(entry) {
      // Bypass path: batching off, or entry shape says "don't debounce".
      if (debounceMs <= 0 || !shouldDebounce(entry)) {
        await dispatchEntries([entry])
        return
      }
      const key = buildKey(entry)
      let bucket = pending.get(key)
      if (!bucket) {
        bucket = { entries: [], timer: undefined }
        pending.set(key, bucket)
      }
      bucket.entries.push(entry)
      if (bucket.timer) timers.clearTimer(bucket.timer)
      bucket.timer = timers.setTimer(() => {
        void flushBucket(key)
      }, debounceMs)
    },

    async flushKey(key) {
      await flushBucket(key)
    },

    async flushAll() {
      const keys = Array.from(pending.keys())
      await Promise.all(keys.map((k) => flushBucket(k)))
    },

    pendingKeys() {
      return pending.size
    },
  }
}
