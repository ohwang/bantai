import { describe, expect, it } from "bun:test"
import {
  buildElicitationCard,
  buildElicitationModal,
  buildResolvedElicitationCard,
  encodeBlockId,
  encodeCancelActionId,
  encodeModalCallbackId,
  encodeOpenActionId,
  parseElicitationActionId,
  parseElicitationSubmission,
  parseModalCallbackId,
} from "../../../../../src/frontends/slack/view/blocks/elicitation"
import type { ElicitationQuestion } from "../../../../../src/protocol/types"

function q(
  question: string,
  opts: Partial<ElicitationQuestion> = {},
): ElicitationQuestion {
  return {
    question,
    options: [],
    ...opts,
  }
}

describe("elicitation inline card", () => {
  it("single-question summary mentions the question text", () => {
    const { blocks, text } = buildElicitationCard({
      id: "elic1",
      questions: [q("Which library?")],
    })
    expect(text).toContain("Which library")
    const section = blocks[0] as { text: { text: string } }
    expect(section.text.text).toContain("Which library")

    const actions = blocks[1] as { elements: Array<{ text: { text: string }; action_id: string; style?: string }> }
    expect(actions.elements).toHaveLength(2)
    expect(actions.elements[0]!.text.text).toBe("Answer")
    expect(actions.elements[0]!.action_id).toBe("bantai:elic:elic1:open")
    expect(actions.elements[0]!.style).toBe("primary")
    expect(actions.elements[1]!.text.text).toBe("Cancel")
    expect(actions.elements[1]!.action_id).toBe("bantai:elic:elic1:cancel")
    expect(actions.elements[1]!.style).toBe("danger")
  })

  it("multi-question summary counts the questions", () => {
    const { blocks, text } = buildElicitationCard({
      id: "e",
      questions: [q("a"), q("b"), q("c")],
    })
    expect(text).toContain("3 questions")
    const section = blocks[0] as { text: { text: string } }
    expect(section.text.text).toContain("3 question")
    const actions = blocks[1] as { elements: Array<{ text: { text: string } }> }
    expect(actions.elements[0]!.text.text).toBe("Answer questions")
  })
})

describe("resolved card", () => {
  it("answered variant lands a checkmark and credits the user", () => {
    const { blocks, text } = buildResolvedElicitationCard({
      previous: { id: "e", questions: [q("x")] },
      answered: true,
      resolverUserId: "U01",
    })
    const section = blocks[0] as { text: { text: string } }
    expect(section.text.text).toContain(":heavy_check_mark:")
    expect(section.text.text).toContain("<@U01>")
    expect(section.text.text).toContain("answered")
    expect(text).toContain("answered")
  })

  it("cancelled variant lands a no-entry sign", () => {
    const { blocks } = buildResolvedElicitationCard({
      previous: { id: "e", questions: [q("x")] },
      answered: false,
      resolverUserId: "U02",
    })
    const section = blocks[0] as { text: { text: string } }
    expect(section.text.text).toContain(":no_entry_sign:")
    expect(section.text.text).toContain("cancelled")
  })
})

describe("modal builder", () => {
  it("single question with options (no free text) → static_select", () => {
    const modal = buildElicitationModal({
      id: "e",
      questions: [
        q("Which?", {
          options: [
            { label: "A", description: "A-desc" },
            { label: "B" },
          ],
          allowFreeText: false,
        }),
      ],
    })
    expect(modal.type).toBe("modal")
    const m = modal as { callback_id: string; title: { text: string }; blocks: unknown[] }
    expect(m.callback_id).toBe("bantai:elic:e")
    expect(m.title.text).toContain("bantai")
    expect(Array.isArray(m.blocks)).toBe(true)
    const input = modal.blocks[0] as {
      type: "input"
      block_id: string
      element: {
        type: string
        action_id: string
        options: Array<{ text: { text: string }; value: string; description?: { text: string } }>
      }
    }
    expect(input.block_id).toBe("bantai:elic:e:q:0")
    expect(input.element.type).toBe("static_select")
    expect(input.element.action_id).toBe("bantai:elic:e:q:0")
    expect(input.element.options).toHaveLength(2)
    expect(input.element.options[0]!.description?.text).toBe("A-desc")
  })

  it("multi-select question → multi_static_select", () => {
    const modal = buildElicitationModal({
      id: "e",
      questions: [
        q("Pick many", {
          options: [{ label: "A" }, { label: "B" }],
          allowFreeText: false,
          multiSelect: true,
        }),
      ],
    })
    const input = modal.blocks[0] as {
      element: { type: string }
    }
    expect(input.element.type).toBe("multi_static_select")
  })

  it("no options → plain_text_input", () => {
    const modal = buildElicitationModal({
      id: "e",
      questions: [q("Describe your change")],
    })
    const input = modal.blocks[0] as {
      element: { type: string; multiline?: boolean }
    }
    expect(input.element.type).toBe("plain_text_input")
    expect(input.element.multiline).toBe(true)
  })

  it("options + allowFreeText (default) → plain_text_input with enumerated placeholder", () => {
    const modal = buildElicitationModal({
      id: "e",
      questions: [
        q("Pick or type", {
          options: [{ label: "Alpha" }, { label: "Beta" }],
          // allowFreeText defaults to true
        }),
      ],
    })
    const input = modal.blocks[0] as {
      element: { type: string; placeholder: { text: string } }
    }
    expect(input.element.type).toBe("plain_text_input")
    expect(input.element.placeholder.text).toContain("Alpha")
  })

  it("multi-question produces one input block per question", () => {
    const modal = buildElicitationModal({
      id: "e",
      questions: [q("A"), q("B"), q("C")],
    })
    // Each question without a header produces one block; with header → two.
    expect(modal.blocks.length).toBe(3)
  })

  it("prefixes each question with its header when present", () => {
    const modal = buildElicitationModal({
      id: "e",
      questions: [q("Body?", { header: "Main" })],
    })
    // section + input
    expect(modal.blocks.length).toBe(2)
    expect(modal.blocks[0]!.type).toBe("section")
    expect(modal.blocks[1]!.type).toBe("input")
  })

  it("truncates labels beyond Slack's 75-char limit", () => {
    const longLabel = "x".repeat(200)
    const modal = buildElicitationModal({
      id: "e",
      questions: [q("Pick", { options: [{ label: longLabel }], allowFreeText: false })],
    })
    const opt = (modal.blocks[0] as {
      element: { options: Array<{ text: { text: string } }> }
    }).element.options[0]!
    expect(opt.text.text.length).toBeLessThanOrEqual(74)
    expect(opt.text.text.endsWith("…")).toBe(true)
  })
})

