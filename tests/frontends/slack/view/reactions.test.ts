import { describe, expect, it } from "bun:test"
import type { ConversationEvent } from "../../../../src/protocol/types"
import {
  createStatusReactionController,
  nextReactionState,
  STATE_TO_SHORTCODE,
  type ReactionAdapter,
} from "../../../../src/frontends/slack/view/reactions"

describe("nextReactionState (pure)", () => {
  it("turn_start resets to working when we're past the initial state", () => {
    expect(nextReactionState("done", { type: "turn_start" })).toBe("working")
    expect(nextReactionState("error", { type: "turn_start" })).toBe("working")
  })

  it("turn_start on a fresh working controller is a no-op", () => {
    expect(nextReactionState("working", { type: "turn_start" })).toBeUndefined()
  })

  it("turn_complete → done", () => {
    expect(nextReactionState("working", { type: "turn_complete" })).toBe("done")
  })

  it("fatal error → error; recoverable error stays put", () => {
    expect(
      nextReactionState("working", { type: "error", code: "rate", message: "x", severity: "fatal" }),
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

  it("interrupt → interrupted", () => {
    expect(nextReactionState("working", { type: "interrupt" } as ConversationEvent)).toBe("interrupted")
  })

  it("intermediate tool / thinking / permission events are ignored", () => {
    // Every one of these used to flip the emoji; they now map to no change
    // so the rate-limit budget stays at 1-2 reactions per turn.
    expect(
      nextReactionState("working", { type: "tool_use_start", id: "1", tool: "Read", input: {} }),
    ).toBeUndefined()
    expect(
      nextReactionState("working", { type: "tool_use_start", id: "1", tool: "Bash", input: {} }),
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
      nextReactionState("working", { type: "permission_request", id: "p1", tool: "Bash", input: {} }),
    ).toBeUndefined()
    expect(
      nextReactionState("working", { type: "permission_response", id: "p1", behavior: "allow" }),
    ).toBeUndefined()
    expect(
      nextReactionState("working", { type: "compact" } as ConversationEvent),
    ).toBeUndefined()
  })

  it("done is never :white_check_mark: — the shortcode is empty", () => {
    expect(STATE_TO_SHORTCODE.done).toBe("")
  })
})

describe("StatusReactionController", () => {
  function makeAdapter() {
    const calls: Array<{ op: "add" | "remove"; name: string }> = []
    const adapter: ReactionAdapter = {
      async addReaction(args) { calls.push({ op: "add", name: args.name }) },
      async removeReaction(args) { calls.push({ op: "remove", name: args.name }) },
    }
    return { adapter, calls }
  }

  async function drain(ms = 20) {
    await new Promise((r) => setTimeout(r, ms))
  }

  it("primes the initial reaction on construction", async () => {
    const { adapter, calls } = makeAdapter()
    createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    await drain()
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual({ op: "add", name: STATE_TO_SHORTCODE.working })
  })

  it("turn_complete removes the working emoji and adds nothing (no :white_check_mark:)", async () => {
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    await drain()
    ctrl.apply({ type: "turn_complete" })
    await drain()
    // Exactly one add (the initial :cyclone:) and one remove of the same —
    // the trigger message ends clean.
    expect(calls).toEqual([
      { op: "add", name: STATE_TO_SHORTCODE.working },
      { op: "remove", name: STATE_TO_SHORTCODE.working },
    ])
    expect(ctrl.current()).toBe("done")
  })

  it("rapid-fire intermediate events do not call the reactions API", async () => {
    // Simulates a 16ms event batch from the renderer: turn_start → tool →
    // tool_end → text_delta → turn_complete all arrive synchronously.
    // Only the initial :cyclone: and the final remove should hit the API;
    // tool / text events are silent.
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
    const removes = calls.filter((c) => c.op === "remove").map((c) => c.name)
    expect(adds).toEqual([STATE_TO_SHORTCODE.working])
    expect(removes).toEqual([STATE_TO_SHORTCODE.working])
    expect(ctrl.current()).toBe("done")
  })

  it("sequential turns (await between events) still only touch the API at start + end", async () => {
    // Even when events are separated by async gaps (real agent behaviour),
    // intermediate tool-use events don't generate reaction transitions.
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    await drain()
    ctrl.apply({ type: "turn_start" })
    await drain()
    ctrl.apply({ type: "tool_use_start", id: "1", tool: "Read", input: {} })
    await drain()
    ctrl.apply({ type: "turn_complete" })
    await drain(50)
    const adds = calls.filter((c) => c.op === "add").map((c) => c.name)
    const removes = calls.filter((c) => c.op === "remove").map((c) => c.name)
    expect(adds).toEqual([STATE_TO_SHORTCODE.working])
    expect(removes).toEqual([STATE_TO_SHORTCODE.working])
    expect(ctrl.current()).toBe("done")
  })

  it("terminate('interrupted') swaps working → octagonal_sign (at most 2 emojis total)", async () => {
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    // Let the initial :cyclone: land before we interrupt, otherwise the
    // coalescer collapses both transitions into the terminal state.
    await drain()
    ctrl.apply({ type: "turn_start" })
    await ctrl.terminate("interrupted")
    const adds = calls.filter((c) => c.op === "add").map((c) => c.name)
    expect(adds).toEqual([STATE_TO_SHORTCODE.working, STATE_TO_SHORTCODE.interrupted])
    expect(adds.length).toBeLessThanOrEqual(2)
    expect(ctrl.current()).toBe("interrupted")
  })

  it("synchronous interrupt coalesces to just :octagonal_sign: (1 emoji)", async () => {
    // When there's no async gap between priming and terminate, the
    // controller skips the intermediate :cyclone: — which is fine:
    // the budget is "at most 2 emojis per turn," and 1 is ≤ 2.
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    await ctrl.terminate("interrupted")
    const adds = calls.filter((c) => c.op === "add").map((c) => c.name)
    expect(adds).toEqual([STATE_TO_SHORTCODE.interrupted])
  })

  it("fatal error swaps working → x", async () => {
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    await drain()
    ctrl.apply({
      type: "error",
      code: "rate",
      message: "x",
      severity: "fatal",
    })
    await drain()
    const adds = calls.filter((c) => c.op === "add").map((c) => c.name)
    expect(adds).toEqual([STATE_TO_SHORTCODE.working, STATE_TO_SHORTCODE.error])
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
    ctrl.apply({ type: "permission_request", id: "p1", tool: "Bash", input: {} })
    ctrl.apply({ type: "permission_response", id: "p1", behavior: "allow" })
    ctrl.apply({ type: "turn_complete" })
    await ctrl.terminate("done")
    for (const c of calls) {
      expect(c.name).not.toBe("white_check_mark")
    }
  })

  it("swallows adapter errors without crashing the pipeline", async () => {
    const failing: ReactionAdapter = {
      async addReaction() { throw new Error("nope") },
      async removeReaction() { throw new Error("nope") },
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
    expect(ctrl.current()).toBe("done")
  })
})
