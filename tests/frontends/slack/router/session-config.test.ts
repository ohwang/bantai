import { describe, expect, it } from "bun:test"
import { buildSessionConfigFromProject } from "../../../../src/frontends/slack/router/registry"
import type { ProjectConfig } from "../../../../src/frontends/slack/router/resolver"

function fakeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    channelId: "C0TEST",
    projectDir: "/tmp/proj",
    backend: "claude",
    approvers: [],
    verbosity: "normal",
    requireMention: true,
    permissionMode: "default",
    triggerName: "bantai",
    controlPrefix: "!bantai",
    sessionBanner: true,
    showCost: false,
    autoJoinThreads: true,
    threadRequireExplicitMention: false,
    threadHistoryLimit: 0,
    interactiveReplies: false,
    debounceMs: 0,
    nativeStreaming: false,
    turnTimeoutS: 0,
    maxBudgetUsd: 0,
    env: {},
    ...overrides,
  }
}

describe("buildSessionConfigFromProject", () => {
  it("passes cwd, model, systemPromptAppend, allowedTools through", () => {
    const cfg = buildSessionConfigFromProject(
      fakeProject({
        model: "claude-opus-4-7",
        systemPromptAppend: "Be terse.",
        allowedTools: ["Read", "Grep"],
      }),
    )
    expect(cfg.cwd).toBe("/tmp/proj")
    expect(cfg.model).toBe("claude-opus-4-7")
    expect(cfg.systemPrompt).toBe("Be terse.")
    expect(cfg.allowedTools).toEqual(["Read", "Grep"])
  })

  it("omits missing optional fields rather than setting them to undefined", () => {
    const cfg = buildSessionConfigFromProject(fakeProject())
    expect("model" in cfg).toBe(false)
    expect("systemPrompt" in cfg).toBe(false)
    expect("allowedTools" in cfg).toBe(false)
    expect("env" in cfg).toBe(false)
  })

  it("injects CLAUDE_CONFIG_DIR into env for the claude backend", () => {
    const cfg = buildSessionConfigFromProject(
      fakeProject({
        backend: "claude",
        claudeConfigDir: "/tmp/claude-cfg/channel-a",
      }),
    )
    expect(cfg.env).toEqual({
      CLAUDE_CONFIG_DIR: "/tmp/claude-cfg/channel-a",
    })
  })

  it("injects CLAUDE_CONFIG_DIR regardless of backend (ignored by non-claude backends at runtime)", () => {
    const cfg = buildSessionConfigFromProject(
      fakeProject({
        backend: "codex",
        claudeConfigDir: "/tmp/claude-cfg/channel-a",
      }),
    )
    expect(cfg.env).toEqual({ CLAUDE_CONFIG_DIR: "/tmp/claude-cfg/channel-a" })
  })

  it("merges project.env on top of CLAUDE_CONFIG_DIR", () => {
    const cfg = buildSessionConfigFromProject(
      fakeProject({
        backend: "claude",
        claudeConfigDir: "/tmp/claude-cfg/channel-a",
        env: { FOO: "bar", NPM_CONFIG_CACHE: "/tmp/npm-a" },
      }),
    )
    expect(cfg.env).toEqual({
      FOO: "bar",
      NPM_CONFIG_CACHE: "/tmp/npm-a",
      CLAUDE_CONFIG_DIR: "/tmp/claude-cfg/channel-a",
    })
  })

  it("overlay wins over ProjectConfig-derived fields", () => {
    const cfg = buildSessionConfigFromProject(
      fakeProject({ model: "claude-opus-4-7" }),
      { model: "claude-haiku-4-5", permissionMode: "plan" },
    )
    expect(cfg.model).toBe("claude-haiku-4-5")
    expect(cfg.permissionMode).toBe("plan")
    expect(cfg.cwd).toBe("/tmp/proj")
  })

  it("project.env without claudeConfigDir still flows into env", () => {
    const cfg = buildSessionConfigFromProject(
      fakeProject({
        backend: "claude",
        env: { MY_TOKEN: "abc" },
      }),
    )
    expect(cfg.env).toEqual({ MY_TOKEN: "abc" })
  })
})
