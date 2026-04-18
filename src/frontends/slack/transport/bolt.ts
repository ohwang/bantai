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
import type { ResolvedSlackConfig } from "../config/schema"
import { log } from "../../../utils/logger"

export interface CreateBoltAppOpts {
  config: ResolvedSlackConfig
  /**
   * Override the log level passed to Bolt. Defaults to WARN so the frontend
   * isn't noisy in terminals; bantai's own log module handles routing.
   */
  logLevel?: LogLevel
}

export function createBoltApp({ config, logLevel }: CreateBoltAppOpts): App {
  const { workspace } = config
  if (!workspace.botToken) {
    throw new Error(
      "slack bot_token missing — set [workspace].bot_token in slack.toml " +
        "(or export the env var named there)",
    )
  }
  if (workspace.mode === "socket" && !workspace.appToken) {
    throw new Error(
      "slack app_token missing — required for Socket Mode. Set " +
        "[workspace].app_token in slack.toml (or its env indirection).",
    )
  }
  if (workspace.mode === "http" && !workspace.signingSecret) {
    throw new Error(
      "slack signing_secret missing — required for HTTP mode. Set " +
        "[workspace].signing_secret in slack.toml (or its env indirection).",
    )
  }

  const baseClientOptions = workspace.slackApiUrl
    ? { slackApiUrl: withApiSuffix(workspace.slackApiUrl) }
    : {}

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

function withApiSuffix(url: string): string {
  if (url.endsWith("/")) return `${url}api/`
  if (url.endsWith("/api/")) return url
  return `${url}/api/`
}
