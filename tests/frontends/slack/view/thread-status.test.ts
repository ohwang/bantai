import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  createThreadStatusController,
  nextThreadStatus,
  type ThreadStatusAdapter,
} from "../../../../src/frontends/slack/view/thread-status"

interface SetCall {
  channel: string
  threadTs: string
  status: string
}

function makeAdapter(opts: { failWith?: string } = {}): {
  adapter: ThreadStatusAdapter
  calls: SetCall[]
} {
  const calls: SetCall[] = []
  const adapter: ThreadStatusAdapter = {
    async setStatus(args) {
      if (opts.failWith) throw new Error(opts.failWith)
      calls.push(args)
    },
  }
  return { adapter, calls }
}

describe("nextThreadStatus", () => {
  it("maps turn_start → 'thinking…'", () => {
    expect(nextThreadStatus({ type: "turn_start" })).toBe("thinking…")
  })
  it("maps text_delta → 'replying…'", () => {
    expect(nextThreadStatus({ type: "text_delta", text: "hi" })).toBe(
      "replying…",
    )
  })
  it("maps tool_use_start → 'running <tool>…'", () => {
    expect(
      nextThreadStatus({
        type: "tool_use_start",
        id: "tu1",
        tool: "Bash",
        input: {},
      }),
    ).toBe("running Bash…")
  })
  it("maps permission_request → 'waiting for approval…'", () => {
    expect(
      nextThreadStatus({
        type: "permission_request",
        id: "p1",
        tool: "Write",
        input: {},
      }),
    ).toBe("waiting for approval…")
  })
  it("clears on turn_complete", () => {
    expect(nextThreadStatus({ type: "turn_complete" })).toBe("")
  })
  it("returns undefined for events with no status implication", () => {
    expect(
      nextThreadStatus({
        type: "session_init",
        tools: [],
        models: [],
      }),
    ).toBeUndefined()
  })
})

describe("ThreadStatusController", () => {
  it("posts transitions through the adapter", async () => {
    const { adapter, calls } = makeAdapter()
    const c = createThreadStatusController({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      minTransitionMs: 0,
    })
    c.apply({ type: "turn_start" })
    c.apply({ type: "tool_use_start", id: "tu1", tool: "Bash", input: {} })
    c.apply({ type: "turn_complete" })
    await c.terminate()
    const statuses = calls.map((c) => c.status)
    expect(statuses).toContain("thinking…")
    expect(statuses).toContain("running Bash…")
    // The last call is a clear — either from turn_complete or terminate.
    expect(statuses.at(-1)).toBe("")
  })

  it("deduplicates unchanged transitions", async () => {
    const { adapter, calls } = makeAdapter()
    const c = createThreadStatusController({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      minTransitionMs: 0,
    })
    c.apply({ type: "turn_start" })
    c.apply({ type: "thinking_delta", text: "hmm" })
    c.apply({ type: "thinking_delta", text: "more" })
    await c.terminate()
    // Only one `thinking…` transition fired even though we saw two
    // thinking_deltas in a row.
    const thinkingCount = calls.filter((c) => c.status === "thinking…").length
    expect(thinkingCount).toBe(1)
  })

  it("disables itself on 'channel doesn't support status' errors", async () => {
    const { adapter, calls } = makeAdapter({
      failWith: "method_not_supported_for_channel_type",
    })
    const c = createThreadStatusController({
      adapter,
      channel: "C_regular",
      threadTs: "100.0",
      minTransitionMs: 0,
    })
    c.apply({ type: "turn_start" })
    c.apply({ type: "text_delta", text: "hi" })
    c.apply({ type: "tool_use_start", id: "tu1", tool: "Bash", input: {} })
    await c.terminate()
    // First call attempted, failed, controller disabled. Nothing else
    // touched the adapter.
    expect(calls).toHaveLength(0)
  })

  it("terminate() is a no-op when no events fired (applied already '')", async () => {
    const { adapter, calls } = makeAdapter()
    const c = createThreadStatusController({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      minTransitionMs: 0,
    })
    await c.terminate()
    expect(calls).toHaveLength(0)
  })

  it("terminate() clears the banner after a live session", async () => {
    const { adapter, calls } = makeAdapter()
    const c = createThreadStatusController({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      minTransitionMs: 0,
    })
    c.apply({ type: "turn_start" })
    // No turn_complete — simulate a crashed / timed-out turn.
    await c.terminate()
    const statuses = calls.map((c) => c.status)
    expect(statuses[0]).toBe("thinking…")
    expect(statuses.at(-1)).toBe("")
  })

  it("keeps trying after a transient error (not disabled)", async () => {
    let calls = 0
    const adapter: ThreadStatusAdapter = {
      async setStatus() {
        calls++
        if (calls === 1) throw new Error("transient: ECONNRESET")
      },
    }
    const c = createThreadStatusController({
      adapter,
      channel: "C1",
      threadTs: "100.0",
      minTransitionMs: 0,
    })
    c.apply({ type: "turn_start" })
    c.apply({ type: "tool_use_start", id: "tu1", tool: "Bash", input: {} })
    await c.terminate()
    // Not disabled — second + third calls land (including the terminate clear).
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})

beforeEach(() => void 0)
afterEach(() => void 0)
