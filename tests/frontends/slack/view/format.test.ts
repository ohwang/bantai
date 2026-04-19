import { describe, expect, it } from "bun:test"
import {
  chunkForSlack,
  markdownToSlackMrkdwn,
  markdownToSlackMrkdwnChunks,
} from "../../../../src/frontends/slack/view/format"

describe("markdownToSlackMrkdwn — inline conversions", () => {
  it("converts **bold** and __bold__ to *bold*", () => {
    expect(markdownToSlackMrkdwn("**hi** and __there__")).toBe("*hi* and *there*")
  })

  it("converts *italic* (CommonMark) to _italic_ (mrkdwn)", () => {
    expect(markdownToSlackMrkdwn("an *emphasised* word")).toBe("an _emphasised_ word")
  })

  it("converts ~~strike~~ to ~strike~", () => {
    expect(markdownToSlackMrkdwn("~~gone~~ away")).toBe("~gone~ away")
  })

  it("converts [label](url) to <url|label>", () => {
    expect(markdownToSlackMrkdwn("see [docs](https://example.com)")).toBe(
      "see <https://example.com|docs>",
    )
  })

  it("preserves inline code and avoids mutating its content", () => {
    expect(markdownToSlackMrkdwn("run `**not bold**` verbatim")).toBe(
      "run `**not bold**` verbatim",
    )
  })

  it("preserves fenced code blocks verbatim", () => {
    const input = "Before\n```ts\n**kept**\n```\nAfter **bold**"
    expect(markdownToSlackMrkdwn(input)).toBe(
      "Before\n```ts\n**kept**\n```\nAfter *bold*",
    )
  })

  it("converts # headings to bolded lines", () => {
    const input = "# Title\n\nBody\n\n## Sub"
    expect(markdownToSlackMrkdwn(input)).toBe("*Title*\n\nBody\n\n*Sub*")
  })

  it("rewrites '-' and '*' list markers to bullets", () => {
    const input = "- one\n- two\n  - nested"
    expect(markdownToSlackMrkdwn(input)).toBe("• one\n• two\n  • nested")
  })

  it("leaves numbered lists alone", () => {
    const input = "1. one\n2. two"
    expect(markdownToSlackMrkdwn(input)).toBe("1. one\n2. two")
  })
})

describe("chunkForSlack", () => {
  it("returns a single chunk when under the limit", () => {
    expect(chunkForSlack("short text", { maxLen: 100 })).toEqual(["short text"])
  })

  it("returns no chunks for empty string", () => {
    expect(chunkForSlack("", { maxLen: 100 })).toEqual([])
  })

  it("splits at paragraph boundaries when possible", () => {
    const input = "para one\n\npara two\n\npara three"
    const chunks = chunkForSlack(input, { maxLen: 12 })
    expect(chunks).toEqual(["para one", "para two", "para three"])
  })

  it("never tears a code fence", () => {
    const code = "```\n" + "x".repeat(40) + "\n```"
    const input = `pre\n\n${code}\n\npost`
    const chunks = chunkForSlack(input, { maxLen: 50 })
    for (const c of chunks) {
      const opens = (c.match(/```/g) ?? []).length
      // Every chunk has either 0 or an even number of fence tokens.
      expect(opens % 2).toBe(0)
    }
    // And the original code block is preserved intact in one of the chunks.
    expect(chunks.some((c) => c.includes("x".repeat(40)))).toBe(true)
  })

  it("splits oversized fences into sub-fences that preserve the language tag", () => {
    const body = "line\n".repeat(200) // way over any chunk size
    const input = "```ts\n" + body + "```"
    const chunks = chunkForSlack(input, { maxLen: 200 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.startsWith("```ts")).toBe(true)
      expect(c.endsWith("```")).toBe(true)
      expect(c.length).toBeLessThanOrEqual(200)
    }
  })

  it("hard-splits oversized paragraphs with sentence/word fallback", () => {
    const input = "sentence one. sentence two. sentence three.".repeat(3)
    const chunks = chunkForSlack(input, { maxLen: 30 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30)
    // Join preserves content (modulo collapsed trailing whitespace).
    const recombined = chunks.join(" ")
    expect(recombined.replace(/\s+/g, " ")).toContain("sentence one")
    expect(recombined.replace(/\s+/g, " ")).toContain("sentence three")
  })
})

describe("markdownToSlackMrkdwnChunks", () => {
  it("is the two-step pipeline", () => {
    const input = "**bold**\n\n- item"
    expect(markdownToSlackMrkdwnChunks(input, { maxLen: 1000 })).toEqual([
      "*bold*\n\n• item",
    ])
  })
})

describe("angle-token preservation", () => {
  it("preserves Slack user mentions", () => {
    expect(markdownToSlackMrkdwn("hey <@U12345> ping")).toBe("hey <@U12345> ping")
  })

  it("preserves Slack channel refs with display name", () => {
    expect(markdownToSlackMrkdwn("see <#C0123|general>")).toBe("see <#C0123|general>")
  })

  it("preserves <!here> / <!channel> / subteams", () => {
    expect(markdownToSlackMrkdwn("<!here> heads up")).toBe("<!here> heads up")
    expect(markdownToSlackMrkdwn("<!subteam^S123|oncall>")).toBe(
      "<!subteam^S123|oncall>",
    )
  })

  it("preserves mailto / tel / http autolinks", () => {
    expect(markdownToSlackMrkdwn("<mailto:a@b.com>")).toBe("<mailto:a@b.com>")
    expect(markdownToSlackMrkdwn("<tel:+15551234>")).toBe("<tel:+15551234>")
    expect(markdownToSlackMrkdwn("<https://example.com>")).toBe(
      "<https://example.com>",
    )
  })

  it("HTML-escapes bare < and > in user text", () => {
    expect(markdownToSlackMrkdwn("a < b > c")).toBe("a &lt; b &gt; c")
    expect(markdownToSlackMrkdwn("A&B Corp")).toBe("A&amp;B Corp")
  })

  it("escapes an unrecognised angle token instead of letting it render", () => {
    // `<script>` isn't in the allowlist; it gets escaped so Slack
    // doesn't attempt to parse it.
    expect(markdownToSlackMrkdwn("<script>x</script>")).toBe(
      "&lt;script&gt;x&lt;/script&gt;",
    )
  })

  it("leaves angle tokens inside inline code untouched", () => {
    expect(markdownToSlackMrkdwn("run `<script>` inline")).toBe(
      "run `<script>` inline",
    )
  })
})

describe("table conversion", () => {
  it("converts a simple GFM table to an aligned code fence", () => {
    const input = "| a | bb |\n|---|----|\n| 1 | 22 |"
    const out = markdownToSlackMrkdwn(input)
    expect(out).toBe(["```", "a  bb", "-  --", "1  22", "```"].join("\n"))
  })

  it("handles multi-row tables", () => {
    const input = [
      "| name | role |",
      "|------|------|",
      "| alice | dev |",
      "| bob | pm |",
    ].join("\n")
    const out = markdownToSlackMrkdwn(input)
    expect(out).toContain("```")
    expect(out).toContain("alice  dev")
    expect(out).toContain("bob    pm")
  })

  it("leaves non-table pipe text alone", () => {
    const input = "run `foo | bar` in a shell"
    expect(markdownToSlackMrkdwn(input)).toBe("run `foo | bar` in a shell")
  })

  it("does not treat a pipe row without separator as a table", () => {
    const input = "| a | b |"
    expect(markdownToSlackMrkdwn(input)).toBe("| a | b |")
  })
})
