/**
 * OpenAI-compatible Chat Completions provider.
 *
 * Works with anything that implements the OpenAI `/chat/completions` shape:
 *   - OpenAI proper        (api.openai.com/v1)
 *   - LM Studio (local)    (localhost:1234/v1)
 *   - vLLM, llama.cpp, …   (custom baseUrl)
 *   - OpenRouter           (openrouter.ai/api/v1)
 *
 * V1 is non-streaming. Streaming is a future surface — when added, it lives
 * here behind the same call signature with an opt-in `stream: true` flag.
 */

import { log } from "../../../utils/logger"
import {
  LlmAuthError,
  LlmRequestError,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
  type OpenAICompatConfig,
} from "../types"

const DEFAULT_MODEL = "gpt-4o-mini"

export async function callOpenAICompat(
  config: OpenAICompatConfig,
  request: LlmRequest,
): Promise<LlmResponse> {
  if (!config.baseUrl || config.baseUrl.trim().length === 0) {
    throw new LlmRequestError(
      "openai-compat: missing baseUrl in config",
      "openai-compat",
    )
  }

  const url = `${trimSlash(config.baseUrl)}/chat/completions`
  const body = buildRequestBody(config, request)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(config.headers ?? {}),
  }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

  log.debug("openai-compat: dispatching", {
    url,
    model: body.model,
    messageCount: body.messages.length,
  })

  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    })
  } catch (err) {
    throw new LlmRequestError(
      `openai-compat: network error talking to ${url}: ${(err as Error).message}`,
      "openai-compat",
    )
  }

  if (!res.ok) {
    const text = await safeReadText(res)
    if (res.status === 401 || res.status === 403) {
      throw new LlmAuthError(
        `openai-compat: ${res.status} from ${url}. Check your apiKey.${text ? ` Server said: ${truncate(text)}` : ""}`,
        "openai-compat",
      )
    }
    throw new LlmRequestError(
      `openai-compat: ${res.status} from ${url}: ${truncate(text)}`,
      "openai-compat",
      res.status,
    )
  }

  const json = (await res.json().catch((err) => {
    throw new LlmRequestError(
      `openai-compat: response is not JSON: ${(err as Error).message}`,
      "openai-compat",
      res.status,
    )
  })) as ChatCompletionsBody

  return parseChatCompletionsBody(json, body.model)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ChatCompletionsRequestBody {
  model: string
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
  max_tokens?: number
  temperature?: number
  stream: false
}

function buildRequestBody(
  config: OpenAICompatConfig,
  request: LlmRequest,
): ChatCompletionsRequestBody {
  const model = request.model || config.defaultModel || DEFAULT_MODEL
  const flat = flattenMessages(request)
  const body: ChatCompletionsRequestBody = {
    model,
    messages: flat,
    stream: false,
  }
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens
  if (request.temperature !== undefined) body.temperature = request.temperature
  return body
}

function flattenMessages(request: LlmRequest): LlmMessage[] {
  const out: LlmMessage[] = []
  if (request.system) out.push({ role: "system", content: request.system })
  if (request.messages) out.push(...request.messages)
  if (request.prompt) out.push({ role: "user", content: request.prompt })
  if (out.length === 0) {
    throw new LlmRequestError(
      "openai-compat: empty request — provide at least one of system/prompt/messages",
      "openai-compat",
    )
  }
  return out
}

interface ChatCompletionsBody {
  id?: string
  choices?: Array<{
    index?: number
    message?: { role?: string; content?: string | null }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function parseChatCompletionsBody(
  body: ChatCompletionsBody,
  model: string,
): LlmResponse {
  const text = body.choices?.[0]?.message?.content ?? ""
  const usage: LlmUsage | undefined = body.usage
    ? {
        inputTokens: body.usage.prompt_tokens,
        outputTokens: body.usage.completion_tokens,
        raw: body.usage as Record<string, unknown>,
      }
    : undefined
  return { text, provider: "openai-compat", model, usage }
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
