/**
 * End-to-end metrics test — verifies the `/metrics` surface reflects
 * real registry + approval-coordinator activity.
 *
 * We don't exercise the HTTP endpoint itself (that requires a real port
 * + socket, which would fight with bun:test's concurrent runner). Instead
 * we wire the same MetricsCollector the launcher would and assert on the
 * rendered output after driving a full turn through the capturing backend.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { startMinislack, type MinislackHandle } from "../../../../src/minislack/testing/harness"
import { joinChannel } from "../../../../src/minislack/core/channels"
import { launchSlack, type SlackLaunchHandle } from "../../../../src/frontends/slack/launcher"
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

interface CapturedHost {
  emit: (e: ConversationEvent) => void
  messages: UserMessage[]
}

function makeCapturingBackend(capture: CapturedHost[]) {
  const state = { closed: false, messages: [] as UserMessage[] }
  let push: ((e: ConversationEvent) => void) | null = null
  let resolveEnd: (() => void) | null = null
  async function* start(_config: SessionConfig): AsyncGenerator<ConversationEvent> {
    void _config
    const queue: ConversationEvent[] = []
    let waiter: ((e: ConversationEvent) => void) | null = null
    push = (e) => {
      if (waiter) {
        const w = waiter
        waiter = null
        w(e)
      } else queue.push(e)
    }
    capture.push({ emit: (e) => push?.(e), messages: state.messages })
    const endPromise = new Promise<void>((r) => {
      resolveEnd = r
    })
    yield { type: "session_init", tools: [], models: [], sessionId: "sdk-metrics" }
    while (!state.closed) {
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      const nxt = await Promise.race([
        new Promise<ConversationEvent>((r) => {
          waiter = r
        }),
        endPromise.then(() => null),
      ])
      if (nxt === null) return
      yield nxt
    }
  }
  const backend: AgentBackend = {
    capabilities(): BackendCapabilities {
      return {
        name: "fake",
        supportsThinking: false,
        supportsToolApproval: false,
        supportsResume: false,
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
      throw new Error("unused")
    },
    sendMessage(m) {
      state.messages.push(m)
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
      throw new Error("unused")
    },
    close() {
      state.closed = true
      resolveEnd?.()
    },
  }
  return backend
}

describe("slack /metrics — registry + approval counters", () => {
  let mini: MinislackHandle
  let registered: ReturnType<MinislackHandle["registerApp"]>
  let aliceId: string
  let generalId: string

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    registered = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history"],
      subscribed_events: ["message", "app_mention"],
    })
    generalId = Array.from(mini.workspace.channels.values()).find(
      (c) => "name" in c && c.name === "general",
    )!.id
    aliceId = Array.from(mini.workspace.users.values()).find(
      (u) => u.name === "alice",
    )!.id
    joinChannel(mini.workspace, generalId, registered.botUser.id)
  })

  afterAll(async () => {
    await mini?.stop()
  })

  it("increments session + turn counters through a mock turn", async () => {
    const hosts: CapturedHost[] = []
    const slack = (await launchSlack({
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
          session_banner: false,
        },
        store_path: "",
      },
      buildHost: ({ project, sessionConfig }) => {
        void project
        const backend = makeCapturingBackend(hosts)
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
    slack.userCache.seed(aliceId, "alice")
    await new Promise((r) => setTimeout(r, 100))

    // Mention alice to open a session.
    await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${slack.botUserId}> metrics pls`)
    const start = Date.now()
    while (hosts.length === 0 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(hosts).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 50))

    // Drive one turn to completion.
    hosts[0]!.emit({ type: "turn_start" })
    hosts[0]!.emit({ type: "text_delta", text: "ok" })
    hosts[0]!.emit({ type: "text_complete", text: "ok" })
    hosts[0]!.emit({
      type: "turn_complete",
      usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0.05 },
    })
    await new Promise((r) => setTimeout(r, 150))

    const mid = slack.metrics.snapshot()
    expect(mid.counters["bantai_slack_turn_started_total"]).toBe(1)
    expect(mid.counters["bantai_slack_turn_completed_total"]).toBe(1)
    expect(mid.counters["bantai_slack_cost_usd_sum"]).toBeCloseTo(0.05, 5)
    expect(mid.gauges["bantai_slack_sessions_active"]).toBe(1)

    // The rendered Prometheus text reflects those counters verbatim.
    const rendered = slack.metrics.render()
    expect(rendered).toContain("bantai_slack_turn_started_total 1")
    expect(rendered).toContain("bantai_slack_turn_completed_total 1")
    expect(rendered).toContain("bantai_slack_sessions_active 1")
    expect(rendered).toMatch(/bantai_slack_cost_usd_sum 0\.05\b/)

    await slack.stop()
    expect(slack.registry.size()).toBe(0)
    // After shutdown the session-count gauge drops back to zero.
    expect(slack.metrics.snapshot().gauges["bantai_slack_sessions_active"]).toBe(0)
  }, 20_000)
})
