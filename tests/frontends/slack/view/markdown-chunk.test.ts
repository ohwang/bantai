/**
 * Tests for `chunkRawMarkdown` — the raw-markdown chunker that feeds
 * Slack's `markdown_text` field (12k-char limit, GFM semantics). The
 * key invariants we care about:
 *
 *   - In-range bodies pass through as a single chunk (no wasted calls).
 *   - Oversize bodies split on paragraph/line boundaries when possible.
 *   - Every chunk is ≤ the limit.
 *   - Fenced code blocks are never "open" across a chunk boundary —
 *     the chunker closes the fence at the end of a chunk and reopens
 *     it (with the original language tag) at the start of the next, so
 *     Slack renders both halves as code.
 *   - Pipe-table rows are kept intact (splits between rows, never
 *     mid-row).
 */
import { describe, expect, it } from "bun:test"
import {
  chunkRawMarkdown,
  SLACK_MARKDOWN_TEXT_LIMIT,
} from "../../../../src/frontends/slack/view/markdown-chunk"

describe("chunkRawMarkdown — basics", () => {
  it("returns an empty array for empty input", () => {
    expect(chunkRawMarkdown("")).toEqual([])
  })

  it("returns a single chunk when the input fits under the limit", () => {
    const md = "# Hello\n\nThis is a short body with **bold**."
    expect(chunkRawMarkdown(md)).toEqual([md])
  })

  it("default limit matches the exported constant", () => {
    // Construct something just under the limit so it fits in one chunk.
    const md = "a".repeat(SLACK_MARKDOWN_TEXT_LIMIT - 10)
    expect(chunkRawMarkdown(md)).toEqual([md])
  })

  it("every emitted chunk is ≤ the limit", () => {
    const limit = 100
    const paragraph = "x".repeat(50)
    const md = Array.from({ length: 20 }, () => paragraph).join("\n\n")
    const chunks = chunkRawMarkdown(md, limit)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(limit)
    }
  })
})

describe("chunkRawMarkdown — paragraph splits", () => {
  it("splits between paragraph boundaries when possible", () => {
    const limit = 30
    const md = "first paragraph here.\n\nsecond paragraph here."
    const chunks = chunkRawMarkdown(md, limit)
    expect(chunks.length).toBeGreaterThan(1)
    // No chunk should contain BOTH paragraphs.
    for (const c of chunks) {
      const hasFirst = c.includes("first")
      const hasSecond = c.includes("second")
      expect(hasFirst && hasSecond).toBe(false)
    }
  })

  it("joins paragraphs that fit together into one chunk", () => {
    const limit = 200
    const md = "short one.\n\nshort two.\n\nshort three."
    const chunks = chunkRawMarkdown(md, limit)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain("short one")
    expect(chunks[0]).toContain("short three")
  })
})

describe("chunkRawMarkdown — fence safety", () => {
  it("never leaves a fence open across a chunk boundary (closes + reopens)", () => {
    // A fenced block longer than the limit must split, and when it
    // does the chunker inserts ``` at the end of chunk N and ```lang
    // at the start of chunk N+1 so each chunk stands alone.
    const limit = 80
    const inner = Array.from({ length: 10 }, (_, i) => `line ${i}: ${"y".repeat(20)}`).join(
      "\n",
    )
    const md = "```ts\n" + inner + "\n```"
    const chunks = chunkRawMarkdown(md, limit)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      // Every chunk must have a balanced number of fence toggles —
      // either 0 (no fence in this chunk at all) or even (open + close).
      const fenceCount = (chunk.match(/^```/gm) ?? []).length
      expect(fenceCount % 2).toBe(0)
    }
    // The original language tag is preserved on reopens.
    const reopens = chunks.slice(1).filter((c) => c.startsWith("```ts"))
    expect(reopens.length).toBeGreaterThan(0)
  })

  it("handles unlabelled fences by reopening with bare ``` ", () => {
    const limit = 60
    const inner = Array.from({ length: 8 }, (_, i) => `row${i}-${"a".repeat(15)}`).join("\n")
    const md = "```\n" + inner + "\n```"
    const chunks = chunkRawMarkdown(md, limit)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      const fenceCount = (chunk.match(/^```/gm) ?? []).length
      expect(fenceCount % 2).toBe(0)
    }
  })
})

describe("chunkRawMarkdown — pipe tables", () => {
  it("splits between table rows, not mid-row", () => {
    // Build a wide table that overflows the chunk limit, each row just
    // under the limit so a row can fit but two rows together can't.
    const header = "| col-a | col-b |\n| --- | --- |"
    const row = (i: number) => `| value-${i} | value-${i} |`
    const rows = Array.from({ length: 10 }, (_, i) => row(i))
    const md = [header, ...rows].join("\n")

    // Pick a limit that forces multiple chunks across table rows.
    const limit = 80
    const chunks = chunkRawMarkdown(md, limit)
    expect(chunks.length).toBeGreaterThan(1)
    // Every line in every chunk must be a "full" pipe-table row — if a
    // row was split mid-way we'd see a line that starts with `|` but
    // doesn't end with `|`.
    for (const chunk of chunks) {
      for (const line of chunk.split("\n")) {
        if (line.startsWith("|")) {
          expect(line.trim().endsWith("|")).toBe(true)
        }
      }
    }
  })
})

describe("chunkRawMarkdown — oversize single lines", () => {
  it("hard-slices a line that alone exceeds the limit", () => {
    const limit = 50
    const longLine = "x".repeat(200)
    const chunks = chunkRawMarkdown(longLine, limit)
    // Multiple chunks, each ≤ limit, and their concatenation covers
    // every character of the input.
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(limit)
    }
    const joined = chunks.join("")
    expect(joined.replace(/\s+/g, "")).toBe(longLine)
  })
})
