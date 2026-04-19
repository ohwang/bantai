/**
 * Bolt App factory for the Slack frontend.
 *
 * Wraps `@slack/bolt`'s `App` constructor with our ResolvedSlackConfig shape.
 * Supports Socket Mode (default) and HTTP Events API mode. When the config
 * sets `slack_api_url` (minislack), the override is plumbed down two levels:
 *   1. `clientOptions.slackApiUrl`  — app.client uses this for chat.postMessage
 *      and friends.
 *   2. `installerOptions.clientOptions.slackApiUrl` — the SocketModeReceiver's
 *      internal SocketModeClient passes this to the WebClient it constructs
 *      to call apps.connections.open. (See node_modules/@slack/bolt/dist/
 *      receivers/SocketModeReceiver.js:27-36.)
 *
 * In HTTP mode the plumbing is simpler — Bolt's HTTPReceiver listens on
 * `port` + `webhookPath`, and minislack (or real Slack) POSTs events there.
 */

import { App, LogLevel } from "@slack/bolt"
import { retryPolicies } from "@slack/web-api"
import type { ResolvedSlackConfig } from "../config/schema"
import { log } from "../../../utils/logger"

export interface CreateBoltAppOpts {
  config: ResolvedSlackConfig
  /**
   * Override the log level passed to Bolt. Defaults to WARN so the frontend
   * isn't noisy in terminals; bantai's own log module handles routing.
   */
  logLevel?: LogLevel
  /**
   * Additional HTTP routes to register on the HTTPReceiver. Ignored for
   * Socket Mode (no receiver surface to attach to). Used by the launcher
   * to expose `/metrics` in http mode — see `metrics/collector.ts`.
   */
  customRoutes?: Array<{
    path: string
    method: string | string[]
    handler: (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => void
  }>
}

export function createBoltApp({ config, logLevel, customRoutes }: CreateBoltAppOpts): App {
  const { workspace } = config
  if (!workspace.botToken) {
    throw new Error(
      "slack bot_token missing — set workspace.bot_token in slack.json " +
        "(or export the env var named there)",
    )
  }
  if (workspace.mode === "socket" && !workspace.appToken) {
    throw new Error(
      "slack app_token missing — required for Socket Mode. Set " +
        "workspace.app_token in slack.json (or its env indirection).",
    )
  }
  if (workspace.mode === "http" && !workspace.signingSecret) {
    throw new Error(
      "slack signing_secret missing — required for HTTP mode. Set " +
        "workspace.signing_secret in slack.json (or its env indirection).",
    )
  }

  // S8: make the 429 / rate-limit story explicit rather than relying on
  // web-api's default (ten retries over ~30 min). The default is already
  // sensible; we just surface it so future operators see that we KNOW rate
  // limits exist + retry, and can tweak the policy in one place.
  const baseClientOptions = {
    retryConfig: retryPolicies.tenRetriesInAboutThirtyMinutes,
    rejectRateLimitedCalls: false,
    ...(workspace.slackApiUrl
      ? { slackApiUrl: withApiSuffix(workspace.slackApiUrl) }
      : {}),
  }

  if (workspace.mode === "socket") {
    return new App({
      token: workspace.botToken,
      appToken: workspace.appToken,
      socketMode: true,
      logLevel: logLevel ?? LogLevel.WARN,
      clientOptions: baseClientOptions,
      installerOptions: workspace.slackApiUrl
        ? { clientOptions: baseClientOptions }
        : undefined,
    })
  }

  return new App({
    token: workspace.botToken,
    signingSecret: workspace.signingSecret,
    socketMode: false,
    port: workspace.port,
    endpoints: workspace.webhookPath,
    logLevel: logLevel ?? LogLevel.WARN,
    clientOptions: baseClientOptions,
    ...(customRoutes && customRoutes.length > 0
      ? { customRoutes: customRoutes as never }
      : {}),
  })
}

/**
 * Verify the bot's identity on startup. Returns the auth.test payload so
 * downstream code can use `botUserId` to gate self-mention filtering later.
 */
export async function verifyAuth(app: App): Promise<{
  botUserId: string
  botId: string
  userId: string | undefined
  teamId: string | undefined
  url: string | undefined
}> {
  const res = await app.client.auth.test()
  if (!res.ok) {
    throw new Error(`slack auth.test failed: ${res.error ?? "unknown_error"}`)
  }
  const payload = {
    botUserId: String(res.bot_id ? res.user_id : res.user_id),
    botId: String(res.bot_id ?? ""),
    userId: res.user_id ? String(res.user_id) : undefined,
    teamId: res.team_id ? String(res.team_id) : undefined,
    url: res.url ? String(res.url) : undefined,
  }
  log.info(
    `slack auth ok: user=${payload.userId} bot=${payload.botId} team=${payload.teamId}`,
  )
  return payload
}

/**
 * Best-effort boot-time diagnostics. After auth.test has succeeded, poke
 * a handful of "cheap" Slack API calls that each require a specific scope
 * bantai uses, and log a warn for any that come back with `missing_scope`
 * or `invalid_auth`. Boots proceed either way — operators see the list so
 * they know which scopes to add at the admin console.
 *
 * Each probe is tiny, cacheable, or no-op in effect:
 *   - conversations.list(limit=1, types=public_channel) — exercises
 *     `channels:read`. Works on any workspace that has at least one
 *     public channel (all do).
 *   - users.list(limit=1) — exercises `users:read`.
 *   - reactions.list(limit=1) — exercises `reactions:read`.
 *
 * Non-probe: `chat:write` is validated indirectly when the bot tries to
 * post its first message. We intentionally don't fire a probe post to
 * avoid spamming the workspace on boot.
 */
export interface DiagnosticFinding {
  code: string
  message: string
}

export async function runBootDiagnostics(
  app: App,
): Promise<DiagnosticFinding[]> {
  const findings: DiagnosticFinding[] = []
  async function probe(code: string, fn: () => Promise<{ ok?: boolean; error?: string }>) {
    try {
      const res = await fn()
      if (!res.ok) {
        findings.push({
          code,
          message: `probe ${code} returned error=${res.error ?? "unknown"}`,
        })
      }
    } catch (err) {
      const message = (err as { data?: { error?: string }; message?: string })
      const errCode = message.data?.error ?? message.message ?? String(err)
      findings.push({ code, message: `probe ${code} threw: ${errCode}` })
    }
  }
  await probe("channels.read", () =>
    app.client.conversations.list({ limit: 1, types: "public_channel" }),
  )
  await probe("users.read", () => app.client.users.list({ limit: 1 }))
  await probe("reactions.read", () =>
    app.client.reactions.list({ limit: 1 }),
  )
  return findings
}

function withApiSuffix(url: string): string {
  if (url.endsWith("/")) return `${url}api/`
  if (url.endsWith("/api/")) return url
  return `${url}/api/`
}
