import { describe, expect, it } from "bun:test"
import {
  compileSlackInteractiveReplies,
  parseInteractiveReplyActionId,
} from "../../../../src/frontends/slack/view/interactive-replies"

describe("compileSlackInteractiveReplies", () => {
  it("returns input unchanged when no directives present", () => {
    const out = compileSlackInteractiveReplies("Just a plain reply.")
    expect(out.text).toBe("Just a plain reply.")
    expect(out.blocks).toBeUndefined()
    expect(out.hasInteractive).toBe(false)
  })

  it("compiles a slack_buttons directive into actions block", () => {
    const out = compileSlackInteractiveReplies(
      "Ship or hold?\n\n[[slack_buttons: Ship:ship:primary, Hold:hold, Abort:abort:danger]]",
    )
    expect(out.hasInteractive).toBe(true)
    expect(out.text).toBe("Ship or hold?")
    expect(out.blocks).toBeDefined()
    const actions = out.blocks!.find((b) => b.type === "actions")
    expect(actions).toBeDefined()
    const elements = (actions as unknown as {
      elements: Array<Record<string, unknown>>
    }).elements
    expect(elements).toHaveLength(3)
    expect(elements[0]).toMatchObject({
      type: "button",
      action_id: "bantai:reply_button:0:0",
      value: "ship",
      style: "primary",
    })
    expect(elements[1]).toMatchObject({ value: "hold" })
    expect((elements[1] as { style?: string }).style).toBeUndefined()
    expect(elements[2]).toMatchObject({ value: "abort", style: "danger" })
  })

  it("maps success → primary and drops secondary", () => {
    const out = compileSlackInteractiveReplies(
      "[[slack_buttons: Yes:yes:success, Maybe:maybe:secondary]]",
    )
    const actions = out.blocks!.find((b) => b.type === "actions")
    const elements = (actions as unknown as {
      elements: Array<Record<string, unknown>>
    }).elements
    expect((elements[0] as { style?: string }).style).toBe("primary")
    expect((elements[1] as { style?: string }).style).toBeUndefined()
  })

  it("compiles slack_select with placeholder", () => {
    const out = compileSlackInteractiveReplies(
      "[[slack_select: Pick env | canary:canary, production:production]]",
    )
    expect(out.hasInteractive).toBe(true)
    const actions = out.blocks!.find((b) => b.type === "actions")
    const elements = (actions as unknown as {
      elements: Array<Record<string, unknown>>
    }).elements
    expect(elements[0]).toMatchObject({
      type: "static_select",
      action_id: "bantai:reply_select:0:0",
    })
    const options = (
      elements[0] as {
        options: Array<{ value: string }>
        placeholder: { text: string }
      }
    )
    expect(options.placeholder.text).toBe("Pick env")
    expect(options.options).toHaveLength(2)
    expect(options.options.map((o) => o.value)).toEqual(["canary", "production"])
  })

  it("auto-promotes a trailing `Options: a, b, c.` line to buttons", () => {
    const out = compileSlackInteractiveReplies(
      "Ready when you are.\nOptions: ship, hold, abort.",
    )
    expect(out.hasInteractive).toBe(true)
    expect(out.text).toBe("Ready when you are.")
    const actions = out.blocks!.find((b) => b.type === "actions")
    const elements = (actions as { elements: Array<{ value: string }> }).elements
    expect(elements.map((e) => e.value)).toEqual(["ship", "hold", "abort"])
  })

  it("auto-promotes to select when Options list has >5 items", () => {
    const out = compileSlackInteractiveReplies(
      "Pick one.\nOptions: a, b, c, d, e, f.",
    )
    const actions = out.blocks!.find((b) => b.type === "actions")
    const elements = (actions as unknown as {
      elements: Array<Record<string, unknown>>
    }).elements
    expect(elements[0]).toMatchObject({ type: "static_select" })
  })

  it("rejects Options line when entries contain non-simple tokens", () => {
    const out = compileSlackInteractiveReplies(
      "Pick one.\nOptions: please pay $5, or maybe not.",
    )
    expect(out.hasInteractive).toBe(false)
  })

  it("rejects Options line with duplicate values", () => {
    const out = compileSlackInteractiveReplies(
      "Pick one.\nOptions: ship, ship, hold.",
    )
    expect(out.hasInteractive).toBe(false)
  })

  it("falls back to plain text when directive body is empty", () => {
    const out = compileSlackInteractiveReplies(
      "Prompt\n[[slack_buttons:   ]]",
    )
    expect(out.hasInteractive).toBe(false)
  })

  it("preserves text segments around multiple directives", () => {
    const out = compileSlackInteractiveReplies(
      "Step 1.\n[[slack_buttons: Go:go]]\nStep 2.\n[[slack_buttons: Next:next]]\nDone.",
    )
    expect(out.hasInteractive).toBe(true)
    // Three section blocks (Step 1, Step 2, Done) + two actions blocks.
    const sections = out.blocks!.filter((b) => b.type === "section")
    const actions = out.blocks!.filter((b) => b.type === "actions")
    expect(sections).toHaveLength(3)
    expect(actions).toHaveLength(2)
    expect(
      (actions[1] as { elements: Array<{ action_id: string }> }).elements[0]!
        .action_id,
    ).toBe("bantai:reply_button:1:0")
  })
})

describe("parseInteractiveReplyActionId", () => {
  it("parses button action IDs", () => {
    expect(parseInteractiveReplyActionId("bantai:reply_button:2:0")).toEqual({
      kind: "button",
      index: 2,
    })
  })

  it("parses select action IDs", () => {
    expect(parseInteractiveReplyActionId("bantai:reply_select:0:0")).toEqual({
      kind: "select",
      index: 0,
    })
  })

  it("returns null for other prefixes", () => {
    expect(parseInteractiveReplyActionId("bantai:perm:xyz:allow")).toBeNull()
    expect(parseInteractiveReplyActionId("random:thing")).toBeNull()
  })
})
