/**
 * Unconfigured-channel behaviour — when `slack.json` declares at least
 * one `channels[]` entry, a message in a channel that is NOT on that
 * list must NOT drive the agent. Instead, the bot posts a helpful
 * threaded reply pointing at `slack.json`.
 *
 * This protects the common misconfiguration where the bot gets added
 * to a new channel but nobody updated slack.json — silently falling
 * back to `defaults` + `launchCwd` would make the agent run in the
 * wrong repository.
 *
 * The empty-`channels[]` (self-host) path is already exercised by
 * `roundtrip.test.ts`; that test only sets `defaults` + no `channels`
 * and expects the agent to run.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  startMinislack,
  type MinislackHandle,
} from "../../../../src/minislack/testing/harness"
import { joinChannel } from "../../../../src/minislack/core/channels"
import {
  launchSlack,
  type SlackLaunchHandle,
} from "../../../../src/frontends/slack/launcher"
import type { CLIFlags } from "../../../../src/cli/options"

const BASE_FLAGS: CLIFlags = {
  config: {},
  backend: "claude",
  help: false,
  version: false,
  debug: false,
  debugBackend: false,
  noDiagnosticsMcp: true,
}

describe("slack frontend — unconfigured channel posts a helpful notice", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle
  let botUserId: string
  let aliceId: string
  let engineeringId: string
  let designId: string

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "multi-user", serveWeb: false })
    const registered = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history"],
      subscribed_events: ["message", "app_mention"],
    })

    const engineering = Array.from(mini.workspace.channels.values()).find(
      (c) => "name" in c && c.name === "engineering",
    )
    const design = Array.from(mini.workspace.channels.values()).find(
      (c) => "name" in c && c.name === "design",
    )
    if (!engineering || !design) throw new Error("fixture missing channels")
    engineeringId = engineering.id
    designId = design.id
    aliceId = Array.from(mini.workspace.users.values()).find(
      (u) => u.name === "alice",
    )!.id
    joinChannel(mini.workspace, engineeringId, registered.botUser.id)
    joinChannel(mini.workspace, designId, registered.botUser.id)

    slack = (await launchSlack({
      ...BASE_FLAGS,
      returnHandle: true,
      slackConfigInline: {
        workspace: {
          mode: "socket",
          bot_token: registered.botToken,
          app_token: registered.appToken,
          slack_api_url: mini.url,
        },
        defaults: {
          backend: "mock",
          verbosity: "normal",
          require_mention: true,
          session_banner: false,
        },
        store_path: "",
        // Only #engineering is declared — #design is unmapped.
        channels: [{ id: engineeringId, name: "engineering", project_dir: "/tmp/eng" }],
      },
    })) as SlackLaunchHandle
    botUserId = slack.botUserId
    slack.userCache.seed(aliceId, "alice")

    await new Promise((r) => setTimeout(r, 150))
  })

  afterAll(async () => {
    await slack?.stop()
    await new Promise((r) => setTimeout(r, 200))
    await mini?.stop()
    await new Promise((r) => setTimeout(r, 50))
  })

  it("posts a helpful reply in an unconfigured channel instead of invoking the agent", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(designId, `<@${botUserId}> hello from an unmapped channel`)

    await waitFor(
      () => botReplyExists(mini, designId, parent.ts),
      { timeoutMs: 5000, message: "expected helper reply" },
    )

    const replies = botRepliesIn(mini, designId, parent.ts)
    // Exactly one reply — the helper. No follow-up agent turn.
    expect(replies.length).toBe(1)
    const text = replies[0]!.text ?? ""
    expect(text).toContain("not configured")
    expect(text).toContain("slack.json")
    // The helper embeds the actual channel id so the user can copy-paste it.
    expect(text).toContain(designId)
  })

  it("still runs the agent in configured channels", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(engineeringId, `<@${botUserId}> hello from a configured channel`)

    await waitFor(
      () => botReplyExists(mini, engineeringId, parent.ts),
      { timeoutMs: 5000, message: "expected agent reply in configured channel" },
    )

    const replies = botRepliesIn(mini, engineeringId, parent.ts)
    expect(replies.length).toBeGreaterThanOrEqual(1)
    // The mock backend's canned text has nothing to do with our helper copy.
    const combined = replies.map((r) => r.text ?? "").join("\n")
    expect(combined).not.toContain("not configured")
  })
})

// ---------------------------------------------------------------------------
// Helpers (mirror roundtrip.test.ts — local copies to keep the test file
// self-contained).
// ---------------------------------------------------------------------------

function botRepliesIn(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): Array<{ text?: string; user?: string; thread_ts?: string }> {
  const ch = mini.workspace.channels.get(channelId)
  if (!ch) return []
  const out: Array<{ text?: string; user?: string; thread_ts?: string }> = []
  for (const msg of ch.messages.values()) {
    if (msg.thread_ts === parentTs && msg.ts !== parentTs) out.push(msg)
  }
  return out
}

function botReplyExists(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): boolean {
  return botRepliesIn(mini, channelId, parentTs).length > 0
}

async function waitFor(
  cond: () => boolean,
  opts: { timeoutMs: number; message: string },
): Promise<void> {
  const start = Date.now()
  const step = 25
  while (Date.now() - start < opts.timeoutMs) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, step))
  }
  throw new Error(`waitFor timed out after ${opts.timeoutMs}ms: ${opts.message}`)
}
