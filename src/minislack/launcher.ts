/**
 * launchMinislack — standalone `bantai minislack` entry point.
 *
 * Reads CLI flags, boots a Minislack via startMinislack(), prints the URL,
 * and blocks on SIGINT. Ctrl+C → handle.stop() → exit.
 *
 * Seeds a deterministic `bantai` app on boot so `bantai slack` can connect
 * without an explicit registration step. Tokens are derived from the app
 * id counter (first app → A00000001), which is stable for a fresh fixture
 * boot AND for `--persist` restarts (we reuse the existing app instead of
 * minting a second one).
 */

import path from "node:path"
import os from "node:os"
import { startMinislack } from "./testing/harness"
import type { FixtureName } from "./testing/fixtures"
import { joinChannel } from "./core/channels"
import { botTokenForApp, appTokenForApp } from "./server/auth"
import type { App } from "./types/slack"

export interface MinislackFlags {
  port?: number
  fixture?: FixtureName
  /** Pass "__default__" for ~/.bantai/minislack/default, or an absolute path. */
  persist?: string
  /** Path to a JSON file of custom emoji. Accepts a flat map or raw Slack emoji.list output. */
  emojisFile?: string
  serveWeb?: boolean
}

export async function launchMinislack(flags: MinislackFlags): Promise<void> {
  const persistDir = flags.persist === "__default__"
    ? path.join(os.homedir(), ".bantai", "minislack", "default")
    : flags.persist

  const handle = await startMinislack({
    port: flags.port,
    fixture: flags.fixture ?? "basic",
    persist: persistDir,
    emojisFile: flags.emojisFile,
    serveWeb: flags.serveWeb,
  })

  const bantai = ensureBantaiApp(handle.workspace, handle.registerApp)

  const out = [
    "",
    `  minislack — fake Slack workspace`,
    `  URL:        ${handle.url}`,
    `  WS base:    ${handle.wsUrl("<socketId>").replace("/<socketId>", "")}`,
    `  fixture:    ${flags.fixture ?? "basic"}`,
    `  team:       ${handle.workspace.team.name} (${handle.workspace.team.id})`,
    `  users:      ${handle.workspace.users.size}`,
    `  channels:   ${handle.workspace.channels.size}`,
    ``,
    `  bantai app: ${bantai.app.id} (bot user ${bantai.botUserId})`,
    `  bot_token:  ${bantai.botToken}`,
    `  app_token:  ${bantai.appToken}`,
    ``,
    `  Press Ctrl+C to stop.`,
    ``,
  ]
  for (const line of out) process.stdout.write(line + "\n")

  await new Promise<void>((resolve) => {
    const onSig = () => {
      process.off("SIGINT", onSig)
      process.off("SIGTERM", onSig)
      resolve()
    }
    process.on("SIGINT", onSig)
    process.on("SIGTERM", onSig)
  })

  await handle.stop()
  process.stdout.write("\nminislack stopped.\n")
}

interface BantaiAppInfo {
  app: App
  botUserId: string
  botToken: string
  appToken: string
}

/**
 * Seed (or re-seed) the default `bantai` app on the running workspace.
 *
 * Fresh boot → `registerApp({ name: "bantai", ... })` mints A00000001.
 * `--persist` restart → the app already lives in workspace.json, so we
 * reuse it (and re-derive its tokens from the stored app id) instead of
 * minting a second `bantai` app.
 *
 * Either way the bot user joins every public channel in the workspace
 * so `@bantai` mentions resolve without a separate `conversations.invite`
 * dance.
 */
function ensureBantaiApp(
  workspace: import("./types/slack").Workspace,
  registerApp: (opts: {
    name: string
    scopes?: string[]
    subscribed_events?: string[]
  }) => { app: App; botUser: { id: string }; botToken: string; appToken: string },
): BantaiAppInfo {
  const existing = Array.from(workspace.apps.values()).find(
    (a) => a.name === "bantai",
  )
  let info: BantaiAppInfo
  if (existing) {
    info = {
      app: existing,
      botUserId: existing.bot_user_id,
      botToken: botTokenForApp(existing.id),
      appToken: appTokenForApp(existing.id),
    }
  } else {
    const registered = registerApp({
      name: "bantai",
      scopes: BANTAI_SCOPES,
      subscribed_events: BANTAI_EVENTS,
    })
    info = {
      app: registered.app,
      botUserId: registered.botUser.id,
      botToken: registered.botToken,
      appToken: registered.appToken,
    }
  }

  // Auto-join every public channel + group. Private channels and DMs
  // are left alone — operators who want the bot in those should invite
  // it explicitly, matching real-Slack behaviour.
  for (const ch of workspace.channels.values()) {
    if (ch.is_channel === true || ch.is_group === true) {
      joinChannel(workspace, ch.id, info.botUserId)
    }
  }
  return info
}

const BANTAI_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "commands",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "reactions:read",
  "reactions:write",
  "users:read",
]

// Minislack's event bus publishes raw `type: "message"` — it doesn't
// split by channel_type the way Slack's Events API does with
// `message.channels` / `message.groups` / `message.im`. Subscribing
// to those split names would match nothing. We subscribe to "message"
// and let the app's own gate inspect channel_type if it cares.
const BANTAI_EVENTS = [
  "app_mention",
  "file_shared",
  "member_joined_channel",
  "message",
  "reaction_added",
]
