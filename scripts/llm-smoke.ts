#!/usr/bin/env bun
/**
 * Smoke test for the bantai-internal LLM service.
 *
 * Usage:
 *
 *   bun run scripts/llm-smoke.ts                 # uses settings + codex auto-detect
 *   bun run scripts/llm-smoke.ts --codex         # force codex-oauth
 *   bun run scripts/llm-smoke.ts --gemini KEY    # force gemini with the given key
 *   bun run scripts/llm-smoke.ts --openai-compat URL [KEY]
 *   bun run scripts/llm-smoke.ts --prompt "..."  # override the test prompt
 *   bun run scripts/llm-smoke.ts --model gpt-5
 *
 * Exits 0 on success, 1 otherwise. Prints the model output, usage, and the
 * provider that was selected. Intended for ad-hoc verification — NOT part
 * of `bun test`, since it makes real network calls.
 */

import {
  complete,
  LlmAuthError,
  LlmNotConfiguredError,
  LlmRequestError,
  type LlmProviderConfig,
} from "../src/services/llm"

interface CliOptions {
  config?: LlmProviderConfig
  prompt: string
  model?: string
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { prompt: "Reply with the single word: ok" }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--codex") {
      opts.config = { kind: "codex-oauth" }
    } else if (a === "--gemini") {
      const key = argv[++i]
      if (!key) throw new Error("--gemini requires an API key")
      opts.config = { kind: "gemini", apiKey: key }
    } else if (a === "--openai-compat") {
      const url = argv[++i]
      if (!url) throw new Error("--openai-compat requires a base URL")
      const next = argv[i + 1]
      const apiKey = next && !next.startsWith("--") ? argv[++i] : undefined
      opts.config = { kind: "openai-compat", baseUrl: url, ...(apiKey ? { apiKey } : {}) }
    } else if (a === "--prompt") {
      opts.prompt = argv[++i] ?? opts.prompt
    } else if (a === "--model") {
      opts.model = argv[++i]
    } else {
      throw new Error(`Unknown argument: ${a}`)
    }
  }
  return opts
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))

  // Avoid spawning the bantai logger's session-id banner; that lives in the
  // TUI bootstrap. The logger lazily writes on first use, so this script
  // only adds a log file if one of the providers logs.
  console.log("LLM smoke test starting…")
  if (opts.config) {
    console.log(`Using forced provider: ${opts.config.kind}`)
  } else {
    console.log("No --provider flag — auto-detecting from settings + ~/.codex/auth.json")
  }

  try {
    const res = await complete(
      {
        system: "You answer in exactly one short word, no punctuation.",
        prompt: opts.prompt,
        model: opts.model,
        maxOutputTokens: 16,
      },
      opts.config ? { config: opts.config } : {},
    )
    console.log("---")
    console.log(`provider: ${res.provider}`)
    console.log(`model:    ${res.model}`)
    console.log(`usage:    ${JSON.stringify(res.usage ?? {})}`)
    console.log(`text:     ${JSON.stringify(res.text)}`)
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) {
      console.error(`[NOT CONFIGURED] ${err.message}`)
      process.exit(1)
    }
    if (err instanceof LlmAuthError) {
      console.error(`[AUTH ERROR / ${err.provider}] ${err.message}`)
      process.exit(1)
    }
    if (err instanceof LlmRequestError) {
      console.error(`[REQUEST ERROR / ${err.provider} ${err.status ?? "-"}] ${err.message}`)
      process.exit(1)
    }
    console.error(`[UNEXPECTED] ${(err as Error).stack ?? String(err)}`)
    process.exit(1)
  }
}

void main()
