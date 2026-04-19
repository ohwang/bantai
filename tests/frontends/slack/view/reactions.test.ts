import { describe, expect, it } from "bun:test"
import type { ConversationEvent } from "../../../../src/protocol/types"
import {
  createStatusReactionController,
  nextReactionState,
  STATE_TO_SHORTCODE,
  type ReactionAdapter,
} from "../../../../src/frontends/slack/view/reactions"

describe("nextReactionState (pure)", () => {
  it("session_init flips queued → working", () => {
    expect(nextReactionState("queued", { type: "session_init", tools: [], models: [] })).toBe("working")
  })

  it("turn_start always returns working", () => {
    expect(nextReactionState("done", { type: "turn_start" })).toBe("working")
  })

  it("tool_use_start classifies by tool family", () => {
    expect(
      nextReactionState("working", { type: "tool_use_start", id: "1", tool: "Read", input: {} }),
    ).toBe("reading")
    expect(
      nextReactionState("working", { type: "tool_use_start", id: "1", tool: "Bash", input: {} }),
    ).toBe("shell")
    expect(
      nextReactionState("working", { type: "tool_use_start", id: "1", tool: "Edit", input: {} }),
    ).toBe("editing")
    expect(
      nextReactionState("working", { type: "tool_use_start", id: "1", tool: "WebSearch", input: {} }),
    ).toBe("web")
  })

  it("tool_use_start returns undefined when already in that state", () => {
    expect(
      nextReactionState("reading", { type: "tool_use_start", id: "1", tool: "Grep", input: {} }),
    ).toBeUndefined()
  })

  it("permission_request → awaiting_approval; permission_response → working", () => {
    expect(
      nextReactionState("reading", { type: "permission_request", id: "p1", tool: "Bash", input: {} }),
    ).toBe("awaiting_approval")
    expect(
      nextReactionState("awaiting_approval", { type: "permission_response", id: "p1", behavior: "allow" }),
    ).toBe("working")
  })

  it("turn_complete → done", () => {
    expect(nextReactionState("thinking", { type: "turn_complete" })).toBe("done")
  })

  it("fatal error → error", () => {
    expect(
      nextReactionState("working", { type: "error", code: "rate", message: "x", severity: "fatal" }),
    ).toBe("error")
  })

  it("interrupt → interrupted", () => {
    expect(nextReactionState("working", { type: "interrupt" } as ConversationEvent)).toBe("interrupted")
  })

  it("text_delta keeps tool states (shows tool work continued)", () => {
    expect(nextReactionState("reading", { type: "text_delta", text: "..." })).toBeUndefined()
    expect(nextReactionState("working", { type: "text_delta", text: "..." })).toBe("thinking")
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
      initial: "queued",
    })
    await drain()
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual({ op: "add", name: STATE_TO_SHORTCODE.queued })
  })

  it("removes the prior emoji before adding the new one", async () => {
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
      initial: "queued",
    })
    await drain()
    ctrl.apply({ type: "turn_start" })
    await drain()
    // queued-add, queued-remove, working-add
    const expected: Array<{ op: "add" | "remove"; name: string }> = [
      { op: "add", name: STATE_TO_SHORTCODE.queued },
      { op: "remove", name: STATE_TO_SHORTCODE.queued },
      { op: "add", name: STATE_TO_SHORTCODE.working },
    ]
    expect(calls).toEqual(expected)
  })

  it("rapid-fire events coalesce: only the final state hits the API", async () => {
    // Simulates a 16ms event batch from the renderer: turn_start → tool →
    // tool_end → text_delta → turn_complete all arrive synchronously.
    // Only the last state change ("done") should generate API calls; the
    // intermediate working/reading transitions are skipped entirely.
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
    // All intermediate states (working, reading) are coalesced; only the
    // initial prime and the final "done" generate API calls.
    expect(adds).toEqual([STATE_TO_SHORTCODE.queued, STATE_TO_SHORTCODE.done])
    expect(ctrl.current()).toBe("done")
  })

  it("sequential transitions (awaited between events) apply each state individually", async () => {
    // When events are separated by async gaps (real agent behaviour: each
    // tool call is async), each state transition is applied in full.
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
    expect(adds).toEqual([
      STATE_TO_SHORTCODE.queued,
      STATE_TO_SHORTCODE.working,
      STATE_TO_SHORTCODE.reading,
      STATE_TO_SHORTCODE.done,
    ])
    expect(ctrl.current()).toBe("done")
  })

  it("terminate() forces the final state even after other events", async () => {
    const { adapter, calls } = makeAdapter()
    const ctrl = createStatusReactionController({
      adapter,
      channel: "C1",
      triggerTs: "t1",
    })
    ctrl.apply({ type: "turn_start" })
    await ctrl.terminate("interrupted")
    const adds = calls.filter((c) => c.op === "add").map((c) => c.name)
    expect(adds).toContain(STATE_TO_SHORTCODE.interrupted)
    expect(ctrl.current()).toBe("interrupted")
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
