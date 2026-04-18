/**
 * Shared storage interface. The harness holds one StorageBackend instance
 * for the life of the server. memory.ts is the default no-op; disk.ts is
 * enabled by the `--persist` flag.
 */

import type { EventBus, Unsubscribe } from "../core/events"
import type { Workspace } from "../types/slack"

export interface StorageBackend {
  readonly kind: "memory" | "disk"
  /** Load state from storage. Returns null if no state exists. */
  load(): Promise<Workspace | null>
  /**
   * Start persisting mutations: subscribe to the bus and trigger debounced
   * saves on every event. Returns an Unsubscribe the caller invokes before
   * `stop()`.
   */
  attach(ws: Workspace, bus: EventBus): Unsubscribe
  /** Flush any pending writes and release resources. */
  stop(): Promise<void>
}
