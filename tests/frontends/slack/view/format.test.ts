import { describe, expect, it } from "bun:test"
import {
  markdownToSlackMrkdwn,
  markdownToSlackMrkdwnChunks,
  normalizeSlackOutboundText,
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

  it("preserves inline code content verbatim (no markdown re-parse)", () => {
    expect(markdownToSlackMrkdwn("run `**not bold**` verbatim")).toBe(
      "run `**not bold**` verbatim",
    )
  })

  it("preserves fenced code bodies (openclaw IR drops the language tag)", () => {
    const input = "Before\n```ts\n**kept**\n```\nAfter **bold**"
    expect(markdownToSlackMrkdwn(input)).toBe(
      "Before\n\n```\n**kept**\n```\nAfter *bold*",
    )
  })

  it("converts # headings to bolded lines", () => {
    const input = "# Title\n\nBody\n\n## Sub"
    expect(markdownToSlackMrkdwn(input)).toBe("*Title*\n\nBody\n\n*Sub*")
  })

  it("rewrites '-' and '*' list markers to bullets, including nested", () => {
    const input = "- one\n- two\n  - nested"
    expect(markdownToSlackMrkdwn(input)).toBe("• one\n• two\n  • nested")
  })

  it("leaves numbered lists alone", () => {
    const input = "1. one\n2. two"
    expect(markdownToSlackMrkdwn(input)).toBe("1. one\n2. two")
  })
})

describe("markdownToSlackMrkdwnChunks", () => {
  it("returns a single chunk when under the limit", () => {
    expect(markdownToSlackMrkdwnChunks("short text", 100)).toEqual(["short text"])
  })

  it("returns no chunks for empty string", () => {
    expect(markdownToSlackMrkdwnChunks("", 100)).toEqual([])
  })

  it("is the two-step pipeline (convert + chunk)", () => {
    expect(markdownToSlackMrkdwnChunks("**bold**\n\n- item", 1000)).toEqual([
      "*bold*\n\n• item",
    ])
  })

  it("splits at paragraph boundaries when possible", () => {
    const input = "para one\n\npara two\n\npara three"
    const chunks = markdownToSlackMrkdwnChunks(input, 12)
    expect(chunks).toEqual(["para one", "para two", "para three"])
  })

  it("never tears a code fence", () => {
    const code = "```\n" + "x".repeat(40) + "\n```"
    const input = `pre\n\n${code}\n\npost`
    const chunks = markdownToSlackMrkdwnChunks(input, 50)
    for (const c of chunks) {
      const opens = (c.match(/```/g) ?? []).length
      // Every chunk has either 0 or an even number of fence tokens.
      expect(opens % 2).toBe(0)
    }
    // And the original code body is preserved intact in one of the chunks.
    expect(chunks.some((c) => c.includes("x".repeat(40)))).toBe(true)
  })

  it("splits oversized fences into fenced sub-chunks", () => {
    // openclaw's IR renderer drops the language tag (emits plain ``` fences).
    // We still require each chunk to be a well-formed fenced block.
    const body = "line\n".repeat(200)
    const input = "```ts\n" + body + "```"
    const chunks = markdownToSlackMrkdwnChunks(input, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.startsWith("```")).toBe(true)
      expect(c.endsWith("```")).toBe(true)
      expect(c.length).toBeLessThanOrEqual(200)
    }
  })

  it("hard-splits oversized paragraphs along whitespace boundaries", () => {
    const input = "sentence one. sentence two. sentence three.".repeat(3)
    const chunks = markdownToSlackMrkdwnChunks(input, 30)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30)
    const recombined = chunks.join(" ")
    expect(recombined.replace(/\s+/g, " ")).toContain("sentence one")
    expect(recombined.replace(/\s+/g, " ")).toContain("sentence three")
  })

  it("re-chunks when rendered length exceeds the limit (HTML escape expands bytes)", () => {
    // "alpha <<" is 8 chars raw, but once rendered each `<` → `&lt;` (4 chars).
    // The render-aware chunker must shrink chunks so every rendered chunk ≤ limit.
    const chunks = markdownToSlackMrkdwnChunks("alpha <<", 8)
    expect(chunks).toEqual(["alpha ", "&lt;&lt;"])
    expect(chunks.every((c) => c.length <= 8)).toBe(true)
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

  it("escapes angle characters even inside inline code spans", () => {
    // Upstream openclaw behaviour: the IR renderer HTML-escapes < and > for
    // Slack across all text (including code spans). This is safer — a raw
    // `<` inside a backtick span could still be interpreted by some Slack
    // surfaces as the start of a mention/link token.
    expect(markdownToSlackMrkdwn("run `<script>` inline")).toBe(
      "run `&lt;script&gt;` inline",
    )
  })
})

describe("table conversion (tableMode: 'code')", () => {
  it("converts a simple GFM table to a pipe-aligned code fence", () => {
    const input = "| a | bb |\n|---|----|\n| 1 | 22 |"
    const out = markdownToSlackMrkdwn(input, { tableMode: "code" })
    expect(out).toBe(
      ["```", "| a | bb |", "| --- | --- |", "| 1 | 22 |", "```"].join("\n"),
    )
  })

  it("aligns multi-row tables to the widest column value", () => {
    const input = [
      "| name | role |",
      "|------|------|",
      "| alice | dev |",
      "| bob | pm |",
    ].join("\n")
    const out = markdownToSlackMrkdwn(input, { tableMode: "code" })
    expect(out).toBe(
      [
        "```",
        "| name  | role |",
        "| ----- | ---- |",
        "| alice | dev  |",
        "| bob   | pm   |",
        "```",
      ].join("\n"),
    )
  })

  it("defaults to tableMode: 'off' — pipe rows pass through as plain text", () => {
    const input = "| a | b |"
    expect(markdownToSlackMrkdwn(input)).toBe("| a | b |")
  })

  it("leaves non-table pipe text alone regardless of mode", () => {
    const input = "run `foo | bar` in a shell"
    expect(markdownToSlackMrkdwn(input)).toBe("run `foo | bar` in a shell")
    expect(markdownToSlackMrkdwn(input, { tableMode: "code" })).toBe(
      "run `foo | bar` in a shell",
    )
  })
})

describe("normalizeSlackOutboundText", () => {
  it("normalizes markdown for outbound send/update paths", () => {
    expect(normalizeSlackOutboundText(" **bold** ")).toBe("*bold*")
  })

  it("handles undefined input at runtime without throwing", () => {
    expect(normalizeSlackOutboundText(undefined as unknown as string)).toBe("")
  })
})
