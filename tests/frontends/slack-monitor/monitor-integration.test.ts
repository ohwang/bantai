/**
 * End-to-end monitor integration test.
 *
 * Boots a real `launchSlack` against a minislack workspace with the
 * admin surface enabled, attaches a real `createAdminContext` (REST +
 * WebSocket) to it, drives a scripted turn through Slack, and asserts
 * the monitor observed the lifecycle it's supposed to: snapshot →
 * session_opened → session_event(s) → eventually a phase transition
 * back to IDLE when the turn completes.
 *
 * This is the "full loop" coverage Item 14 calls for in
 * `team/bantai-slack-monitor-tui.md` — the same shape as
 * `tests/frontends/slack/integration/admin.test.ts` but the consumer is
 * our own client instead of hand-rolled fetch calls.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startMinislack, type MinislackHandle } from "../../../src/minislack/testing/harness"
import { joinChannel } from "../../../src/minislack/core/channels"
import {
  launchSlack,
  type SlackLaunchHandle,
} from "../../../src/frontends/slack/launcher"
import type { CLIFlags } from "../../../src/cli/options"
import { createAdminContext } from "../../../src/frontends/slack-monitor/context/admin-context"

const BASE_FLAGS: CLIFlags = {
  config: {},
  backend: "claude",
  help: false,
  version: false,
  debug: false,
  debugBackend: false,
  noDiagnosticsMcp: true,
}

describe("slack-monitor — integration against real launchSlack + minislack", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle
  let tmp: string
  let aliceId: string
  let botUserId: string
  let generalId: string

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "bantai-monitor-integ-"))
    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    const registered = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history", "users:read"],
      subscribed_events: [
        "message",
        "app_mention",
        "member_joined_channel",
      ],
    })
    const general = Array.from(mini.workspace.channels.values()).find(
      (c) => "name" in c && c.name === "general",
    )
    if (!general) throw new Error("fixture missing #general")
    generalId = general.id
    aliceId = Array.from(mini.workspace.users.values()).find((u) => u.name === "alice")!.id
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
        store_path: "",
      },
      adminOverrides: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        tokenPath: join(tmp, "admin-token"),
        readOnly: false,
      },
    })) as SlackLaunchHandle
    botUserId = slack.botUserId
    slack.userCache.seed(aliceId, "alice")
    // Let Bolt + admin Bun.serve settle before we connect.
    await new Promise((r) => setTimeout(r, 150))
  })

  afterAll(async () => {
    await slack?.stop()
    await new Promise((r) => setTimeout(r, 200))
    await mini?.stop()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("observes a full turn lifecycle end-to-end", async () => {
    const port = slack.admin!.server.port()
    const ctx = createAdminContext({
      baseUrl: `http://127.0.0.1:${port}`,
      token: slack.admin!.token,
      // Tight timers so the test doesn't hang waiting for the WS handshake.
      pingIntervalMs: 0,
      initialReconnectMs: 0,
    })

    try {
      await ctx.bootstrap()
      expect(ctx.store.state.loaded).toBe(true)
      // Config arrived via /admin/config.
      expect(ctx.store.state.config?.mode).toBe("socket")

      // Wait for the WS to open + the `hello` frame to land.
      await waitFor(
        () => ctx.state() === "open" && ctx.store.state.protocol !== "",
        { timeoutMs: 3000, message: "WS never opened" },
      )

      // Drive a real turn through minislack → Slack → router → mock backend.
      const parent = await mini
        .asUser(aliceId)
        .sendMessage(generalId, `<@${botUserId}> hello agent`)

      // The monitor should register a new session and at least one
      // session_event flowing through the admin bus within a few seconds.
      await waitFor(
        () =>
          Object.keys(ctx.store.state.sessions).length > 0 &&
          Object.values(ctx.store.state.events).some(
            (tail) => tail.length > 0,
          ),
        { timeoutMs: 6000, message: "monitor never saw session + events" },
      )

      // Pick the session that matches the thread we just opened.
      const key = Object.keys(ctx.store.state.sessions).find((k) =>
        k.includes(generalId),
      )
      expect(key).toBeDefined()
      const summary = ctx.store.state.sessions[key!]
      expect(summary?.channelId).toBe(generalId)
      expect(summary?.threadTs).toBe(parent.ts)
      expect(summary?.backend).toBe("mock")

      // Phase should eventually settle back to IDLE after the mock turn.
      await waitFor(
        () => ctx.store.state.sessions[key!]?.phase === "IDLE",
        { timeoutMs: 6000, message: "phase never returned to IDLE" },
      )

      // The event tail should include a turn_complete (the mock backend
      // always emits one before returning to IDLE).
      const tail = ctx.store.state.events[key!] ?? []
      const hasTurnComplete = tail.some(
        (e) => (e as { type?: string }).type === "turn_complete",
      )
      expect(hasTurnComplete).toBe(true)
    } finally {
      ctx.close()
    }
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(
  pred: () => boolean,
  opts: { timeoutMs: number; message: string },
): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > opts.timeoutMs) {
      throw new Error(`waitFor timed out: ${opts.message}`)
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}
