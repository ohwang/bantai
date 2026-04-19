/**
 * S2 exit criterion — streaming chat.update + status-reaction transitions
 * observed against minislack.
 *
 * Scenario:
 *   1. alice @mentions bantai with text that triggers the mock backend's
 *      "read + reply" simulation ("can you read the file?").
 *   2. Assert: the bot's thread accumulates a single message (the streamed
 *      draft), not a chain of posts. Updates land in place.
 *   3. Assert: at least one status reaction is applied to alice's trigger
 *      message and the final reaction is :white_check_mark: (done).
 *
 * Streaming is inherently asynchronous — we use a generous wait window and
 * polling rather than deterministic timing assertions. What matters for S2
 * is that the bot is *correct* (single visible message, correct final
 * reaction), not that we can snapshot intermediate chat.update text.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { startMinislack, type MinislackHandle } from "../../../../src/minislack/testing/harness"
import { joinChannel } from "../../../../src/minislack/core/channels"
import { launchSlack, type SlackLaunchHandle } from "../../../../src/frontends/slack/launcher"
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

describe("slack frontend S2 — streaming + reactions", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle
  let botUserId: string
  let aliceId: string
  let generalId: string

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    const app = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history", "reactions:write", "users:read"],
      subscribed_events: [
        "message",
        "app_mention",
        "reaction_added",
      ],
    })
    const general = Array.from(mini.workspace.channels.values()).find(
      (c) => (c.is_channel === true || c.is_group === true) && "name" in c && c.name === "general",
    )
    if (!general) throw new Error("fixture missing #general")
    generalId = general.id
    aliceId = Array.from(mini.workspace.users.values()).find((u) => u.name === "alice")!.id
    joinChannel(mini.workspace, general.id, app.botUser.id)

    slack = (await launchSlack({
      ...BASE_FLAGS,
      returnHandle: true,
      slackConfigInline: {
        workspace: {
          mode: "socket",
          bot_token: app.botToken,
          app_token: app.appToken,
          slack_api_url: mini.url,
        },
        defaults: {
          backend: "mock",
          verbosity: "normal",
          require_mention: true,
          // S3 posts a session banner on session_init; that would add a
          // second reply alongside the streamed assistant message. S2's
          // assertion is specifically about the *streaming* surface being
          // one visible message, so we opt out of the banner here.
          session_banner: false,
        },
        store_path: "",
      },
    })) as SlackLaunchHandle
    botUserId = slack.botUserId
    slack.userCache.seed(aliceId, "alice")

    await new Promise((r) => setTimeout(r, 150))
  })

  afterAll(async () => {
    await slack?.stop()
    await new Promise((r) => setTimeout(r, 250))
    await mini?.stop()
    await new Promise((r) => setTimeout(r, 50))
  })

  it("produces a single streaming message (not a chain of posts)", async () => {
    const parent = await mini
      .asUser(aliceId)
      // Use a prompt that does NOT trigger the mock's tool simulation —
      // `read` / `file` / `bash` / `ask` / `question` would each surface
      // a separate Block Kit card (tool / approval / elicitation). We're
      // asserting specifically about the streaming-text message here.
      .sendMessage(generalId, `<@${botUserId}> just say hello`)

    // Wait until the mock completes the turn (~2s worth of deltas).
    await waitFor(
      () => replyCountIn(mini, generalId, parent.ts) >= 1,
      { timeoutMs: 10_000, message: "expected at least one reply" },
    )
    // Give the streaming updates time to finalise.
    await new Promise((r) => setTimeout(r, 500))

    const replies = repliesFor(mini, generalId, parent.ts)
    // The streaming outbox produces one *message* that gets updated in
    // place. That's what we assert against: one visible reply, non-empty.
    expect(replies.length).toBe(1)
    expect((replies[0]?.text ?? "").length).toBeGreaterThan(0)
  })

  it("lands at least one reaction on the trigger message and finishes on :white_check_mark:", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> just reply`)
    await waitFor(
      () => replyCountIn(mini, generalId, parent.ts) >= 1,
      { timeoutMs: 10_000, message: "expected reply" },
    )
    // Wait for the terminal reaction to land.
    await waitFor(
      () => finalReactionFor(mini, generalId, parent.ts) === "white_check_mark",
      { timeoutMs: 5000, message: "expected final :white_check_mark: reaction" },
    )
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repliesFor(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): Array<{ text?: string; reactions?: Array<{ name: string; users: string[]; count: number }> }> {
  const ch = mini.workspace.channels.get(channelId)
  if (!ch) return []
  const out: Array<{ text?: string; reactions?: Array<{ name: string; users: string[]; count: number }> }> = []
  for (const msg of ch.messages.values()) {
    if (msg.thread_ts === parentTs && msg.ts !== parentTs) {
      out.push(msg as { text?: string; reactions?: Array<{ name: string; users: string[]; count: number }> })
    }
  }
  return out
}

function replyCountIn(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): number {
  return repliesFor(mini, channelId, parentTs).length
}

/** Find the reaction currently on the PARENT message. At most one live emoji. */
function finalReactionFor(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): string | undefined {
  const ch = mini.workspace.channels.get(channelId)
  if (!ch) return undefined
  const parent = ch.messages.get(parentTs)
  if (!parent) return undefined
  const reactions = (parent as { reactions?: Array<{ name: string; users: string[]; count: number }> }).reactions
  if (!reactions || reactions.length === 0) return undefined
  // There should be exactly one live emoji at the end of the turn; if there
  // are several (from transitions), return the last one — the state machine
  // removes the previous before adding the next.
  return reactions[reactions.length - 1]?.name
}

async function waitFor(
  cond: () => boolean,
  opts: { timeoutMs: number; message: string },
): Promise<void> {
  const start = Date.now()
  const step = 50
  while (Date.now() - start < opts.timeoutMs) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, step))
  }
  throw new Error(`waitFor timed out after ${opts.timeoutMs}ms: ${opts.message}`)
}
