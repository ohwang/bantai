import { describe, expect, it } from "bun:test"
import { buildThinkingBlocks } from "../../../../../src/frontends/slack/view/blocks/thinking"

describe("buildThinkingBlocks", () => {
  it.each(["silent", "concise", "normal"] as const)("returns null at %s", (v) => {
    expect(buildThinkingBlocks({ text: "deep thoughts", verbosity: v })).toBeNull()
  })

  it("returns null for empty or whitespace-only text", () => {
    expect(buildThinkingBlocks({ text: "", verbosity: "verbose" })).toBeNull()
    expect(buildThinkingBlocks({ text: "   \n", verbosity: "verbose" })).toBeNull()
  })

  it("renders at verbose: context header + quoted italic body", () => {
    const { blocks, text } = buildThinkingBlocks({
      text: "Let me consider the edge cases",
      verbosity: "verbose",
    })!
    expect(blocks.length).toBe(2)
    const ctx = blocks[0] as { type: string; elements: Array<{ text: string }> }
    expect(ctx.type).toBe("context")
    expect(ctx.elements[0]!.text).toContain(":thought_balloon:")
    const sec = blocks[1] as { type: string; text: { text: string } }
    expect(sec.type).toBe("section")
    expect(sec.text.text.startsWith("> _")).toBe(true)
    expect(sec.text.text).toContain("edge cases")
    expect(text).toBe("thinking…")
  })

  it("also renders at debug", () => {
    const out = buildThinkingBlocks({ text: "hmm", verbosity: "debug" })
    expect(out).toBeTruthy()
  })

  it("truncates very long thinking to keep the block under Slack's 3000-char cap", () => {
    const huge = "x".repeat(5000)
    const { blocks } = buildThinkingBlocks({ text: huge, verbosity: "verbose" })!
    const sec = blocks[1] as { text: { text: string } }
    expect(sec.text.text.length).toBeLessThan(2800)
    expect(sec.text.text).toContain("…")
  })

  it("escapes mrkdwn control characters inside the italic wrapper", () => {
    const { blocks } = buildThinkingBlocks({
      text: "uses *bold* _italic_ and `code`",
      verbosity: "verbose",
    })!
    const sec = blocks[1] as { text: { text: string } }
    expect(sec.text.text).toContain("\\*bold\\*")
    expect(sec.text.text).toContain("\\_italic\\_")
    expect(sec.text.text).toContain("\\`code\\`")
  })
})
