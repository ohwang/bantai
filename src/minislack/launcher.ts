/**
 * launchMinislack — standalone `bantai minislack` entry point.
 *
 * Reads CLI flags, boots a Minislack via startMinislack(), prints the URL,
 * and blocks on SIGINT. Ctrl+C → handle.stop() → exit.
 */

import path from "node:path"
import os from "node:os"
import { startMinislack } from "./testing/harness"
import type { FixtureName } from "./testing/fixtures"

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
