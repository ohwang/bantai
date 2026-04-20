import { describe, expect, it } from "bun:test"
import {
  buildConciseToolSummary,
  buildToolCompletedCard,
  buildToolRunningCard,
  summarizeInput,
} from "../../../../../src/frontends/slack/view/blocks/tool-card"
import type { VerbosityLevel } from "../../../../../src/frontends/slack/config/schema"

function sectionText(block: unknown): string {
  const b = block as { type: string; text: { text: string } }
  return b.text.text
}

describe("summarizeInput", () => {
  it("prefers common shortcut keys", () => {
    expect(summarizeInput({ command: "ls -la" })).toBe("command: ls -la")
    expect(summarizeInput({ file_path: "/tmp/x.ts" })).toBe("file_path: /tmp/x.ts")
    expect(summarizeInput({ pattern: "foo" })).toBe("pattern: foo")
    expect(summarizeInput({ url: "https://x" })).toBe("url: https://x")
  })

  it("annotates extra fields with '+N' when the preferred key has siblings", () => {
    expect(summarizeInput({ command: "ls", cwd: "/tmp" })).toBe("command: ls (+1)")
  })

  it("falls back to the first non-empty string property", () => {
    expect(summarizeInput({ foo: "", name: "alice" })).toBe("name: alice")
  })

  it("falls back to JSON.stringify for weirder shapes", () => {
    expect(summarizeInput({ a: 1, b: 2 })).toBe('{"a":1,"b":2}')
  })

  it("string inputs are used as-is (collapsed whitespace)", () => {
    expect(summarizeInput("hello   world\n")).toBe("hello world")
  })

  it("null / undefined → empty string", () => {
    expect(summarizeInput(null)).toBe("")
    expect(summarizeInput(undefined)).toBe("")
  })
})

describe("buildToolRunningCard", () => {
  it("returns null at silent / concise", () => {
    expect(
      buildToolRunningCard({ id: "t", tool: "Bash", input: { command: "ls" }, verbosity: "silent" }),
    ).toBeNull()
    expect(
      buildToolRunningCard({ id: "t", tool: "Bash", input: { command: "ls" }, verbosity: "concise" }),
    ).toBeNull()
  })

  it("normal → one-line summary with running hint", () => {
    const card = buildToolRunningCard({
      id: "t",
      tool: "Bash",
      input: { command: "ls -la" },
      verbosity: "normal",
    })!
    expect(card.blocks).toHaveLength(1)
    const txt = sectionText(card.blocks[0])
    expect(txt).toContain("Bash")
    expect(txt).toContain("ls -la")
    expect(txt).toContain("running")
    expect(txt).toContain(":hammer_and_wrench:")
  })

  it("verbose / debug → summary + code-fenced input", () => {
    const card = buildToolRunningCard({
      id: "t",
      tool: "Bash",
      input: { command: "ls -la" },
      verbosity: "verbose",
    })!
    expect(card.blocks).toHaveLength(2)
    expect(sectionText(card.blocks[1])).toContain("```")
    expect(sectionText(card.blocks[1])).toContain("ls -la")
  })

  it("unknown tool falls back to :tools: emoji", () => {
    const card = buildToolRunningCard({
      id: "t",
      tool: "Esoteric",
      input: {},
      verbosity: "normal",
    })!
    expect(sectionText(card.blocks[0])).toContain(":tools:")
  })
})

