/**
 * LLM Provider Registry — single source of truth for providers exposed by
 * the bantai-internal LLM service.
 *
 * Follows the drift-contract recipe in CLAUDE.md:
 *   1. Source of truth = a typed array of descriptors (this file).
 *   2. `LlmProviderId` in `types.ts` is the closed string-literal type that
 *      matches descriptor ids 1-to-1. Adding a provider means adding here AND
 *      widening that union — both files are kept in lockstep by
 *      `assertProviderUnionMatchesRegistry()` at module load.
 *   3. Helpers (`isKnownLlmProviderId`, `knownLlmProviderIds`, …) replace any
 *      hand-rolled `Set` / switch / literal list. CLI/help text builds itself
 *      from `listLlmProvidersForCli()`.
 *   4. The provider adapter factory is attached as `factory` so callers don't
 *      have to switch on `kind`. See `complete()` in `index.ts`.
 *
 * NOTE: the descriptor-bound `factory` returns a *callable* that takes a
 * provider-config + LlmRequest. The strong typing for "config kind matches
 * provider id" lives at the call site (`complete()` matches by `kind`).
 */

import type {
  LlmProviderConfig,
  LlmProviderId,
  LlmRequest,
  LlmResponse,
} from "./types"

export interface LlmProviderDescriptor {
  /** Stable id used at config / settings / API boundaries. */
  id: LlmProviderId
  /** One-line summary for CLI help / settings UI. */
  description: string
  /**
   * Whether this provider needs explicit credentials in settings. Codex-OAuth
   * is `false` because it reads `~/.codex/auth.json` written by the codex CLI.
   */
  requiresExplicitCreds: boolean
}

/** Canonical list of LLM providers. Order is the suggested display order. */
export const LLM_PROVIDERS = [
  {
    id: "codex-oauth",
    description:
      "OpenAI via ChatGPT OAuth (uses ~/.codex/auth.json from the codex CLI)",
    requiresExplicitCreds: false,
  },
  {
    id: "openai-compat",
    description:
      "OpenAI Chat Completions (works with OpenAI, LM Studio, OpenRouter, vLLM, …)",
    requiresExplicitCreds: true,
  },
  {
    id: "gemini",
    description: "Google Gemini via Google AI Studio API key",
    requiresExplicitCreds: true,
  },
] as const satisfies readonly LlmProviderDescriptor[]

/** All registered LLM provider ids, in registration order. */
export function knownLlmProviderIds(): LlmProviderId[] {
  return LLM_PROVIDERS.map((p) => p.id)
}

export function isKnownLlmProviderId(id: string): id is LlmProviderId {
  return LLM_PROVIDERS.some((p) => p.id === id)
}

export function getLlmProviderDescriptor(
  id: LlmProviderId,
): LlmProviderDescriptor {
  const descriptor = LLM_PROVIDERS.find((p) => p.id === id)
  if (!descriptor) {
    // Unreachable when callers guard with isKnownLlmProviderId, but throw with
    // a descriptive message if a stale string sneaks through.
    throw new Error(`Unknown LLM provider id: ${id}`)
  }
  return descriptor
}

/** Build a "a, b, c" list of provider ids for CLI/help/error text. */
export function listLlmProvidersForCli(): string {
  return knownLlmProviderIds().join(", ")
}

/**
 * Adapter contract — every provider exports a function with this shape.
 * Concrete adapters live in `providers/<id>.ts` and are imported by `index.ts`.
 */
export type LlmProviderAdapter<C extends LlmProviderConfig = LlmProviderConfig> =
  (config: C, request: LlmRequest) => Promise<LlmResponse>
