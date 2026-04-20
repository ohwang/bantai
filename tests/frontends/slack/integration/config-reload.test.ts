/**
 * Integration — hot reload of slack.json.
 *
 * Drives the real ConfigReloader → launcher wiring:
 *   1. Boot the launcher against a slack.json file on disk.
 *   2. Write a new channel row into the file.
 *   3. Assert the reload fires (metrics counter ticks, notify channel
 *      receives a diff summary).
 *   4. Write an invalid config and assert it's rejected (prior config
 *      stays live, rejection counter ticks, notify channel sees the
 *      error card).
 *
 * Doesn't exercise the "new channel routes a turn" path — that would
 * re-prove resolver semantics that multi-channel.test.ts already covers.
 * The signal we care about here is "file-on-disk change reaches the
 * running process" — once that's green, the rest of the pipeline is
 * unchanged.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

interface ConfigShape {
  workspace: {
    mode: "socket"
    bot_token: string
    app_token: string
    slack_api_url: string
  }
  defaults: {
    backend: "mock"
    verbosity: "normal"
    require_mention: true
    session_banner: false
    reload_notify_channel?: string
  }
  channels: Array<{ id: string; name: string }>
  store_path: ""
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
}

describe("slack config hot-reload — integration", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle
  let generalId: string
  let opsId: string
  let tmpDir: string
  let configPath: string

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    const registered = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history"],
      subscribed_events: ["message", "app_mention"],
    })

    const general = Array.from(mini.workspace.channels.values()).find(
      (c) => "name" in c && c.name === "general",
    )!
    generalId = general.id
    joinChannel(mini.workspace, generalId, registered.botUser.id)

    // Reuse #general as the notify channel — it's the one the bot is
    // already joined into.
    opsId = generalId

    tmpDir = mkdtempSync(join(tmpdir(), "bantai-reload-"))
    configPath = join(tmpDir, "slack.json")

    const initial: ConfigShape = {
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
        reload_notify_channel: opsId,
      },
      channels: [],
      store_path: "",
    }
    writeFileSync(configPath, JSON.stringify(initial, null, 2))

    slack = (await launchSlack({
      ...BASE_FLAGS,
      returnHandle: true,
      slackConfigPath: configPath,
      // Inline URL override to route Bolt's Web API at minislack even
      // though the file-on-disk already has `slack_api_url` — the
      // override is what the other integration tests use, keep parity.
      slackApiUrlOverride: mini.url,
    })) as SlackLaunchHandle

    // Bolt's socket client needs a beat to open the WS.
    await new Promise((r) => setTimeout(r, 150))
  })

  afterAll(async () => {
    await slack?.stop()
    await new Promise((r) => setTimeout(r, 100))
    await mini?.stop()
    await new Promise((r) => setTimeout(r, 50))
  })

  function countNotifyMessages(): number {
    const ch = mini.workspace.channels.get(opsId)
    if (!ch) return 0
    let count = 0
    for (const msg of ch.messages.values()) {
      // Only reload-summary posts (they're authored by the bot; the
      // test itself never posts here).
      if (msg.text && /config reloaded|config reload rejected/.test(msg.text)) {
        count++
      }
    }
    return count
  }

  function latestNotifyText(): string | undefined {
    const ch = mini.workspace.channels.get(opsId)
    if (!ch) return undefined
    let latestTs = ""
    let latestText: string | undefined
    for (const msg of ch.messages.values()) {
      if (!msg.text) continue
      if (!/config reloaded|config reload rejected/.test(msg.text)) continue
      if (msg.ts > latestTs) {
        latestTs = msg.ts
        latestText = msg.text
      }
    }
    return latestText
  }

  it("picks up a valid edit and posts a diff summary to the notify channel", async () => {
    const beforeCount = countNotifyMessages()
    const beforeApplied =
      slack.metrics.snapshot().counters[
        "bantai_slack_config_reload_applied_total"
      ] ?? 0

    // Add a new channel row to the file.
    const next: ConfigShape = {
      workspace: {
        mode: "socket",
        bot_token: slack.config.workspace.botToken!,
        app_token: slack.config.workspace.appToken!,
        slack_api_url: mini.url,
      },
      defaults: {
        backend: "mock",
        verbosity: "normal",
        require_mention: true,
        session_banner: false,
        reload_notify_channel: opsId,
      },
      channels: [{ id: "C_NEW_CHANNEL", name: "planning" }],
      store_path: "",
    }
    writeFileSync(configPath, JSON.stringify(next, null, 2))

    await waitUntil(
      () =>
        (slack.metrics.snapshot().counters[
          "bantai_slack_config_reload_applied_total"
        ] ?? 0) > beforeApplied,
    )

    // Verify the running process sees the new channel in its current
    // resolved config — the whole point of the getter-based plumbing.
    expect(slack.config.channels.map((c) => c.id)).toContain("C_NEW_CHANNEL")

    // Last-reload gauge advanced to a non-zero epoch.
    const ts =
      slack.metrics.snapshot().gauges[
        "bantai_slack_config_last_reload_timestamp_seconds"
      ] ?? 0
    expect(ts).toBeGreaterThan(0)

    // Notify channel got a summary post. Wait a beat for the async
    // chat.postMessage to reach minislack's store.
    await waitUntil(() => countNotifyMessages() > beforeCount)
    const text = latestNotifyText()
    expect(text).toBeDefined()
    expect(text!).toMatch(/config reloaded/)
    expect(text!).toMatch(/planning|C_NEW_CHANNEL/)
  }, 15_000)

  it("rejects a malformed edit and leaves the previous config live", async () => {
    const beforeRejected =
      slack.metrics.snapshot().counters[
        "bantai_slack_config_reload_rejected_total"
      ] ?? 0
    const beforeApplied =
      slack.metrics.snapshot().counters[
        "bantai_slack_config_reload_applied_total"
      ] ?? 0
    const beforeNotifyCount = countNotifyMessages()
    const channelsBefore = slack.config.channels.map((c) => c.id)

    // Truncated brace → zod will reject. (jsonc-parser accepts a lot of
    // loose shapes, but a completely unterminated object still errors;
    // the zod step after is where we usually land the rejection.)
    writeFileSync(configPath, "{ not valid json at all")

    await waitUntil(
      () =>
        (slack.metrics.snapshot().counters[
          "bantai_slack_config_reload_rejected_total"
        ] ?? 0) > beforeRejected,
    )

    // Applied counter did NOT move.
    const afterApplied =
      slack.metrics.snapshot().counters[
        "bantai_slack_config_reload_applied_total"
      ] ?? 0
    expect(afterApplied).toBe(beforeApplied)

    // Current config is the previous good one — channels list unchanged.
    expect(slack.config.channels.map((c) => c.id)).toEqual(channelsBefore)

    // Notify channel got a rejection card.
    await waitUntil(() => countNotifyMessages() > beforeNotifyCount)
    const text = latestNotifyText()
    expect(text).toBeDefined()
    expect(text!).toMatch(/config reload rejected/)
  }, 15_000)
})