describe("buildToolCompletedCard", () => {
  const baseOutput = "line1\nline2\nline3"

  it.each<[VerbosityLevel, boolean]>([
    ["silent", false],
    ["concise", false],
    ["normal", true],
    ["verbose", true],
    ["debug", true],
  ])("verbosity=%s renders=%s", (verbosity, renders) => {
    const card = buildToolCompletedCard({
      id: "t",
      tool: "Bash",
      input: { command: "ls" },
      output: baseOutput,
      verbosity,
    })
    expect(card !== null).toBe(renders)
  })

  it("normal → headline + 6-line preview as a code fence", () => {
    const big = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")
    const card = buildToolCompletedCard({
      id: "t",
      tool: "Bash",
      input: { command: "ls" },
      output: big,
      verbosity: "normal",
    })!
    expect(card.blocks).toHaveLength(2)
    expect(sectionText(card.blocks[0])).toContain(":heavy_check_mark:")
    const preview = sectionText(card.blocks[1])
    expect(preview).toContain("```")
    expect(preview).toContain("line 6") // 6th line lands
    expect(preview).not.toContain("line 7") // 7th is truncated
    expect(preview).toContain("(+14 lines)")
  })

  it("normal with error → italic error body, no code fence", () => {
    const card = buildToolCompletedCard({
      id: "t",
      tool: "Bash",
      input: { command: "fail" },
      output: "",
      error: "command not found",
      verbosity: "normal",
    })!
    expect(sectionText(card.blocks[0])).toContain(":no_entry_sign:")
    expect(sectionText(card.blocks[1])).toContain("command not found")
    expect(sectionText(card.blocks[1])).not.toContain("```")
    expect(card.text).toContain("error")
  })

  it("verbose → input fence + output fence, no extra raw block", () => {
    const card = buildToolCompletedCard({
      id: "t",
      tool: "Bash",
      input: { command: "ls -la" },
      output: baseOutput,
      verbosity: "verbose",
    })!
    // headline + input fence + output fence
    expect(card.blocks.length).toBe(3)
    expect(sectionText(card.blocks[1])).toContain("ls -la")
    expect(sectionText(card.blocks[2])).toContain("line1")
  })

  it("debug → verbose + raw JSON fence", () => {
    const card = buildToolCompletedCard({
      id: "t",
      tool: "Bash",
      input: { command: "ls" },
      output: baseOutput,
      verbosity: "debug",
    })!
    // headline + input fence + output fence + raw JSON fence
    expect(card.blocks.length).toBe(4)
    const raw = sectionText(card.blocks[3])
    expect(raw).toContain("```json")
    expect(raw).toContain('"id": "t"')
  })

  it("long output is truncated inside the code fence", () => {
    const huge = "x".repeat(5000)
    const card = buildToolCompletedCard({
      id: "t",
      tool: "Bash",
      input: { command: "ls" },
      output: huge,
      verbosity: "verbose",
    })!
    const fence = sectionText(card.blocks[2])
    expect(fence.length).toBeLessThan(3000)
    expect(fence).toContain("…")
  })

  it("empty output at normal → '(no output)'", () => {
    const card = buildToolCompletedCard({
      id: "t",
      tool: "Bash",
      input: { command: "ls" },
      output: "",
      verbosity: "normal",
    })!
    expect(sectionText(card.blocks[1])).toContain("(no output)")
  })

  it("elapsedMs lands in a context block", () => {
    const card = buildToolCompletedCard({
      id: "t",
      tool: "Bash",
      input: { command: "ls" },
      output: "ok",
      verbosity: "normal",
      elapsedMs: 2345,
    })!
    const last = card.blocks[card.blocks.length - 1] as { type: string; elements: Array<{ text: string }> }
    expect(last.type).toBe("context")
    expect(last.elements[0]!.text).toContain("2.3s")
  })
})

describe("buildConciseToolSummary", () => {
  it("returns null on empty list", () => {
    expect(buildConciseToolSummary([])).toBeNull()
  })

  it("summarises one tool", () => {
    const card = buildConciseToolSummary(["Bash"])!
    const block = card.blocks[0] as { elements: Array<{ text: string }> }
    expect(block.elements[0]!.text).toContain("1 tool:")
    expect(block.elements[0]!.text).toContain("Bash")
  })

  it("collapses duplicates with ×N", () => {
    const card = buildConciseToolSummary(["Bash", "Read", "Bash", "Bash"])!
    const block = card.blocks[0] as { elements: Array<{ text: string }> }
    expect(block.elements[0]!.text).toContain("Bash ×3")
    expect(block.elements[0]!.text).toContain("Read")
    expect(block.elements[0]!.text).toContain("4 tools")
  })
})
