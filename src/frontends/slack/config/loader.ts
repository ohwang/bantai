/**
 * slack.toml loader — resolves the config file across standard locations,
 * parses it with smol-toml, validates it with zod, and resolves any SecretRef
 * indirections against process.env.
 *
 * Locations searched, first match wins:
 *   1. explicit path passed in
 *   2. <cwd>/.bantai/slack.toml
 *   3. ~/.bantai/slack.toml
 *
 * Returns `{ config, path }` — `path` is "<none>" when all locations miss
 * and an inline object is supplied instead (used by tests / the minislack
 * harness).
 */

import { parse as parseToml } from "smol-toml"
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
  /** Explicit path to a slack.toml file. Overrides the search order. */
  path?: string
  /** Working directory to resolve `./.bantai/slack.toml`. Defaults to cwd. */
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
    return resolveSlackConfig(parsed, "<inline>", env)
  }

  const candidates = candidatePaths(opts)
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      const raw = await readFile(candidate, "utf8")
      const tomlParsed: unknown = parseToml(raw)
      const parsed = parseSlackConfig(tomlParsed, candidate)
      return resolveSlackConfig(parsed, candidate, env)
    }
  }
  throw new Error(
    `slack.toml not found. Searched:\n  ${candidates.join("\n  ")}\n` +
      `Create one at ./.bantai/slack.toml or ~/.bantai/slack.toml, ` +
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
    path.join(cwd, ".bantai", "slack.toml"),
    path.join(os.homedir(), ".bantai", "slack.toml"),
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
