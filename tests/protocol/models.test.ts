/**
 * Tests for `src/protocol/models.ts` — the single source of truth for model
 * display names and context windows.
 */

import { describe, expect, it } from "bun:test"
import {
  MODEL_NAMES,
  MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  friendlyModelName,
  modelContextWindow,
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

describe("modelContextWindow", () => {
  it("returns the direct table value for known canonical IDs", () => {
    expect(modelContextWindow("claude-opus-4-7")).toBe(1_000_000)
    expect(modelContextWindow("claude-sonnet-4-6")).toBe(200_000)
  })

  it("parses Claude Code alias suffixes (e.g. 'opus[1m]') so the startup fallback agrees with session_init", () => {
    // Regression: before this lookup was added, `opus[1m]` only resolved
    // for the friendly name and the context-window lookup quietly fell
    // through to DEFAULT_CONTEXT_WINDOW (200K) — producing an
    // "Opus 4.7 (200K)" flash in the status bar at startup despite the
    // user explicitly opting into the 1M window.
    expect(modelContextWindow("opus[1m]")).toBe(1_000_000)
    expect(modelContextWindow("opus[1M]")).toBe(1_000_000)
    expect(modelContextWindow("claude-opus-4-7[1m]")).toBe(1_000_000)
    expect(modelContextWindow("claude-opus-4-7[200k]")).toBe(200_000)
  })

  it("parses the SDK's display-formatted suffix variants", () => {
    // These are the forms the Claude SDK init mapper handles too.
    expect(modelContextWindow("claude-opus-4-6 [1M context]")).toBe(1_000_000)
    expect(modelContextWindow("claude-opus-4-6 (1M context)")).toBe(1_000_000)
  })

  it("falls back to the suffix-stripped key when present", () => {
    // `claude-opus-4-6[200k]` → suffix wins (200K), not the table's 1M.
    // But `claude-opus-4-6[xyz]` (unparseable) → strips, table hit (1M).
    expect(modelContextWindow("claude-opus-4-6[200k]")).toBe(200_000)
  })

  it("returns the default fallback for unknown models", () => {
    expect(modelContextWindow("totally-made-up-model")).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(modelContextWindow("")).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it("honors a caller-provided fallback for unknown models", () => {
    expect(modelContextWindow("totally-made-up-model", 42)).toBe(42)
  })
})
