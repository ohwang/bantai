/**
 * Smoke test for the message-hop helpers — `matchMessageHopKey`,
 * `pickMessageHopTarget`, and `pickTurnAnchorHopIndices`. These are the
 * pure pieces of the Ctrl+, / Ctrl+. (and Ctrl+Shift+J/K /
 * Ctrl+Shift+Cmd+J/K) "previous / next message" feature; the imperative
 * companion (anchor lookup, scrollBy, sticky-bottom bookkeeping) lives in
 * conversation.tsx and is parity-by-construction once these helpers return
 * the right value.
 */

import { describe, expect, it } from "bun:test"
import {
  matchMessageHopKey,
  pickAllMessageHopIndices,
  pickMessageHopTarget,
  pickTurnAnchorHopIndices,
} from "../../src/frontends/tui/components/conversation"
import type { Block } from "../../src/protocol/types"
import type { ToolGroup } from "../../src/frontends/tui/utils/tool-grouping"

type Ev = Parameters<typeof matchMessageHopKey>[0]

const base: Ev = {
  name: "",
  ctrl: false,
  option: false,
  meta: false,
  super: false,
  shift: false,
}

// ---------------------------------------------------------------------------
// matchMessageHopKey
// ---------------------------------------------------------------------------

describe("matchMessageHopKey", () => {
  it("Ctrl+. hops to the next message (mode: any)", () => {
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "." })).toEqual({
      dir: "next",
      mode: "any",
    })
  })

  it("Ctrl+, hops to the previous message (mode: any)", () => {
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "," })).toEqual({
      dir: "prev",
      mode: "any",
    })
  })

  it("plain , / . (no modifier) do not hop — they reach the textarea", () => {
    expect(matchMessageHopKey({ ...base, name: "," })).toBeNull()
    expect(matchMessageHopKey({ ...base, name: "." })).toBeNull()
  })

  it("Alt+, / Alt+. do not hop — Option is a dead-key compose on macOS", () => {
    expect(matchMessageHopKey({ ...base, option: true, name: "," })).toBeNull()
    expect(matchMessageHopKey({ ...base, option: true, name: "." })).toBeNull()
  })

  it("Ctrl+Alt+, / Ctrl+Alt+. do not hop", () => {
    expect(
      matchMessageHopKey({ ...base, ctrl: true, option: true, name: "," }),
    ).toBeNull()
    expect(
      matchMessageHopKey({ ...base, ctrl: true, option: true, name: "." }),
    ).toBeNull()
  })

  it("Ctrl+Shift+, / Ctrl+Shift+. do not hop (those would type < / >)", () => {
    expect(
      matchMessageHopKey({ ...base, ctrl: true, shift: true, name: "," }),
    ).toBeNull()
    expect(
      matchMessageHopKey({ ...base, ctrl: true, shift: true, name: "." }),
    ).toBeNull()
  })

  it("Cmd-mapped meta / super combos on punctuation do not hop", () => {
    expect(matchMessageHopKey({ ...base, meta: true, name: "," })).toBeNull()
    expect(matchMessageHopKey({ ...base, super: true, name: "." })).toBeNull()
  })

  it("Ctrl+Shift+J / Ctrl+Shift+K hop with mode: any (vim-direction alias for ,/.)", () => {
    expect(
      matchMessageHopKey({ ...base, ctrl: true, shift: true, name: "j" }),
    ).toEqual({ dir: "next", mode: "any" })
    expect(
      matchMessageHopKey({ ...base, ctrl: true, shift: true, name: "k" }),
    ).toEqual({ dir: "prev", mode: "any" })
  })

  it("Ctrl+Shift+Cmd+J / Ctrl+Shift+Cmd+K hop with mode: turn-anchors (skip mid-turn replies)", () => {
    // macOS: Cmd → super under Kitty keyboard protocol.
    expect(
      matchMessageHopKey({ ...base, ctrl: true, shift: true, super: true, name: "j" }),
    ).toEqual({ dir: "next", mode: "turn-anchors" })
    expect(
      matchMessageHopKey({ ...base, ctrl: true, shift: true, super: true, name: "k" }),
    ).toEqual({ dir: "prev", mode: "turn-anchors" })
    // Linux/Win: Cmd-equivalent → meta. Both routes accepted for portability.
    expect(
      matchMessageHopKey({ ...base, ctrl: true, shift: true, meta: true, name: "j" }),
    ).toEqual({ dir: "next", mode: "turn-anchors" })
    expect(
      matchMessageHopKey({ ...base, ctrl: true, shift: true, meta: true, name: "k" }),
    ).toEqual({ dir: "prev", mode: "turn-anchors" })
  })

  it("Ctrl+J / Ctrl+K (no shift) do not hop — those scroll one line, not one message", () => {
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "j" })).toBeNull()
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "k" })).toBeNull()
  })

  it("Ctrl+Alt+Shift+J / K do not hop — Option (alt) is rejected (macOS dead-key compose)", () => {
    expect(
      matchMessageHopKey({
        ...base, ctrl: true, shift: true, option: true, name: "j",
      }),
    ).toBeNull()
    expect(
      matchMessageHopKey({
        ...base, ctrl: true, shift: true, option: true, name: "k",
      }),
    ).toBeNull()
  })

  it("Ctrl+other-letter does not hop — collisions with Emacs / view bindings", () => {
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "n" })).toBeNull()
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "p" })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Block factories shared by both anchor-set helpers.
// ---------------------------------------------------------------------------

