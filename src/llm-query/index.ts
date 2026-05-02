#!/usr/bin/env bun
/**
 * bantai-llm-query — adhoc CLI for testing the bantai-internal LLM service.
 *
 * One-shot. Sends a single chat message to a provider and prints the
 * assistant's text reply to stdout, plus a one-line `[provider=… model=…
 * input=… output=…]` footer to stderr. No TUI.
 *
 * The provider is resolved with the same precedence as `complete()`:
 *
 *   1. `--provider <id>` flag (this CLI overrides settings).
 *   2. `BantaiConfig.llm` from settings.
 *   3. Implicit Codex OAuth fallback when `~/.codex/auth.json` exists.
 *
 * Examples:
 *   # Whatever resolveLlmConfig() picks (settings → implicit codex)
 *   bantai-llm-query "what is 2+2"
 *
 *   # Force codex-oauth, override the model
 *   bantai-llm-query --provider codex-oauth --model gpt-5.5 "hello"
 *
 *   # OpenAI-compat against LM Studio
 *   bantai-llm-query --provider openai-compat \
 *     --base-url http://localhost:1234/v1 \
 *     --model qwen3-coder \
 *     "summarize the bantai project"
 *
 *   # Gemini
 *   bantai-llm-query --provider gemini --api-key "$GEMINI_KEY" "hi"
 *
 *   # System prompt + token cap
 *   bantai-llm-query --system "be terse" --max-tokens 64 "what is solidjs"
 *
 * Exit codes:
 *   0  success
 *   1  unexpected error
 *   2  CLI usage error / not configured
 *   3  auth error (e.g. expired codex token)
 *   4  request error (HTTP non-2xx, bad model, network, …)
 */

import { Command } from "commander"

import {
  complete,
  isKnownLlmProviderId,
  knownLlmProviderIds,
  listLlmProvidersForCli,
  LlmAuthError,
  LlmNotConfiguredError,
  LlmRequestError,
  type LlmProviderConfig,
  type LlmProviderId,
} from "../services/llm"
import { log } from "../utils/logger"

interface CliFlags {
  provider?: string
  model?: string
  system?: string
  maxTokens?: string
  temperature?: string
  baseUrl?: string
  apiKey?: string
  header?: string[]
  debug?: boolean
}

async function main(argv: string[]): Promise<void> {
  const program = new Command()

  program
    .name("bantai-llm-query")
    .description(
      "Adhoc one-shot LLM query for testing the bantai LLM service. " +
        "Prints reply to stdout, run summary to stderr.",
    )
    .argument("<message...>", "User message to send")
    .option(
      "-p, --provider <id>",
      `Provider override (default: resolved from settings). Choices: ${listLlmProvidersForCli()}`,
    )
    .option("-m, --model <name>", "Model id (provider default if omitted)")
    .option("-s, --system <text>", "System prompt prepended before the user message")
    .option("--max-tokens <n>", "Soft cap on output tokens")
    .option("--temperature <n>", "Sampling temperature (0..2)")
    .option(
      "--base-url <url>",
      "Base URL — REQUIRED for openai-compat, optional for gemini",
    )
    .option(
      "--api-key <key>",
      "API key — REQUIRED for gemini, optional for openai-compat",
    )
    .option(
      "-H, --header <k=v>",
      "Extra header for openai-compat (repeatable)",
      collectHeader,
      [] as string[],
    )
    .option("--debug", "Bump the file logger to debug level")
    .allowUnknownOption(false)

  program.action(async (messageParts: string[], rawOpts: CliFlags) => {
    if (rawOpts.debug) log.setLevel("debug")

    const message = messageParts.join(" ").trim()
    if (!message) die("empty message — pass at least one positional arg.")

    const config = buildConfigFromFlags(rawOpts)
    const maxOutputTokens = parseNumberFlag(rawOpts.maxTokens, "--max-tokens")
    const temperature = parseNumberFlag(rawOpts.temperature, "--temperature")

    const startedAt = Date.now()
    try {
      const res = await complete(
        {
          system: rawOpts.system,
          prompt: message,
          model: rawOpts.model,
          maxOutputTokens,
          temperature,
        },
        config ? { config } : {},
      )
      // Body to stdout (so users can pipe). Make sure it ends with a newline
      // for shell-friendliness, but don't add a second one if the model already
      // produced one.
      process.stdout.write(res.text)
      if (!res.text.endsWith("\n")) process.stdout.write("\n")

      const elapsed = Date.now() - startedAt
      const inTok = res.usage?.inputTokens ?? "?"
      const outTok = res.usage?.outputTokens ?? "?"
      process.stderr.write(
        `[provider=${res.provider} model=${res.model} input=${inTok} output=${outTok} elapsed=${elapsed}ms]\n`,
      )
    } catch (err) {
      handleError(err)
    }
  })

  await program.parseAsync(argv)
}

