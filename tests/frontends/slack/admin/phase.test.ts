import { describe, expect, it } from "bun:test"
import {
  createPhaseTracker,
  nextPhase,
} from "../../../../src/frontends/slack/admin/phase"
import type { AgentEvent } from "../../../../src/protocol/types"

describe("nextPhase", () => {
  it("starts UNKNOWN and becomes IDLE on session_init", () => {
    expect(
      nextPhase("UNKNOWN", {
        type: "session_init",
        tools: [],
        models: [],
      } as AgentEvent),
    ).toBe("IDLE")
  })

  it("turn_start → RUNNING, turn_complete → IDLE", () => {
    expect(nextPhase("IDLE", { type: "turn_start" })).toBe("RUNNING")
    expect(nextPhase("RUNNING", { type: "turn_complete" })).toBe("IDLE")
  })

  it("permission_request → WAITING_FOR_PERM, response → RUNNING", () => {
    expect(
      nextPhase("RUNNING", {
        type: "permission_request",
        id: "p1",
        tool: "Bash",
        input: {},
      }),
    ).toBe("WAITING_FOR_PERM")
    expect(
      nextPhase("WAITING_FOR_PERM", {
        type: "permission_response",
        id: "p1",
        behavior: "allow",
      }),
    ).toBe("RUNNING")
  })

  it("elicitation_request → WAITING_FOR_ELIC, response → RUNNING", () => {
    expect(
      nextPhase("RUNNING", {
        type: "elicitation_request",
        id: "e1",
        questions: [],
      }),
    ).toBe("WAITING_FOR_ELIC")
    expect(
      nextPhase("WAITING_FOR_ELIC", {
        type: "elicitation_response",
        id: "e1",
        answers: {},
      }),
    ).toBe("RUNNING")
  })

  it("fatal error latches into ERROR; recoverable error leaves phase unchanged", () => {
    expect(
      nextPhase("RUNNING", {
        type: "error",
        code: "x",
        message: "boom",
        severity: "fatal",
      }),
    ).toBe("ERROR")
    expect(
      nextPhase("RUNNING", {
        type: "error",
        code: "x",
        message: "soft",
        severity: "recoverable",
      }),
    ).toBe("RUNNING")
    // No severity field at all — treat as non-fatal (state unchanged).
    expect(
      nextPhase("RUNNING", { type: "error", code: "x", message: "no sev" }),
    ).toBe("RUNNING")
  })

  it("interrupt → INTERRUPTING; shutdown → SHUTTING_DOWN", () => {
    expect(nextPhase("RUNNING", { type: "interrupt" })).toBe("INTERRUPTING")
    expect(nextPhase("IDLE", { type: "shutdown" })).toBe("SHUTTING_DOWN")
  })

  it("ignores streaming / housekeeping events", () => {
    const noChange: AgentEvent[] = [
      { type: "text_delta", text: "hi" },
      { type: "thinking_delta", text: "…" },
      {
        type: "tool_use_start",
        id: "t1",
        tool: "Bash",
        input: {},
      },
      {
        type: "tool_use_end",
        id: "t1",
        output: "done",
      },
      {
        type: "cost_update",
        inputTokens: 100,
        outputTokens: 50,
      },
    ]
    for (const event of noChange) {
      expect(nextPhase("RUNNING", event)).toBe("RUNNING")
      expect(nextPhase("IDLE", event)).toBe("IDLE")
    }
  })
})

describe("createPhaseTracker", () => {
  it("starts UNKNOWN by default and transitions through a typical turn", () => {
    const t = createPhaseTracker()
    expect(t.current()).toBe("UNKNOWN")

    const initObs = t.observe({
      type: "session_init",
      tools: [],
      models: [],
    } as AgentEvent)
    expect(initObs).toEqual({ prev: "UNKNOWN", next: "IDLE", changed: true })

    const start = t.observe({ type: "turn_start" })
    expect(start.changed).toBe(true)
    expect(start.next).toBe("RUNNING")

    const ignored = t.observe({ type: "text_delta", text: "x" })
    expect(ignored).toEqual({ prev: "RUNNING", next: "RUNNING", changed: false })

    const done = t.observe({ type: "turn_complete" })
    expect(done.changed).toBe(true)
    expect(done.next).toBe("IDLE")
    expect(t.current()).toBe("IDLE")
  })

  it("accepts an explicit initial phase (rehydrated session starts at IDLE)", () => {
    const t = createPhaseTracker("IDLE")
    expect(t.current()).toBe("IDLE")
    expect(t.observe({ type: "turn_start" }).changed).toBe(true)
  })

  it("set() forces a phase and reports change only when it actually moves", () => {
    const t = createPhaseTracker("IDLE")
    expect(t.set("RUNNING")).toEqual({
      prev: "IDLE",
      next: "RUNNING",
      changed: true,
    })
    expect(t.set("RUNNING")).toEqual({
      prev: "RUNNING",
      next: "RUNNING",
      changed: false,
    })
    expect(t.current()).toBe("RUNNING")
  })

  it("permission approval round-trip reports two changes (RUNNING → WAITING → RUNNING)", () => {
    const t = createPhaseTracker("RUNNING")
    const waiting = t.observe({
      type: "permission_request",
      id: "p",
      tool: "Bash",
      input: {},
    })
    expect(waiting.changed).toBe(true)
    const resumed = t.observe({
      type: "permission_response",
      id: "p",
      behavior: "allow",
    })
    expect(resumed.changed).toBe(true)
    expect(t.current()).toBe("RUNNING")
  })
})
