/**
 * Tests for JsonlTailer.
 *
 * Covers:
 *   - initial replay: existing lines are delivered before start() returns
 *   - line framing: only complete (\n-terminated) lines are delivered
 *   - live append: appending after start() delivers the new line via watcher
 *   - partial line buffering: a mid-write chunk is not delivered until the
 *     trailing newline lands
 *   - rename/delete: triggers onEnd("rename") and closes cleanly
 *   - close() is idempotent and stops further deliveries
 *
 * fs.watch is noisy on macOS (multiple events per write) — tests rely on
 * the tailer's offset tracking to deduplicate those events. We use a short
 * poll loop rather than fixed sleeps to keep the suite quick.
 */

import { describe, expect, it, afterEach, beforeEach } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  renameSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonlTailer } from "../../src/backends/follow/jsonl-tailer"

let tmpDir: string
let filePath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bantai-tailer-"))
  filePath = join(tmpDir, "session.jsonl")
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1500,
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out")
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe("JsonlTailer", () => {
  it("replays existing lines on start()", () => {
    writeFileSync(filePath, "line1\nline2\nline3\n")
    const lines: string[] = []
    const tailer = new JsonlTailer({
      path: filePath,
      onLine: (l) => lines.push(l),
    })
    const { replayedLines } = tailer.start()
    expect(replayedLines).toBe(3)
    expect(lines).toEqual(["line1", "line2", "line3"])
    tailer.close()
  })

  it("does not deliver a trailing partial line until the newline arrives", async () => {
    writeFileSync(filePath, "complete\npartial")
    const lines: string[] = []
    const tailer = new JsonlTailer({
      path: filePath,
      onLine: (l) => lines.push(l),
    })
    tailer.start()
    expect(lines).toEqual(["complete"])

    // Append the rest of the partial line plus a new one.
    appendFileSync(filePath, "-more\nsecond\n")
    await waitFor(() => lines.length >= 3)
    expect(lines).toEqual(["complete", "partial-more", "second"])
    tailer.close()
  })

  it("delivers lines appended after start()", async () => {
    writeFileSync(filePath, "first\n")
    const lines: string[] = []
    const tailer = new JsonlTailer({
      path: filePath,
      onLine: (l) => lines.push(l),
    })
    tailer.start()

    appendFileSync(filePath, "second\n")
    await waitFor(() => lines.length >= 2)
    appendFileSync(filePath, "third\n")
    await waitFor(() => lines.length >= 3)

    expect(lines).toEqual(["first", "second", "third"])
    tailer.close()
  })

  it("triggers onEnd('rename') when the file is renamed", async () => {
    writeFileSync(filePath, "only\n")
    const lines: string[] = []
    const ends: Array<"rename" | "error"> = []
    const tailer = new JsonlTailer({
      path: filePath,
      onLine: (l) => lines.push(l),
      onEnd: (reason) => ends.push(reason),
    })
    tailer.start()

    renameSync(filePath, filePath + ".moved")
    await waitFor(() => ends.length >= 1)
    expect(ends[0]).toBe("rename")
    tailer.close()
  })

  it("close() is idempotent and stops further deliveries", async () => {
    writeFileSync(filePath, "a\n")
    const lines: string[] = []
    const tailer = new JsonlTailer({
      path: filePath,
      onLine: (l) => lines.push(l),
    })
    tailer.start()
    tailer.close()
    tailer.close() // should not throw
    appendFileSync(filePath, "b\n")
    // Give the watcher a moment to (not) fire
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(lines).toEqual(["a"])
  })

  it("skips empty lines (blank JSONL rows are not data)", () => {
    writeFileSync(filePath, "one\n\n\ntwo\n")
    const lines: string[] = []
    const tailer = new JsonlTailer({
      path: filePath,
      onLine: (l) => lines.push(l),
    })
    tailer.start()
    expect(lines).toEqual(["one", "two"])
    tailer.close()
  })
})
