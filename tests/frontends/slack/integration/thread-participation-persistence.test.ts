/**
 * Integration test — thread-participation persistence across launcher restart.
 *
 * The bug being pinned down: before this change the gate's
 * `threadHasPriorBotPost` signal came from an in-memory cache that
 * evaporated on process death. A Slack thread the bot had happily been
 * serving would silently stop responding after a restart unless the user
 * re-mentioned `@bantai` on every reply.
 *
 * Flow:
 *   1. Launcher A boots on a SQLite store.
 *   2. Alice @-mentions the bot in the general channel → session opens,
 *      bot replies in a new thread. The outbound post runs through the
 *      send-adapter's `onPostSucceeded` hook, which calls the
 *      thread-participation cache → `store.recordThreadPost`.
 *   3. Stop launcher A (stand-in for a crash/deploy).
 *   4. Launcher B boots on the same SQLite store. Its
 *      ThreadParticipationCache is store-backed, so `has(channel,threadTs)`
 *      sees the prior participation row.
 *   5. Alice posts IN THE THREAD without `@bantai`. The gate accepts via
 *      `threadHasPriorBotPost`, the registry rehydrates the session with
 *      `resume: sdk-session-A`, and the backend's capturing harness sees
 *      the inbound UserMessage.
 *
 * The assertion target is that launcher B's capturing backend receives
 * the follow-up user turn — if the gate had rejected the no-mention
 * message, no backend would have been constructed at all.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startMinislack, type MinislackHandle } from "../../../../src/minislack/testing/harness"
import { joinChannel } from "../../../../src/minislack/core/channels"
import {
  launchSlack,
  type SlackLaunchHandle,
} from "../../../../src/frontends/slack/launcher"
import type { CLIFlags } from "../../../../src/cli/options"
import type {
  AgentBackend,
  BackendCapabilities,
  ConversationEvent,
  ModelInfo,
  SessionConfig,
  SessionInfo,
  UserMessage,
} from "../../../../src/protocol/types"
import { createSessionHost } from "../../../../src/session/host"
import { SubagentManager } from "../../../../src/subagents/manager"

const BASE_FLAGS: CLIFlags = {
  config: {},
  backend: "claude",
  help: false,
  version: false,
  debug: false,
  debugBackend: false,
  noDiagnosticsMcp: true,
}

interface CapturedStart {
  label: string
  sessionConfig: SessionConfig
  messages: UserMessage[]
  emit: (e: ConversationEvent) => void
}

function createCapturingBackend(
  capture: { label: string; sessionIdToEmit: string; hosts: CapturedStart[] },
): { backend: AgentBackend } {
  const state = { messages: [] as UserMessage[], closed: false }
  let pushEvent: ((e: ConversationEvent) => void) | null = null
  let resolveEnd: (() => void) | null = null

  async function* start(config: SessionConfig): AsyncGenerator<ConversationEvent> {
    const queue: ConversationEvent[] = []
    let waiter: ((e: ConversationEvent) => void) | null = null
    pushEvent = (e) => {
      if (waiter) {
        const w = waiter
        waiter = null
        w(e)
      } else queue.push(e)
    }
    capture.hosts.push({
      label: capture.label,
      sessionConfig: config,
      messages: state.messages,
      emit: (e) => pushEvent?.(e),
    })
    const endPromise = new Promise<void>((r) => {
      resolveEnd = r
    })
    yield {
      type: "session_init",
      tools: [],
      models: [],
      sessionId: capture.sessionIdToEmit,
    }
    while (!state.closed) {
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      const next = await Promise.race([
        new Promise<ConversationEvent>((r) => {
          waiter = r
        }),
        endPromise.then(() => null),
      ])
      if (next === null) return
      yield next
    }
  }

  const backend: AgentBackend = {
    capabilities(): BackendCapabilities {
      return {
        name: "fake",
        supportsThinking: false,
        supportsToolApproval: false,
        supportsResume: true,
        supportsContinue: false,
        supportsFork: false,
        supportsStreaming: true,
        supportsSubagents: false,
        supportsCompact: false,
        supportedPermissionModes: ["default"],
      }
    },
    start,
    resume() {
      throw new Error("resume via separate method not supported; use start()")
    },
    sendMessage(msg) {
      state.messages.push(msg)
    },
    interrupt() {},
    approveToolUse() {},
    denyToolUse() {},
    respondToElicitation() {},
    cancelElicitation() {},
    async setModel() {},
    async setPermissionMode() {},
    async setEffort() {},
    async availableModels(): Promise<ModelInfo[]> { return [] },
    async listSessions(): Promise<SessionInfo[]> { return [] },
    async forkSession(): Promise<string> {
      throw new Error("fork not supported")
    },
    close() {
      state.closed = true
      resolveEnd?.()
    },
  }
  return { backend }
}

describe("slack frontend — thread-participation persistence across restart", () => {
  let mini: MinislackHandle
  let storeDir: string
  let storePath: string
  let botUserId: string
  let aliceId: string
  let generalId: string
  let registered: ReturnType<MinislackHandle["registerApp"]>

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    registered = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history"],
      subscribed_events: ["message", "app_mention"],
    })
    const general = Array.from(mini.workspace.channels.values()).find(
      (c) => "name" in c && c.name === "general",
    )!
    generalId = general.id
    aliceId = Array.from(mini.workspace.users.values()).find((u) => u.name === "alice")!.id
    joinChannel(mini.workspace, generalId, registered.botUser.id)

    storeDir = mkdtempSync(join(tmpdir(), "bantai-thread-part-"))
    storePath = join(storeDir, "slack.db")
  })

  afterAll(async () => {
    await mini?.stop()
    await new Promise((r) => setTimeout(r, 50))
    try {
      rmSync(storeDir, { recursive: true, force: true })
    } catch {}
  })

  it("launcher B accepts a no-mention thread reply because participation persisted", async () => {
    // ---- Launcher A — first boot, bot posts in thread. ----
    const hostsA: CapturedStart[] = []
    const slackA = (await launchSlack({
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
          session_banner: false,
        },
        store_path: storePath,
      },
      buildHost: ({ project, sessionConfig }) => {
        void project
        const { backend } = createCapturingBackend({
          label: "A",
          sessionIdToEmit: "sdk-session-A",
          hosts: hostsA,
        })
        const host = createSessionHost({
          backend,
          config: sessionConfig,
          subagentManager: new SubagentManager(),
          currentBackend: "claude",
          close: () => backend.close(),
        })
        return { host, backend }
      },
    })) as SlackLaunchHandle
    botUserId = slackA.botUserId
    slackA.userCache.seed(aliceId, "alice")
    await new Promise((r) => setTimeout(r, 150))

    // Turn 1 — alice @-mentions, bot replies. The reply flows through the
    // send-adapter's onPostSucceeded hook → recordThreadPost persists.
    const firstMessage = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> hello bot`)
    const threadTs = firstMessage.ts
    const startMs = Date.now()
    while (hostsA.length === 0 && Date.now() - startMs < 5000) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(hostsA.length).toBe(1)

    await new Promise((r) => setTimeout(r, 100))
    hostsA[0]!.emit({ type: "turn_start" })
    hostsA[0]!.emit({ type: "text_delta", text: "hi alice" })
    hostsA[0]!.emit({ type: "text_complete", text: "hi alice" })
    hostsA[0]!.emit({
      type: "turn_complete",
      usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.01 },
    })
    // Give the outbox + participation-record pipeline a beat to flush.
    await new Promise((r) => setTimeout(r, 300))

    // Sanity: the store has a participation row for (generalId, threadTs).
    // Open a fresh handle so we don't race launcher A's handle.
    {
      const { createSessionStore } = await import(
        "../../../../src/frontends/slack/store/sessions"
      )
      const inspect = createSessionStore({ path: storePath })
      expect(inspect.hasThreadPost(generalId, threadTs)).toBe(true)
      inspect.close()
    }

    await slackA.stop()
    await new Promise((r) => setTimeout(r, 200))

    // ---- Launcher B — cold boot on the same SQLite store. ----
    const hostsB: CapturedStart[] = []
    const slackB = (await launchSlack({
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
          // require_mention: true means the gate falls back to the
          // thread-participation signal for follow-ups with no `@bantai`.
          require_mention: true,
          auto_join_threads: true,
          session_banner: false,
        },
        store_path: storePath,
      },
      buildHost: ({ project, sessionConfig }) => {
        void project
        const { backend } = createCapturingBackend({
          label: "B",
          sessionIdToEmit: "sdk-session-B",
          hosts: hostsB,
        })
        const host = createSessionHost({
          backend,
          config: sessionConfig,
          subagentManager: new SubagentManager(),
          currentBackend: "claude",
          close: () => backend.close(),
        })
        return { host, backend }
      },
    })) as SlackLaunchHandle
    slackB.userCache.seed(aliceId, "alice")
    await new Promise((r) => setTimeout(r, 150))

    // Alice posts in the thread WITHOUT an @mention. Pre-fix, the gate
    // would reject this with `no-mention-in-channel` — the in-memory
    // thread-participation cache was wiped by launcher A's stop. Post-fix,
    // the store-backed cache sees the row and the gate accepts via
    // `threadHasPriorBotPost`.
    await mini
      .asUser(aliceId)
      .sendMessage(generalId, "follow-up with no mention", { thread_ts: threadTs })
    const startMsB = Date.now()
    while (hostsB.length === 0 && Date.now() - startMsB < 5000) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(hostsB.length).toBe(1)
    // Rehydrated session — carried launcher A's persisted session id.
    expect(hostsB[0]!.sessionConfig.resume).toBe("sdk-session-A")

    // The backend should have received the user turn (the gate let it
    // through, dispatch went all the way to entry.send).
    const sawUserTurn = await waitFor(
      () => hostsB[0]!.messages.length > 0,
      2_000,
    )
    expect(sawUserTurn).toBe(true)
    expect(hostsB[0]!.messages[0]!.text).toContain("follow-up with no mention")

    await slackB.stop()
  })
})

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return cond()
}
