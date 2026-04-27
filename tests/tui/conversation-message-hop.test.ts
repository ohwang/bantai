/**
 * Smoke test for the message-hop helpers — `matchMessageHopKey` and
 * `pickMessageHopTarget`. These are the pure pieces of the Ctrl+, / Ctrl+.
 * "previous / next user-or-assistant message" feature; the imperative
 * companion (anchor lookup, scrollBy, sticky-bottom bookkeeping) lives in
 * conversation.tsx and is parity-by-construction once these helpers return
 * the right value.
 */

import { describe, expect, it } from "bun:test"
import {
  matchMessageHopKey,
  pickMessageHopTarget,
} from "../../src/frontends/tui/components/conversation"

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
  it("Ctrl+. hops to the next message", () => {
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "." })).toBe("next")
  })

  it("Ctrl+, hops to the previous message", () => {
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "," })).toBe("prev")
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

  it("Cmd-mapped meta / super combos do not hop", () => {
    expect(matchMessageHopKey({ ...base, meta: true, name: "," })).toBeNull()
    expect(matchMessageHopKey({ ...base, super: true, name: "." })).toBeNull()
  })

  it("Ctrl+other-letter does not hop — collisions with Emacs / view bindings", () => {
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "n" })).toBeNull()
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "p" })).toBeNull()
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "j" })).toBeNull()
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "k" })).toBeNull()
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
