/**
 * Model metadata — single source of truth for model display names and context windows.
 *
 * Consumed by header-bar, conversation, and status-bar components.
 */

import { getBackendDescriptor } from "./registry"

/** Map raw API model IDs to friendly display names */
export const MODEL_NAMES: Record<string, string> = {
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-sonnet-4-5-20250514": "Sonnet 4.5",
  "claude-3-5-sonnet-20241022": "Sonnet 3.5",
  "claude-3-5-haiku-20241022": "Haiku 3.5",
  // Gemini 3.x (model IDs from Gemini CLI v0.37.0)
  "auto-gemini-3": "Gemini 3 (Auto)",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro (Preview)",
  "gemini-3-flash-preview": "Gemini 3 Flash (Preview)",
  "gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash-Lite (Preview)",
  // Gemini 2.5
  "auto-gemini-2.5": "Gemini 2.5 (Auto)",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash-Lite",
  // Copilot models
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "gpt-5-mini": "GPT-5 Mini",
  "gpt-4.1": "GPT-4.1",
  // OpenAI GPT-5.5 family (Codex default as of 2026-04-23)
  "gpt-5.5": "GPT-5.5",
  "gpt-5.5-pro": "GPT-5.5 Pro",
  "gpt-5-codex": "GPT-5 Codex",
  "gpt-5": "GPT-5",
}

/** Model context window sizes (in tokens) for context usage calculation.
 *
 * Gemini models: all 1M (1,048,576) per Vertex AI docs as of April 2026.
 * Claude models: Opus 1M, Sonnet/Haiku 200K per Anthropic docs.
 *
 * Note: ACP does not provide context window info in model metadata.
 * These are hardcoded fallbacks when the SDK doesn't report dynamically.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-5-20250514": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  // Gemini 3.x series
  "gemini-3.1-pro-preview": 1_000_000,
  "gemini-3-flash-preview": 1_000_000,
  "gemini-3.1-flash-lite-preview": 1_000_000,
  // Gemini 2.5 series
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.5-flash-lite": 1_000_000,
  // OpenAI GPT-5 family. GPT-5.5 ships with a 1M API context window;
  // when invoked through Codex the runtime caps it at 400K. We report the
  // API-side maximum so context-usage math stays consistent across surfaces
  // (Codex itself enforces its own ceiling internally).
  "gpt-5.5": 1_000_000,
  "gpt-5.5-pro": 1_000_000,
  "gpt-5-codex": 400_000,
  "gpt-5": 400_000,
}

export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Matches Claude Code alias context-window suffixes like `opus[1m]`,
 *  `claude-opus-4-7[200k]`, or the SDK's display variants `[1M context]` /
 *  `(1M context)`. Captured: numeric count and `K|M` unit. Kept in lockstep
 *  with the regex in `src/backends/claude/event-mapper.ts`. */
const CONTEXT_WINDOW_SUFFIX_RE = /[\[(](\d+)([KkMm])\s*(?:context|tokens?)?[\])]/

/** Resolve a model's context window in tokens.
 *
 * Lookup order:
 *   1. Direct hit in `MODEL_CONTEXT_WINDOWS` for the raw key.
 *   2. Claude Code alias suffix — `opus[1m]` / `[200k]` / `[1M context]` —
 *      parsed from the raw string. This matches Claude Code's `settings.json`
 *      convention and mirrors the parser in the Claude SDK event mapper, so
 *      the pre-`session_init` startup fallback agrees with the
 *      post-`session_init` value (no `(200K)` → `(1M)` flash).
 *   3. Suffix-stripped lookup (e.g. `claude-opus-4-7[1m]` with no `[1m]`
 *      entry → fall back to `claude-opus-4-7`'s entry).
 *   4. `fallback` (defaults to `DEFAULT_CONTEXT_WINDOW`).
 */
export function modelContextWindow(
  rawModel: string,
  fallback: number = DEFAULT_CONTEXT_WINDOW,
): number {
  if (!rawModel) return fallback

  const direct = MODEL_CONTEXT_WINDOWS[rawModel]
  if (typeof direct === "number") return direct

  const suffixMatch = rawModel.match(CONTEXT_WINDOW_SUFFIX_RE)
  if (suffixMatch) {
    const num = parseInt(suffixMatch[1]!, 10)
    const unit = suffixMatch[2]!.toUpperCase()
    if (Number.isFinite(num) && num > 0) {
      return unit === "M" ? num * 1_000_000 : num * 1_000
    }
  }

  const stripped = rawModel
    .replace(/\s*[\[(]\d+[KkMm]\s*(?:context|tokens?)?[\])]\s*$/, "")
    .trim()
  if (stripped && stripped !== rawModel) {
    const fromStripped = MODEL_CONTEXT_WINDOWS[stripped]
    if (typeof fromStripped === "number") return fromStripped
  }

  return fallback
}

/** Short aliases used by Claude Code's settings (e.g., "opus", "sonnet", "haiku").
 *
 * Policy: aliases track the latest shipped version, matching Anthropic's API
 * convention where bare `opus`/`sonnet`/`haiku` resolve to the newest model in
 * the family. When a new version ships (e.g. Opus 4.7), bump the alias here
 * rather than pinning users to the previous release.
 */
const MODEL_ALIASES: Record<string, string> = {
  "opus": "Opus 4.7",
  "sonnet": "Sonnet 4.6",
  "haiku": "Haiku 4.5",
}

/** Convert raw model IDs to friendly display names, stripping "Claude " prefix as fallback */
export function friendlyModelName(name: string): string {
  if (MODEL_NAMES[name]) return MODEL_NAMES[name]
  if (MODEL_ALIASES[name]) return MODEL_ALIASES[name]
  // Strip context-window suffixes from Claude Code aliases: "opus[1m]" → "opus"
  const stripped = name.replace(/\[\d+[mMkK]\]$/, "")
  if (stripped !== name) {
    if (MODEL_NAMES[stripped]) return MODEL_NAMES[stripped]
    if (MODEL_ALIASES[stripped]) return MODEL_ALIASES[stripped]
  }
  return name.replace(/^[Cc]laude\s+/, "")
}

/**
 * Convert a backend capability name to a user-facing brand name.
 *
 * Looks up `BackendDescriptor.displayName` from the registry so adding a new
 * backend doesn't require touching this file. The `claude*` prefix is
 * special-cased because Claude reports versioned capability names
 * (`claude-v1`, `claude-v2`, …) but they all map to the same brand.
 */
export function friendlyBackendName(backendName: string): string {
  if (backendName.startsWith("claude")) return "Claude"
  return getBackendDescriptor(backendName)?.displayName ?? "the assistant"
}
