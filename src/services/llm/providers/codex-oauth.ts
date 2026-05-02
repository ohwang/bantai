/**
 * Codex OAuth provider — calls OpenAI's Responses API via the ChatGPT
 * backend (`https://chatgpt.com/backend-api/codex/responses`) using the
 * OAuth access token written by the codex CLI to `~/.codex/auth.json`.
 *
 * When the user is in `ApiKey` mode (also supported by the codex CLI), we
 * fall back to the public `https://api.openai.com/v1/responses` endpoint
 * with `Authorization: Bearer <OPENAI_API_KEY>`.
 *
 * Wire format:
 *   POST .../responses
 *   { model, instructions, input: [{role, content}, ...],
 *     stream: true, store: false }
 *
 * Streaming is REQUIRED by the ChatGPT backend (it rejects `stream: false`
 * with `{"detail":"Stream must be set to true"}`). We accept that, consume
 * the SSE stream internally, aggregate the text deltas, and surface the
 * complete response to the caller — the public API stays non-streaming.
 * `store: false` is also REQUIRED by the ChatGPT backend.
 *
 * `instructions` is also REQUIRED by the ChatGPT backend (it rejects a
 * missing/empty value with `{"detail":"Instructions are required"}`). When
 * the caller doesn't supply a system prompt, we send `DEFAULT_INSTRUCTIONS`
 * (a short, neutral assistant prompt). The standard OpenAI Responses API
 * tolerates omitting the field, but we send the same body in both modes to
 * keep the SSE consumer single-pathed (~5 token cost in ApiKey mode is fine).
 *
 * V1 caveats:
 *   - Caller-facing API is non-streaming. A future surface can expose the
 *     SSE iterator for token-level streaming if a use case appears.
 *   - No tool use.
 *   - On 401 we throw `LlmAuthError` ("re-run codex login").
 *   - On any other error we throw `LlmRequestError` with the upstream status
 *     and a truncated body for debuggability.
 */

import { log } from "../../../utils/logger"
import {
  assertCodexTokenFresh,
  readCodexAuth,
  type CodexAuthFile,
} from "../codex-credentials"
import {
  LlmAuthError,
  LlmRequestError,
  type CodexOauthConfig,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
} from "../types"

const CHATGPT_BACKEND_BASE = "https://chatgpt.com/backend-api/codex"
const OPENAI_API_BASE = "https://api.openai.com/v1"
/**
 * Verified working via the ChatGPT backend. The plain `gpt-5` family is
 * rejected with `"... not supported when using Codex with a ChatGPT account"`,
 * so we default to a model the ChatGPT-account routing accepts. Callers
 * with `auth_mode: "ApiKey"` can pass any model they have access to.
 */
const DEFAULT_MODEL = "gpt-5.5"
/**
 * Sent as `instructions` when the caller didn't supply a system prompt. The
 * ChatGPT backend rejects a missing/empty value as
 * `{"detail":"Instructions are required"}`, so we always send something.
 * Kept short and persona-neutral so it adds ~5 input tokens and doesn't
 * bias adhoc completions (titles, summaries, recaps).
 */
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant."

