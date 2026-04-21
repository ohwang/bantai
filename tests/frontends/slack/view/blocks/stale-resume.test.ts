import { describe, expect, it } from "bun:test"
import {
  buildStaleResumeBlocks,
  buildResolvedStaleResumeBlocks,
  encodeActionId,
  parseStaleResumeActionId,
  type StaleResumeCardInput,
} from "../../../../../src/frontends/slack/view/blocks/stale-resume"

function sampleInput(
  overrides: Partial<StaleResumeCardInput> = {},
): StaleResumeCardInput {
  return {
    id: "prompt-1",
    currentBackendName: "Gemini",
    priorBackendName: "Codex",
    queuedTurnPreview: "run the tests again",
    reason: "backend_mismatch",
    canInjectHistory: false,
    ...overrides,
  }
}

describe("buildStaleResumeBlocks", () => {
  it("always includes Start fresh + Cancel turn buttons", () => {
    const { blocks } = buildStaleResumeBlocks(sampleInput())
    const actions = blocks.find((b) => b.type === "actions")
    expect(actions).toBeDefined()
    const buttonActionIds = (
      actions as { elements: Array<{ action_id: string }> }
    ).elements.map((e) => e.action_id)
    expect(buttonActionIds).toContain("bantai:stale_resume:prompt-1:fresh")
    expect(buttonActionIds).toContain("bantai:stale_resume:prompt-1:cancel")
  })

  it("omits the inject button when canInjectHistory=false", () => {
    const { blocks } = buildStaleResumeBlocks(
      sampleInput({ canInjectHistory: false }),
    )
    const actions = blocks.find((b) => b.type === "actions") as {
      elements: Array<{ action_id: string }>
    }
    expect(actions.elements.map((e) => e.action_id)).not.toContain(
      "bantai:stale_resume:prompt-1:inject",
    )
  })

  it("includes the inject button when canInjectHistory=true", () => {
    const { blocks } = buildStaleResumeBlocks(
      sampleInput({ canInjectHistory: true }),
    )
    const actions = blocks.find((b) => b.type === "actions") as {
      elements: Array<{ action_id: string }>
    }
    expect(actions.elements.map((e) => e.action_id)).toContain(
      "bantai:stale_resume:prompt-1:inject",
    )
  })

  it("uses the 'different backend' headline for backend_mismatch", () => {
    const { blocks, text } = buildStaleResumeBlocks(
      sampleInput({ reason: "backend_mismatch" }),
    )
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain("different backend")
    expect(text).toContain("Gemini")
  })

  it("uses the 'no longer available' headline for session_file_missing", () => {
    const { blocks } = buildStaleResumeBlocks(
      sampleInput({ reason: "session_file_missing", priorBackendName: undefined }),
    )
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain("no longer available")
  })

  it("truncates very long queued-turn previews with an ellipsis", () => {
    const longText = "x".repeat(500)
    const { blocks } = buildStaleResumeBlocks(
      sampleInput({ queuedTurnPreview: longText }),
    )
    const preview = blocks[2] as { text: { text: string } }
    expect(preview.text.text).toMatch(/…/)
  })

  it("escapes <, >, & in the queued-turn preview", () => {
    const { blocks } = buildStaleResumeBlocks(
      sampleInput({ queuedTurnPreview: "<script>evil</script> & friends" }),
    )
    const preview = blocks[2] as { type: string; text: { text: string } }
    expect(preview.text.text).not.toContain("<script>")
    expect(preview.text.text).toContain("&lt;script&gt;")
    expect(preview.text.text).toContain("&amp;")
  })
})

describe("buildResolvedStaleResumeBlocks", () => {
  it("renders the 'started fresh' variant for decision=fresh", () => {
    const { blocks, text } = buildResolvedStaleResumeBlocks({
      previous: sampleInput(),
      resolver: { userId: "U1" },
      decision: "fresh",
    })
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain("started fresh by <@U1>")
    expect(text).toContain("started fresh")
  })

  it("renders the 'cancelled' variant for decision=cancel", () => {
    const { blocks } = buildResolvedStaleResumeBlocks({
      previous: sampleInput(),
      resolver: { userId: "U2" },
      decision: "cancel",
    })
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain("cancelled by <@U2>")
  })

  it("renders the 'replayed with history' variant for decision=inject", () => {
    const { blocks } = buildResolvedStaleResumeBlocks({
      previous: sampleInput({ canInjectHistory: true }),
      resolver: { userId: "U3" },
      decision: "inject",
    })
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain("replayed with history by <@U3>")
  })
})

describe("action_id codec", () => {
  it("encode → parse round-trip for each decision", () => {
    for (const decision of ["fresh", "inject", "cancel"] as const) {
      const encoded = encodeActionId("abc123", decision)
      const parsed = parseStaleResumeActionId(encoded)
      expect(parsed).toEqual({ id: "abc123", decision })
    }
  })

  it("rejects malformed action ids", () => {
    expect(parseStaleResumeActionId("bantai:perm:abc:allow")).toBeNull()
    expect(parseStaleResumeActionId("bantai:stale_resume:abc")).toBeNull()
    expect(parseStaleResumeActionId("bantai:stale_resume:abc:wat")).toBeNull()
    expect(parseStaleResumeActionId("stale_resume:abc:fresh")).toBeNull()
    expect(parseStaleResumeActionId("")).toBeNull()
  })

  it("ids are allowed to contain non-colon characters", () => {
    const encoded = encodeActionId("uuid-with-dashes", "fresh")
    const parsed = parseStaleResumeActionId(encoded)
    expect(parsed?.id).toBe("uuid-with-dashes")
    expect(parsed?.decision).toBe("fresh")
  })
})
