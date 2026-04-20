/**
 * Unit coverage for `formatEvent` in panes/event-stream.tsx.
 *
 * The formatter is property-driven (`Record<string, unknown>` probe)
 * rather than discriminated against the AgentEvent union because the
 * monitor is a best-effort read-only viewer — a new AgentEvent variant
 * should render with a reasonable fallback instead of throwing. These
 * tests lock that down: known shapes produce the intended compact
 * strings, and unknown shapes don't explode.
 */

import { describe, expect, it } from "bun:test"
import { formatEvent } from "../../../src/frontends/slack-monitor/panes/event-stream"
import type { AgentEvent } from "../../../src/protocol/types"

function ev<T extends Record<string, unknown>>(o: T): AgentEvent {
  return o as unknown as AgentEvent
}

describe("formatEvent", () => {
  it("formats session_init with id + model", () => {
    const out = formatEvent(
      ev({ type: "session_init", sessionId: "s1", model: "claude-sonnet-4" }),
    )
    expect(out.kind).toBe("session_init")
    expect(out.body).toContain("s1")
    expect(out.body).toContain("claude-sonnet-4")
  })

  it("falls back to models[0] when model is absent", () => {
    const out = formatEvent(
      ev({ type: "session_init", sessionId: "s2", models: ["haiku-a"] }),
    )
    expect(out.body).toContain("haiku-a")
  })

  it("formats turn_start / turn_complete", () => {
    const start = formatEvent(ev({ type: "turn_start", turnId: "t-1" }))
    expect(start.body).toContain("t-1")
    const done = formatEvent(
      ev({ type: "turn_complete", turnId: "t-1", costUsd: 0.1234 }),
    )
    expect(done.body).toContain("t-1")
    expect(done.body).toContain("$0.123")
  })

  it("truncates text deltas to keep rows one-line", () => {
    const long = "x".repeat(400)
    const out = formatEvent(ev({ type: "text_delta", text: long }))
    expect(out.kind).toBe("text")
    expect(out.body.length).toBeLessThanOrEqual(120)
    expect(out.body.endsWith("…")).toBe(true)
  })

  it("formats permission_request and permission_response", () => {
    const req = formatEvent(
      ev({ type: "permission_request", id: "p1", tool: "Bash", input: {} }),
    )
    expect(req.body).toContain("Bash")
    expect(req.body).toContain("p1")
    const res = formatEvent(
      ev({ type: "permission_response", id: "p1", decision: "allow" }),
    )
    expect(res.body).toContain("p1")
    expect(res.body).toContain("allow")
  })

  it("formats error with message", () => {
    const out = formatEvent(
      ev({ type: "error", message: "rate limit exceeded" }),
    )
    expect(out.kind).toBe("error")
    expect(out.body).toContain("rate limit")
  })

  it("falls back to type + JSON for unknown event shapes", () => {
    const out = formatEvent(ev({ type: "future_kind_v9", foo: "bar" }))
    expect(out.kind).toBe("future_kind_v9")
    expect(out.body).toContain("bar")
  })

  it("never throws on missing type field", () => {
    const out = formatEvent(ev({}))
    expect(typeof out.kind).toBe("string")
    expect(typeof out.body).toBe("string")
  })
})
