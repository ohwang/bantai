import { describe, expect, it } from "bun:test"
import { buildCodexMcpConfigArgs } from "../../src/backends/codex/mcp-config"

describe("buildCodexMcpConfigArgs", () => {
  describe("empty inputs", () => {
    it("returns [] when both fields are undefined", () => {
      expect(buildCodexMcpConfigArgs(undefined, undefined)).toEqual([])
    })

    it("returns [] when both fields are empty objects", () => {
      expect(buildCodexMcpConfigArgs({}, {})).toEqual([])
    })
  })

  describe("stdio entries", () => {
    it("emits command/args/env triplets per stdio entry", () => {
      const args = buildCodexMcpConfigArgs(
        {
          "bantai-slack-upload": {
            command: "bantai",
            args: ["slack", "mcp-upload-server"],
            env: { BANTAI_SLACK_CHANNEL: "C123" },
          },
        },
        undefined,
      )
      expect(args).toEqual([
        "--config",
        'mcp_servers.bantai-slack-upload.command="bantai"',
        "--config",
        'mcp_servers.bantai-slack-upload.args=["slack", "mcp-upload-server"]',
        "--config",
        'mcp_servers.bantai-slack-upload.env.BANTAI_SLACK_CHANNEL="C123"',
      ])
    })

    it("skips stdio entries with non-bare names instead of emitting them", () => {
      const args = buildCodexMcpConfigArgs(
        {
          "weird name with spaces": { command: "x" },
          ok: { command: "y" },
        },
        undefined,
      )
      expect(args).toContain("--config")
      expect(args.some((a) => a.includes("weird name"))).toBe(false)
      expect(args.some((a) => a.includes("mcp_servers.ok.command="))).toBe(true)
    })
  })

  describe("http entries", () => {
    it("emits url + bearer_token_env_var per http entry", () => {
      const args = buildCodexMcpConfigArgs(undefined, {
        "bantai-slack": {
          url: "http://127.0.0.1:53412/mcp",
          bearerTokenEnvVar: "BANTAI_SLACK_MCP_TOKEN",
        },
      })
      expect(args).toEqual([
        "--config",
        'mcp_servers.bantai-slack.url="http://127.0.0.1:53412/mcp"',
        "--config",
        'mcp_servers.bantai-slack.bearer_token_env_var="BANTAI_SLACK_MCP_TOKEN"',
      ])
    })

    it("emits http_headers entries when provided, quoting non-bare keys", () => {
      const args = buildCodexMcpConfigArgs(undefined, {
        "svc-a": {
          url: "https://example/mcp",
          httpHeaders: {
            "X-Tenant": "acme", // bare-allowed (hyphen ok in TOML bare keys)
            "X.With.Dots": "weird", // not bare → must be quoted
            region: "us-east",
          },
        },
      })
      expect(args).toContain("--config")
      expect(args).toContain('mcp_servers.svc-a.http_headers.X-Tenant="acme"')
      expect(args).toContain('mcp_servers.svc-a.http_headers."X.With.Dots"="weird"')
      expect(args).toContain('mcp_servers.svc-a.http_headers.region="us-east"')
    })

    it("omits bearer_token_env_var when unset", () => {
      const args = buildCodexMcpConfigArgs(undefined, {
        "svc-a": { url: "https://example/mcp" },
      })
      expect(args).toEqual([
        "--config",
        'mcp_servers.svc-a.url="https://example/mcp"',
      ])
    })

    it("skips http entries with non-bare names", () => {
      const args = buildCodexMcpConfigArgs(undefined, {
        "weird name": { url: "https://example/mcp" },
        ok: { url: "https://other/mcp" },
      })
      expect(args.some((a) => a.includes("weird name"))).toBe(false)
      expect(args.some((a) => a.includes("mcp_servers.ok.url="))).toBe(true)
    })

    it("skips http entry on name collision with stdio entry", () => {
      const args = buildCodexMcpConfigArgs(
        { dup: { command: "x" } },
        { dup: { url: "https://example/mcp" } },
      )
      // stdio wins; http skipped to avoid Codex's stdio+http rejection
      expect(args).toContain('mcp_servers.dup.command="x"')
      expect(args.some((a) => a.includes(".url="))).toBe(false)
    })
  })

  describe("mixed inputs", () => {
    it("emits both stdio and http entries when fields are disjoint", () => {
      const args = buildCodexMcpConfigArgs(
        { upload: { command: "uploader" } },
        { slack: { url: "http://127.0.0.1:1234/mcp" } },
      )
      expect(args).toContain('mcp_servers.upload.command="uploader"')
      expect(args).toContain('mcp_servers.slack.url="http://127.0.0.1:1234/mcp"')
    })
  })
})
