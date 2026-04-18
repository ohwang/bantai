/**
 * Slack Launcher — boots the Slack frontend server.
 *
 * Phase S0 (this slice):
 *   1. Load slack.toml (cwd/~/.bantai/slack.toml) — validated with zod.
 *   2. Create a Bolt App (Socket Mode or HTTP), optionally pointed at
 *      minislack via the `slack_api_url` override.
 *   3. Register event handlers (message, app_mention, reactions, block
 *      actions, view submissions).
 *   4. For every inbound text message, post "ack" back to the same
 *      channel/thread.
 *
 * Phases S1+ replace the ack handler with:
 *   - inbox → router → SessionHost → AgentBackend pipeline,
 *   - a rich view layer (reactions, Block Kit cards, streaming),
 *   - SQLite persistence.
 */

import type { App } from "@slack/bolt"
import type { CLIFlags } from "../../cli/options"
import { log } from "../../utils/logger"
import { loadSlackConfig } from "./config/loader"
import type { ResolvedSlackConfig } from "./config/schema"
import { createBoltApp, verifyAuth } from "./transport/bolt"
import { postMessage, registerEvents, type InboundSlackEvent } from "./transport/events"

export interface LaunchSlackOpts extends CLIFlags {
  /** Explicit slack.toml path — takes precedence over config search. */
  slackConfigPath?: string
  /** Override for [workspace].slack_api_url — the minislack URL in tests. */
  slackApiUrlOverride?: string
  /**
   * When true, return after the server is ready instead of blocking forever.
   * Integration tests use this; the CLI path does not.
   */
  returnHandle?: boolean
}

export interface SlackLaunchHandle {
  app: App
  config: ResolvedSlackConfig
  botUserId: string
  stop(): Promise<void>
}

export async function launchSlack(opts: LaunchSlackOpts): Promise<SlackLaunchHandle | void> {
  if (opts.debug) log.setLevel("debug")
  else log.setLevel("info")

  const config = await loadSlackConfig({
    path: opts.slackConfigPath,
    cwd: opts.config.cwd,
  })

  if (opts.slackApiUrlOverride) {
    config.workspace.slackApiUrl = opts.slackApiUrlOverride
  }

  log.info(
    `slack: loaded config from ${config.source} (mode=${config.workspace.mode}` +
      (config.workspace.slackApiUrl ? `, api=${config.workspace.slackApiUrl}` : "") +
      `)`,
  )

  const app = createBoltApp({ config })
  await app.start()
  const auth = await verifyAuth(app)

  registerEvents({
    app,
    botUserId: auth.botUserId,
    onInbound: buildAckHandler(app),
  })

  log.info(`slack: server ready — bot user ${auth.botUserId}`)

  const handle: SlackLaunchHandle = {
    app,
    config,
    botUserId: auth.botUserId,
    async stop() {
      await app.stop()
    },
  }

  if (opts.returnHandle) return handle

  // CLI path: block until SIGINT / SIGTERM, then shut down cleanly.
  await waitForSignal()
  log.info("slack: received shutdown signal — stopping")
  await app.stop()
  return undefined
}

// ---------------------------------------------------------------------------
// S0 handler — "ack" every inbound text message.
// ---------------------------------------------------------------------------

function buildAckHandler(app: App) {
  return async (event: InboundSlackEvent): Promise<void> => {
    if (event.kind !== "message" && event.kind !== "app_mention") return
    const threadTs = event.threadTs ?? event.ts
    await postMessage(app, {
      channel: event.channel,
      threadTs,
      text: `ack: received "${truncate(event.text, 80)}"`,
    })
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

// ---------------------------------------------------------------------------
// SIGINT / SIGTERM handling
// ---------------------------------------------------------------------------

function waitForSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      resolve()
    }
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
  })
}
