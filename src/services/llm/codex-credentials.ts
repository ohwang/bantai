/**
 * Codex OAuth credentials reader.
 *
 * The `codex` CLI writes its OAuth state to `~/.codex/auth.json`:
 *
 *   {
 *     "OPENAI_API_KEY": "sk-..." | null,
 *     "auth_mode": "ChatGPT" | "ApiKey",
 *     "last_refresh": "2026-04-24T15:40:33.786346Z",
 *     "tokens": {
 *       "access_token":  "<JWT>",
 *       "refresh_token": "<opaque>",
 *       "id_token":      "<JWT>",
 *       "account_id":    "<uuid>"
 *     }
 *   }
 *
 * V1 SCOPE:
 *   - We READ this file to bootstrap calls against chatgpt.com/backend-api.
 *   - We DO NOT refresh tokens ourselves. If the access_token is expired (or
 *     the API returns 401), we surface a clear `LlmAuthError` instructing the
 *     user to re-run `codex login`. The codex CLI itself refreshes tokens on
 *     normal use, so as long as the user runs codex from time to time the
 *     file stays fresh.
 *   - We honor `auth_mode === "ApiKey"`: if the user is in API-key mode, we
 *     use `OPENAI_API_KEY` and target `api.openai.com` instead of the
 *     ChatGPT backend.
 *
 * V2 (deferred): implement OAuth refresh against `auth.openai.com/oauth/token`
 * with the codex public client_id, write the refreshed tokens back atomically
 * so the codex CLI sees them too.
 */

import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"

import { log } from "../../utils/logger"
import { LlmAuthError } from "./types"

export interface CodexAuthFile {
  /** Path the credentials were read from. */
  path: string
  authMode: "ChatGPT" | "ApiKey" | "unknown"
  /** Present only when authMode === "ChatGPT". */
  oauth?: {
    accessToken: string
    refreshToken?: string
    idToken?: string
    accountId?: string
    /** Decoded `exp` claim from the access token (epoch seconds). Undefined if not a JWT. */
    accessTokenExpiresAt?: number
  }
  /** Present only when authMode === "ApiKey". */
  apiKey?: string
  /** ISO timestamp of last refresh (whatever wrote it last). */
  lastRefresh?: string
}

const AUTH_FILE_REL = path.join(".codex", "auth.json")

/** Resolve the home dir, preferring $HOME so tests/dev can override. */
function resolveHome(): string {
  return process.env.HOME || os.homedir()
}

/** Canonical path of the codex auth file. */
export function codexAuthPath(homeOverride?: string): string {
  return path.join(homeOverride ?? resolveHome(), AUTH_FILE_REL)
}

/**
 * Load and validate the codex auth.json. Throws `LlmAuthError` with a
 * user-friendly message when the file is missing / unreadable / malformed.
 */
export async function readCodexAuth(opts?: {
  home?: string
}): Promise<CodexAuthFile> {
  const file = codexAuthPath(opts?.home)

  let raw: string
  try {
    raw = await fs.readFile(file, "utf-8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new LlmAuthError(
        `Codex credentials not found at ${file}. Run \`codex login\` to sign in with ChatGPT, or configure a different LLM provider in bantai settings.`,
        "codex-oauth",
      )
    }
    throw new LlmAuthError(
      `Failed to read ${file}: ${(err as Error).message}`,
      "codex-oauth",
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new LlmAuthError(
      `Codex auth file at ${file} is not valid JSON (${(err as Error).message}). Re-run \`codex login\` to repair it.`,
      "codex-oauth",
    )
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LlmAuthError(
      `Codex auth file at ${file} has unexpected shape. Re-run \`codex login\`.`,
      "codex-oauth",
    )
  }

  const obj = parsed as Record<string, unknown>
  const authModeRaw = typeof obj.auth_mode === "string" ? obj.auth_mode : "unknown"
  const authMode: CodexAuthFile["authMode"] =
    authModeRaw === "ChatGPT" || authModeRaw === "ApiKey"
      ? authModeRaw
      : "unknown"

  const lastRefresh = typeof obj.last_refresh === "string" ? obj.last_refresh : undefined

  const result: CodexAuthFile = { path: file, authMode, lastRefresh }

  if (authMode === "ApiKey") {
    const key = typeof obj.OPENAI_API_KEY === "string" ? obj.OPENAI_API_KEY : ""
    if (!key) {
      throw new LlmAuthError(
        `Codex auth file at ${file} is in ApiKey mode but has no OPENAI_API_KEY. Re-run \`codex login\`.`,
        "codex-oauth",
      )
    }
    result.apiKey = key
    return result
  }

  // ChatGPT (default) or unknown mode — try to extract OAuth tokens.
  const tokens = obj.tokens
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new LlmAuthError(
      `Codex auth file at ${file} has no \`tokens\` block. Re-run \`codex login\`.`,
      "codex-oauth",
    )
  }
  const t = tokens as Record<string, unknown>
  const accessToken = typeof t.access_token === "string" ? t.access_token : ""
  if (!accessToken) {
    throw new LlmAuthError(
      `Codex auth file at ${file} has no access_token. Re-run \`codex login\`.`,
      "codex-oauth",
    )
  }

  result.oauth = {
    accessToken,
    refreshToken: typeof t.refresh_token === "string" ? t.refresh_token : undefined,
    idToken: typeof t.id_token === "string" ? t.id_token : undefined,
    accountId: typeof t.account_id === "string" ? t.account_id : undefined,
    accessTokenExpiresAt: tryDecodeJwtExp(accessToken),
  }
  return result
}

/**
 * Throw if the access token is past its `exp` (with a 60s safety margin).
 * Returning normally does NOT guarantee the token is valid — only that we
 * have no client-side reason to reject it. The server is the final arbiter.
 */
export function assertCodexTokenFresh(creds: CodexAuthFile): void {
  if (creds.authMode === "ApiKey") return
  const exp = creds.oauth?.accessTokenExpiresAt
  if (exp === undefined) return // not a JWT we can introspect — let the server decide.
  const nowSec = Math.floor(Date.now() / 1000)
  if (exp - 60 <= nowSec) {
    throw new LlmAuthError(
      `Codex access token expired at ${new Date(exp * 1000).toISOString()}. Run any \`codex\` command (e.g. \`codex login\`) to refresh, or wait — the codex CLI refreshes tokens automatically on next use.`,
      "codex-oauth",
    )
  }
}

/**
 * Decode the `exp` claim from a JWT without verifying the signature. Returns
 * undefined for anything that doesn't look like a 3-segment JWT. Logged at
 * debug level on failure — token introspection is best-effort.
 */
function tryDecodeJwtExp(jwt: string): number | undefined {
  const parts = jwt.split(".")
  if (parts.length !== 3) return undefined
  const payload = parts[1]
  if (!payload) return undefined
  try {
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4)
    const json = Buffer.from(
      padded.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8")
    const claims = JSON.parse(json) as { exp?: unknown }
    return typeof claims.exp === "number" ? claims.exp : undefined
  } catch (err) {
    log.debug("codex jwt decode failed", { error: (err as Error).message })
    return undefined
  }
}
