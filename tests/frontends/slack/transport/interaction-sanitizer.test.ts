import { describe, expect, it } from "bun:test"
import {
  renderSlackInteractionMessage,
  sanitizeSlackInteractionPayload,
} from "../../../../src/frontends/slack/transport/interaction-sanitizer"

describe("sanitizeSlackInteractionPayload — redaction", () => {
  it("redacts trigger_id / response_url / private_metadata", () => {
    const input = {
      type: "block_actions",
      trigger_id: "13345224609.738474920.8b5297d4c7",
      response_url: "https://hooks.slack.com/actions/T0/secret/LONG",
      actions: [
        {
          action_id: "approve",
          value: "ok",
        },
      ],
      view: {
        callback_id: "modal",
        private_metadata: "opaque-app-state",
        hash: "abc",
      },
    }
    const out = sanitizeSlackInteractionPayload(input) as Record<string, unknown>
    expect(out.trigger_id).toBe("[redacted]")
    expect(out.response_url).toBe("[redacted]")
    const view = out.view as Record<string, unknown>
    expect(view.private_metadata).toBe("[redacted]")
    expect(view.hash).toBe("[redacted]")
    // Non-secret fields survive.
    expect(view.callback_id).toBe("modal")
  })

  it("redaction reaches arbitrarily deep keys", () => {
    const input = {
      nested: {
        wrapper: {
          trigger_id: "leaking",
        },
      },
    }
    const out = sanitizeSlackInteractionPayload(input) as Record<string, unknown>
    const nested = out.nested as Record<string, unknown>
    const wrapper = nested.wrapper as Record<string, unknown>
    expect(wrapper.trigger_id).toBe("[redacted]")
  })

  it("honours a caller-supplied redactKeys override", () => {
    const input = { secret_field: "sensitive" }
    const out = sanitizeSlackInteractionPayload(input, {
      redactKeys: ["secret_field"],
    }) as Record<string, unknown>
    expect(out.secret_field).toBe("[redacted]")
  })
})

describe("sanitizeSlackInteractionPayload — size caps", () => {
  it("truncates long strings to maxStringLen", () => {
    const input = { summary: "x".repeat(1000) }
    const out = sanitizeSlackInteractionPayload(input, {
      maxStringLen: 50,
    }) as { summary: string }
    expect(out.summary.length).toBe(50)
    expect(out.summary.endsWith("…")).toBe(true)
  })

  it("truncates arrays to maxArrayLen + adds overflow marker", () => {
    const input = { items: Array.from({ length: 200 }, (_, i) => `item${i}`) }
    const out = sanitizeSlackInteractionPayload(input, {
      maxArrayLen: 10,
    }) as { items: string[] }
    expect(out.items).toHaveLength(11) // 10 kept + marker
    expect(out.items[10]).toBe("[+190 more]")
  })

  it("compact-forms when serialised payload exceeds compactBudget", () => {
    const bigValues: Record<string, unknown> = {}
    for (let i = 0; i < 50; i++) {
      bigValues[`block${i}`] = {
        action_id: `input_${i}`,
        value: "x".repeat(200),
      }
    }
    const input = {
      type: "view_submission",
      callback_id: "big_modal",
      team: { id: "T1", domain: "example" },
      user: { id: "U1", name: "alice", team_id: "T1" },
      channel: { id: "C1", name: "eng" },
      response_url: "https://hooks.slack.com/x",
      trigger_id: "trig",
      view: {
        id: "V1",
        state: { values: bigValues },
        private_metadata: "opaque",
        hash: "h",
      },
    }
    const out = sanitizeSlackInteractionPayload(input, {
      compactBudget: 500,
      maxStringLen: 40,
    }) as Record<string, unknown>
    expect(out._compacted).toBe(true)
    expect(out.type).toBe("view_submission")
    expect(out.callback_id).toBe("big_modal")
    // Essentials survive compaction.
    expect((out.user as Record<string, unknown>).id).toBe("U1")
    expect((out.channel as Record<string, unknown>).id).toBe("C1")
    const view = out.view as Record<string, unknown>
    const state = view.state as Record<string, unknown>
    expect(state.values).toBeDefined()
  })
})

describe("sanitizeSlackInteractionPayload — safety", () => {
  it("handles null / undefined without crashing", () => {
    expect(sanitizeSlackInteractionPayload(null)).toBe(null)
    expect(sanitizeSlackInteractionPayload(undefined)).toBe(undefined)
  })

  it("passes through primitives", () => {
    expect(sanitizeSlackInteractionPayload(42)).toBe(42)
    expect(sanitizeSlackInteractionPayload(true)).toBe(true)
    expect(sanitizeSlackInteractionPayload("short string")).toBe("short string")
  })

  it("bounds recursion depth so nested cycles don't hang", () => {
    // Build a 20-deep nested object. Sanitiser caps at MAX_DEPTH=8,
    // deeper fields should be replaced with "[depth-limit]".
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 20; i++) {
      deep = { nested: deep }
    }
    const out = sanitizeSlackInteractionPayload(deep)
    // Walk down to find the depth marker.
    let cursor: unknown = out
    let found = false
    for (let i = 0; i < 25; i++) {
      if (cursor === "[depth-limit]") {
        found = true
        break
      }
      if (cursor && typeof cursor === "object" && "nested" in cursor) {
        cursor = (cursor as { nested: unknown }).nested
      } else {
        break
      }
    }
    expect(found).toBe(true)
  })
})

describe("renderSlackInteractionMessage", () => {
  it("prefixes with 'Slack interaction:' and emits compact JSON", () => {
    const msg = renderSlackInteractionMessage({
      type: "block_actions",
      trigger_id: "secret",
      actions: [{ action_id: "click", value: "go" }],
    })
    expect(msg.startsWith("Slack interaction: ")).toBe(true)
    expect(msg).toContain('"type":"block_actions"')
    expect(msg).toContain('"trigger_id":"[redacted]"')
    // No leaked secrets.
    expect(msg).not.toContain("secret")
  })
})
