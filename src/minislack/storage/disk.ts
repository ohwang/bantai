/**
 * Disk-backed storage.
 *
 *   <root>/workspace.json    JSON snapshot (see snapshot.ts)
 *   <root>/files/<id>.bin    Raw bytes for each attached file
 *
 * Writes are debounced: any number of bus events in the same tick collapse
 * into one JSON write. File bytes are written once, the first save after a
 * new file id enters ws.files with bytes available; they are re-read on
 * load() so reattached files keep serving the same content.
 */

import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { getFileBytes, setFileBytes } from "../core/files"
import type { Workspace } from "../types/slack"
import { fromSnapshot, toSnapshot, type WorkspaceSnapshot } from "./snapshot"
import type { StorageBackend } from "./types"

export interface DiskStorageOpts {
  root: string
  /** Debounce window in ms. Default 25. */
  debounceMs?: number
}

export function createDiskStorage(opts: DiskStorageOpts): StorageBackend {
  const root = path.resolve(opts.root)
  const jsonPath = path.join(root, "workspace.json")
  const tmpPath = path.join(root, "workspace.json.tmp")
  const filesDir = path.join(root, "files")
  const debounceMs = Math.max(0, opts.debounceMs ?? 25)

  let ws: Workspace | null = null
  let scheduled: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> | null = null
  let pendingDuringWrite = false
  const bytesWritten = new Set<string>()

  async function ensureDirs(): Promise<void> {
    await mkdir(root, { recursive: true })
    await mkdir(filesDir, { recursive: true })
  }

  async function writeSnapshotNow(): Promise<void> {
    if (!ws) return
    await ensureDirs()
    // 1. Any file bytes that haven't landed yet.
    for (const id of ws.files.keys()) {
      if (bytesWritten.has(id)) continue
      const bytes = getFileBytes(ws, id)
      if (!bytes) continue
      await writeFile(path.join(filesDir, `${id}.bin`), bytes)
      bytesWritten.add(id)
    }
    // 2. workspace.json atomically.
    const snap = toSnapshot(ws)
    await writeFile(tmpPath, JSON.stringify(snap, null, 2))
    await rename(tmpPath, jsonPath)
  }

  function schedule(): void {
    if (writing) {
      pendingDuringWrite = true
      return
    }
    if (scheduled) return
    scheduled = setTimeout(() => {
      scheduled = null
      writing = (async () => {
        try {
          await writeSnapshotNow()
        } catch (err) {
          console.error("[minislack] disk save failed:", err)
        } finally {
          writing = null
          if (pendingDuringWrite) {
            pendingDuringWrite = false
            schedule()
          }
        }
      })()
    }, debounceMs)
  }

  async function flush(): Promise<void> {
    if (scheduled) {
      clearTimeout(scheduled)
      scheduled = null
    }
    if (writing) await writing
    await writeSnapshotNow()
  }

  return {
    kind: "disk",
    async load() {
      if (!existsSync(jsonPath)) return null
      const raw = await readFile(jsonPath, "utf8")
      const snap = JSON.parse(raw) as WorkspaceSnapshot
      const loaded = fromSnapshot(snap)
      if (existsSync(filesDir)) {
        const entries = await readdir(filesDir)
        for (const entry of entries) {
          if (!entry.endsWith(".bin")) continue
          const id = entry.slice(0, -".bin".length)
          const bytes = await readFile(path.join(filesDir, entry))
          setFileBytes(loaded, id, new Uint8Array(bytes))
          bytesWritten.add(id)
        }
      }
      ws = loaded
      return loaded
    },
    attach(workspace, bus) {
      ws = workspace
      // Seed a first save so a persisted fixture lands even without a mutation.
      schedule()
      return bus.subscribe({}, () => schedule())
    },
    async stop() {
      await flush()
    },
  }
}
