/**
 * Resolve an `LlmProviderConfig` from bantai settings + filesystem fallbacks.
 *
 * Priority (highest first):
 *   1. `BantaiConfig.llm` from settings (any scope — project / global / claude).
 *   2. Implicit Codex-OAuth fallback when `~/.codex/auth.json` exists.
 *
 * Returns `null` if nothing usable is found — the caller (typically
 * `complete()`) is responsible for turning that into `LlmNotConfiguredError`.
 *
 * The settings shape is permissive at parse time (we treat the file as a
 * black box because malformed settings should never crash bantai), and is
 * narrowed via the `LlmProviderConfig` discriminated union.
 *
 * Adding a new provider:
 *   1. Add a descriptor to `LLM_PROVIDERS` in `registry.ts`.
 *   2. Add a config branch to `LlmProviderConfig` in `types.ts`.
 *   3. Wire its adapter in the `dispatch()` switch in `index.ts`.
 *   4. Add a parse branch in `parseLlmConfigCandidate()` below.
 *   5. Run `tsc --noEmit` — exhaustiveness checks the dispatch switch and
 *      this file's `case` will both fail compilation if you forgot a step.
 */

import fs from "node:fs/promises"

import { loadConfig } from "../../config/settings"
import { log } from "../../utils/logger"
import { codexAuthPath } from "./codex-credentials"
import { isKnownLlmProviderId } from "./registry"
import type {
  CodexOauthConfig,
  GeminiConfig,
  LlmProviderConfig,
  OpenAICompatConfig,
} from "./types"

/**
 * Best-effort resolution. Never throws on malformed config or missing
 * fallbacks — returns `null` instead so the caller can surface a clean
 * `LlmNotConfiguredError`.
 */
export async function resolveLlmConfig(): Promise<LlmProviderConfig | null> {
  // 1. Settings first.
  try {
    const resolved = await loadConfig()
    const fromSettings = (resolved.values as Record<string, unknown>).llm
    const parsed = parseLlmConfigCandidate(fromSettings)
    if (parsed) return parsed
  } catch (err) {
    log.warn("llm: failed to load settings, falling back to auto-detect", {
      error: (err as Error).message,
    })
  }

  // 2. Implicit Codex OAuth — if the user has run `codex login`, use it.
  if (await fileExists(codexAuthPath())) {
    return { kind: "codex-oauth" } satisfies CodexOauthConfig
  }

  return null
}

/**
 * Validate an arbitrary value as an `LlmProviderConfig`. Returns `null` for
 * anything we don't recognize so a stale settings file can't poison startup.
 *
 * Exposed for tests + the future `/llm` slash command's settings validator.
 */
export function parseLlmConfigCandidate(value: unknown): LlmProviderConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const kind = obj.kind
  if (typeof kind !== "string" || !isKnownLlmProviderId(kind)) {
    if (typeof kind === "string") {
      log.warn("llm: unknown provider kind in settings, ignoring", { kind })
    }
    return null
  }

  switch (kind) {
    case "codex-oauth": {
      const cfg: CodexOauthConfig = { kind: "codex-oauth" }
      if (typeof obj.defaultModel === "string") cfg.defaultModel = obj.defaultModel
      return cfg
    }
    case "openai-compat": {
      if (typeof obj.baseUrl !== "string" || obj.baseUrl.trim().length === 0) {
        log.warn("llm: openai-compat config missing baseUrl, ignoring")
        return null
      }
      const cfg: OpenAICompatConfig = {
        kind: "openai-compat",
        baseUrl: obj.baseUrl,
      }
      if (typeof obj.apiKey === "string") cfg.apiKey = obj.apiKey
      if (typeof obj.defaultModel === "string") cfg.defaultModel = obj.defaultModel
      if (
        obj.headers &&
        typeof obj.headers === "object" &&
        !Array.isArray(obj.headers)
      ) {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(obj.headers as Record<string, unknown>)) {
          if (typeof v === "string") headers[k] = v
        }
        if (Object.keys(headers).length > 0) cfg.headers = headers
      }
      return cfg
    }
    case "gemini": {
      if (typeof obj.apiKey !== "string" || obj.apiKey.trim().length === 0) {
        log.warn("llm: gemini config missing apiKey, ignoring")
        return null
      }
      const cfg: GeminiConfig = { kind: "gemini", apiKey: obj.apiKey }
      if (typeof obj.baseUrl === "string") cfg.baseUrl = obj.baseUrl
      if (typeof obj.defaultModel === "string") cfg.defaultModel = obj.defaultModel
      return cfg
    }
    default: {
      // Exhaustive — see the recipe note in the file header.
      const _exhaustive: never = kind
      log.warn("llm: unhandled provider kind", { kind: _exhaustive })
      return null
    }
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
