/**
 * Tests for `src/protocol/models.ts` — the single source of truth for model
 * display names and context windows.
 */

import { describe, expect, it } from "bun:test"
import {
  MODEL_NAMES,
  MODEL_CONTEXT_WINDOWS,
  friendlyModelName,
} from "../../src/protocol/models"

describe("friendlyModelName", () => {
  it("maps claude-opus-4-6 to 'Opus 4.6'", () => {
    expect(friendlyModelName("claude-opus-4-6")).toBe("Opus 4.6")
  })

  it("maps claude-opus-4-7 to 'Opus 4.7'", () => {
    expect(friendlyModelName("claude-opus-4-7")).toBe("Opus 4.7")
  })

  it("resolves the bare 'opus' alias to the newest shipped Opus", () => {
    // Policy: the short alias tracks the latest shipped version so users
    // configuring `model: "opus"` render consistently with the Anthropic API.
    expect(friendlyModelName("opus")).toBe("Opus 4.7")
  })

  it("strips context-window suffixes on Claude Code aliases", () => {
    expect(friendlyModelName("opus[1m]")).toBe("Opus 4.7")
  })

  it("falls back to stripping the 'Claude ' prefix for unknown IDs", () => {
    expect(friendlyModelName("Claude Experimental")).toBe("Experimental")
  })
})

describe("MODEL_NAMES / MODEL_CONTEXT_WINDOWS coverage", () => {
  it("includes claude-opus-4-7 in both tables", () => {
    expect(MODEL_NAMES["claude-opus-4-7"]).toBe("Opus 4.7")
    expect(MODEL_CONTEXT_WINDOWS["claude-opus-4-7"]).toBe(1_000_000)
  })

  it("keeps claude-opus-4-6 listed alongside 4.7 (users can still select it)", () => {
    expect(MODEL_NAMES["claude-opus-4-6"]).toBe("Opus 4.6")
    expect(MODEL_CONTEXT_WINDOWS["claude-opus-4-6"]).toBe(1_000_000)
  })
})
