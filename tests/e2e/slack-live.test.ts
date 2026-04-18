/**
 * Real-Slack E2E smoke test — plan §S9 "E2E Slack smoke test
 * (tests/e2e/slack-live.test.ts, gated by env)".
 *
 * Only runs when the operator explicitly enables it by setting BOTH
 *   BANTAI_SLACK_LIVE_BOT_TOKEN (xoxb-…)
 *   BANTAI_SLACK_LIVE_APP_TOKEN (xapp-…)
 * and a target channel via BANTAI_SLACK_LIVE_CHANNEL (C0…). Without those
 * the describe block reports a single "skipped" test so `bun test` stays
 * green in CI + local dev. With them, we boot the launcher against real
 * Slack, post a fake inbound @mention via the Web API, and assert the
 * bot replies in the same thread.
 *
 * This harness ships the test infrastructure — operators supply their
 * own creds. Do NOT check tokens into CI directly; use a secret store
 * and inject them per-run.
 */

import { describe, expect, it } from "bun:test"
import { WebClient } from "@slack/web-api"
import { launchSlack, type SlackLaunchHandle } from "../../src/frontends/slack/launcher"
import type { CLIFlags } from "../../src/cli/options"

const BOT = process.env.BANTAI_SLACK_LIVE_BOT_TOKEN
const APP = process.env.BANTAI_SLACK_LIVE_APP_TOKEN
const CHANNEL = process.env.BANTAI_SLACK_LIVE_CHANNEL
const LIVE_ENABLED = !!(BOT && APP && CHANNEL)

const BASE_FLAGS: CLIFlags = {
  config: {},
  backend: "claude",
  help: false,
  version: false,
  debug: false,
  debugBackend: false,
  noDiagnosticsMcp: true,
}

describe("Slack frontend — live workspace smoke test", () => {
  if (!LIVE_ENABLED) {
    it.skip("skipped — set BANTAI_SLACK_LIVE_{BOT,APP}_TOKEN + _CHANNEL to enable", () => {})
    return
  }

  it("boots against real Slack, acks an @mention, shuts down cleanly", async () => {
    const client = new WebClient(BOT!)
    const auth = await client.auth.test()
    if (!auth.ok) throw new Error(`live: auth.test failed: ${auth.error}`)
    const botUserId = String(auth.user_id)

    const slack = (await launchSlack({
      ...BASE_FLAGS,
      returnHandle: true,
      slackConfigInline: {
        workspace: {
          mode: "socket",
          bot_token: BOT,
          app_token: APP,
        },
        defaults: {
          backend: "claude",
          verbosity: "concise",
          require_mention: true,
          session_banner: false,
          // Cap the turn hard so a misbehaving backend can't run for
          // minutes against real Anthropic credits.
          turn_timeout_s: 60,
          max_budget_usd: 0.5,
        },
      },
    })) as SlackLaunchHandle

    try {
      // Give Bolt a beat to connect to Slack's WS.
      await new Promise((r) => setTimeout(r, 1000))

      // Post the @mention from a real user (the operator running the
      // test — Slack doesn't let us spoof arbitrary senders).
      const probe = await client.chat.postMessage({
        channel: CHANNEL!,
        text: `<@${botUserId}> bantai e2e smoke — respond with OK`,
      })
      expect(probe.ok).toBe(true)
      const threadTs = String(probe.ts)

      // Poll conversations.replies until the bot replies, or bail out
      // at 45s with a descriptive failure.
      const deadline = Date.now() + 45_000
      let replies: { ok?: boolean; messages?: Array<{ user?: string; text?: string }> } = {}
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        replies = (await client.conversations.replies({
          channel: CHANNEL!,
          ts: threadTs,
        })) as typeof replies
        const bot = replies.messages?.find((m) => m.user === botUserId)
        if (bot) break
      }
      const reply = replies.messages?.find((m) => m.user === botUserId)
      expect(reply).toBeDefined()
      expect(reply!.text?.length ?? 0).toBeGreaterThan(0)

      // Metrics surface reflects the turn the bot actually ran.
      const snap = slack.metrics.snapshot()
      expect(snap.counters["bantai_slack_turn_completed_total"] ?? 0).toBeGreaterThanOrEqual(1)
    } finally {
      await slack.stop()
    }
  }, 120_000)
})
