/**
 * Admin bearer-token bootstrap.
 *
 * The admin HTTP + WebSocket server authenticates with a single bearer
 * token. Rather than shipping one with the code or requiring operators to
 * paste it into slack.json, we persist it on disk at `config.admin.tokenPath`
 * (default `~/.bantai/slack/admin-token`, mode 0600).
 *
 * On launch:
 *   1. If the file exists, read + trim it. If non-empty, use it.
 *   2. Otherwise generate a fresh 256-bit URL-safe token, write it with
 *      mode 0600 (parent directory created if needed).
 *
 * The value handed back to the launcher is ALWAYS trimmed so whitespace
 * in the file (editor newlines, etc.) doesn't silently break auth.
 */

import { mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { randomBytes } from "node:crypto"
import { log } from "../../../utils/logger"

export interface LoadAdminTokenResult {
  /** Token value — safe to hand to `Authorization: Bearer <...>`. */
  token: string
  /** Absolute path the token was loaded from / written to. */
  path: string
  /** True when we just generated + wrote a fresh token. */
  generated: boolean
}

/**
 * Load or generate the admin bearer token. Creates parent directories and
 * sets mode 0600 on write. Never logs the token itself.
 *
 * @param path  Absolute path. Callers resolve `~` upstream — the config
 *              schema's `expandHome` already did this when constructing
 *              `ResolvedAdminConfig.tokenPath`.
 */
export function loadOrGenerateAdminToken(path: string): LoadAdminTokenResult {
  if (!path) {
    throw new Error("admin token path is empty — config.admin.tokenPath missing?")
  }
  // Try to read an existing token first. An empty or whitespace-only file
  // is treated as "regenerate" — otherwise operators who truncate the file
  // to rotate the credential would get an empty string as the token.
  try {
    const raw = readFileSync(path, "utf8")
    const trimmed = raw.trim()
    if (trimmed.length > 0) {
      warnIfGroupReadable(path)
      return { token: trimmed, path, generated: false }
    }
    log.info(`slack admin: token file at ${path} is empty — regenerating`)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") {
      log.warn(
        `slack admin: could not read token file ${path} (${code ?? String(err)}) — generating a fresh one`,
      )
    }
    // Fall through to generation.
  }
  const token = generateToken()
  const dir = dirname(path)
  try {
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true })
    writeFileSync(path, token, { encoding: "utf8", mode: 0o600 })
    // writeFileSync's `mode` is advisory on some platforms if the file
    // already existed — enforce it explicitly to catch that case.
    chmodSync(path, 0o600)
  } catch (err) {
    throw new Error(
      `admin token generation failed: could not write ${path} (${String(err)})`,
    )
  }
  log.info(`slack admin: generated fresh bearer token at ${path} (mode 0600)`)
  return { token, path, generated: true }
}

/**
 * 256-bit URL-safe-ish token — base64url without padding. Cryptographically
 * random, not user-guessable. Don't change the alphabet lightly: the admin
 * server's `timingSafeEqual` is byte-wise on the raw string, so the value
 * is compared as-is.
 */
function generateToken(): string {
  return randomBytes(32).toString("base64url")
}

/**
 * Emit a warning (but don't fail) when the token file is group/world-
 * readable. We could force-fix the mode, but that might mask a real
 * permission problem on shared hosts — the operator should know.
 */
function warnIfGroupReadable(path: string): void {
  try {
    const s = statSync(path)
    // mode 0600 = owner-rw only. Anything broader is worth a warning.
    const loose = s.mode & 0o077
    if (loose !== 0) {
      log.warn(
        `slack admin: token file ${path} has mode ${(s.mode & 0o777).toString(8)} — expected 0600. Run \`chmod 600 ${path}\`.`,
      )
    }
  } catch {
    // stat failures aren't actionable here — we already successfully
    // read the file, so the mode check is best-effort.
  }
}
