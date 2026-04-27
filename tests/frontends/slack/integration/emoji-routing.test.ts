/**
 * Integration test for the emoji-based backend router.
 *
 * Drives the full pipeline (transport → routing → emoji-router → registry
 * → SessionHost → banner) against an in-process minislack. Asserts on the
 * session banner posted to the channel — its body carries:
 *
 *   - `backend <id>` — the backend the router actually picked
 *   - `routed via :emoji: → <Label>` — the emoji-route summary line
 *
 * To avoid spawning real codex/gemini binaries (or hitting the real Claude
 * API) inside the test, we monkey-patch every `factory` in
 * `BACKEND_REGISTRY` to return `MockAdapter` for the duration of the suite.
 * The original factories are restored in afterAll. The unit-tested parser
 * (`tests/frontends/slack/router/emoji-router.test.ts`) covers the
 * keyword/route table; this file only verifies the wiring through routing.ts.
 *
 * What gets asserted:
 *
 *   1. `:claude:` in the root message → session.project.backend === "claude"
 *      and the banner shows "routed via :claude: → Claude".
 *   2. `:openai:` (substring matches `openai`) → backend === "codex".
 *   3. `:opus:` → backend === "claude" AND model === "claude-opus-4-7".
 *   4. No emoji → falls back to channel default backend ("mock"), no
 *      "routed via" line in the banner.
 *   5. Emoji in a follow-up reply (after the session is open) is IGNORED
 *      — flipping the backend mid-thread would break resume semantics.
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
import {
  BACKEND_REGISTRY,
  type BackendDescriptor,
} from "../../../../src/protocol/registry"
import { MockAdapter } from "../../../../src/backends/mock/adapter"

const BASE_FLAGS: CLIFlags = {
  config: {},
  backend: "claude",
  help: false,
  version: false,
  debug: false,
  debugBackend: false,
  noDiagnosticsMcp: true,
}

describe("emoji-based backend routing — minislack integration", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle
  let botUserId: string
  let aliceId: string
  let generalId: string

  // Snapshot the original backend factories so we can restore them in
  // afterAll. Tests run inside the same Bun process as everything else,
  // and the registry is module-level state — leaking a mock factory
  // would silently break later test suites that expect e.g. ClaudeAdapter.
  const savedFactories: Array<{
    descriptor: BackendDescriptor
    factory?: BackendDescriptor["factory"]
    isAvailable: BackendDescriptor["isAvailable"]
  }> = []

  beforeAll(async () => {
    // Override every backend's factory to return MockAdapter, so
    // emoji-routed sessions actually start and emit session_init without
    // shelling out to codex/gemini/etc. We also force `isAvailable: true`
    // for backends that gate on `binaryOnPath(...)` so the registry isn't
    // the thing rejecting the route.
    for (const desc of BACKEND_REGISTRY) {
      savedFactories.push({
        descriptor: desc,
        factory: desc.factory,
        isAvailable: desc.isAvailable,
      })
      desc.factory = () => new MockAdapter()
      desc.isAvailable = () => true
    }

    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    const registered = mini.registerApp({
      name: "bantai",
      scopes: [
        "chat:write",
        "app_mentions:read",
        "channels:history",
        "users:read",
      ],
      subscribed_events: ["message", "app_mention"],
    })

    const general = Array.from(mini.workspace.channels.values()).find(
      (c) =>
        (c.is_channel === true || c.is_group === true) &&
        "name" in c &&
        c.name === "general",
    )
    if (!general) throw new Error("fixture missing #general")
    generalId = general.id
    aliceId = Array.from(mini.workspace.users.values()).find(
      (u) => u.name === "alice",
    )!.id
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
          // We want banners — they're what we assert on for routing.
          session_banner: true,
          // Disable thread-history prefetch so the suite stays
          // deterministic (no extra messages.history calls).
          thread_history_limit: 0,
        },
        store_path: "",
      },
    })) as SlackLaunchHandle
    botUserId = slack.botUserId
    slack.userCache.seed(aliceId, "alice")

    // Bolt's SocketModeClient needs a beat to open the WS.
    await new Promise((r) => setTimeout(r, 200))
  })

  afterAll(async () => {
    await slack?.stop()
    await new Promise((r) => setTimeout(r, 250))
    await mini?.stop()
    await new Promise((r) => setTimeout(r, 50))

    // Restore the original backend descriptors so subsequent suites in
    // the same process see the real factories.
    for (const saved of savedFactories) {
      if (saved.factory) saved.descriptor.factory = saved.factory
      else delete saved.descriptor.factory
      saved.descriptor.isAvailable = saved.isAvailable
    }
  })

  // -------------------------------------------------------------------------

  it(":claude: in the root message routes the new session to the claude backend", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> :claude: hello agent`)

    // Banner posts on session_init; wait for it to land.
    const banner = await waitForBanner(mini, generalId, parent.ts)
    expect(banner).toContain("backend claude")
    expect(banner).toContain("routed via :claude: → Claude")

    // Cross-check the registry — the SessionEntry's resolved project
    // should reflect the routed backend, not the channel default.
    const entry = peekEntry(slack, generalId, parent.ts)
    expect(entry?.project.backend).toBe("claude")
  })

  it(":openai: routes to the codex backend (substring keyword)", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> :openai: please`)

    const banner = await waitForBanner(mini, generalId, parent.ts)
    expect(banner).toContain("backend codex")
    expect(banner).toContain("routed via :openai:")

    const entry = peekEntry(slack, generalId, parent.ts)
    expect(entry?.project.backend).toBe("codex")
  })

  it(":opus: routes to claude AND pins the model to claude-opus-4-7", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> :opus: analyse this`)

    const banner = await waitForBanner(mini, generalId, parent.ts)
    expect(banner).toContain("backend claude")
    expect(banner).toContain("model claude-opus-4-7")
    expect(banner).toContain("routed via :opus:")

    const entry = peekEntry(slack, generalId, parent.ts)
    expect(entry?.project.backend).toBe("claude")
    expect(entry?.project.model).toBe("claude-opus-4-7")
  })

  it("no routing emoji → falls back to the channel default and the banner has no 'routed via' line", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> hello with no emoji`)

    const banner = await waitForBanner(mini, generalId, parent.ts)
    expect(banner).toContain("backend mock")
    expect(banner).not.toContain("routed via")

    const entry = peekEntry(slack, generalId, parent.ts)
    expect(entry?.project.backend).toBe("mock")
  })

  it("emoji in a thread reply is IGNORED — the existing session keeps its backend", async () => {
    // Open a session with the channel default (mock).
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> open a session`)
    await waitForBanner(mini, generalId, parent.ts)
    const before = peekEntry(slack, generalId, parent.ts)?.project.backend
    expect(before).toBe("mock")

    // Now follow up inside the same thread with a routing emoji. The
    // router only fires on FIRST-message-of-thread (i.e.
    // `!hadExistingSession`) so this must NOT flip the backend.
    await mini
      .asUser(aliceId)
      .sendMessage(generalId, ":claude: actually use Claude please", {
        thread_ts: parent.ts,
      })
    // Give the inbound a moment to route; we don't expect a banner.
    await new Promise((r) => setTimeout(r, 250))
    const after = peekEntry(slack, generalId, parent.ts)?.project.backend
    expect(after).toBe("mock")
  })
})

// ---------------------------------------------------------------------------
// Helpers — small + scoped to this suite. Mirrors the conventions in
// roundtrip.test.ts so anyone who's read that file recognises the shape.
// ---------------------------------------------------------------------------

/**
 * Look up the first banner posted in the given thread. The banner is the
 * `chat.postMessage` whose blocks contain a `context` element with the
 * `bantai session started` / `bantai session resumed` text. Returns the
 * combined mrkdwn text of that block, or undefined when no banner has
 * been posted yet.
 */