/**
 * Build an explicit `LlmProviderConfig` from CLI flags, or return `undefined`
 * to let `complete()` auto-resolve from settings + filesystem.
 */
function buildConfigFromFlags(opts: CliFlags): LlmProviderConfig | undefined {
  // No provider override → auto-resolve. Reject credential-shaping flags
  // because there's no provider to attach them to.
  if (!opts.provider) {
    if (opts.baseUrl || opts.apiKey || (opts.header && opts.header.length > 0)) {
      die(
        "--base-url / --api-key / --header require --provider <id>. " +
          "Auto-resolved providers can't accept credential overrides.",
      )
    }
    return undefined
  }

  if (!isKnownLlmProviderId(opts.provider)) {
    die(
      `Unknown provider "${opts.provider}". Known: ${knownLlmProviderIds().join(", ")}.`,
    )
  }
  const id: LlmProviderId = opts.provider

  switch (id) {
    case "codex-oauth": {
      if (opts.baseUrl) {
        die("codex-oauth doesn't accept --base-url (endpoint is fixed).")
      }
      if (opts.apiKey) {
        die(
          "codex-oauth reads credentials from ~/.codex/auth.json. " +
            "Don't pass --api-key — run `codex login` instead.",
        )
      }
      if (opts.header && opts.header.length > 0) {
        die("codex-oauth doesn't accept --header.")
      }
      return { kind: "codex-oauth" }
    }
    case "openai-compat": {
      if (!opts.baseUrl) {
        die(
          "openai-compat requires --base-url (e.g. http://localhost:1234/v1 or https://api.openai.com/v1).",
        )
      }
      const headers = parseHeaderFlags(opts.header)
      const cfg: LlmProviderConfig = {
        kind: "openai-compat",
        baseUrl: opts.baseUrl,
      }
      if (opts.apiKey) cfg.apiKey = opts.apiKey
      if (headers) cfg.headers = headers
      return cfg
    }
    case "gemini": {
      if (!opts.apiKey) {
        die(
          "gemini requires --api-key (get one from https://aistudio.google.com/apikey).",
        )
      }
      if (opts.header && opts.header.length > 0) {
        die("gemini doesn't accept --header.")
      }
      const cfg: LlmProviderConfig = { kind: "gemini", apiKey: opts.apiKey }
      if (opts.baseUrl) cfg.baseUrl = opts.baseUrl
      return cfg
    }
    default: {
      // Drift-contract recipe — TS catches a missing case if the union grows.
      const _exhaustive: never = id
      die(`unhandled provider id: ${String(_exhaustive)}`)
    }
  }
}

function collectHeader(value: string, prev: string[]): string[] {
  return [...prev, value]
}

function parseHeaderFlags(
  flags: string[] | undefined,
): Record<string, string> | undefined {
  if (!flags || flags.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const raw of flags) {
    const eq = raw.indexOf("=")
    if (eq <= 0) {
      die(`invalid --header value (expected key=value): ${raw}`)
    }
    const k = raw.slice(0, eq).trim()
    const v = raw.slice(eq + 1)
    if (!k) die(`invalid --header — empty key in: ${raw}`)
    out[k] = v
  }
  return out
}

function parseNumberFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) {
    die(`${name} must be a finite number, got: ${value}`)
  }
  return n
}

function handleError(err: unknown): never {
  if (err instanceof LlmNotConfiguredError) {
    process.stderr.write(`bantai-llm-query: ${err.message}\n`)
    process.exit(2)
  }
  if (err instanceof LlmAuthError) {
    process.stderr.write(
      `bantai-llm-query: auth error (${err.provider}): ${err.message}\n`,
    )
    process.exit(3)
  }
  if (err instanceof LlmRequestError) {
    const status = err.status !== undefined ? ` [HTTP ${err.status}]` : ""
    process.stderr.write(
      `bantai-llm-query: request error (${err.provider})${status}: ${err.message}\n`,
    )
    process.exit(4)
  }
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`bantai-llm-query: ${msg}\n`)
  process.exit(1)
}

function die(message: string): never {
  process.stderr.write(`bantai-llm-query: ${message}\n`)
  process.exit(2)
}

main(process.argv).catch((err) => {
  handleError(err)
})
