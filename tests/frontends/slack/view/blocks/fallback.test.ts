import { describe, expect, it } from "bun:test"
import type { KnownBlock } from "@slack/types"
import {
  buildSlackBlocksFallbackText,
  withBlockKitFallback,
  MAX_BLOCKS_PER_MESSAGE,
  MAX_BLOCK_TEXT_CHARS,
} from "../../../../../src/frontends/slack/view/blocks/fallback"
import {
  truncateSlackMrkdwn,
  truncateSlackText,
} from "../../../../../src/frontends/slack/view/blocks/truncate"

describe("truncateSlackText", () => {
  it("returns input unchanged when under the limit", () => {
    expect(truncateSlackText("hello", 20)).toBe("hello")
  })

  it("truncates with an ellipsis", () => {
    expect(truncateSlackText("hello world", 7)).toBe("hello …")
  })

  it("trims surrounding whitespace before measuring", () => {
    expect(truncateSlackText("  hi  ", 10)).toBe("hi")
  })
})

describe("truncateSlackMrkdwn", () => {
  it("is a no-op under the limit", () => {
    expect(truncateSlackMrkdwn("hello", 20)).toBe("hello")
  })

  it("backs off a mid-token `<@U…>` cut", () => {
    // "prefix <@U12345> suffix" — 25 chars.
    // Limit chosen to cut mid-mention.
    const out = truncateSlackMrkdwn("prefix <@U12345> suffix", 12)
    expect(out.endsWith("…")).toBe(true)
    expect(out.includes("<@U1")).toBe(false)
    expect(out.startsWith("prefix ")).toBe(true)
  })

  it("closes a dangling fence", () => {
    const text = "```bash\nline 1\nline 2\nline 3\n```"
    const out = truncateSlackMrkdwn(text, 18)
    // We sliced mid-fence; must end with a closer.
    expect(out).toContain("```")
    const opens = (out.match(/```/g) ?? []).length
    expect(opens % 2).toBe(0)
  })

  it("leaves balanced fences untouched when the whole thing fits", () => {
    const text = "```\nhi\n```"
    expect(truncateSlackMrkdwn(text, 100)).toBe(text)
  })

  it("degenerate max falls back to raw slice", () => {
    expect(truncateSlackMrkdwn("abc", 2)).toBe(truncateSlackText("abc", 2))
  })
})

describe("buildSlackBlocksFallbackText", () => {
  it("prefers the header", () => {
    const blocks: KnownBlock[] = [
      { type: "header", text: { type: "plain_text", text: "Deploy review" } },
      { type: "section", text: { type: "mrkdwn", text: "body" } },
    ]
    expect(buildSlackBlocksFallbackText(blocks)).toBe("Deploy review")
  })

  it("falls back to the first section text", () => {
    const blocks: KnownBlock[] = [
      { type: "section", text: { type: "mrkdwn", text: "status: green" } },
    ]
    expect(buildSlackBlocksFallbackText(blocks)).toBe("status: green")
  })

  it("handles context-only payloads", () => {
    const blocks: KnownBlock[] = [
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: "elapsed: 12ms" },
          { type: "mrkdwn", text: "tokens: 300" },
        ],
      },
    ]
    expect(buildSlackBlocksFallbackText(blocks)).toBe("elapsed: 12ms tokens: 300")
  })

  it("returns a generic label when nothing is extractable", () => {
    expect(buildSlackBlocksFallbackText([])).toBe("Shared a Block Kit message")
  })
})

describe("withBlockKitFallback", () => {
  const textSection: KnownBlock = {
    type: "section",
    text: { type: "mrkdwn", text: "hi" },
  }

  it("returns the payload unchanged when under limits", () => {
    const input = { text: "fallback", blocks: [textSection] }
    const out = withBlockKitFallback(input)
    expect(out).toEqual(input)
  })

  it("drops blocks when over MAX_BLOCKS_PER_MESSAGE", () => {
    const many: KnownBlock[] = Array.from(
      { length: MAX_BLOCKS_PER_MESSAGE + 1 },
      () => textSection,
    )
    const out = withBlockKitFallback({ text: "summary", blocks: many })
    expect(out.blocks).toBeUndefined()
    expect(out.text).toBe("summary")
  })

  it("drops blocks when a text field is too long", () => {
    const huge: KnownBlock = {
      type: "section",
      text: { type: "mrkdwn", text: "x".repeat(MAX_BLOCK_TEXT_CHARS + 1) },
    }
    const out = withBlockKitFallback({ text: "", blocks: [huge] })
    expect(out.blocks).toBeUndefined()
    // Empty caller text → extracted from block; then truncated.
    expect(out.text.length).toBeLessThanOrEqual(MAX_BLOCK_TEXT_CHARS)
  })

  it("drops blocks when serialized payload is too large", () => {
    // 20 blocks of ~2kB text = 40kB, over our 30kB cap. Each individual
    // block stays under the per-text limit so this trips the size gate.
    const bulky: KnownBlock[] = Array.from({ length: 20 }, () => ({
      type: "section",
      text: { type: "mrkdwn", text: "x".repeat(2000) },
    }))
    const out = withBlockKitFallback({ text: "bulky fallback", blocks: bulky })
    expect(out.blocks).toBeUndefined()
    expect(out.text).toBe("bulky fallback")
  })

  it("passes through when blocks array is empty", () => {
    const out = withBlockKitFallback({ text: "plain", blocks: [] })
    expect(out.blocks).toEqual([])
  })
})
