import { describe, expect, it } from "bun:test"
import { loadSlackConfig } from "../../../../src/frontends/slack/config/loader"
import {
  composeSystemPrompt,
  isChannelConfigured,
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

  describe("agentIdentity", () => {
    it("is undefined when neither defaults nor override supply fields", async () => {
      const cfg = await makeConfig({
        workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
        channels: [{ id: "C0NOID" }],
      })
      const proj = resolveProjectForChannel(cfg, "C0NOID", { launchCwd: "/cwd" })
      expect(proj.agentIdentity).toBeUndefined()
    })

    it("picks up defaults-level identity when channel omits", async () => {
      const cfg = await makeConfig({
        workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
        defaults: {
          agent_username: "bantai-default",
          agent_icon_emoji: ":robot_face:",
        },
        channels: [{ id: "C0DEF" }],
      })
      const proj = resolveProjectForChannel(cfg, "C0DEF", { launchCwd: "/cwd" })
      expect(proj.agentIdentity).toEqual({
        username: "bantai-default",
        iconEmoji: ":robot_face:",
      })
    })

    it("channel override fields win field-by-field (not all-or-nothing)", async () => {
      // Real-world: defaults set a shared icon, a single channel retitles
      // the bot. The icon should still come from defaults.
      const cfg = await makeConfig({
        workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
        defaults: {
          agent_username: "bantai",
          agent_icon_emoji: ":robot_face:",
        },
        channels: [
          { id: "C0OVR", agent_username: "Reviewer" },
        ],
      })
      const proj = resolveProjectForChannel(cfg, "C0OVR", { launchCwd: "/cwd" })
      expect(proj.agentIdentity).toEqual({
        username: "Reviewer",
        iconEmoji: ":robot_face:",
      })
    })

    it("accepts icon_url from the channel override", async () => {
      const cfg = await makeConfig({
        workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
        channels: [
          {
            id: "C0URL",
            agent_username: "Refactor-bot",
            agent_icon_url: "https://example.com/icon.png",
          },
        ],
      })
      const proj = resolveProjectForChannel(cfg, "C0URL", { launchCwd: "/cwd" })
      expect(proj.agentIdentity).toEqual({
        username: "Refactor-bot",
        iconUrl: "https://example.com/icon.png",
      })
    })
  })
})

describe("isChannelConfigured", () => {
  it("returns false when channels[] is empty (self-host mode)", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
    })
    expect(isChannelConfigured(cfg, "CANYTHING")).toBe(false)
  })

  it("returns true for a channel declared in channels[]", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      channels: [{ id: "C0MAPPED", project_dir: "/tmp/repo" }],
    })
    expect(isChannelConfigured(cfg, "C0MAPPED")).toBe(true)
  })

  it("returns false for a channel missing from a non-empty channels[]", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      channels: [{ id: "C0MAPPED", project_dir: "/tmp/repo" }],
    })
    expect(isChannelConfigured(cfg, "C0OTHER")).toBe(false)
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

describe("composeSystemPrompt", () => {
  it("returns undefined when nothing is set", () => {
    expect(composeSystemPrompt(undefined, undefined, undefined)).toBeUndefined()
  })

  it("returns the workspace default when the channel has no overrides", () => {
    expect(composeSystemPrompt("default", undefined, undefined)).toBe("default")
  })

  it("replace swaps out the default entirely", () => {
    expect(composeSystemPrompt("default", "channel-replace", undefined)).toBe(
      "channel-replace",
    )
  })

  it("append concatenates LAST with a blank-line separator", () => {
    expect(composeSystemPrompt("default", undefined, "channel-append")).toBe(
      "default\n\nchannel-append",
    )
  })

  it("replace + append: append is concatenated onto the replace text", () => {
    expect(composeSystemPrompt("default", "channel-replace", "channel-append")).toBe(
      "channel-replace\n\nchannel-append",
    )
  })

  it("append without any base becomes the full prompt", () => {
    expect(composeSystemPrompt(undefined, undefined, "only-append")).toBe(
      "only-append",
    )
  })

  it("replace without a default still works", () => {
    expect(composeSystemPrompt(undefined, "only-replace", undefined)).toBe(
      "only-replace",
    )
  })

  it("append as an array joins entries with a blank-line separator", () => {
    expect(composeSystemPrompt("default", undefined, ["one", "two", "three"])).toBe(
      "default\n\none\n\ntwo\n\nthree",
    )
  })

  it("append as a single-element array behaves like a plain string", () => {
    expect(composeSystemPrompt("default", undefined, ["only"])).toBe(
      "default\n\nonly",
    )
  })

  it("empty append array is treated as no append", () => {
    expect(composeSystemPrompt("default", undefined, [])).toBe("default")
  })

  it("append array with only empty strings is treated as no append", () => {
    expect(composeSystemPrompt("default", undefined, ["", ""])).toBe("default")
  })
})

describe("resolveProjectForChannel — system prompt composition", () => {
  it("picks up defaults.system_prompt when channel omits both overrides", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      defaults: { system_prompt: "workspace-base" },
      channels: [{ id: "C0DEF" }],
    })
    const proj = resolveProjectForChannel(cfg, "C0DEF", { launchCwd: "/cwd" })
    expect(proj.systemPrompt).toBe("workspace-base")
  })

  it("channel.system_prompt_replace swaps out defaults.system_prompt", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      defaults: { system_prompt: "workspace-base" },
      channels: [{ id: "C0RE", system_prompt_replace: "channel-base" }],
    })
    const proj = resolveProjectForChannel(cfg, "C0RE", { launchCwd: "/cwd" })
    expect(proj.systemPrompt).toBe("channel-base")
  })

  it("channel.system_prompt_append is concatenated after the base with a blank line", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      defaults: { system_prompt: "workspace-base" },
      channels: [{ id: "C0AP", system_prompt_append: "channel-extra" }],
    })
    const proj = resolveProjectForChannel(cfg, "C0AP", { launchCwd: "/cwd" })
    expect(proj.systemPrompt).toBe("workspace-base\n\nchannel-extra")
  })

  it("replace + append: append lands last", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      defaults: { system_prompt: "workspace-base" },
      channels: [
        {
          id: "C0BOTH",
          system_prompt_replace: "channel-base",
          system_prompt_append: "channel-extra",
        },
      ],
    })
    const proj = resolveProjectForChannel(cfg, "C0BOTH", { launchCwd: "/cwd" })
    expect(proj.systemPrompt).toBe("channel-base\n\nchannel-extra")
  })

  it("channel.system_prompt_append accepts an array and joins with blank lines", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      defaults: { system_prompt: "workspace-base" },
      channels: [
        {
          id: "C0ARR",
          system_prompt_append: ["first-append", "second-append"],
        },
      ],
    })
    const proj = resolveProjectForChannel(cfg, "C0ARR", { launchCwd: "/cwd" })
    expect(proj.systemPrompt).toBe(
      "workspace-base\n\nfirst-append\n\nsecond-append",
    )
  })

  it("no defaults, no channel overrides → undefined (backend default)", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      channels: [{ id: "C0NONE" }],
    })
    const proj = resolveProjectForChannel(cfg, "C0NONE", { launchCwd: "/cwd" })
    expect(proj.systemPrompt).toBeUndefined()
  })
})
