/**
 * `bantai slack monitor` launcher.
 *
 * Resolves the admin server URL + bearer token from a mix of CLI flags
 * and (optionally) the same `slack.json` the Slack frontend reads. The
 * precedence is:
 *
 *   1. Explicit `--url`.
 *   2. Explicit `--token`.
 *   3. Token file read from `--token-path`.
 *   4. Values derived from `slack.json`'s `admin` block (found via the
 *      same search order as `bantai slack`).
 *
 * We keep the monitor self-sufficient on a freshly-cloned machine: if
 * slack.json can't be found the operator can still attach by passing
 * `--url` + one of `--token` / `--token-path` directly.
 *
 * Once the admin context is built the launcher blocks on `bootstrap()`
 * (fails loud on HTTP 4xx/5xx) and then calls OpenTUI's `render()`. The
 * render call is not awaited — per AGENTS.md rule 4, awaiting `render()`
 * resolves immediately and causes the process to exit. We hook a
 * process-wide SIGINT handler instead so Ctrl-C cleanly tears down the
 * WS + settles any in-flight write action before exit.
 */

import { readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { render } from "@opentui/solid"
import { MonitorApp } from "./app"
import { createAdminContext } from "./context/admin-context"
import { loadSlackConfig } from "../slack/config/loader"
import { log } from "../../utils/logger"

export interface SlackMonitorFlags {
  /** Explicit base URL (e.g. http://127.0.0.1:4242). Overrides slack.json. */
  url?: string
  /** Explicit bearer token. Overrides --token-path and slack.json. */
  token?: string
  /** Path to a token file. Overrides slack.json. */
  tokenPath?: string
  /** Optional slack.json path (same semantics as `bantai slack`). */
  slackConfigPath?: string
  /** Rendered cap on per-session event tails in the UI. */
  maxEventsPerSession?: number
}

interface Resolved {
  baseUrl: string
  token: string
  sourceUrl: "flag" | "config" | "default"
  sourceToken: "flag" | "flag-path" | "config" | "default-path"
}

/**
 * Launch the `bantai slack monitor` OpenTUI frontend. Returns once the
 * admin context is torn down; in normal use the process exits on Ctrl-C
 * via the SIGINT handler installed at the top.
 */
export async function launchSlackMonitor(flags: SlackMonitorFlags): Promise<void> {
  const resolved = await resolveConnection(flags)
  log.info(
    `slack-monitor: connecting to ${resolved.baseUrl} (url=${resolved.sourceUrl}, token=${resolved.sourceToken})`,
  )

  const ctx = createAdminContext({
    baseUrl: resolved.baseUrl,
    token: resolved.token,
    ...(flags.maxEventsPerSession !== undefined
      ? { maxEventsPerSession: flags.maxEventsPerSession }
      : {}),
  })

  // Bootstrap first — this is the first real auth / reachability check.
  // We want a clean CLI error here rather than a blank TUI.
  try {
    await ctx.bootstrap()
  } catch (err) {
    ctx.close()
    // eslint-disable-next-line no-console
    console.error(
      `bantai slack monitor: failed to bootstrap ${resolved.baseUrl}: ${stringifyError(err)}`,
    )
    process.exit(2)
  }

  let exited = false
  const exit = () => {
    if (exited) return
    exited = true
    try {
      ctx.close()
    } catch (err) {
      log.debug(`slack-monitor: close() errored: ${String(err)}`)
    }
    // Give the WS half a tick to flush a close frame before slamming the door.
    setTimeout(() => process.exit(0), 25)
  }
  process.once("SIGINT", exit)
  process.once("SIGTERM", exit)

  // OpenTUI's render() is fire-and-forget (AGENTS.md rule 4). Intentionally
  // not awaited; any downstream error bubbles into the ErrorBoundary-less
  // root where it'll be logged and the process will continue serving the
  // TUI until the user hits q / Ctrl-C.
  render(() => <MonitorApp ctx={ctx} baseUrl={resolved.baseUrl} onExit={exit} />).catch(
    (err) => {
      log.error(`slack-monitor: render threw: ${String(err)}`)
      exit()
    },
  )
}

// ---------------------------------------------------------------------------
// Connection resolution
// ---------------------------------------------------------------------------

async function resolveConnection(flags: SlackMonitorFlags): Promise<Resolved> {
  let baseUrl: string | undefined = flags.url
  let sourceUrl: Resolved["sourceUrl"] = "flag"
  let token: string | undefined = flags.token
  let sourceToken: Resolved["sourceToken"] = "flag"
  let tokenPath: string | undefined = flags.tokenPath

  // Try slack.json whenever any required piece is still missing. The
  // loader throws when the file can't be found anywhere — that's fine,
  // we treat the throw as "no slack.json context", the operator can
  // still have supplied --url + --token on the CLI.
  const missing = !baseUrl || (!token && !tokenPath)
  if (missing) {
    try {
      const cfg = await loadSlackConfig(
        flags.slackConfigPath ? { path: flags.slackConfigPath } : {},
      )
      if (!baseUrl) {
        const host = cfg.admin.host || "127.0.0.1"
        const port = cfg.admin.port || 4242
        baseUrl = `http://${host}:${port}`
        sourceUrl = "config"
      }
      if (!token && !tokenPath) {
        tokenPath = cfg.admin.tokenPath
        sourceToken = "config"
      }
    } catch (err) {
      if (flags.slackConfigPath) {
        // Operator asked for a specific config — surface the failure.
        throw err
      }
      log.debug(
        `slack-monitor: slack.json not loaded (${String(err)}); relying on --url / --token flags`,
      )
    }
  }

  if (!baseUrl) {
    baseUrl = "http://127.0.0.1:4242"
    sourceUrl = "default"
  }

  if (!token) {
    if (!tokenPath) {
      tokenPath = path.join(os.homedir(), ".bantai", "slack", "admin-token")
      sourceToken = "default-path"
    } else if (sourceToken !== "config") {
      sourceToken = "flag-path"
    }
    token = await readTokenFile(tokenPath)
  }

  return { baseUrl, token, sourceUrl, sourceToken }
}

async function readTokenFile(p: string): Promise<string> {
  try {
    const raw = await readFile(p, "utf8")
    const t = raw.trim()
    if (!t) {
      throw new Error(`admin token file is empty: ${p}`)
    }
    return t
  } catch (err) {
    const msg = stringifyError(err)
    throw new Error(
      `could not read admin token from ${p}: ${msg}. ` +
        `Pass --token <value> or --token-path <path>, or start \`bantai slack\` first ` +
        `so the admin bootstrap writes the token file.`,
    )
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
