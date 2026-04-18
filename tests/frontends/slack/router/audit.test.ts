import { describe, expect, it } from "bun:test"
import { loadSlackConfig } from "../../../../src/frontends/slack/config/loader"
import { auditSlackConfig } from "../../../../src/frontends/slack/router/audit"

async function makeConfig(inline: unknown, env: NodeJS.ProcessEnv = {}) {
  return await loadSlackConfig({ inline, env })
}

describe("auditSlackConfig", () => {
  it("flags an empty defaults.approvers with permission_mode=default", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      // default permission_mode is "default" and default approvers is []
    })
    const findings = auditSlackConfig(cfg, { launchCwd: "/tmp" })
    const codes = findings.map((f) => f.code)
    expect(codes).toContain("approvers.defaults_empty")
  })

  it("silent when defaults.permission_mode=plan (read-only)", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      defaults: { permission_mode: "plan" },
    })
    const findings = auditSlackConfig(cfg, { launchCwd: "/tmp" })
    expect(findings.map((f) => f.code)).not.toContain("approvers.defaults_empty")
  })

  it("silent when defaults.permission_mode=bypassPermissions", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      defaults: { permission_mode: "bypassPermissions" },
    })
    const findings = auditSlackConfig(cfg, { launchCwd: "/tmp" })
    expect(findings.map((f) => f.code)).not.toContain("approvers.defaults_empty")
  })

  it("silent when defaults.approvers is populated", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      defaults: { approvers: ["U0ALICE"] },
    })
    const findings = auditSlackConfig(cfg, { launchCwd: "/tmp" })
    expect(findings.map((f) => f.code)).not.toContain("approvers.defaults_empty")
  })

  it("flags a channel that overrides approvers=[] explicitly", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      defaults: { approvers: ["U0ALICE"] },
      channels: [{ id: "C0UNSAFE", approvers: [] }],
    })
    const findings = auditSlackConfig(cfg, { launchCwd: "/tmp" })
    const codes = findings.map((f) => f.code)
    expect(codes).toContain("approvers.channel_empty")
  })

  it("does not double-flag channels that just inherit empty defaults", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      channels: [{ id: "C0INHERIT" }], // no approvers override
    })
    const findings = auditSlackConfig(cfg, { launchCwd: "/tmp" })
    const codes = findings.map((f) => f.code)
    expect(codes).toContain("approvers.defaults_empty")
    expect(codes).not.toContain("approvers.channel_empty")
  })

  it("flags unknown MCP server references per channel", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket", bot_token: "xoxb-x", app_token: "xapp-x" },
      mcp_servers: { git: { command: "mcp-git" } },
      channels: [{ id: "C0MCP", mcp_servers: ["git", "typo"] }],
    })
    const findings = auditSlackConfig(cfg, { launchCwd: "/tmp" })
    const unknown = findings.filter((f) => f.code === "mcp.unknown_server")
    expect(unknown).toHaveLength(1)
    expect(unknown[0]!.message).toContain("typo")
  })

  it("flags missing tokens for socket mode", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "socket" /* no bot_token, no app_token */ },
    })
    const findings = auditSlackConfig(cfg, { launchCwd: "/tmp" })
    const codes = findings.map((f) => f.code)
    expect(codes).toContain("workspace.bot_token_missing")
    expect(codes).toContain("workspace.app_token_missing")
  })

  it("flags missing signing_secret for http mode", async () => {
    const cfg = await makeConfig({
      workspace: { mode: "http", bot_token: "xoxb-x" },
    })
    const findings = auditSlackConfig(cfg, { launchCwd: "/tmp" })
    expect(findings.map((f) => f.code)).toContain("workspace.signing_secret_missing")
  })
})
