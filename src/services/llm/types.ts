/**
 * Types for the bantai-internal LLM service.
 *
 * The service exposes a small, provider-agnostic API for adhoc LLM calls
 * (session summaries, titles, recaps, history compaction). Streaming, tool
 * use and multi-modal are intentionally NOT in V1 — when a caller needs
 * them, it should either grow this surface or talk to the provider directly.
 *
 * The shape mirrors the OpenAI Chat Completions / Responses request — that's
 * the lowest-common-denominator across the providers we plug in.
 */

export type LlmRole = "system" | "user" | "assistant"

export interface LlmMessage {
  role: LlmRole
  content: string
}

export interface LlmRequest {
  /** Optional system prompt, prepended before `messages`. */
  system?: string
  /** Optional shorthand for a single user message. Combined with `messages`. */
  prompt?: string
  /** Explicit conversation. `system` and `prompt` are folded in if present. */
  messages?: LlmMessage[]
  /** Model id understood by the resolved provider. Falls back to the provider's default. */
  model?: string
  /** Soft cap on output tokens. Provider will clamp to its own limits. */
  maxOutputTokens?: number
  /** 0..2 sampling temperature. Provider may ignore for reasoning models. */
  temperature?: number
  /** Caller-provided abort signal. The provider passes it to `fetch`. */
  signal?: AbortSignal
}

export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
  /** Provider-specific extras (cached input tokens, reasoning tokens, …). Opaque. */
  raw?: Record<string, unknown>
}

export interface LlmResponse {
  /** The assistant's text response. Empty string is permitted (some refusals). */
  text: string
  /** The provider id that produced this response (matches `LlmProviderId`). */
  provider: LlmProviderId
  /** The model id the provider actually used. */
  model: string
  usage?: LlmUsage
}

/** Closed enumeration — keep in sync with `LLM_PROVIDERS` in `registry.ts`. */
export type LlmProviderId = "codex-oauth" | "openai-compat" | "gemini"

/**
 * Configuration tagged by provider id. `LlmProviderConfig` is what the
 * service stores in settings and passes to a provider adapter.
 *
 * Codex-OAuth has no extra config — credentials live in `~/.codex/auth.json`,
 * managed by the `codex` CLI.
 */
export type LlmProviderConfig =
  | CodexOauthConfig
  | OpenAICompatConfig
  | GeminiConfig

export interface CodexOauthConfig {
  kind: "codex-oauth"
  /** Default model when a request omits it. */
  defaultModel?: string
}

export interface OpenAICompatConfig {
  kind: "openai-compat"
  /**
   * Base URL of the API. e.g.
   *   - OpenAI:    "https://api.openai.com/v1"
   *   - LM Studio: "http://localhost:1234/v1"
   *   - OpenRouter:"https://openrouter.ai/api/v1"
   * Trailing slash optional.
   */
  baseUrl: string
  /** Bearer token. Some local servers (LM Studio with auth disabled) don't need one. */
  apiKey?: string
  /** Default model when a request omits it. */
  defaultModel?: string
  /** Extra headers (e.g. OpenRouter's `HTTP-Referer`). */
  headers?: Record<string, string>
}

export interface GeminiConfig {
  kind: "gemini"
  /** Google AI Studio API key. */
  apiKey: string
  /** Optional override; defaults to the standard public endpoint. */
  baseUrl?: string
  /** Default model when a request omits it. */
  defaultModel?: string
}

/** Thrown when no provider is configured and the caller hasn't supplied one. */
export class LlmNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LlmNotConfiguredError"
  }
}

/** Thrown when a provider's auth is bad / expired (e.g. Codex token expired). */
export class LlmAuthError extends Error {
  constructor(
    message: string,
    /** The provider id that produced the error. */
    readonly provider: LlmProviderId,
  ) {
    super(message)
    this.name = "LlmAuthError"
  }
}

/** Thrown for any non-auth provider failure (bad model, rate limit, network). */
export class LlmRequestError extends Error {
  constructor(
    message: string,
    readonly provider: LlmProviderId,
    /** HTTP status, when the failure came from an HTTP response. */
    readonly status?: number,
  ) {
    super(message)
    this.name = "LlmRequestError"
  }
}