/** Public adapter — see `LlmProviderAdapter` in registry.ts. */
export async function callCodexOauth(
  config: CodexOauthConfig,
  request: LlmRequest,
): Promise<LlmResponse> {
  const creds = await readCodexAuth()
  assertCodexTokenFresh(creds)

  const { url, headers } = buildAuthHeaders(creds)
  const body = buildRequestBody(config, request)

  log.debug("codex-oauth: dispatching", {
    url,
    model: body.model,
    authMode: creds.authMode,
    inputCount: body.input.length,
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
      `codex-oauth: network error talking to ${url}: ${(err as Error).message}`,
      "codex-oauth",
    )
  }

  if (!res.ok) {
    const text = await safeReadText(res)
    if (res.status === 401 || res.status === 403) {
      throw new LlmAuthError(
        `codex-oauth: ${res.status} from ${url}. Run \`codex login\` to refresh credentials.${text ? ` Server said: ${truncate(text)}` : ""}`,
        "codex-oauth",
      )
    }
    throw new LlmRequestError(
      `codex-oauth: ${res.status} from ${url}: ${truncate(text)}`,
      "codex-oauth",
      res.status,
    )
  }

  if (!res.body) {
    throw new LlmRequestError(
      `codex-oauth: empty response body from ${url}`,
      "codex-oauth",
      res.status,
    )
  }

  return await consumeSseAsResponse(res.body, body.model)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildAuthHeaders(
  creds: CodexAuthFile,
): { url: string; headers: Record<string, string> } {
  if (creds.authMode === "ApiKey") {
    if (!creds.apiKey) {
      // readCodexAuth() guarantees apiKey when authMode==="ApiKey", but defend
      // anyway so a future schema drift can't silently fall through.
      throw new LlmAuthError(
        "codex-oauth: ApiKey mode but no OPENAI_API_KEY in auth.json",
        "codex-oauth",
      )
    }
    return {
      url: `${OPENAI_API_BASE}/responses`,
      headers: {
        "Content-Type": "application/json",
        // The public OpenAI Responses API accepts both, but we ask for the
        // SSE stream so the ApiKey path uses the same SSE consumer as the
        // ChatGPT-backend path. This avoids two divergent body parsers.
        Accept: "text/event-stream",
        Authorization: `Bearer ${creds.apiKey}`,
      },
    }
  }

  if (!creds.oauth) {
    throw new LlmAuthError(
      "codex-oauth: ChatGPT mode but no oauth tokens in auth.json — run `codex login`.",
      "codex-oauth",
    )
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Streaming is required by the ChatGPT backend (see file header).
    Accept: "text/event-stream",
    Authorization: `Bearer ${creds.oauth.accessToken}`,
  }
  if (creds.oauth.accountId) {
    // Same casing the codex CLI uses; some backend variants accept either case.
    headers["chatgpt-account-id"] = creds.oauth.accountId
  }
  return {
    url: `${CHATGPT_BACKEND_BASE}/responses`,
    headers,
  }
}

interface ResponsesApiRequestBody {
  model: string
  /**
   * Codex's ChatGPT-backend REQUIRES `instructions` — it rejects a
   * missing/empty value with `{"detail":"Instructions are required"}`.
   * We always send something: the joined system messages from the caller,
   * or `DEFAULT_INSTRUCTIONS` if the caller didn't supply any.
   */
  instructions: string
  input: Array<{ role: "user" | "assistant"; content: string }>
  /**
   * Codex's ChatGPT-backend REQUIRES `stream: true` — it rejects
   * `stream: false` with `{"detail":"Stream must be set to true"}`. We
   * consume the SSE stream internally and surface the aggregated result.
   */
  stream: true
  /**
   * Codex's ChatGPT-backend Responses API REQUIRES `store: false` — the
   * backend rejects the request with `{"detail":"Store must be set to false"}`
   * otherwise. The standard OpenAI Responses API tolerates either value.
   */
  store: false
}

function buildRequestBody(
  config: CodexOauthConfig,
  request: LlmRequest,
): ResponsesApiRequestBody {
  const model = request.model || config.defaultModel || DEFAULT_MODEL
  const flat = flattenMessages(request)

  const systemMessages = flat.filter((m) => m.role === "system").map((m) => m.content)
  const instructions =
    systemMessages.length > 0 ? systemMessages.join("\n\n") : DEFAULT_INSTRUCTIONS

  const input = flat
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))

  // The ChatGPT backend currently rejects `max_output_tokens` and several
  // common sampling knobs as `Unsupported parameter`. Cap and temperature
  // are intentionally NOT forwarded here; callers that need bounded output
  // should specify it in the prompt ("answer in <= 32 words"). For ApiKey
  // mode we'd technically be allowed to forward them, but keeping the body
  // identical across both modes keeps the SSE consumer single-pathed.
  return {
    model,
    instructions,
    input,
    stream: true,
    store: false,
  }
}

function flattenMessages(request: LlmRequest): LlmMessage[] {
  const out: LlmMessage[] = []
  if (request.system) out.push({ role: "system", content: request.system })
  if (request.messages) out.push(...request.messages)
  if (request.prompt) out.push({ role: "user", content: request.prompt })
  if (out.length === 0) {
    throw new LlmRequestError(
      "codex-oauth: empty request — provide at least one of system/prompt/messages",
      "codex-oauth",
    )
  }
  return out
}

