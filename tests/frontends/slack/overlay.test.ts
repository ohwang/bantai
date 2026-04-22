/**
 * Tests for `buildSessionMcpOverlay` — the per-session overlay that wires
 * the slack_upload tool into every backend (not just Claude). The overlay
 * emits both an in-process SDK MCP (`mcpServers.bantai-slack-upload`) and
 * a backend-agnostic stdio spec (`stdioMcpServers.bantai-slack-upload`);
 * each adapter picks the one it supports.
 */

import { describe, expect, it } from "bun:test"
import { buildSessionMcpOverlay } from "../../../src/frontends/slack/routing"
import type { ProjectConfig } from "../../../src/frontends/slack/router/resolver"

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    channelId: "C1",
    channelName: "proj",
    projectDir: "/tmp/proj",
    backend: "claude",
    model: undefined,
    claudeConfigDir: undefined,
    systemPrompt: undefined,
    allowedTools: undefined,
    mcpServers: undefined,
    resolvedMcpServers: undefined,
    approvers: [],
    permissionMode: "default",
    verbosity: "normal",
    requireMention: true,
    triggerName: "@bantai",
    sessionBanner: false,
    showCost: false,
    autoJoinThreads: true,
    threadRequireExplicitMention: false,
    threadHistoryLimit: 0,
    interactiveReplies: true,
    debounceMs: 0,
    nativeStreaming: false,
    turnTimeoutS: 0,
    maxBudgetUsd: 0,
    env: {},
    ...overrides,
  } as ProjectConfig
}

const fakeInProcess = () =>
  ({
    name: "bantai-slack-upload",
    instance: { __fake: true },
    type: "sdk" as const,
  }) as unknown as ReturnType<
    Parameters<typeof buildSessionMcpOverlay>[0]["slackUploadMcp"]
  >

describe("buildSessionMcpOverlay", () => {
  it("emits both mcpServers + stdioMcpServers when both factories are provided", () => {
    const overlay = buildSessionMcpOverlay({
      project: makeProject(),
      channel: "C1",
      threadTs: "1.0",
      slackUploadMcp: fakeInProcess,
      slackUploadStdioSpec: (channel, threadTs, cwd) => ({
        command: "/usr/bin/bantai",
        args: ["slack", "mcp-upload-server"],
        env: {
          BANTAI_SLACK_CHANNEL: channel,
          BANTAI_SLACK_THREAD_TS: threadTs,
          BANTAI_SLACK_CWD: cwd,
          BANTAI_SLACK_BOT_TOKEN: "xoxb-fake",
        },
      }),
    })
    expect(overlay).toBeDefined()
    expect(overlay!.mcpServers).toBeDefined()
    expect(overlay!.mcpServers!["bantai-slack-upload"]).toBeDefined()
    expect(overlay!.stdioMcpServers).toBeDefined()
    expect(overlay!.stdioMcpServers!["bantai-slack-upload"]!.command).toBe(
      "/usr/bin/bantai",
    )
    expect(
      overlay!.stdioMcpServers!["bantai-slack-upload"]!.env!["BANTAI_SLACK_CHANNEL"],
    ).toBe("C1")
  })

  it("omits stdioMcpServers when the factory returns undefined (no bot token)", () => {
    const overlay = buildSessionMcpOverlay({
      project: makeProject(),
      channel: "C1",
      threadTs: "1.0",
      slackUploadMcp: fakeInProcess,
      slackUploadStdioSpec: () => undefined,
    })
    expect(overlay!.mcpServers).toBeDefined()
    expect(overlay!.stdioMcpServers).toBeUndefined()
  })

  it("merges project.resolvedMcpServers into the in-process mcpServers", () => {
    const overlay = buildSessionMcpOverlay({
      project: makeProject({
        resolvedMcpServers: {
          "user-thing": { type: "stdio", command: "x" } as unknown as never,
        },
      }),
      channel: "C1",
      threadTs: "1.0",
      slackUploadMcp: fakeInProcess,
    })
    expect(overlay!.mcpServers!["user-thing"]).toBeDefined()
    expect(overlay!.mcpServers!["bantai-slack-upload"]).toBeDefined()
  })

  it("attaches a Slack-context preamble via appendSystemPrompt that names the channel/thread and the slack_upload tool", () => {
    const overlay = buildSessionMcpOverlay({
      project: makeProject(),
      channel: "CHANNEL_X",
      threadTs: "17000.001",
      slackUploadMcp: fakeInProcess,
    })
    const preamble = overlay!.appendSystemPrompt
    expect(preamble).toBeDefined()
    expect(preamble).toContain("CHANNEL_X")
    expect(preamble).toContain("17000.001")
    expect(preamble).toContain("slack_upload")
    expect(preamble).toContain("PROACTIVELY")
  })
})
