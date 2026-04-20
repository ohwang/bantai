/**
 * JsonlTailer — read-and-watch a single JSONL file.
 *
 * Responsibilities:
 *   1. On start, read the existing file line-by-line and hand each
 *      complete (newline-terminated) line to an onLine callback.
 *   2. After initial replay, install an fs.watch and, on every `change`,
 *      open the file, seek to the last known offset, read the remainder,
 *      split on `\n`, deliver complete lines only — buffering any trailing
 *      partial line until the next `change`.
 *   3. On `rename` / delete, log a warning and close. Claude Code does not
 *      rotate JSONL files; a rename is always a signal that the session
 *      moved or was deleted.
 *   4. Expose `close()` that removes the watcher and stops delivering.
 *
 * Intentional constraints:
 *   - Lines are only delivered once the trailing `\n` lands. Claude Code
 *     writes atomically per entry, but fs.watch can fire mid-write on
 *     macOS — this guard prevents parsing a half-written JSON object.
 *   - All delivery is synchronous from the tailer's perspective. The onLine
 *     callback may do async work, but the tailer does not await it — doing
 *     so would serialise the file under high-throughput sessions and risk
 *     losing change events.
 *   - Never silently drop a watcher error. AGENTS.md's "never silently drop
 *     data from an external source" applies equally to infrastructure
 *     signals: if the watcher dies, we surface it via onError so the
 *     backend can emit a fatal AgentEvent.
 */

import { openSync, readSync, closeSync, statSync, watch } from "node:fs"
import type { FSWatcher } from "node:fs"
import { log } from "../../utils/logger"

export interface JsonlTailerOptions {
  /** Absolute path to the JSONL file. */
  path: string
  /** Called once per complete, newline-terminated line. Does NOT include the trailing `\n`. */
  onLine: (line: string) => void
  /** Called when the file is renamed / deleted, or when an unrecoverable IO error occurs. */
  onEnd?: (reason: "rename" | "error", error?: unknown) => void
}

export class JsonlTailer {
  private readonly path: string
  private readonly onLine: (line: string) => void
  private readonly onEnd?: (reason: "rename" | "error", err?: unknown) => void

  private offset = 0
  private residual = "" // trailing partial line buffer
  private watcher: FSWatcher | null = null
  private closed = false

  constructor(opts: JsonlTailerOptions) {
    this.path = opts.path
    this.onLine = opts.onLine
    this.onEnd = opts.onEnd
  }

  /**
   * Run the initial replay synchronously, then install the watcher. Returns
   * after the initial read completes. Subsequent appends are delivered via
   * watcher callbacks.
   *
   * Returning the count of replayed lines is handy for callers that want to
   * emit a "history_loaded" marker at the boundary between replay and tail.
   */
  start(): { replayedLines: number } {
    const replayedLines = this.readFromCurrentOffset()

    if (this.closed) return { replayedLines }

    // `fs.watch` has sharp edges on macOS (multiple events per write) and
    // Linux (eventType values differ), but for our "same-host JSONL" use
    // case the `change` event is consistent enough. We deduplicate by
    // always re-reading from the tracked offset — spurious events cost an
    // extra empty read, which is cheap.
    try {
      this.watcher = watch(this.path, { persistent: false }, (eventType) => {
        if (this.closed) return
        if (eventType === "rename") {
          // Rename/delete: the JSONL path is no longer valid. Claude Code
          // does not rotate — this is always a terminal signal.
          log.warn("JSONL tailer saw rename/delete event", { path: this.path })
          this.closeInternal()
          this.onEnd?.("rename")
          return
        }
        // "change" — re-read from the tracked offset.
        try {
          this.readFromCurrentOffset()
        } catch (err) {
          log.error("JSONL tailer read failed", {
            path: this.path,
            error: err instanceof Error ? err.message : String(err),
          })
          this.closeInternal()
          this.onEnd?.("error", err)
        }
      })
      this.watcher.on("error", (err) => {
        if (this.closed) return
        log.error("JSONL tailer watcher errored", {
          path: this.path,
          error: err instanceof Error ? err.message : String(err),
        })
        this.closeInternal()
        this.onEnd?.("error", err)
      })
    } catch (err) {
      // Watcher install failed outright (e.g. file vanished between initial
      // read and watch). Surface as an error so the backend can report it.
      log.error("JSONL tailer failed to install watcher", {
        path: this.path,
        error: err instanceof Error ? err.message : String(err),
      })
      this.closed = true
      this.onEnd?.("error", err)
    }

    return { replayedLines }
  }

  /** Stop watching and release resources. Idempotent. */
  close(): void {
    this.closeInternal()
  }

  /**
   * Read from `this.offset` to EOF, split on newlines, deliver complete
   * lines via `onLine`, and stash any trailing partial line in `residual`.
   * Returns the number of lines delivered on this call.
   */
  private readFromCurrentOffset(): number {
    if (this.closed) return 0

    let size: number
    try {
      size = statSync(this.path).size
    } catch (err) {
      log.warn("JSONL tailer stat failed — treating as EOF", {
        path: this.path,
        error: err instanceof Error ? err.message : String(err),
      })
      return 0
    }

    if (size < this.offset) {
      // Truncation. Unusual (Claude Code doesn't truncate); reset to start
      // and replay from scratch rather than silently dropping the contents.
      log.warn("JSONL tailer saw file shrink — resetting offset", {
        path: this.path,
        previousOffset: this.offset,
        newSize: size,
      })
      this.offset = 0
      this.residual = ""
    }

    if (size === this.offset) return 0

    const toRead = size - this.offset
    const buffer = Buffer.allocUnsafe(toRead)
    const fd = openSync(this.path, "r")
    let bytesRead = 0
    try {
      bytesRead = readSync(fd, buffer, 0, toRead, this.offset)
    } finally {
      closeSync(fd)
    }
    this.offset += bytesRead

    const chunk = this.residual + buffer.slice(0, bytesRead).toString("utf-8")
    const parts = chunk.split("\n")
    this.residual = parts.pop() ?? ""

    let delivered = 0
    for (const part of parts) {
      if (this.closed) break
      // Empty lines are fine — skip without noise. Any non-empty line
      // reaches onLine; JSON parsing is the translator's responsibility.
      if (part.length === 0) continue
      this.onLine(part)
      delivered++
    }
    return delivered
  }

  private closeInternal(): void {
    if (this.closed) return
    this.closed = true
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        // Best-effort — don't fail close() on a watcher that's already dead.
      }
      this.watcher = null
    }
  }
}