const user = (text = "u"): Block => ({ type: "user", text })
const assistant = (text = "a"): Block => ({ type: "assistant", text })
const thinking = (text = "t"): Block => ({ type: "thinking", text })
const sys = (text = "s"): Block => ({ type: "system", text })
const toolGroup = (): ToolGroup => ({
  type: "group",
  blocks: [],
  totalDuration: 0,
  toolCounts: {},
  status: "done",
})

// ---------------------------------------------------------------------------
// pickAllMessageHopIndices — "any" mode (Ctrl+,/. and Ctrl+Shift+J/K).
// Every user OR assistant block is an anchor; tool groups, thinking,
// system, etc. are skipped.
// ---------------------------------------------------------------------------

describe("pickAllMessageHopIndices", () => {
  it("empty conversation → no anchors", () => {
    expect(pickAllMessageHopIndices([])).toEqual([])
  })

  it("alternating turns → every user and every assistant is anchored", () => {
    const items = [user(), assistant(), user(), assistant(), user(), assistant()]
    expect(pickAllMessageHopIndices(items)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("multi-assistant turns → ALL assistant blocks are anchored (no skip)", () => {
    // turn1: u, a, a, a — every assistant counts in "any" mode (this is the
    // contrast point with pickTurnAnchorHopIndices).
    const items = [user(), assistant(), assistant(), assistant(), user(), assistant()]
    expect(pickAllMessageHopIndices(items)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("noise blocks (thinking, system, tool groups) are skipped", () => {
    const items = [
      user(),       // 0 ← anchor
      thinking(),   // 1
      toolGroup(),  // 2
      sys(),        // 3
      assistant(),  // 4 ← anchor
    ]
    expect(pickAllMessageHopIndices(items)).toEqual([0, 4])
  })

  it("undefined slots (sparse arrays) are skipped without crashing", () => {
    const items: Array<Block | ToolGroup | undefined> = [
      user(), undefined, assistant(), undefined,
    ]
    expect(pickAllMessageHopIndices(items)).toEqual([0, 2])
  })
})

// ---------------------------------------------------------------------------
// pickTurnAnchorHopIndices
// ---------------------------------------------------------------------------

describe("pickTurnAnchorHopIndices", () => {

  it("empty conversation → no anchors", () => {
    expect(pickTurnAnchorHopIndices([])).toEqual([])
  })

  it("only user messages → all of them are anchors (no assistants to skip)", () => {
    expect(pickTurnAnchorHopIndices([user(), user(), user()])).toEqual([0, 1, 2])
  })

  it("only assistant messages with no user → no anchors (assistants are leading, no turn)", () => {
    // No user message has been seen, so none of these assistants belong to a
    // turn. The binding is a no-op for this conversation shape.
    expect(
      pickTurnAnchorHopIndices([assistant(), assistant(), assistant()]),
    ).toEqual([])
  })

  it("simple alternating turns → user + each turn's trailing assistant", () => {
    // u, a, u, a, u, a — every assistant happens to be the trailing one of
    // its turn (single-assistant turns), so the result is every block.
    const items = [user(), assistant(), user(), assistant(), user(), assistant()]
    expect(pickTurnAnchorHopIndices(items)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("multi-assistant turns → only the trailing assistant of each turn is anchored", () => {
    // turn1: u, a, a   ← only the second 'a' is anchored
    // turn2: u, a, a   ← same
    // turn3: u, a, a   ← same (final turn's trailing assistant included)
    //
    //   indices: 0  1  2   3  4  5   6  7  8
    //            u  a  a*  u  a  a*  u  a  a*
    //
    // Anchors: [0, 2, 3, 5, 6, 8]. The intermediate 1, 4, 7 are skipped.
    const items = [
      user(), assistant(), assistant(),
      user(), assistant(), assistant(),
      user(), assistant(), assistant(),
    ]
    expect(pickTurnAnchorHopIndices(items)).toEqual([0, 2, 3, 5, 6, 8])
  })

  it("turn ending without an assistant → only the user anchor for that turn", () => {
    // u, a, u, a, u   ← final user has no assistant yet (mid-stream / pre-reply)
    //   indices: 0  1  2  3  4
    //
    // turn1 = (u@0, a@1) → both anchored
    // turn2 = (u@2, a@3) → both anchored
    // turn3 = (u@4, ???) → only user@4 anchored (no trailing assistant)
    const items = [user(), assistant(), user(), assistant(), user()]
    expect(pickTurnAnchorHopIndices(items)).toEqual([0, 1, 2, 3, 4])
  })

  it("leading assistants before any user are NOT anchored (they don't belong to a turn)", () => {
    // a, a, u, a, u, a
    //   indices: 0  1  2  3  4  5
    //
    // Pre-user assistants (0, 1) are leading "noise" (e.g. resume banner) —
    // they don't belong to any user-led turn. First anchor is u@2.
    // turn1 = (u@2, a@3); turn2 = (u@4, a@5).
    const items = [
      assistant(), assistant(),
      user(), assistant(),
      user(), assistant(),
    ]
    expect(pickTurnAnchorHopIndices(items)).toEqual([2, 3, 4, 5])
  })

  it("noise blocks (thinking, system, tool groups) are skipped — they're not part of the user/assistant set", () => {
    // u, thinking, tool-group, system, a, a, u, thinking, a
    //   indices: 0    1            2          3       4  5  6    7         8
    //
    // turn1 = (u@0, last asst before u@6 = a@5) → anchors 0, 5.
    //   The intermediate a@4 is mid-turn, skipped.
    // turn2 = (u@6, last asst at end = a@8) → anchors 6, 8.
    const items = [
      user(),         // 0
      thinking(),     // 1
      toolGroup(),    // 2
      sys(),          // 3
      assistant(),    // 4 mid-turn, skipped
      assistant(),    // 5 trailing assistant of turn 1
      user(),         // 6
      thinking(),     // 7
      assistant(),    // 8 trailing assistant of turn 2 (final)
    ]
    expect(pickTurnAnchorHopIndices(items)).toEqual([0, 5, 6, 8])
  })

  it("undefined slots (sparse arrays) are skipped without crashing", () => {
    const items: Array<Block | ToolGroup | undefined> = [
      user(),       // 0
      undefined,    // 1
      assistant(),  // 2 — trailing assistant of turn 1
      undefined,    // 3
      user(),       // 4
      assistant(),  // 5 — trailing assistant of turn 2 (final)
    ]
    expect(pickTurnAnchorHopIndices(items)).toEqual([0, 2, 4, 5])
  })

  it("output is ascending — guarantees pickMessageHopTarget can consume it", () => {
    const items = [
      user(), assistant(), assistant(),
      user(), assistant(),
    ]
    const out = pickTurnAnchorHopIndices(items)
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]
      const cur = out[i]
      if (prev !== undefined && cur !== undefined) {
        expect(cur).toBeGreaterThan(prev)
      }
    }
  })

  it("traversal pattern is `user → end-of-turn reply → user → end-of-turn reply → ...`", () => {
    // Documents the user-facing contract: the anchor sequence alternates
    // user / trailing-assistant per turn. A regression here means the
    // Ctrl+Shift+Cmd+J/K binding has lost its "skip mid-turn replies"
    // semantics.
    //
    //   turn1: u₀ a₁ a₂      (a₂ is trailing)
    //   turn2: u₃ a₄ a₅ a₆   (a₆ is trailing)
    //   turn3: u₇ a₈         (a₈ is trailing, end of conversation)
    const items = [
      user(), assistant(), assistant(),
      user(), assistant(), assistant(), assistant(),
      user(), assistant(),
    ]
    const out = pickTurnAnchorHopIndices(items)
    expect(out).toEqual([0, 2, 3, 6, 7, 8])
    // Verify the alternation explicitly.
    expect(items[out[0]!]?.type).toBe("user")       // u₀
    expect(items[out[1]!]?.type).toBe("assistant")  // a₂ (turn1 trailing)
    expect(items[out[2]!]?.type).toBe("user")       // u₃
    expect(items[out[3]!]?.type).toBe("assistant")  // a₆ (turn2 trailing)
    expect(items[out[4]!]?.type).toBe("user")       // u₇
    expect(items[out[5]!]?.type).toBe("assistant")  // a₈ (turn3 trailing)
  })
})

// ---------------------------------------------------------------------------
// pickMessageHopTarget
// ---------------------------------------------------------------------------

describe("pickMessageHopTarget", () => {
  // Conversation: messages at y=0, 20, 50, 100. Viewport top is the
  // current scroll position (after add'l offset for the scrollbox header).
  const anchors = [0, 20, 50, 100]

  it("Ctrl+. from the very top jumps to the second message", () => {
    expect(pickMessageHopTarget(anchors, 0, "next")).toEqual({
      kind: "anchor",
      y: 20,
    })
  })

  it("Ctrl+. mid-conversation jumps to the next anchor below", () => {
    expect(pickMessageHopTarget(anchors, 20, "next")).toEqual({
      kind: "anchor",
      y: 50,
    })
  })

  it("Ctrl+. when viewport sits between two anchors picks the next one", () => {
    expect(pickMessageHopTarget(anchors, 35, "next")).toEqual({
      kind: "anchor",
      y: 50,
    })
  })

  it("Ctrl+. at the last message reports edge (caller scrolls to bottom)", () => {
    expect(pickMessageHopTarget(anchors, 100, "next")).toEqual({ kind: "edge" })
  })

  it("Ctrl+. past the last message reports edge", () => {
    expect(pickMessageHopTarget(anchors, 200, "next")).toEqual({ kind: "edge" })
  })

  it("Ctrl+, from the bottom jumps to the previous anchor", () => {
    expect(pickMessageHopTarget(anchors, 100, "prev")).toEqual({
      kind: "anchor",
      y: 50,
    })
  })

  it("Ctrl+, mid-conversation jumps to the anchor above", () => {
    expect(pickMessageHopTarget(anchors, 50, "prev")).toEqual({
      kind: "anchor",
      y: 20,
    })
  })

  it("Ctrl+, when viewport sits between two anchors picks the previous one", () => {
    expect(pickMessageHopTarget(anchors, 35, "prev")).toEqual({
      kind: "anchor",
      y: 20,
    })
  })

  it("Ctrl+, at the first message reports edge (caller scrolls to top)", () => {
    expect(pickMessageHopTarget(anchors, 0, "prev")).toEqual({ kind: "edge" })
  })

  it("Ctrl+, above the first message reports edge", () => {
    // Possible if the viewport is showing the header bar (y < 0 isn't
    // physically possible in our scrollbox, but exact-zero is the sentinel).
    expect(pickMessageHopTarget(anchors, 0, "prev")).toEqual({ kind: "edge" })
  })

  it("empty conversation returns null (no-op)", () => {
    expect(pickMessageHopTarget([], 0, "next")).toBeNull()
    expect(pickMessageHopTarget([], 100, "prev")).toBeNull()
  })

  it("single message: Ctrl+. edges, Ctrl+, edges", () => {
    expect(pickMessageHopTarget([42], 42, "next")).toEqual({ kind: "edge" })
    expect(pickMessageHopTarget([42], 42, "prev")).toEqual({ kind: "edge" })
  })

  it("single message: Ctrl+. from above lands on it, Ctrl+, from below lands on it", () => {
    expect(pickMessageHopTarget([42], 0, "next")).toEqual({
      kind: "anchor",
      y: 42,
    })
    expect(pickMessageHopTarget([42], 100, "prev")).toEqual({
      kind: "anchor",
      y: 42,
    })
  })

  it("unsorted input is sorted internally — render order is whatever DOM order produces", () => {
    // The hop logic walks ascending y, not array order. Anchors arrive in
    // index order from grouped(), but a future view-level reordering must
    // not break hop.
    expect(pickMessageHopTarget([100, 20, 50, 0], 35, "next")).toEqual({
      kind: "anchor",
      y: 50,
    })
    expect(pickMessageHopTarget([100, 20, 50, 0], 35, "prev")).toEqual({
      kind: "anchor",
      y: 20,
    })
  })

  it("1-cell tolerance avoids self-hopping when anchor is exactly at viewport top", () => {
    // The viewport already has anchor y=20 at its top — Ctrl+. must skip past
    // it to y=50, not re-target itself.
    expect(pickMessageHopTarget(anchors, 20, "next")).toEqual({
      kind: "anchor",
      y: 50,
    })
    // Symmetric: Ctrl+, from y=20 jumps up, not back to itself.
    expect(pickMessageHopTarget(anchors, 20, "prev")).toEqual({
      kind: "anchor",
      y: 0,
    })
  })
})
