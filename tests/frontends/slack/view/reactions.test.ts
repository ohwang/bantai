import { describe, expect, it } from "bun:test"
import type { ConversationEvent } from "../../../../src/protocol/types"
import {
  createStatusReactionController,
  nextReactionState,
  STATE_TO_SHORTCODE,
  type ReactionAdapter,
} from "../../../../src/frontends/slack/view/reactions"

describe("nextReactionState (pure)", () => {
  it("turn_start moves non-working states to working", () => {
    expect(nextReactionState("waiting", { type: "turn_start" })).toBe("working")
    expect(nextReactionState("error", { type: "turn_start" })).toBe("working")
    expect(nextReactionState("interrupted", { type: "turn_start" })).toBe("working")
  })

  it("turn_start on a fresh working controller is a no-op", () => {
    expect(nextReactionState("working", { type: "turn_start" })).toBeUndefined()
  })

  it("turn_complete → waiting", () => {
    expect(nextReactionState("working", { type: "turn_complete" })).toBe("waiting")
  })

  it("permission_request / elicitation_request flip to waiting", () => {
    expect(
      nextReactionState("working", {
        type: "permission_request",
        id: "p1",
        tool: "Bash",
        input: {},
      }),
    ).toBe("waiting")
    expect(
      nextReactionState("working", {
        type: "elicitation_request",
        id: "e1",
        questions: [],
      } as unknown as ConversationEvent),
    ).toBe("waiting")
  })

  it("permission_response / elicitation_response flip back to working", () => {
    expect(
      nextReactionState("waiting", {
        type: "permission_response",
        id: "p1",
        behavior: "allow",
      }),
    ).toBe("working")
    expect(
      nextReactionState("waiting", {
        type: "elicitation_response",
        id: "e1",
      } as unknown as ConversationEvent),
    ).toBe("working")
  })

  it("interrupt → interrupted (user stop, timeout, or budget all use this path)", () => {
    expect(nextReactionState("working", { type: "interrupt" } as ConversationEvent)).toBe(
      "interrupted",
    )
  })

  it("fatal error → error; recoverable error stays put", () => {
    expect(
      nextReactionState("working", {
        type: "error",
        code: "rate",
        message: "x",
        severity: "fatal",
      }),
    ).toBe("error")
    expect(
      nextReactionState("working", {
        type: "error",
        code: "flaky",
        message: "retry",
        severity: "recoverable",
      }),
    ).toBeUndefined()
  })

  it("intermediate events are ignored (tool / thinking / text / compact / rate_limit)", () => {
    expect(
      nextReactionState("working", {
        type: "tool_use_start",
        id: "1",
        tool: "Read",
        input: {},
      }),
    ).toBeUndefined()
    expect(
      nextReactionState("working", { type: "tool_use_end", id: "1", output: "ok" }),
    ).toBeUndefined()
    expect(
      nextReactionState("working", { type: "thinking_delta", text: "…" }),
    ).toBeUndefined()
    expect(
      nextReactionState("working", { type: "text_delta", text: "reply" }),
    ).toBeUndefined()
    expect(
      nextReactionState("working", { type: "compact" } as ConversationEvent),
    ).toBeUndefined()
  })

  it("maps each state to the expected emoji and never uses :white_check_mark:", () => {
    expect(STATE_TO_SHORTCODE.working).toBe("speech_balloon")
    expect(STATE_TO_SHORTCODE.waiting).toBe("round_pushpin")
    expect(STATE_TO_SHORTCODE.interrupted).toBe("watermelon")
    expect(STATE_TO_SHORTCODE.error).toBe("octagonal_sign")
    for (const shortcode of Object.values(STATE_TO_SHORTCODE)) {
      expect(shortcode).not.toBe("white_check_mark")
    }
  })
})

