/**
 * slack.json loader — resolves the config file across standard locations,
 * parses it with jsonc-parser (JSON + // and /* *\/ comments + trailing
 * commas), validates it with zod, and resolves any SecretRef indirections
 * against process.env.
 *
 * Locations searched, first match wins:
 *   1. explicit path passed in
 *   2. <cwd>/.bantai/slack.json
 *   3. ~/.bantai/slack.json
 *
 * Returns `{ config, path }` — `path` is "<inline>" when all locations miss
 * and an inline object is supplied instead (used by tests / the minislack
 * harness).
 */

import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import { readFile, access } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  SlackConfigSchema,
  resolveSlackConfig,
  type ResolvedSlackConfig,
  type SlackConfig,
} from "./schema"

export interface LoadSlackConfigOpts {
  /** Explicit path to a slack.json file. Overrides the search order. */
  path?: string
  /** Working directory to resolve `./.bantai/slack.json`. Defaults to cwd. */
  cwd?: string
  /** Override environment for secret resolution (tests). */
  env?: NodeJS.ProcessEnv
  /** Inline config (for tests / in-process harnesses) — skips filesystem. */
  inline?: unknown
}

export async function loadSlackConfig(
  opts: LoadSlackConfigOpts = {},
): Promise<ResolvedSlackConfig> {
  const env = opts.env ?? process.env
  if (opts.inline !== undefined) {
    const parsed = parseSlackConfig(opts.inline, "<inline>")
    await applySystemPromptFile(parsed, "<inline>", env)
    return resolveSlackConfig(parsed, "<inline>", env)
  }

  const candidates = candidatePaths(opts)
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      const raw = await readFile(candidate, "utf8")
      const jsoncParsed = parseJsoncOrThrow(raw, candidate)
      const parsed = parseSlackConfig(jsoncParsed, candidate)
      await applySystemPromptFile(parsed, candidate, env)
      return resolveSlackConfig(parsed, candidate, env)
    }
  }
  throw new Error(
    `slack.json not found. Searched:\n  ${candidates.join("\n  ")}\n` +
      `Create one at ./.bantai/slack.json or ~/.bantai/slack.json, ` +
      `or pass --slack-config <path>.`,
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function candidatePaths(opts: LoadSlackConfigOpts): string[] {
  if (opts.path) return [opts.path]
  const cwd = opts.cwd ?? process.cwd()
  return [
    path.join(cwd, ".bantai", "slack.json"),
    path.join(os.homedir(), ".bantai", "slack.json"),
  ]
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * If `defaults.system_prompt_file` is set, read the target file and inject
 * its contents into `defaults.system_prompt`. Rules:
 *
 *   - `system_prompt` + `system_prompt_file` both set → load-time error.
 *     The operator should pick one source of truth so there's no ambiguity
 *     about which string the backend ends up seeing.
 *   - Relative path → resolved against the directory of the config file on
 *     disk. For inline configs (`sourceLabel === "<inline>"`) there is no
 *     config-file directory, so relative paths are rejected — inline
 *     callers (tests, in-process harnesses) must pass absolute paths.
 *   - Leading `~/` → expanded against $HOME.
 *   - File missing / unreadable → load-time error with the attempted path,
 *     so "silent empty prompt" can't slip into production.
 *
 * Mutates `parsed` in place. `system_prompt_file` is left on the object
 * for observability — downstream consumers only read `system_prompt`.
 */
async function applySystemPromptFile(
  parsed: SlackConfig,
  sourceLabel: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const filePath = parsed.defaults.system_prompt_file
  if (filePath === undefined) return

  if (parsed.defaults.system_prompt !== undefined) {
    throw new Error(
      `Invalid slack config at ${sourceLabel}: ` +
        `defaults.system_prompt and defaults.system_prompt_file are mutually exclusive. ` +
        `Pick one — either inline the prompt, or point at a file.`,
    )
  }

  const resolvedPath = resolveSystemPromptFilePath(filePath, sourceLabel, env)
  let contents: string
  try {
    contents = await readFile(resolvedPath, "utf8")
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Invalid slack config at ${sourceLabel}: ` +
        `failed to read defaults.system_prompt_file at ${resolvedPath} — ${reason}`,
    )
  }
  parsed.defaults.system_prompt = contents
}

/**
 * Resolve the `system_prompt_file` path to an absolute path. See
 * `applySystemPromptFile` for the resolution rules.
 */
function resolveSystemPromptFilePath(
  filePath: string,
  sourceLabel: string,
  env: NodeJS.ProcessEnv,
): string {
  if (filePath.startsWith("~")) {
    const home = env.HOME ?? env.USERPROFILE ?? ""
    if (!home) {
      throw new Error(
        `Invalid slack config at ${sourceLabel}: ` +
          `defaults.system_prompt_file uses ~ but $HOME is not set`,
      )
    }
    return `${home}${filePath.slice(1)}`
  }
  if (path.isAbsolute(filePath)) return filePath
  if (sourceLabel === "<inline>") {
    throw new Error(
      `Invalid slack config at ${sourceLabel}: ` +
        `defaults.system_prompt_file="${filePath}" is relative, ` +
        `but inline configs have no config-file directory to resolve against. ` +
        `Pass an absolute path (or a ~-prefixed one) for inline use.`,
    )
  }
  return path.resolve(path.dirname(sourceLabel), filePath)
}

/**
 * Parse JSONC, aggregating syntax errors into a single readable Error. We
 * enable `allowTrailingCommas` because JSONC by convention allows them and
 * an agent-authored file is more likely to leave one behind than a human
 * one. Comments (`//` and `/* *\/`) are always stripped by the parser.
 */
function parseJsoncOrThrow(raw: string, sourceLabel: string): unknown {
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length > 0) {
    const rendered = errors
      .map((e) => {
        const loc = lineColumnFor(raw, e.offset)
        return `  - ${printParseErrorCode(e.error)} at line ${loc.line}:${loc.column}`
      })
      .join("\n")
    throw new Error(
      `Invalid JSONC in slack config at ${sourceLabel}:\n${rendered}`,
    )
  }
  return parsed
}

function lineColumnFor(source: string, offset: number): { line: number; column: number } {
  let line = 1
  let column = 1
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++
      column = 1
    } else {
      column++
    }
  }
  return { line, column }
}

export function parseSlackConfig(raw: unknown, sourceLabel: string): SlackConfig {
  const result = SlackConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n")
    throw new Error(
      `Invalid slack config at ${sourceLabel}:\n${issues}`,
    )
  }
  return result.data
}
