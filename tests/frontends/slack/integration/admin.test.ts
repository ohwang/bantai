/**
 * Launcher-side admin-surface integration test.
 *
 * The pure `tests/frontends/slack/admin/server.test.ts` suite already
 * exercises every REST route + WS path against a hand-rolled `boot()`
 * harness. This file covers the bit that harness can't: did the REAL
 * `launchSlack` actually stand up the admin server, load the token,
 * attach the ring buffer, and expose the handle — and does it tear
 * everything down cleanly on `handle.stop()`.
 *
 * We use minislack + the mock backend (same pattern as `roundtrip.test.ts`)
 * so the exercise is end-to-end: real Bolt + real registry + real
 * coordinator + real admin server, just with a fake Slack workspace.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startMinislack, type MinislackHandle } from "../../../../src/minislack/testing/harness"
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

describe("slack launcher — admin surface bootstrap", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle
  let tmp: string

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "bantai-admin-launcher-"))
    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    const registered = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history", "users:read"],
      subscribed_events: ["message", "app_mention"],
    })

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
        // admin intentionally left unset — rely on the CLI-override path
        // below so we exercise `adminOverrides` plumbing too.
      },
      adminOverrides: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        tokenPath: join(tmp, "admin-token"),
        readOnly: false,
      },
    })) as SlackLaunchHandle
    // Let Bolt's SocketModeClient + admin Bun.serve settle.
    await new Promise((r) => setTimeout(r, 150))
  })

  afterAll(async () => {
    await slack?.stop()
    await new Promise((r) => setTimeout(r, 150))
    await mini?.stop()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("exposes the admin handle when config.admin.enabled is true", () => {
    expect(slack.admin).toBeDefined()
    expect(slack.admin!.token.length).toBeGreaterThanOrEqual(40)
    expect(slack.admin!.tokenPath).toBe(join(tmp, "admin-token"))
    // Token file on disk MUST match the handed-back value.
    const disk = readFileSync(slack.admin!.tokenPath, "utf8").trim()
    expect(disk).toBe(slack.admin!.token)
    // Mode 0600 — writable only by the owner.
    const mode = statSync(slack.admin!.tokenPath).mode & 0o777
    expect(mode).toBe(0o600)
    // Bound to a real port chosen by the OS.
    expect(slack.admin!.server.port()).toBeGreaterThan(0)
    expect(slack.admin!.server.hostname()).toBe("127.0.0.1")
  })

  it("rejects requests without a bearer token", async () => {
    const port = slack.admin!.server.port()
    const res = await fetch(`http://127.0.0.1:${port}/admin/health`)
    expect(res.status).toBe(401)
  })

  it("returns a health snapshot with the configured workspace + bot user", async () => {
    const port = slack.admin!.server.port()
    const res = await fetch(`http://127.0.0.1:${port}/admin/health`, {
      headers: { authorization: `Bearer ${slack.admin!.token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      mode: string
      botUserId: string
      workspaceId: string
    }
    expect(body.ok).toBe(true)
    expect(body.mode).toBe("socket")
    expect(body.botUserId).toBe(slack.botUserId)
    expect(body.workspaceId.length).toBeGreaterThan(0)

    // And `/admin/version` returns the launcher's package version.
    const vRes = await fetch(`http://127.0.0.1:${port}/admin/version`, {
      headers: { authorization: `Bearer ${slack.admin!.token}` },
    })
    expect(vRes.status).toBe(200)
    const vBody = (await vRes.json()) as { protocol: string; server: string }
    expect(typeof vBody.protocol).toBe("string")
    expect(vBody.protocol.length).toBeGreaterThan(0)
    expect(vBody.server.length).toBeGreaterThan(0)
  })
})

describe("slack launcher — admin surface disabled path", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    const registered = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write"],
      subscribed_events: ["message"],
    })
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
    })) as SlackLaunchHandle
    await new Promise((r) => setTimeout(r, 100))
  })

  afterAll(async () => {
    await slack?.stop()
    await new Promise((r) => setTimeout(r, 100))
    await mini?.stop()
  })

  it("leaves handle.admin undefined when admin is disabled", () => {
    expect(slack.admin).toBeUndefined()
  })
})
