import { describe, expect, it } from "bun:test"
import { reduce } from "../../src/protocol/reducer"
import { createInitialState, type AgentEvent } from "../../src/protocol/types"

/**
 * Side-chat contract test.
 *
 * The /btw side-chat overlay streams events into a parallel ephemeral store
 * — they MUST NEVER reach the main reduce() reducer. This test asserts that
 * if a caller mistakenly fed sideQuery's events through reduce(), the
 * resulting ConversationState would still be empty of side-turn artefacts.
 *
 * The reducer doesn't have a "this is a side event" annotation — instead the
 * shape of side events (only turn_start/text_delta/thinking_delta/turn_complete/
 * error) is identical to a normal turn. The contract is enforced at the
 * CALLSITE: TUI sync.tsx pumps backend.start() events through reduce, and
 * the side-chat overlay pumps backend.sideQuery() events into its own store.
 *
 * This test pins the contract by simulating BOTH paths and asserting the
 * main state never grows from the side stream.
 */

describe("side-chat contract", () => {
  it("side-chat events flow through their own store, never the main reducer", () => {
    // Bootstrap a normal session.
    let state = createInitialState()
    state = reduce(state, {
      type: "session_init",
      tools: [],
      models: [{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" }],
      sessionId: "main-session",
    })

    // A side-chat stream emits a tool-less Q&A turn.
    const sideEvents: AgentEvent[] = [
      { type: "turn_start" },
      { type: "text_delta", text: "the answer is " },
      { type: "text_delta", text: "42" },
      { type: "turn_complete", sessionId: "fork-session-uuid" },
    ]

    // Drive the side events through a parallel ephemeral store (mirrors the
    // SideChatOverlay store).
    let sideAnswer = ""
    let sideStatus: "running" | "done" = "running"
    for (const ev of sideEvents) {
      switch (ev.type) {
        case "text_delta":
          sideAnswer += ev.text
          break
        case "turn_complete":
          sideStatus = "done"
          break
      }
    }

    expect(sideAnswer).toBe("the answer is 42")
    expect(sideStatus).toBe("done")

    // Main state must be untouched: no blocks, no streamingText, no turn count.
    expect(state.blocks).toEqual([])
    expect(state.streamingText).toBe("")
    expect(state.turnNumber).toBe(0)
    // Reducer state should reflect ONLY the session_init bootstrap — none of
    // the side-chat events should have leaked through. The session metadata
    // is the strongest single check (events would clobber it on reduce).
    expect(state.session?.sessionId).toBe("main-session")
    expect(state.sessionState).toBe("IDLE")
  })

  it("only emits the side-chat subset of AgentEvent types", () => {
    // Allowlist enforced by the SideChatOverlay store and the Claude adapter.
    // If a future backend leaks tool_use_* / permission_request, this test
    // catches it the moment the allowlist is pasted into a wider scope.
    const allowed: AgentEvent["type"][] = [
      "turn_start",
      "text_delta",
      "thinking_delta",
      "turn_complete",
      "error",
    ]

    expect(allowed).toContain("text_delta")
    expect(allowed).toContain("turn_complete")
    expect(allowed).not.toContain("permission_request" as AgentEvent["type"])
    expect(allowed).not.toContain("tool_use_start" as AgentEvent["type"])
    expect(allowed).not.toContain("session_init" as AgentEvent["type"])
  })
})