describe("StatusReactionController", () => {
  function makeAdapter() {
    const calls: Array<{ op: "add" | "remove"; name: string }> = []
    const adapter: ReactionAdapter = {
      async addReaction(args) {
        calls.push({ op: "add", name: args.name })
      },
      async removeReaction(args) {
        calls.push({ op: "remove", name: args.name })
      },
    }
    return { adapter, calls }
  }

  async function drain(ms = 20) {
    await new Promise((r) => setTimeout(r, ms))
  }

  it("primes the initial :speech_balloon: on construction", async () => {
    const { adapter, calls } = makeAdapter()
    createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    await drain()
    expect(calls).toEqual([{ op: "add", name: "speech_balloon" }])
  })

  it("turn_complete swaps :speech_balloon: → :round_pushpin: (2 emoji transitions)", async () => {
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    await drain()
    ctrl.apply({ type: "turn_complete" })
    await drain()
    expect(calls).toEqual([
      { op: "add", name: "speech_balloon" },
      { op: "remove", name: "speech_balloon" },
      { op: "add", name: "round_pushpin" },
    ])
    expect(ctrl.current()).toBe("waiting")
  })

  it("rapid-fire intermediate events do not call the reactions API", async () => {
    // Simulates a 16ms event batch from the renderer: turn_start → tool →
    // tool_end → text_delta → turn_complete all arrive synchronously.
    // Only the start/final transitions should hit the API; tool / text
    // events are silent.
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    await drain()
    ctrl.apply({ type: "turn_start" })
    ctrl.apply({ type: "tool_use_start", id: "1", tool: "Read", input: {} })
    ctrl.apply({ type: "tool_use_end", id: "1", output: "..." })
    ctrl.apply({ type: "text_delta", text: "here" })
    ctrl.apply({ type: "turn_complete" })
    await drain(50)
    const adds = calls.filter((c) => c.op === "add").map((c) => c.name)
    expect(adds).toEqual(["speech_balloon", "round_pushpin"])
    expect(ctrl.current()).toBe("waiting")
  })

  it("permission round-trip: :speech_balloon: → :round_pushpin: → :speech_balloon: when spaced", async () => {
    // Events separated by async gaps apply each transition in full.
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    await drain()
    ctrl.apply({
      type: "permission_request",
      id: "p1",
      tool: "Bash",
      input: {},
    })
    await drain()
    ctrl.apply({
      type: "permission_response",
      id: "p1",
      behavior: "allow",
    })
    await drain()
    ctrl.apply({ type: "turn_complete" })
    await drain(50)
    const adds = calls.filter((c) => c.op === "add").map((c) => c.name)
    expect(adds).toEqual([
      "speech_balloon",
      "round_pushpin",
      "speech_balloon",
      "round_pushpin",
    ])
    expect(ctrl.current()).toBe("waiting")
  })

  it("permission auto-response inside the same batch coalesces to zero API calls", async () => {
    // Auto-allow policy: permission_request immediately followed by
    // permission_response. The coalescer sees state flip to waiting and
    // back to working within the same flush window — no visible flip.
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    await drain()
    ctrl.apply({
      type: "permission_request",
      id: "p1",
      tool: "Bash",
      input: {},
    })
    ctrl.apply({
      type: "permission_response",
      id: "p1",
      behavior: "allow",
    })
    await drain()
    // Only the initial prime — no flip at all.
    const adds = calls.filter((c) => c.op === "add").map((c) => c.name)
    expect(adds).toEqual(["speech_balloon"])
  })

  it("terminate('interrupted') → :watermelon:", async () => {
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    await drain()
    await ctrl.terminate("interrupted")
    const adds = calls.filter((c) => c.op === "add").map((c) => c.name)
    expect(adds).toEqual(["speech_balloon", "watermelon"])
    expect(ctrl.current()).toBe("interrupted")
  })

  it("terminate('done') → :round_pushpin:", async () => {
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    await drain()
    await ctrl.terminate("done")
    const adds = calls.filter((c) => c.op === "add").map((c) => c.name)
    expect(adds).toEqual(["speech_balloon", "round_pushpin"])
    expect(ctrl.current()).toBe("waiting")
  })

  it("fatal error → :octagonal_sign:", async () => {
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    await drain()
    ctrl.apply({
      type: "error",
      code: "backend_crash",
      message: "x",
      severity: "fatal",
    })
    await drain()
    const adds = calls.filter((c) => c.op === "add").map((c) => c.name)
    expect(adds).toEqual(["speech_balloon", "octagonal_sign"])
    expect(ctrl.current()).toBe("error")
  })

  it("never emits :white_check_mark: across any lifecycle", async () => {
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    ctrl.apply({ type: "turn_start" })
    ctrl.apply({ type: "tool_use_start", id: "1", tool: "Bash", input: {} })
    ctrl.apply({
      type: "permission_request",
      id: "p1",
      tool: "Bash",
      input: {},
    })
    ctrl.apply({
      type: "permission_response",
      id: "p1",
      behavior: "allow",
    })
    ctrl.apply({ type: "turn_complete" })
    await ctrl.terminate("done")
    for (const c of calls) {
      expect(c.name).not.toBe("white_check_mark")
    }
  })

  it("swallows adapter errors without crashing the pipeline", async () => {
    const failing: ReactionAdapter = {
      async addReaction() {
        throw new Error("nope")
      },
      async removeReaction() {
        throw new Error("nope")
      },
    }
    const ctrl = createStatusReactionController({
      adapter: failing,
      channel: "C1",
      triggerTs: "t1",
    })
    ctrl.apply({ type: "turn_start" })
    ctrl.apply({ type: "turn_complete" })
    // Shouldn't throw; state progresses despite API failures.
    await ctrl.terminate("done")
    expect(ctrl.current()).toBe("waiting")
  })
})
