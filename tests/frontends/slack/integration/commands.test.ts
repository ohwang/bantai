/**
 * S3 integration — session banner posts on session_init, and `!bantai help`
 * is intercepted in the launcher and responded to without driving the
 * backend.
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

describe("slack frontend S3 — banner + !bantai commands", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle
  let botUserId: string
  let aliceId: string
  let generalId: string

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    const app = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history", "reactions:write"],
      subscribed_events: ["message", "app_mention", "reaction_added"],
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
          session_banner: true,
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

  it("posts a Block Kit banner in the thread on the first turn", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> hello`)
    await waitFor(
      () => findBannerReply(mini, generalId, parent.ts) !== undefined,
      { timeoutMs: 5000, message: "expected banner in thread" },
    )
    const banner = findBannerReply(mini, generalId, parent.ts)!
    // Banner text fallback mentions backend + model + project (plan §5).
    expect(banner.text ?? "").toMatch(/bantai/i)
    expect(Array.isArray(banner.blocks)).toBe(true)
    expect(banner.blocks!.length).toBeGreaterThanOrEqual(2)
  })

  it("responds to '!bantai help' without driving the backend", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> !bantai help`)
    await waitFor(
      () => findHelpReply(mini, generalId, parent.ts) !== undefined,
      { timeoutMs: 5000, message: "expected !bantai help reply" },
    )
    const reply = findHelpReply(mini, generalId, parent.ts)!
    expect(reply.text ?? "").toContain("bantai control commands")
  })

  it("'!bantai status' returns the session config summary", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> !bantai status`)
    await waitFor(
      () => findStatusReply(mini, generalId, parent.ts) !== undefined,
      { timeoutMs: 5000, message: "expected !bantai status reply" },
    )
    const reply = findStatusReply(mini, generalId, parent.ts)!
    expect(reply.text ?? "").toContain("backend")
    expect(reply.text ?? "").toContain("mock")
  })

  it("'!bantai verbosity debug' persists verbosity for the channel", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> !bantai verbosity debug`)
    await waitFor(
      () => repliesFor(mini, generalId, parent.ts).some((r) => (r.text ?? "").includes("verbosity set")),
      { timeoutMs: 5000, message: "expected verbosity ack" },
    )

    // Subsequent `!bantai status` should reflect the change.
    const parent2 = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> !bantai status`)
    await waitFor(
      () =>
        repliesFor(mini, generalId, parent2.ts).some((r) =>
          (r.text ?? "").includes("verbosity:") && (r.text ?? "").includes("debug"),
        ),
      { timeoutMs: 5000, message: "expected status to show debug verbosity" },
    )
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MiniMessage {
  text?: string
  blocks?: unknown[]
  user?: string
  thread_ts?: string
  ts?: string
}

function repliesFor(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): MiniMessage[] {
  const ch = mini.workspace.channels.get(channelId)
  if (!ch) return []
  const out: MiniMessage[] = []
  for (const msg of ch.messages.values()) {
    if (msg.thread_ts === parentTs && msg.ts !== parentTs) out.push(msg as MiniMessage)
  }
  return out
}

function findBannerReply(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): MiniMessage | undefined {
  return repliesFor(mini, channelId, parentTs).find(
    (m) => Array.isArray(m.blocks) && m.blocks.length > 0 && (m.text ?? "").includes("bantai"),
  )
}

function findHelpReply(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): MiniMessage | undefined {
  return repliesFor(mini, channelId, parentTs).find((m) =>
    (m.text ?? "").includes("bantai control commands"),
  )
}

function findStatusReply(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): MiniMessage | undefined {
  return repliesFor(mini, channelId, parentTs).find((m) =>
    (m.text ?? "").includes("bantai status"),
  )
}

async function waitFor(
  cond: () => boolean,
  opts: { timeoutMs: number; message: string },
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < opts.timeoutMs) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`waitFor timed out after ${opts.timeoutMs}ms: ${opts.message}`)
}