function findBannerText(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): string | undefined {
  const ch = mini.workspace.channels.get(channelId)
  if (!ch) return undefined
  for (const msg of ch.messages.values()) {
    if (msg.thread_ts !== parentTs || msg.ts === parentTs) continue
    const blocks = (msg as { blocks?: unknown }).blocks
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "context"
      ) {
        const elements = (block as { elements?: unknown[] }).elements ?? []
        for (const el of elements) {
          const text = (el as { text?: string }).text
          if (typeof text === "string" && text.includes("bantai session")) {
            return text
          }
        }
      }
    }
  }
  return undefined
}

async function waitForBanner(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
  timeoutMs = 5000,
): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const text = findBannerText(mini, channelId, parentTs)
    if (text) return text
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(
    `waitForBanner: no session banner appeared in ${channelId}:${parentTs} within ${timeoutMs}ms`,
  )
}

function peekEntry(
  slack: SlackLaunchHandle,
  channelId: string,
  threadTs: string,
): { project: { backend: string; model?: string } } | undefined {
  // Walk every live entry the registry knows about and find the one
  // whose key matches our (channel, thread). Avoids hard-coding the
  // minislack fixture's workspace id (`T0001`) — the key shape is
  // `slack:<workspace>:<channel>:<threadTs|main>`, so we just split on
  // `:` and match the parts we care about.
  const all = slack.registry.entries()
  for (const entry of all) {
    const parts = entry.key.split(":")
    if (parts.length !== 4) continue
    if (parts[2] !== channelId) continue
    if (parts[3] !== threadTs && parts[3] !== "main") continue
    return entry
  }
  return undefined
}
