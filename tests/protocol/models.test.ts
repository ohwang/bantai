/**
 * Tests for `src/protocol/models.ts` — the single source of truth for model
 * display names and context windows.
 */

import { describe, expect, it } from "bun:test"
import {
  MODEL_NAMES,
  MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  findCurrentModel,
  friendlyModelName,
  modelContextWindow,
  resolveContextWindow,
} from "../../src/protocol/models"
import type { ModelInfo } from "../../src/protocol/types"

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

describe("resolveContextWindow", () => {
  it("prefers the live model.contextWindow when set (Codex 0.122+ / Qwen _meta.contextLimit)", () => {
    const model = { id: "auto-gemini-3", name: "Gemini 3 (Auto)", contextWindow: 750_000 }
    // Even when the table has a different value for the id (1M),
    // the live cap from the backend wins.
    expect(resolveContextWindow(model, "Gemini 3 (Auto)")).toBe(750_000)
  })

  it("falls back to the model.id when the display name doesn't match the table", () => {
    // Regression: Gemini ACP reports `id: "auto-gemini-3"` and
    // `name: "Gemini 3 (Auto)"`; `state.currentModel` carries the name,
    // which the table doesn't key on. Without an id-aware fallback the
    // status bar shows DEFAULT_CONTEXT_WINDOW (200K) and the % math is 5x
    // too high.
    const model = { id: "auto-gemini-3", name: "Gemini 3 (Auto)" }
    expect(resolveContextWindow(model, "Gemini 3 (Auto)")).toBe(1_000_000)
  })

  it("falls back to the raw display key when neither model.contextWindow nor model.id resolve", () => {
    const model = { id: "unknown-foo", name: "claude-opus-4-7" }
    // model.id misses; the raw lookup hits the canonical table.
    expect(resolveContextWindow(model, "claude-opus-4-7")).toBe(1_000_000)
  })

  it("returns DEFAULT_CONTEXT_WINDOW when nothing matches", () => {
    expect(resolveContextWindow(undefined, "")).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(resolveContextWindow({ id: "made-up", name: "made-up" }, "")).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it("treats a zero/negative model.contextWindow as missing (not a real cap)", () => {
    const model = { id: "auto-gemini-3", name: "Gemini 3 (Auto)", contextWindow: 0 }
    // Should fall through to the id lookup, not multiply by zero downstream.
    expect(resolveContextWindow(model, "Gemini 3 (Auto)")).toBe(1_000_000)
  })
})

describe("findCurrentModel", () => {
  // Realistic Qwen Code 0.15.x payload — three configured models, the live
  // one is `[1]` (NOT `[0]`). This is the exact shape that broke the status
  // bar: `models[0]` (coder-model, 1M ctx) hijacked the % math even though
  // the user was running the local 262K qwen3.6 model.
  const QWEN_MODELS: ModelInfo[] = [
    { id: "coder-model(qwen-oauth)", name: "coder-model", provider: "qwen", contextWindow: 1_000_000 },
    { id: "qwen/qwen3.6-35b-a3b(openai)", name: "Qwen3.6 35B-A3B (LM Studio, local)", provider: "qwen", contextWindow: 262_144 },
    { id: "openai/gpt-oss-20b(openai)", name: "GPT-OSS 20B (LM Studio, local)", provider: "qwen", contextWindow: 32_768 },
  ]

  it("returns the model whose id matches `currentModel` even when it isn't first", () => {
    // Critical regression: this is the bug we shipped this fix for.
    const model = findCurrentModel(QWEN_MODELS, "qwen/qwen3.6-35b-a3b(openai)")
    expect(model?.id).toBe("qwen/qwen3.6-35b-a3b(openai)")
    expect(model?.contextWindow).toBe(262_144)
  })

  it("falls back to a name match when `currentModel` is the display name", () => {
    // Some surfaces (header-bar's `state.currentModel`) carry the **name**
    // rather than the id — `findCurrentModel` must accept both.
    const model = findCurrentModel(QWEN_MODELS, "GPT-OSS 20B (LM Studio, local)")
    expect(model?.id).toBe("openai/gpt-oss-20b(openai)")
    expect(model?.contextWindow).toBe(32_768)
  })

  it("falls back to `models[0]` when `currentModel` is null (pre-session_init)", () => {
    // Before session_init lands, `state.currentModel` is null — preserve the
    // historical behaviour of "best guess = first reported model".
    const model = findCurrentModel(QWEN_MODELS, null)
    expect(model?.id).toBe("coder-model(qwen-oauth)")
  })

  it("falls back to `models[0]` when `currentModel` matches nothing in the list", () => {
    // Defensive: a stale `currentModel` (left over from a previous backend)
    // shouldn't crash — fall through to the first reported model.
    const model = findCurrentModel(QWEN_MODELS, "deleted-model")
    expect(model?.id).toBe("coder-model(qwen-oauth)")
  })

  it("returns undefined when the model list is empty or undefined", () => {
    expect(findCurrentModel(undefined, "anything")).toBeUndefined()
    expect(findCurrentModel([], "anything")).toBeUndefined()
  })

  it("prefers id-match over name-match when both are present", () => {
    // Shouldn't happen in practice (id ≠ name across distinct entries) but
    // pin the deterministic behaviour: id wins so behaviour matches the
    // adapter's `currentModelId` semantic.
    const models: ModelInfo[] = [
      { id: "alpha", name: "Beta", provider: "x" },
      { id: "Beta", name: "Gamma", provider: "x" },
    ]
    expect(findCurrentModel(models, "Beta")?.id).toBe("Beta")
  })
})
