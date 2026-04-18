import { describe, expect, it } from "bun:test"
import { loadSlackConfig } from "../../../../src/frontends/slack/config/loader"
import {
  resolveMcpServersForChannel,
  resolveProjectForChannel,
} from "../../../../src/frontends/slack/router/resolver"
import type { McpServerSpec } from "../../../../src/frontends/slack/config/schema"

async function makeConfig(inline: unknown, env: NodeJS.ProcessEnv = {}) {
  return await loadSlackConfig({ inline, env })
}

describe("resolveProjectForChannel", () => {
  it("falls back to defaults + launchCwd when channel is not declared", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      defaults: { backend: "claude", model: "claude-sonnet-4-6" },
    })
    const proj = resolveProjectForChannel(cfg, "CUNKNOWN", { launchCwd: "/tmp/project" })
    expect(proj.channelId).toBe("CUNKNOWN")
    expect(proj.projectDir).toBe("/tmp/project")
    expect(proj.backend).toBe("claude")
    expect(proj.model).toBe("claude-sonnet-4-6")
    expect(proj.requireMention).toBe(true)
    expect(proj.approvers).toEqual([])
    expect(proj.verbosity).toBe("normal")
    expect(proj.triggerName).toBe("bantai")
  })

  it("applies channel override on top of defaults", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      defaults: { backend: "claude", model: "claude-sonnet-4-6", require_mention: true, verbosity: "normal" },
      channels: [
        {
          id: "C0BACKEND",
          name: "eng-backend",
          project_dir: "/home/me/dev/backend",
          backend: "codex",
          model: "gpt-5-codex",
          approvers: ["U0ALICE", "U0BOB"],
          verbosity: "verbose",
          require_mention: false,
        },
      ],
    })
    const proj = resolveProjectForChannel(cfg, "C0BACKEND", { launchCwd: "/ignored" })
    expect(proj.channelName).toBe("eng-backend")
    expect(proj.projectDir).toBe("/home/me/dev/backend")
    expect(proj.backend).toBe("codex")
    expect(proj.model).toBe("gpt-5-codex")
    expect(proj.approvers).toEqual(["U0ALICE", "U0BOB"])
    expect(proj.verbosity).toBe("verbose")
    expect(proj.requireMention).toBe(false)
  })

  it("channel override leaves defaults in place for unset keys", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      defaults: { verbosity: "debug", approvers: ["U0DEFAULT"] },
      channels: [
        {
          id: "C0PARTIAL",
          project_dir: "/home/me/dev/partial",
          // no verbosity override, no approvers override
        },
      ],
    })
    const proj = resolveProjectForChannel(cfg, "C0PARTIAL", { launchCwd: "/ignored" })
    expect(proj.verbosity).toBe("debug")
    expect(proj.approvers).toEqual(["U0DEFAULT"])
  })

  it("resolves env-indirected overrides to concrete strings", async () => {
    const cfg = await makeConfig(
      {
        workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
        channels: [
          {
            id: "C0ENV",
            env: {
              ANTHROPIC_API_KEY: { env: "BANTAI_TEST_KEY" },
              STATIC: "literal-value",
            },
          },
        ],
      },
      { BANTAI_TEST_KEY: "secret-abc" },
    )
    const proj = resolveProjectForChannel(
      cfg,
      "C0ENV",
      { launchCwd: "/cwd", env: { BANTAI_TEST_KEY: "secret-abc" } },
    )
    expect(proj.env.ANTHROPIC_API_KEY).toBe("secret-abc")
    expect(proj.env.STATIC).toBe("literal-value")
  })

  it("drops env refs whose vars are missing (no fallback noise)", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      channels: [{ id: "C0MISSING", env: { MISSING: { env: "NOT_SET" } } }],
    })
    const proj = resolveProjectForChannel(cfg, "C0MISSING", { launchCwd: "/cwd", env: {} })
    expect(proj.env.MISSING).toBeUndefined()
    expect(Object.keys(proj.env).length).toBe(0)
  })

  it("parses the global mcp_servers registry and filters per-channel", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      mcp_servers: {
        git: { command: "mcp-git", args: ["--repo", "."] },
        search: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer token" },
        },
      },
      channels: [{ id: "C0MCP", mcp_servers: ["git"] }],
    })
    expect(Object.keys(cfg.mcpServers)).toEqual(["git", "search"])
    const proj = resolveProjectForChannel(cfg, "C0MCP", { launchCwd: "/cwd" })
    expect(proj.resolvedMcpServers).toBeDefined()
    expect(Object.keys(proj.resolvedMcpServers!)).toEqual(["git"])
    const git = proj.resolvedMcpServers!["git"]
    expect(git).toEqual({ command: "mcp-git", args: ["--repo", "."] })
  })

  it("channels without mcp_servers leave resolvedMcpServers undefined", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      mcp_servers: { git: { command: "mcp-git" } },
      channels: [{ id: "C0NO_MCP" }],
    })
    const proj = resolveProjectForChannel(cfg, "C0NO_MCP", { launchCwd: "/cwd" })
    expect(proj.resolvedMcpServers).toBeUndefined()
  })
})

describe("resolveMcpServersForChannel", () => {
  const registry: Record<string, McpServerSpec> = {
    git: { command: "mcp-git", args: [] },
    search: { type: "http", url: "https://example.com/mcp" },
  }

  it("returns undefined when the channel doesn't opt in", () => {
    expect(resolveMcpServersForChannel(registry, undefined, "C0")).toBeUndefined()
  })
  it("returns {} when the channel explicitly disables all servers", () => {
    expect(resolveMcpServersForChannel(registry, [], "C0")).toEqual({})
  })
  it("returns the named subset", () => {
    expect(resolveMcpServersForChannel(registry, ["git"], "C0")).toEqual({
      git: { command: "mcp-git", args: [] },
    })
  })
  it("drops unknown names but keeps the known ones", () => {
    const out = resolveMcpServersForChannel(registry, ["git", "typo"], "C0")
    expect(Object.keys(out!)).toEqual(["git"])
  })
})