describe("action_id / callback_id codec", () => {
  it("open / cancel round-trip", () => {
    expect(parseElicitationActionId(encodeOpenActionId("x"))).toEqual({
      kind: "open",
      id: "x",
    })
    expect(parseElicitationActionId(encodeCancelActionId("y"))).toEqual({
      kind: "cancel",
      id: "y",
    })
  })

  it("unknown shapes return null", () => {
    expect(parseElicitationActionId("bantai:perm:x:allow")).toBeNull()
    expect(parseElicitationActionId("bantai:elic:x:yolo")).toBeNull()
    expect(parseElicitationActionId("other:elic:x:open")).toBeNull()
  })

  it("modal callback_id round-trip", () => {
    expect(parseModalCallbackId(encodeModalCallbackId("abc"))).toBe("abc")
    expect(parseModalCallbackId("bantai:elic:x:extra")).toBeNull()
    expect(parseModalCallbackId("some:thing:else")).toBeNull()
  })
})

describe("parseElicitationSubmission", () => {
  it("harvests plain_text_input values by question text", () => {
    const questions = [q("Name?"), q("Age?")]
    const values = {
      [encodeBlockId("e", 0)]: {
        [encodeBlockId("e", 0)]: { type: "plain_text_input", value: "alice" },
      },
      [encodeBlockId("e", 1)]: {
        [encodeBlockId("e", 1)]: { type: "plain_text_input", value: "30" },
      },
    }
    const parsed = parseElicitationSubmission({
      callbackId: encodeModalCallbackId("e"),
      values,
      questions,
    })
    expect(parsed).toEqual({ id: "e", answers: { "Name?": "alice", "Age?": "30" } })
  })

  it("harvests static_select values", () => {
    const questions = [
      q("Pick", { options: [{ label: "A" }, { label: "B" }], allowFreeText: false }),
    ]
    const values = {
      [encodeBlockId("e", 0)]: {
        [encodeBlockId("e", 0)]: {
          type: "static_select",
          selected_option: { value: "A", text: { text: "A" } },
        },
      },
    }
    const parsed = parseElicitationSubmission({
      callbackId: encodeModalCallbackId("e"),
      values,
      questions,
    })
    expect(parsed).toEqual({ id: "e", answers: { Pick: "A" } })
  })

  it("joins multi_static_select values with commas", () => {
    const questions = [
      q("Pick many", {
        options: [{ label: "A" }, { label: "B" }, { label: "C" }],
        allowFreeText: false,
        multiSelect: true,
      }),
    ]
    const values = {
      [encodeBlockId("e", 0)]: {
        [encodeBlockId("e", 0)]: {
          type: "multi_static_select",
          selected_options: [
            { value: "A", text: { text: "A" } },
            { value: "B", text: { text: "B" } },
          ],
        },
      },
    }
    const parsed = parseElicitationSubmission({
      callbackId: encodeModalCallbackId("e"),
      values,
      questions,
    })
    expect(parsed?.answers["Pick many"]).toBe("A, B")
  })

  it("drops empty / whitespace-only free-text answers", () => {
    const questions = [q("Q1"), q("Q2")]
    const values = {
      [encodeBlockId("e", 0)]: {
        [encodeBlockId("e", 0)]: { type: "plain_text_input", value: "   " },
      },
      [encodeBlockId("e", 1)]: {
        [encodeBlockId("e", 1)]: { type: "plain_text_input", value: "ok" },
      },
    }
    const parsed = parseElicitationSubmission({
      callbackId: encodeModalCallbackId("e"),
      values,
      questions,
    })
    expect(parsed?.answers).toEqual({ Q2: "ok" })
  })

  it("returns null for non-elicitation callback_ids", () => {
    expect(
      parseElicitationSubmission({
        callbackId: "bantai:other:e",
        values: {},
        questions: [],
      }),
    ).toBeNull()
  })
})
