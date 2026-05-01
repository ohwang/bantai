/**
 * Public entry point for the bantai-internal LLM service.
 *
 * Callers use `complete()` for adhoc LLM calls (summaries, titles, recaps,
 * compaction). The provider is resolved in this order:
 *
 *   1. `opts.config` passed by the caller (highest priority).
 *   2. `BantaiConfig.llm` from settings (project / global / claude).
 *   3. Implicit Codex OAuth fallback if `~/.codex/auth.json` exists in
 *      ChatGPT mode — so users who already use the codex backend get LLM
 *      calls "for free" without any extra setup.
 *
 * If none of the above resolves, throws `LlmNotConfiguredError`.
 *
 * Usage:
 *
 *   import { complete } from "../../services/llm"
 *
 *   const { text } = await complete({
 *     system: "Generate a short title for this conversation.",
 *     prompt: lastUserMessage,
 *     maxOutputTokens: 32,
 *   })
 */

import { resolveLlmConfig } from "./config"
import { callCodexOauth } from "./providers/codex-oauth"
import { callGemini } from "./providers/gemini"
import { callOpenAICompat } from "./providers/openai-compat"
import {
  LlmNotConfiguredError,
  type LlmProviderConfig,
  type LlmRequest,
  type LlmResponse,
} from "./types"

export type {
  CodexOauthConfig,
  GeminiConfig,
  LlmMessage,
  LlmProviderConfig,
  LlmProviderId,
  LlmRequest,
  LlmResponse,
  LlmRole,
  LlmUsage,
  OpenAICompatConfig,
} from "./types"
export {
  LlmAuthError,
  LlmNotConfiguredError,
  LlmRequestError,
} from "./types"
export {
  knownLlmProviderIds,
  isKnownLlmProviderId,
  getLlmProviderDescriptor,
  listLlmProvidersForCli,
  LLM_PROVIDERS,
} from "./registry"

export interface CompleteOptions {
  /** Explicit provider config — overrides settings + auto-detection. */
  config?: LlmProviderConfig
}

/**
 * Run a single LLM completion. Throws:
 *   - `LlmNotConfiguredError` if no provider can be resolved.
 *   - `LlmAuthError` for credential / token issues (re-login required).
 *   - `LlmRequestError` for everything else.
 */
export async function complete(
  request: LlmRequest,
  opts: CompleteOptions = {},
): Promise<LlmResponse> {
  const config = opts.config ?? (await resolveLlmConfig())
  if (!config) {
    throw new LlmNotConfiguredError(
      "No LLM provider configured. Set one via `bantai` settings (`llm` key), or run `codex login` so we can use ChatGPT OAuth automatically.",
    )
  }
  return await dispatch(config, request)
}

async function dispatch(
  config: LlmProviderConfig,
  request: LlmRequest,
): Promise<LlmResponse> {
  switch (config.kind) {
    case "codex-oauth":
      return await callCodexOauth(config, request)
    case "openai-compat":
      return await callOpenAICompat(config, request)
    case "gemini":
      return await callGemini(config, request)
    default: {
      // Exhaustive check — TypeScript will fail this branch if a new
      // provider is added to LlmProviderConfig but not wired here. This is
      // exactly the drift-contract recipe in CLAUDE.md ("switches that need
      // exhaustiveness become Record<X, V> or exhaustive switches").
      const _exhaustive: never = config
      throw new Error(`unhandled LLM provider config: ${JSON.stringify(_exhaustive)}`)
    }
  }
}
