/**
 * Smoke test for matchScrollKey — the pure helper that maps keyboard events
 * to a conversation-scroll direction. Covers both Ctrl+Up/Down (arrow) and
 * Alt+K/J (vim home-row) bindings, and confirms unrelated keys don't trigger.
 *
 * Tests the helper directly so we don't have to boot OpenTUI just to verify
 * the keymap. The companion logic in conversation.tsx (preventDefault,
 * scrollBy step size, setScrolledAway / isNearBottom bookkeeping) is shared
 * by both binding pairs, so once matchScrollKey returns the right direction
 * the rest is parity-by-construction.
 */

import { describe, expect, it } from "bun:test"
import { matchScrollKey } from "../../src/frontends/tui/components/conversation"

type Ev = Parameters<typeof matchScrollKey>[0]

const base: Ev = {
  name: "",
  ctrl: false,
  option: false,
  meta: false,
  super: false,
  shift: false,
}

describe("matchScrollKey", () => {
  it("Ctrl+Up scrolls up", () => {
    expect(matchScrollKey({ ...base, ctrl: true, name: "up" })).toBe("up")
  })

  it("Ctrl+Down scrolls down", () => {
    expect(matchScrollKey({ ...base, ctrl: true, name: "down" })).toBe("down")
  })

  it("Alt+K scrolls up (vim home-row)", () => {
    expect(matchScrollKey({ ...base, option: true, name: "k" })).toBe("up")
  })

  it("Alt+J scrolls down (vim home-row)", () => {
    expect(matchScrollKey({ ...base, option: true, name: "j" })).toBe("down")
  })

  it("plain j / k (no modifier) do not scroll — they reach the textarea", () => {
    expect(matchScrollKey({ ...base, name: "j" })).toBeNull()
    expect(matchScrollKey({ ...base, name: "k" })).toBeNull()
  })

  it("plain Up / Down arrows do not scroll — input history binding", () => {
    expect(matchScrollKey({ ...base, name: "up" })).toBeNull()
    expect(matchScrollKey({ ...base, name: "down" })).toBeNull()
  })

  it("Ctrl+J / Ctrl+K do not scroll (LF / kill-line collisions)", () => {
    expect(matchScrollKey({ ...base, ctrl: true, name: "j" })).toBeNull()
    expect(matchScrollKey({ ...base, ctrl: true, name: "k" })).toBeNull()
  })

  it("Shift+Ctrl+Up / Shift+Alt+K do not scroll", () => {
    expect(
      matchScrollKey({ ...base, ctrl: true, shift: true, name: "up" }),
    ).toBeNull()
    expect(
      matchScrollKey({ ...base, option: true, shift: true, name: "k" }),
    ).toBeNull()
  })

  it("Cmd-mapped meta / super combos do not scroll", () => {
    expect(matchScrollKey({ ...base, meta: true, name: "up" })).toBeNull()
    expect(matchScrollKey({ ...base, super: true, name: "j" })).toBeNull()
  })

  it("Alt+other-letter does not scroll", () => {
    expect(matchScrollKey({ ...base, option: true, name: "h" })).toBeNull()
    expect(matchScrollKey({ ...base, option: true, name: "l" })).toBeNull()
  })
})