/**
 * Consume an OpenAI Responses-API SSE stream and aggregate it into a single
 * `LlmResponse`. The stream is a sequence of `event: <name>\n data: <json>\n\n`
 * frames terminated by either a `[DONE]` sentinel or stream EOF.
 *
 * Events we care about (all optional — the parser is forgiving):
 *   - `response.output_text.delta`  payload.delta is a text fragment
 *   - `response.output_text.done`   payload.text is the full chunk text
 *   - `response.completed`          payload.response.usage carries token counts
 *   - `response.failed` / `error`   surfaces the upstream error
 *
 * Anything else is logged at debug level and ignored. We deliberately do
 * NOT log skip paths at info level — SSE event vocabulary changes over
 * time and quiet forward-compat is desirable here. (The data we *do*
 * extract still gets logged at debug, which is enough for postmortems.)
 */
async function consumeSseAsResponse(
  body: ReadableStream<Uint8Array>,
  model: string,
): Promise<LlmResponse> {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  let textBuffer = ""
  let usage: LlmUsage | undefined
  let upstreamError: string | undefined

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Parse complete SSE frames. Each frame ends with a blank line.
      let sep: number
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawFrame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const frame = parseSseFrame(rawFrame)
        if (!frame) continue
        if (frame.data === "[DONE]") return finish()
        const handled = handleEvent(frame.event, frame.data)
        if (handled?.error) upstreamError = handled.error
        if (handled?.text) textBuffer += handled.text
        if (handled?.usage) usage = handled.usage
      }
    }
    // Drain any trailing frame without the terminating blank line.
    if (buffer.trim().length > 0) {
      const frame = parseSseFrame(buffer)
      if (frame && frame.data !== "[DONE]") {
        const handled = handleEvent(frame.event, frame.data)
        if (handled?.error) upstreamError = handled.error
        if (handled?.text) textBuffer += handled.text
        if (handled?.usage) usage = handled.usage
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // releaseLock throws if the stream is already locked elsewhere;
      // there's nothing useful to do beyond logging at debug level.
      log.debug("codex-oauth: SSE reader.releaseLock threw")
    }
  }

  return finish()

  function finish(): LlmResponse {
    if (upstreamError && textBuffer.length === 0) {
      throw new LlmRequestError(
        `codex-oauth: stream error: ${upstreamError}`,
        "codex-oauth",
      )
    }
    return { text: textBuffer, provider: "codex-oauth", model, usage }
  }
}

interface SseFrame {
  event?: string
  data: string
}

function parseSseFrame(raw: string): SseFrame | null {
  const lines = raw.split("\n")
  let event: string | undefined
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith(":")) continue // SSE comment / keepalive
    if (line.startsWith("event:")) {
      event = line.slice(6).trim()
    } else if (line.startsWith("data:")) {
      // SSE: leading single-space after the colon is allowed and stripped.
      const v = line.slice(5)
      dataLines.push(v.startsWith(" ") ? v.slice(1) : v)
    }
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join("\n") }
}

interface HandledEvent {
  text?: string
  usage?: LlmUsage
  error?: string
}

function handleEvent(eventName: string | undefined, dataRaw: string): HandledEvent | null {
  let payload: unknown
  try {
    payload = JSON.parse(dataRaw)
  } catch {
    log.debug("codex-oauth: non-JSON SSE data, skipping", { event: eventName })
    return null
  }
  if (!payload || typeof payload !== "object") return null
  const obj = payload as Record<string, unknown>

  // Some servers carry the event name inside the payload as `type`. Fall
  // back to it when the SSE `event:` line is missing.
  const type = eventName ?? (typeof obj.type === "string" ? obj.type : undefined)

  if (type === "response.output_text.delta") {
    const delta = typeof obj.delta === "string" ? obj.delta : ""
    return delta ? { text: delta } : null
  }
  if (type === "response.completed") {
    const responseObj = obj.response as Record<string, unknown> | undefined
    const u = responseObj?.usage as Record<string, unknown> | undefined
    if (!u) return null
    return {
      usage: {
        inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
        outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
        raw: u,
      },
    }
  }
  if (type === "response.failed" || type === "error") {
    const err = obj.error as Record<string, unknown> | undefined
    const msg =
      (err && typeof err.message === "string" && err.message) ||
      (typeof obj.message === "string" && obj.message) ||
      "unknown stream error"
    return { error: msg }
  }
  // Quiet forward-compat for everything else (`response.created`,
  // `response.output_item.added`, `response.output_text.done`, etc.).
  return null
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
