/**
 * Smoke test for the message-hop helpers — `matchMessageHopKey` and
 * `pickMessageHopTarget`. These are the pure pieces of the Alt+N / Alt+P
 * "next / previous user-or-assistant message" feature; the imperative
 * companion (anchor lookup, scrollBy, sticky-bottom bookkeeping) lives in
 * conversation.tsx and is parity-by-construction once these helpers return
 * the right value.
 *
 * Mirrors tests/tui/conversation-scroll-key.test.ts in style — the helper
 * is unit-testable without booting OpenTUI.
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
  it("Alt+N hops to the next message", () => {
    expect(matchMessageHopKey({ ...base, option: true, name: "n" })).toBe("next")
  })

  it("Alt+P hops to the previous message", () => {
    expect(matchMessageHopKey({ ...base, option: true, name: "p" })).toBe("prev")
  })

  it("plain n / p (no modifier) do not hop — they reach the textarea", () => {
    expect(matchMessageHopKey({ ...base, name: "n" })).toBeNull()
    expect(matchMessageHopKey({ ...base, name: "p" })).toBeNull()
  })

  it("Ctrl+N / Ctrl+P do not hop — Emacs next-line / previous-line collisions", () => {
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "n" })).toBeNull()
    expect(matchMessageHopKey({ ...base, ctrl: true, name: "p" })).toBeNull()
  })

  it("Ctrl+Alt+N / Ctrl+Alt+P do not hop", () => {
    expect(
      matchMessageHopKey({ ...base, ctrl: true, option: true, name: "n" }),
    ).toBeNull()
    expect(
      matchMessageHopKey({ ...base, ctrl: true, option: true, name: "p" }),
    ).toBeNull()
  })

  it("Shift+Alt+N / Shift+Alt+P do not hop", () => {
    expect(
      matchMessageHopKey({ ...base, option: true, shift: true, name: "n" }),
    ).toBeNull()
    expect(
      matchMessageHopKey({ ...base, option: true, shift: true, name: "p" }),
    ).toBeNull()
  })

  it("Cmd-mapped meta / super combos do not hop", () => {
    expect(matchMessageHopKey({ ...base, meta: true, name: "n" })).toBeNull()
    expect(matchMessageHopKey({ ...base, super: true, name: "p" })).toBeNull()
  })

  it("Alt+other-letter does not hop", () => {
    expect(matchMessageHopKey({ ...base, option: true, name: "j" })).toBeNull()
    expect(matchMessageHopKey({ ...base, option: true, name: "k" })).toBeNull()
    expect(matchMessageHopKey({ ...base, option: true, name: "f" })).toBeNull()
    expect(matchMessageHopKey({ ...base, option: true, name: "b" })).toBeNull()
    expect(matchMessageHopKey({ ...base, option: true, name: "d" })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// pickMessageHopTarget
// ---------------------------------------------------------------------------

describe("pickMessageHopTarget", () => {
  // Conversation: messages at y=0, 20, 50, 100. Viewport top is the
  // current scroll position (after add'l offset for the scrollbox header).
  const anchors = [0, 20, 50, 100]

  it("Alt+N from the very top jumps to the second message", () => {
    expect(pickMessageHopTarget(anchors, 0, "next")).toEqual({
      kind: "anchor",
      y: 20,
    })
  })

  it("Alt+N mid-conversation jumps to the next anchor below", () => {
    expect(pickMessageHopTarget(anchors, 20, "next")).toEqual({
      kind: "anchor",
      y: 50,
    })
  })

  it("Alt+N when viewport sits between two anchors picks the next one", () => {
    expect(pickMessageHopTarget(anchors, 35, "next")).toEqual({
      kind: "anchor",
      y: 50,
    })
  })

  it("Alt+N at the last message reports edge (caller scrolls to bottom)", () => {
    expect(pickMessageHopTarget(anchors, 100, "next")).toEqual({ kind: "edge" })
  })

  it("Alt+N past the last message reports edge", () => {
    expect(pickMessageHopTarget(anchors, 200, "next")).toEqual({ kind: "edge" })
  })

  it("Alt+P from the bottom jumps to the previous anchor", () => {
    expect(pickMessageHopTarget(anchors, 100, "prev")).toEqual({
      kind: "anchor",
      y: 50,
    })
  })

  it("Alt+P mid-conversation jumps to the anchor above", () => {
    expect(pickMessageHopTarget(anchors, 50, "prev")).toEqual({
      kind: "anchor",
      y: 20,
    })
  })

  it("Alt+P when viewport sits between two anchors picks the previous one", () => {
    expect(pickMessageHopTarget(anchors, 35, "prev")).toEqual({
      kind: "anchor",
      y: 20,
    })
  })

  it("Alt+P at the first message reports edge (caller scrolls to top)", () => {
    expect(pickMessageHopTarget(anchors, 0, "prev")).toEqual({ kind: "edge" })
  })

  it("Alt+P above the first message reports edge", () => {
    // Possible if the viewport is showing the header bar (y < 0 isn't
    // physically possible in our scrollbox, but exact-zero is the sentinel).
    expect(pickMessageHopTarget(anchors, 0, "prev")).toEqual({ kind: "edge" })
  })

  it("empty conversation returns null (no-op)", () => {
    expect(pickMessageHopTarget([], 0, "next")).toBeNull()
    expect(pickMessageHopTarget([], 100, "prev")).toBeNull()
  })

  it("single message: Alt+N edges, Alt+P edges", () => {
    expect(pickMessageHopTarget([42], 42, "next")).toEqual({ kind: "edge" })
    expect(pickMessageHopTarget([42], 42, "prev")).toEqual({ kind: "edge" })
  })

  it("single message: Alt+N from above lands on it, Alt+P from below lands on it", () => {
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
    // The viewport already has anchor y=20 at its top — Alt+N must skip past
    // it to y=50, not re-target itself.
    expect(pickMessageHopTarget(anchors, 20, "next")).toEqual({
      kind: "anchor",
      y: 50,
    })
    // Symmetric: Alt+P from y=20 jumps up, not back to itself.
    expect(pickMessageHopTarget(anchors, 20, "prev")).toEqual({
      kind: "anchor",
      y: 0,
    })
  })
})
