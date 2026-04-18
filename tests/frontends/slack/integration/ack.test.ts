/**
 * S0 exit criterion — boot the Slack frontend against minislack and
 * verify the ack round-trip.
 *
 * Scenario:
 *   1. startMinislack({ fixture: "basic" }) — alice + bob + #general.
 *   2. Register a bantai app and join the bot to #general.
 *   3. launchSlack pointing at minislack via slack_api_url override.
 *   4. alice posts "hello bantai" in #general.
 *   5. Assert minislack workspace now has a bot reply
 *      "ack: received \"hello bantai\"" in the thread started at alice's message.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { startMinislack, type MinislackHandle } from "../../../../src/minislack/testing/harness"
import { joinChannel } from "../../../../src/minislack/core/channels"
import { launchSlack, type SlackLaunchHandle } from "../../../../src/frontends/slack/launcher"
import type { CLIFlags } from "../../../../src/cli/options"

// Bolt talks to stdout a lot; pin its log level down so tests stay quiet.
// (The launcher already sets Bolt log level to WARN.)

const BASE_FLAGS: CLIFlags = {
  config: {},
  backend: "claude",
  help: false,
  version: false,
  debug: false,
  debugBackend: false,
  noDiagnosticsMcp: true,
}

describe("slack frontend S0 — ack round trip against minislack", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle
  let aliceId: string
  let generalId: string
  let botUserId: string

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "basic", serveWeb: false })

    // Register a bantai app + grab its tokens. Subscribe to the events our
    // transport layer consumes — Socket Mode only delivers subscribed types.
    const registered = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history", "reactions:write"],
      subscribed_events: [
        "message",
        "app_mention",
        "member_joined_channel",
        "reaction_added",
        "file_shared",
      ],
    })

    const general = Array.from(mini.workspace.channels.values()).find(
      (c) => (c.is_channel === true || c.is_group === true) && "name" in c && c.name === "general",
    )
    if (!general) throw new Error("expected fixture 'basic' to include #general")
    generalId = general.id
    aliceId = Array.from(mini.workspace.users.values()).find((u) => u.name === "alice")!.id

    // Put the bot in #general so message events are delivered.
    joinChannel(mini.workspace, general.id, registered.botUser.id)

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
      },
    })) as SlackLaunchHandle
    botUserId = slack.botUserId

    // Give Bolt's SocketModeClient a beat to subscribe via the WebSocket.
    await new Promise((r) => setTimeout(r, 150))
  })

  afterAll(async () => {
    await slack?.stop()
    // Give any in-flight axios/follow-redirects chat.postMessage from the
    // last test's ack a moment to settle. Without this, Bun's test runner
    // surfaces an uncaught TypeError from follow-redirects/index.js:647
    // when the CustomError constructor runs during socket teardown.
    await new Promise((r) => setTimeout(r, 250))
    await mini?.stop()
    await new Promise((r) => setTimeout(r, 50))
  })

  it("auth.test resolves the bot user id", () => {
    expect(botUserId).toBeTruthy()
    expect(botUserId.startsWith("U")).toBe(true)
  })

  it("replies 'ack' in a new thread when a user posts in a channel", async () => {
    const posted = await mini.asUser(aliceId).sendMessage(generalId, "hello bantai")
    expect(posted.ts).toBeTruthy()

    await waitFor(
      () => findAckReply(mini, generalId, posted.ts, "hello bantai"),
      { timeoutMs: 3000, message: "expected ack reply" },
    )
  })

  it("replies in the existing thread when a user replies in one", async () => {
    // Start a new parent message.
    const parent = await mini.asUser(aliceId).sendMessage(generalId, "parent turn")
    await waitFor(
      () => findAckReply(mini, generalId, parent.ts, "parent turn"),
      { timeoutMs: 3000, message: "expected parent ack" },
    )

    // Reply in the thread — the bot should ack under the same parent.
    const follow = await mini.asUser(aliceId).sendMessage(generalId, "follow up", { thread_ts: parent.ts })
    expect(follow.thread_ts).toBe(parent.ts)

    await waitFor(
      () => findAckReply(mini, generalId, parent.ts, "follow up"),
      { timeoutMs: 3000, message: "expected follow-up ack in same thread" },
    )
  })

  it("ignores its own bot messages (no ack loop)", async () => {
    // We verify this by counting ack replies before + after: the bot's own
    // reply should NOT trigger a nested ack.
    const parent = await mini.asUser(aliceId).sendMessage(generalId, "loop check")
    await waitFor(
      () => findAckReply(mini, generalId, parent.ts, "loop check"),
      { timeoutMs: 3000, message: "expected initial ack" },
    )
    // Give the loop a moment to misfire if it's going to.
    await new Promise((r) => setTimeout(r, 250))
    const replies = repliesFor(mini, generalId, parent.ts)
    // Exactly one reply (the ack); the ack itself must not have spawned another.
    expect(replies.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findAckReply(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
  originalText: string,
): boolean {
  const replies = repliesFor(mini, channelId, parentTs)
  const expected = `ack: received "${originalText}"`
  return replies.some((m) => m.text === expected)
}

function repliesFor(
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
