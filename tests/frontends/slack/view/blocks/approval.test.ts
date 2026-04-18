import { describe, expect, it } from "bun:test"
import {
  buildApprovalBlocks,
  buildResolvedApprovalBlocks,
  encodeActionId,
  parseApprovalActionId,
} from "../../../../../src/frontends/slack/view/blocks/approval"

describe("approval Block Kit builder", () => {
  it("emits header + section (code fence) + context + actions with 3 buttons", () => {
    const { blocks, text } = buildApprovalBlocks({
      id: "perm_1",
      tool: "Bash",
      input: { command: "ls -la" },
    })
    expect(text).toContain("approval needed")
    expect(text).toContain("Bash")
    // header + code section + context + actions  (no description, no displayName)
    expect(blocks.length).toBe(4)
    expect(blocks[0]!.type).toBe("header")
    expect(blocks[1]!.type).toBe("section")
    expect(blocks[2]!.type).toBe("context")
    expect(blocks[3]!.type).toBe("actions")

    const section = blocks[1] as { text: { text: string } }
    expect(section.text.text).toContain("```")
    expect(section.text.text).toContain('"command": "ls -la"')

    const actions = blocks[3] as { elements: Array<{ text: { text: string }; action_id: string; style?: string }> }
    expect(actions.elements).toHaveLength(3)
    expect(actions.elements.map((e) => e.text.text)).toEqual([
      "Allow once",
      "Allow always",
      "Deny",
    ])
    expect(actions.elements[0]!.style).toBe("primary")
    expect(actions.elements[1]!.style).toBe("primary")
    expect(actions.elements[2]!.style).toBe("danger")
    expect(actions.elements[0]!.action_id).toBe("bantai:perm:perm_1:allow")
    expect(actions.elements[1]!.action_id).toBe("bantai:perm:perm_1:allowAlways")
    expect(actions.elements[2]!.action_id).toBe("bantai:perm:perm_1:deny")
  })

  it("inserts a description section when displayName/description provided", () => {
    const { blocks } = buildApprovalBlocks({
      id: "p",
      tool: "Write",
      input: { file_path: "/tmp/x" },
      displayName: "Write file",
      description: "Claude wants to edit */tmp/x*",
    })
    // header + description-section + code-section + context + actions
    expect(blocks.length).toBe(5)
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain("Write")
    expect(header.text.text).toContain("Write file")
    const descSection = blocks[1] as { text: { text: string } }
    expect(descSection.text.text).toContain("Claude wants to edit")
  })

  it("truncates long input to keep the code block under the 3000-char limit", () => {
    const big = "x".repeat(4000)
    const { blocks } = buildApprovalBlocks({
      id: "p",
      tool: "Bash",
      input: big,
    })
    const section = blocks[1] as { type: "section"; text: { text: string } }
    expect(section.text.text.length).toBeLessThan(3000)
    expect(section.text.text).toContain("…")
  })

  it("renders approvers list when provided, otherwise 'anyone in the channel'", () => {
    const withApprovers = buildApprovalBlocks({
      id: "p",
      tool: "Bash",
      input: {},
      approvers: ["U01", "U02"],
    })
    const ctx1 = withApprovers.blocks[2] as { elements: Array<{ text: string }> }
    expect(ctx1.elements[0]!.text).toContain("<@U01>")
    expect(ctx1.elements[0]!.text).toContain("<@U02>")

    const without = buildApprovalBlocks({ id: "p", tool: "Bash", input: {} })
    const ctx2 = without.blocks[2] as { elements: Array<{ text: string }> }
    expect(ctx2.elements[0]!.text.toLowerCase()).toContain("anyone")
  })

  it("adds a TTL hint to the context block when ttlMs provided", () => {
    const { blocks } = buildApprovalBlocks({
      id: "p",
      tool: "Bash",
      input: {},
      ttlMs: 120_000,
    })
    const ctx = blocks[2] as { elements: Array<{ text: string }> }
    expect(ctx.elements.length).toBe(2)
    expect(ctx.elements[1]!.text.toLowerCase()).toContain("auto-reject")
    expect(ctx.elements[1]!.text).toContain("2")
  })

  it("stringifies non-string inputs via JSON.stringify with indentation", () => {
    const { blocks } = buildApprovalBlocks({
      id: "p",
      tool: "Bash",
      input: { a: 1, b: [1, 2, 3] },
    })
    const section = blocks[1] as { text: { text: string } }
    expect(section.text.text).toMatch(/\{\n  "a": 1/)
  })

  it("passes a raw string input through without JSON.stringify", () => {
    const { blocks } = buildApprovalBlocks({
      id: "p",
      tool: "Bash",
      input: "echo hello",
    })
    const section = blocks[1] as { text: { text: string } }
    expect(section.text.text).toContain("echo hello")
    // The raw string itself should not be wrapped in JSON quotes.
    expect(section.text.text).not.toContain('"echo hello"')
  })
})

describe("resolved approval card", () => {
  it("renders a completed allow variant with a checkmark", () => {
    const { blocks, text } = buildResolvedApprovalBlocks({
      previous: { id: "p", tool: "Bash", input: "ls" },
      resolver: { userId: "U01" },
      decision: "allow",
    })
    // header + section
    expect(blocks.length).toBe(2)
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain("white_check_mark")
    expect(header.text.text).toContain("Bash")
    expect(header.text.text).toContain("allowed by")
    expect(header.text.text).toContain("U01")
    expect(text).toContain("Bash")
    expect(text).toContain("allowed")
  })

  it("renders the allowAlways variant with '(always)'", () => {
    const { blocks } = buildResolvedApprovalBlocks({
      previous: { id: "p", tool: "Write", input: "x" },
      resolver: { userId: "U01" },
      decision: "allowAlways",
    })
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain("allowed (always)")
  })

  it("renders the deny variant with :no_entry_sign:", () => {
    const { blocks, text } = buildResolvedApprovalBlocks({
      previous: { id: "p", tool: "Bash", input: "rm -rf" },
      resolver: { userId: "U99" },
      decision: "deny",
    })
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain("no_entry_sign")
    expect(header.text.text).toContain("denied by")
    expect(text).toContain("denied")
  })

  it("renders timeout variant with hourglass + 'auto-denied'", () => {
    const { blocks } = buildResolvedApprovalBlocks({
      previous: { id: "p", tool: "Bash", input: "x" },
      resolver: { userId: "U00" },
      decision: "timeout",
    })
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain("hourglass")
    expect(header.text.text).toContain("auto-denied")
  })

  it("truncates long input on the resolved card too", () => {
    const { blocks } = buildResolvedApprovalBlocks({
      previous: { id: "p", tool: "Bash", input: "y".repeat(5000) },
      resolver: { userId: "U01" },
      decision: "allow",
    })
    const section = blocks[1] as { text: { text: string } }
    expect(section.text.text.length).toBeLessThan(3000)
    expect(section.text.text).toContain("…")
  })
})

describe("action_id codec", () => {
  it("encodes the three decision types", () => {
    expect(encodeActionId("abc", "allow")).toBe("bantai:perm:abc:allow")
    expect(encodeActionId("abc", "allowAlways")).toBe("bantai:perm:abc:allowAlways")
    expect(encodeActionId("abc", "deny")).toBe("bantai:perm:abc:deny")
  })

  it("round-trips through parseApprovalActionId", () => {
    for (const d of ["allow", "allowAlways", "deny"] as const) {
      const parsed = parseApprovalActionId(encodeActionId("req_42", d))
      expect(parsed).toEqual({ id: "req_42", decision: d })
    }
  })

  it("rejects unknown action_id shapes", () => {
    expect(parseApprovalActionId("bantai:perm:abc")).toBeNull()
    expect(parseApprovalActionId("other:perm:abc:allow")).toBeNull()
    expect(parseApprovalActionId("bantai:other:abc:allow")).toBeNull()
    expect(parseApprovalActionId("bantai:perm:abc:yolo")).toBeNull()
    expect(parseApprovalActionId("random")).toBeNull()
  })
})
