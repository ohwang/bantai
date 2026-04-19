/**
 * S7 exit criterion — two channels pointed at two different project
 * configs (backend model / approvers / allowed_tools / claude_config_dir),
 * both handled by one launcher process with no cross-talk.
 *
 * We use the `multi-user` fixture (alice/bob/carol/dave + general/
 * engineering/design channels), register #engineering and #design as
 * bantai channels with *different* settings, and then drive one turn
 * into each. A single capturing backend records which SessionConfig it
 * was handed per channel — that's what tells us the plumbing actually
 * delivered the per-channel overrides to the backend spawn.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
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

interface CapturedHost {
  channelLabel: string
  sessionConfig: SessionConfig
  messages: UserMessage[]
}

function createCapturingBackend(capture: {
  channelLabel: string
  hosts: CapturedHost[]
}): { backend: AgentBackend; close: () => void } {
  const state = { messages: [] as UserMessage[], closed: false }
  let resolveEnd: (() => void) | null = null

  async function* start(config: SessionConfig): AsyncGenerator<ConversationEvent> {
    capture.hosts.push({
      channelLabel: capture.channelLabel,
      sessionConfig: config,
      messages: state.messages,
    })
    const endPromise = new Promise<void>((r) => {
      resolveEnd = r
    })
    yield {
      type: "session_init",
      tools: [],
      models: [],
      sessionId: `fake-${capture.channelLabel}`,
    }
    // Do nothing else — we only care about what SessionConfig arrived.
    await endPromise
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
      throw new Error("resume not supported")
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
  return { backend, close: () => backend.close() }
}

describe("slack frontend S7 — per-channel isolation", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle
  let botUserId: string
  let aliceId: string
  let bobId: string
  let daveId: string
  let engineeringId: string
  let designId: string
  const capturedHosts: CapturedHost[] = []

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "multi-user", serveWeb: false })
    const registered = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history"],
      subscribed_events: ["message", "app_mention"],
    })

    const engineering = Array.from(mini.workspace.channels.values()).find(
      (c) => "name" in c && c.name === "engineering",
    )
    const design = Array.from(mini.workspace.channels.values()).find(
      (c) => "name" in c && c.name === "design",
    )
    if (!engineering || !design) throw new Error("fixture missing channels")
    engineeringId = engineering.id
    designId = design.id
    aliceId = Array.from(mini.workspace.users.values()).find((u) => u.name === "alice")!.id
    bobId = Array.from(mini.workspace.users.values()).find((u) => u.name === "bob")!.id
    daveId = Array.from(mini.workspace.users.values()).find((u) => u.name === "dave")!.id
    joinChannel(mini.workspace, engineeringId, registered.botUser.id)
    joinChannel(mini.workspace, designId, registered.botUser.id)

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
          session_banner: false,
        },
        store_path: "",
        channels: [
          {
            id: engineeringId,
            name: "engineering",
            project_dir: "/tmp/eng-repo",
            model: "claude-opus-4-7",
            approvers: ["U0ENG_APPROVER"],
            allowed_tools: ["Read", "Grep"],
            claude_config_dir: "/tmp/claude/eng",
            system_prompt_append: "Be concise.",
            verbosity: "verbose",
          },
          {
            id: designId,
            name: "design",
            project_dir: "/tmp/design-repo",
            model: "claude-haiku-4-5",
            approvers: ["U0DES_APPROVER"],
            allowed_tools: ["Write"],
            claude_config_dir: "/tmp/claude/design",
            verbosity: "concise",
          },
        ],
      },
      buildHost: ({ project, sessionConfig }) => {
        const label = project.channelName ?? project.channelId
        const { backend } = createCapturingBackend({
          channelLabel: label,
          hosts: capturedHosts,
        })
        const subagentManager = new SubagentManager()
        const host = createSessionHost({
          backend,
          config: sessionConfig,
          subagentManager,
          currentBackend: "claude",
          close: () => backend.close(),
        })
        return { host, backend }
      },
    })) as SlackLaunchHandle
    botUserId = slack.botUserId
    slack.userCache.seed(aliceId, "alice")
    slack.userCache.seed(bobId, "bob")
    slack.userCache.seed(daveId, "dave")

    await new Promise((r) => setTimeout(r, 150))
  })

  afterAll(async () => {
    await slack?.stop()
    await new Promise((r) => setTimeout(r, 200))
    await mini?.stop()
    await new Promise((r) => setTimeout(r, 50))
  })

  it("each channel spawns a backend with its own per-channel SessionConfig", async () => {
    // Alice @mentions the bot in #engineering.
    await mini
      .asUser(aliceId)
      .sendMessage(engineeringId, `<@${botUserId}> hello from eng`)
    // Dave (a member of #design in the multi-user fixture) @mentions the bot.
    await mini
      .asUser(daveId)
      .sendMessage(designId, `<@${botUserId}> hello from design`)

    // Wait for both hosts to land.
    const start = Date.now()
    while (capturedHosts.length < 2 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(capturedHosts.length).toBeGreaterThanOrEqual(2)

    const eng = capturedHosts.find((h) => h.channelLabel === "engineering")
    const des = capturedHosts.find((h) => h.channelLabel === "design")
    expect(eng).toBeTruthy()
    expect(des).toBeTruthy()

    // Per-channel model / cwd / env / systemPrompt / allowedTools plumbed
    // through — no cross-contamination.
    expect(eng!.sessionConfig.model).toBe("claude-opus-4-7")
    expect(eng!.sessionConfig.cwd).toBe("/tmp/eng-repo")
    expect(eng!.sessionConfig.allowedTools).toEqual(["Read", "Grep"])
    expect(eng!.sessionConfig.systemPrompt).toBe("Be concise.")
    expect(eng!.sessionConfig.env?.CLAUDE_CONFIG_DIR).toBe("/tmp/claude/eng")

    expect(des!.sessionConfig.model).toBe("claude-haiku-4-5")
    expect(des!.sessionConfig.cwd).toBe("/tmp/design-repo")
    expect(des!.sessionConfig.allowedTools).toEqual(["Write"])
    expect(des!.sessionConfig.systemPrompt).toBeUndefined()
    expect(des!.sessionConfig.env?.CLAUDE_CONFIG_DIR).toBe("/tmp/claude/design")

    // Each backend only saw ITS own channel's user message.
    expect(eng!.messages.map((m) => m.text)).toEqual([
      expect.stringContaining("hello from eng"),
    ])
    expect(des!.messages.map((m) => m.text)).toEqual([
      expect.stringContaining("hello from design"),
    ])
  })
})
