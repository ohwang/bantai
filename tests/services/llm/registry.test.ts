import { describe, expect, it } from "bun:test"

import { parseLlmConfigCandidate } from "../../../src/services/llm/config"
import {
  isKnownLlmProviderId,
  knownLlmProviderIds,
  LLM_PROVIDERS,
  listLlmProvidersForCli,
} from "../../../src/services/llm/registry"
import type { LlmProviderId } from "../../../src/services/llm/types"

describe("LLM provider registry", () => {
  it("LLM_PROVIDERS, knownLlmProviderIds and the LlmProviderId union agree", () => {
    const ids = LLM_PROVIDERS.map((p) => p.id)
    expect(knownLlmProviderIds()).toEqual(ids)
    // Compile-time check: the descriptor ids satisfy LlmProviderId. A typo
    // in either the registry or the union shows up here at compile time.
    const _check: LlmProviderId[] = [...ids]
    expect(_check).toEqual(ids)
  })

  it("isKnownLlmProviderId narrows correctly", () => {
    expect(isKnownLlmProviderId("codex-oauth")).toBe(true)
    expect(isKnownLlmProviderId("openai-compat")).toBe(true)
    expect(isKnownLlmProviderId("gemini")).toBe(true)
    expect(isKnownLlmProviderId("not-real")).toBe(false)
    expect(isKnownLlmProviderId("")).toBe(false)
  })

  it("listLlmProvidersForCli reflects the registry order", () => {
    expect(listLlmProvidersForCli()).toBe(knownLlmProviderIds().join(", "))
  })
})

describe("parseLlmConfigCandidate", () => {
  it("returns null for missing/non-object input", () => {
    expect(parseLlmConfigCandidate(undefined)).toBeNull()
    expect(parseLlmConfigCandidate(null)).toBeNull()
    expect(parseLlmConfigCandidate("hello")).toBeNull()
    expect(parseLlmConfigCandidate([])).toBeNull()
  })

  it("returns null for an unknown kind", () => {
    expect(parseLlmConfigCandidate({ kind: "claude" })).toBeNull()
    expect(parseLlmConfigCandidate({})).toBeNull()
  })

  it("accepts a minimal codex-oauth config", () => {
    const cfg = parseLlmConfigCandidate({ kind: "codex-oauth" })
    expect(cfg).toEqual({ kind: "codex-oauth" })
  })

  it("accepts a codex-oauth config with defaultModel", () => {
    const cfg = parseLlmConfigCandidate({ kind: "codex-oauth", defaultModel: "gpt-5" })
    expect(cfg).toEqual({ kind: "codex-oauth", defaultModel: "gpt-5" })
  })

  it("rejects openai-compat without baseUrl", () => {
    expect(parseLlmConfigCandidate({ kind: "openai-compat" })).toBeNull()
    expect(parseLlmConfigCandidate({ kind: "openai-compat", baseUrl: "" })).toBeNull()
  })

  it("accepts openai-compat with baseUrl + extras", () => {
    const cfg = parseLlmConfigCandidate({
      kind: "openai-compat",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "sk-x",
      defaultModel: "qwen2.5-coder",
      headers: { "HTTP-Referer": "https://bantai.dev", bad: 5 },
    })
    expect(cfg).toEqual({
      kind: "openai-compat",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "sk-x",
      defaultModel: "qwen2.5-coder",
      headers: { "HTTP-Referer": "https://bantai.dev" },
    })
  })

  it("rejects gemini without apiKey", () => {
    expect(parseLlmConfigCandidate({ kind: "gemini" })).toBeNull()
    expect(parseLlmConfigCandidate({ kind: "gemini", apiKey: "" })).toBeNull()
  })

  it("accepts gemini with apiKey + defaultModel", () => {
    const cfg = parseLlmConfigCandidate({
      kind: "gemini",
      apiKey: "ABC",
      defaultModel: "gemini-2.5-pro",
    })
    expect(cfg).toEqual({
      kind: "gemini",
      apiKey: "ABC",
      defaultModel: "gemini-2.5-pro",
    })
  })
})
