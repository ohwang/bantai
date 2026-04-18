/**
 * No-op storage — the default when `--persist` is not set.
 * Present so startMinislack() can always hold a StorageBackend reference.
 */

import type { EventBus, Unsubscribe } from "../core/events"
import type { StorageBackend } from "./types"

export function createMemoryStorage(): StorageBackend {
  return {
    kind: "memory",
    async load() {
      return null
    },
    attach(_ws, _bus: EventBus): Unsubscribe {
      return () => {}
    },
    async stop() {},
  }
}
