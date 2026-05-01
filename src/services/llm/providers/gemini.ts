/**
 * Google Gemini provider — Google AI Studio (`generativelanguage.googleapis.com`).
 *
 * Wire format (generateContent, non-streaming):
 *   POST {baseUrl}/v1beta/models/{model}:generateContent?key={apiKey}
 *   {
 *     "systemInstruction": { "parts": [{ "text": "..." }] },
 *     "contents": [
 *       { "role": "user" | "model", "parts": [{ "text": "..." }] },
 *       ...
 *     ],
 *     "generationConfig": { "maxOutputTokens": ..., "temperature": ... }
 *   }
 *
 * Returns:
 *   {
 *     "candidates": [
 *       { "content": { "role": "model", "parts": [{ "text": "..." }] } }
 *     ],
 *     "usageMetadata": { "promptTokenCount": ..., "candidatesTokenCount": ... }
 *   }
 */

import { log } from "../../../utils/logger"
import {
  LlmAuthError,
  LlmRequestError,
  type GeminiConfig,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
} from "../types"

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"
const DEFAULT_MODEL = "gemini-2.5-flash"

export async function callGemini(
  config: GeminiConfig,
  request: LlmRequest,
): Promise<LlmResponse> {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new LlmAuthError(
      "gemini: missing apiKey in config (get one from https://aistudio.google.com/apikey)",
      "gemini",
    )
  }

  const baseUrl = trimSlash(config.baseUrl?.trim() || DEFAULT_BASE_URL)
  const model = request.model || config.defaultModel || DEFAULT_MODEL
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`
  const body = buildRequestBody(request)

  log.debug("gemini: dispatching", {
    url,
    model,
    contentCount: body.contents.length,
  })

  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // Gemini accepts the API key as a query string OR as `x-goog-api-key`.
        // The header form keeps the key out of access logs.
        "x-goog-api-key": config.apiKey,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    })
  } catch (err) {
    throw new LlmRequestError(
      `gemini: network error talking to ${url}: ${(err as Error).message}`,
      "gemini",
    )
  }

  if (!res.ok) {
    const text = await safeReadText(res)
    if (res.status === 401 || res.status === 403) {
      throw new LlmAuthError(
        `gemini: ${res.status} from ${url}. Check your apiKey.${text ? ` Server said: ${truncate(text)}` : ""}`,
        "gemini",
      )
    }
    throw new LlmRequestError(
      `gemini: ${res.status} from ${url}: ${truncate(text)}`,
      "gemini",
      res.status,
    )
  }

  const json = (await res.json().catch((err) => {
    throw new LlmRequestError(
      `gemini: response is not JSON: ${(err as Error).message}`,
      "gemini",
      res.status,
    )
  })) as GeminiBody

  return parseGeminiBody(json, model)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface GeminiRequestBody {
  systemInstruction?: { parts: Array<{ text: string }> }
  contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>
  generationConfig?: {
    maxOutputTokens?: number
    temperature?: number
  }
}

function buildRequestBody(request: LlmRequest): GeminiRequestBody {
  const flat = flattenMessages(request)

  const systemTexts = flat.filter((m) => m.role === "system").map((m) => m.content)
  const systemInstruction =
    systemTexts.length > 0
      ? { parts: systemTexts.map((text) => ({ text })) }
      : undefined

  const contents = flat
    .filter((m) => m.role !== "system")
    .map((m) => ({
      // Gemini uses "model" instead of "assistant".
      role: (m.role === "assistant" ? "model" : "user") as "user" | "model",
      parts: [{ text: m.content }],
    }))

  const body: GeminiRequestBody = { systemInstruction, contents }
  if (request.maxOutputTokens !== undefined || request.temperature !== undefined) {
    body.generationConfig = {}
    if (request.maxOutputTokens !== undefined) body.generationConfig.maxOutputTokens = request.maxOutputTokens
    if (request.temperature !== undefined) body.generationConfig.temperature = request.temperature
  }
  return body
}

function flattenMessages(request: LlmRequest): LlmMessage[] {
  const out: LlmMessage[] = []
  if (request.system) out.push({ role: "system", content: request.system })
  if (request.messages) out.push(...request.messages)
  if (request.prompt) out.push({ role: "user", content: request.prompt })
  if (out.length === 0) {
    throw new LlmRequestError(
      "gemini: empty request — provide at least one of system/prompt/messages",
      "gemini",
    )
  }
  return out
}

interface GeminiBody {
  candidates?: Array<{
    content?: { role?: string; parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  promptFeedback?: { blockReason?: string }
}

function parseGeminiBody(body: GeminiBody, model: string): LlmResponse {
  if (body.promptFeedback?.blockReason) {
    throw new LlmRequestError(
      `gemini: prompt blocked (${body.promptFeedback.blockReason})`,
      "gemini",
    )
  }
  const parts = body.candidates?.[0]?.content?.parts ?? []
  const text = parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
  const usage: LlmUsage | undefined = body.usageMetadata
    ? {
        inputTokens: body.usageMetadata.promptTokenCount,
        outputTokens: body.usageMetadata.candidatesTokenCount,
        raw: body.usageMetadata as Record<string, unknown>,
      }
    : undefined
  return { text, provider: "gemini", model, usage }
}

function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

function truncate(s: string, max = 500): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…(+${s.length - max} bytes)`
}
