/**
 * S1 exit criterion — full round-trip:
 *   @mention in minislack → inbox.gate passes → router opens a SessionHost
 *   using the mock backend → backend emits text_complete → event-renderer
 *   posts the agent's response back in the same thread.
 *
 * The mock backend lives in src/backends/mock/adapter.ts; it emits a
 * session_init → turn_start → text_delta* → text_complete → turn_complete
 * sequence without making any network calls. Perfect for deterministic
 * integration tests.
 *
 * Scenarios:
 *   1. @mention → bot replies with the mock's canned text in a new thread.
 *   2. Reply in the thread (no @mention) → bot replies again (auto-join).
 *   3. Channel post WITHOUT a mention → no bot reply (gate rejects).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { startMinislack, type MinislackHandle } from "../../../../src/minislack/testing/harness"
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

describe("slack frontend S1 — mock backend round-trip against minislack", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle
  let botUserId: string
  let aliceId: string
  let bobId: string
  let generalId: string

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    const registered = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history", "users:read"],
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
    if (!general) throw new Error("fixture missing #general")
    generalId = general.id
    aliceId = Array.from(mini.workspace.users.values()).find((u) => u.name === "alice")!.id
    bobId = Array.from(mini.workspace.users.values()).find((u) => u.name === "bob")!.id
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
        defaults: {
          backend: "mock",
          verbosity: "normal",
          require_mention: true,
          auto_join_threads: true,
        },
      },
    })) as SlackLaunchHandle
    botUserId = slack.botUserId
    // Pre-seed the user cache so we don't depend on a live users.info call for
    // the turn-prefix — minislack supports users.info but this keeps the test
    // quiet even if the request's async path drifts.
    slack.userCache.seed(aliceId, "alice")
    slack.userCache.seed(bobId, "bob")

    // Bolt's SocketModeClient needs a beat to open the WS.
    await new Promise((r) => setTimeout(r, 150))
  })

  afterAll(async () => {
    await slack?.stop()
    // Let follow-redirects / axios drain any in-flight requests so Bun's test
    // runner teardown doesn't race on them.
    await new Promise((r) => setTimeout(r, 250))
    await mini?.stop()
    await new Promise((r) => setTimeout(r, 50))
  })

  it("replies with mock agent text in a new thread on @mention", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> hello agent`)
    await waitFor(
      () => botReplyExists(mini, generalId, parent.ts),
      { timeoutMs: 5000, message: "expected mock-agent reply in thread" },
    )
    const reply = botReplyIn(mini, generalId, parent.ts)
    expect(reply).toBeTruthy()
    expect(reply!.text).toBeTruthy()
    // Mock's canned response pool is short; just confirm the bot said something.
    expect((reply!.text ?? "").length).toBeGreaterThan(0)
  })

  it("continues in the same thread without a re-mention (auto-join)", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> first message`)
    await waitFor(
      () => countBotRepliesIn(mini, generalId, parent.ts) >= 1,
      { timeoutMs: 5000, message: "expected first reply" },
    )

    // Reply in the thread without a mention — the auto-join rule should pick
    // it up because the thread already has a live SessionHost.
    await mini
      .asUser(aliceId)
      .sendMessage(generalId, "follow up please", { thread_ts: parent.ts })

    await waitFor(
      () => countBotRepliesIn(mini, generalId, parent.ts) >= 2,
      { timeoutMs: 5000, message: "expected auto-join reply" },
    )
  })

  it("does NOT reply to a channel post without a mention", async () => {
    const before = Array.from(mini.workspace.channels.get(generalId)!.messages.values()).length
    const posted = await mini
      .asUser(aliceId)
      .sendMessage(generalId, "just venting, no mention")
    // Wait long enough that a rogue agent turn would have landed.
    await new Promise((r) => setTimeout(r, 500))
    expect(countBotRepliesIn(mini, generalId, posted.ts)).toBe(0)
    // Also: no extra top-level bot post from a stray agent turn.
    const after = Array.from(mini.workspace.channels.get(generalId)!.messages.values()).length
    // We expect exactly +1 (alice's own message); the bot should not have
    // produced anything new.
    expect(after).toBe(before + 1)
  })

  it("multi-user attribution — bob's mention also drives the agent", async () => {
    const parent = await mini
      .asUser(bobId)
      .sendMessage(generalId, `<@${botUserId}> bob asking`)
    await waitFor(
      () => countBotRepliesIn(mini, generalId, parent.ts) >= 1,
      { timeoutMs: 5000, message: "expected reply to bob" },
    )
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function botReplyIn(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): { text?: string; user?: string; thread_ts?: string } | undefined {
  const ch = mini.workspace.channels.get(channelId)
  if (!ch) return undefined
  for (const msg of ch.messages.values()) {
    if (msg.thread_ts === parentTs && msg.ts !== parentTs) return msg
  }
  return undefined
}

function botReplyExists(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): boolean {
  return !!botReplyIn(mini, channelId, parentTs)
}

function countBotRepliesIn(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): number {
  const ch = mini.workspace.channels.get(channelId)
  if (!ch) return 0
  let n = 0
  for (const msg of ch.messages.values()) {
    if (msg.thread_ts === parentTs && msg.ts !== parentTs) n++
  }
  return n
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
