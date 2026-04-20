/**
 * Model metadata — single source of truth for model display names and context windows.
 *
 * Consumed by header-bar, conversation, and status-bar components.
 */

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
}

export const DEFAULT_CONTEXT_WINDOW = 200_000

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

/** Convert backend capability name to a user-facing brand name */
export function friendlyBackendName(backendName: string): string {
  if (backendName.startsWith("claude")) return "Claude"
  if (backendName === "gemini") return "Gemini"
  if (backendName === "copilot") return "GitHub Copilot"
  if (backendName === "codex") return "Codex"
  if (backendName === "mock") return "Mock"
  if (backendName === "acp") return "ACP agent"
  return "the assistant"
}
