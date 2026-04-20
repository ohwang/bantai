import { describe, expect, it } from "bun:test"
import {
  formatSlackDoctorReport,
  runSlackDoctor,
  type SlackDoctorReport,
} from "../../../src/frontends/slack/doctor"
import type { ResolvedSlackConfig } from "../../../src/frontends/slack/config/schema"

describe("formatSlackDoctorReport", () => {
  it("renders a clean report when all probes pass", () => {
    const report: SlackDoctorReport = {
      source: "/home/op/.bantai/slack.json",
      mode: "socket",
      persistenceEnabled: true,
      auth: {
        botUserId: "U0BOT",
        botId: "B0BOT",
        teamId: "T0TEAM",
        url: "https://acme.slack.com/",
      },
      findings: [],
      admin: {
        enabled: false,
        host: "127.0.0.1",
        port: 4242,
        tokenPath: "/home/op/.bantai/slack/admin-token",
        readOnly: false,
        sessionRingSize: 200,
      },
    }
    const text = formatSlackDoctorReport(report)
    expect(text).toContain("config:     /home/op/.bantai/slack.json")
    expect(text).toContain("mode:       socket")
    expect(text).toContain("bot user:   U0BOT")
    expect(text).toContain("team:       T0TEAM")
    expect(text).toContain("persist:    enabled")
    expect(text).toContain("diagnostics: all probes ok")
    expect(text).not.toContain("finding(s)")
  })

  it("renders each diagnostic finding under a count header", () => {
    const report: SlackDoctorReport = {
      source: "<inline>",
      mode: "http",
      persistenceEnabled: false,
      auth: { botUserId: "U0B", botId: "B0B" },
      findings: [
        { code: "channels.read", message: "probe channels.read threw: missing_scope" },
        { code: "users.read", message: "probe users.read returned error=ratelimited" },
      ],
      admin: {
        enabled: false,
        host: "127.0.0.1",
        port: 4242,
        tokenPath: "~/.bantai/slack/admin-token",
        readOnly: false,
        sessionRingSize: 200,
      },
    }
    const text = formatSlackDoctorReport(report)
    expect(text).toContain("persist:    disabled")
    expect(text).toContain("diagnostics: 2 finding(s)")
    expect(text).toContain("- channels.read: probe channels.read threw: missing_scope")
    expect(text).toContain("- users.read: probe users.read returned error=ratelimited")
  })

  it("omits optional auth fields when absent", () => {
    const report: SlackDoctorReport = {
      source: "<inline>",
      mode: "socket",
      persistenceEnabled: false,
      auth: { botUserId: "U0BOT", botId: "" },
      findings: [],
      admin: {
        enabled: false,
        host: "127.0.0.1",
        port: 4242,
        tokenPath: "/home/op/.bantai/slack/admin-token",
        readOnly: false,
        sessionRingSize: 200,
      },
    }
    const text = formatSlackDoctorReport(report)
    expect(text).not.toContain("bot id:")
    expect(text).not.toContain("team:")
    expect(text).not.toContain("url:")
  })
})

describe("runSlackDoctor", () => {
  it("starts + stops the injected app and returns the auth / findings", async () => {
    const calls: string[] = []
    const fakeApp = {
      async start() {
        calls.push("start")
      },
      async stop() {
        calls.push("stop")
      },
      client: {
        auth: {
          async test() {
            calls.push("auth.test")
            return {
              ok: true,
              bot_id: "B0BOT",
              user_id: "U0BOT",
              team_id: "T0TEAM",
              url: "https://acme.slack.com/",
            }
          },
        },
        conversations: { async list() { return { ok: true } } },
        users: { async list() { return { ok: true } } },
        reactions: { async list() { return { ok: true } } },
      },
    } as unknown as Parameters<
      NonNullable<Parameters<typeof runSlackDoctor>[0]>["createApp"] &
        ((c: ResolvedSlackConfig) => unknown)
    >[0] extends infer _ ? never : never

    const config: ResolvedSlackConfig = {
      workspace: {
        mode: "socket",
        botToken: "xoxb-test",
        appToken: "xapp-test",
        webhookPath: "/slack/events",
      },
      defaults: {
        backend: "claude",
        permission_mode: "default",
        require_mention: true,
        trigger_name: "bantai",
        verbosity: "normal",
        control_prefix: "!bantai",
        session_banner: true,
        approvers: [],
        auto_join_threads: true,
        thread_require_explicit_mention: false,
        thread_history_limit: 20,
        interactive_replies: false,
        debounce_ms: 0,
        native_streaming: false,
        show_cost: false,
        turn_timeout_s: 0,
        max_budget_usd: 0,
        idle_timeout_s: 3600,
      },
      channels: [],
      mcpServers: {},
      storePath: "/tmp/slack.db",
      admin: {
        enabled: false,
        host: "127.0.0.1",
        port: 4242,
        tokenPath: "/home/op/.bantai/slack/admin-token",
        readOnly: false,
        sessionRingSize: 200,
      },
      source: "<inline>",
    }

    const report = await runSlackDoctor({
      async loadConfig() {
        return config
      },
      createApp: () => fakeApp as never,
    })

    expect(calls).toEqual(["start", "auth.test", "stop"])
    expect(report.source).toBe("<inline>")
    expect(report.mode).toBe("socket")
    expect(report.persistenceEnabled).toBe(true)
    expect(report.auth.botUserId).toBe("U0BOT")
    expect(report.auth.teamId).toBe("T0TEAM")
    expect(report.findings).toEqual([])
    expect(report.admin.enabled).toBe(false)
  })

  it("stops the app even when auth.test throws", async () => {
    const calls: string[] = []
    const fakeApp = {
      async start() { calls.push("start") },
      async stop() { calls.push("stop") },
      client: {
        auth: {
          async test() {
            throw new Error("invalid_auth")
          },
        },
        conversations: { async list() { return { ok: true } } },
        users: { async list() { return { ok: true } } },
        reactions: { async list() { return { ok: true } } },
      },
    }
    const config: ResolvedSlackConfig = {
      workspace: { mode: "socket", webhookPath: "/slack/events" },
      defaults: {
        backend: "claude",
        permission_mode: "default",
        require_mention: true,
        trigger_name: "bantai",
        verbosity: "normal",
        control_prefix: "!bantai",
        session_banner: true,
        approvers: [],
        auto_join_threads: true,
        thread_require_explicit_mention: false,
        thread_history_limit: 20,
        interactive_replies: false,
        debounce_ms: 0,
        native_streaming: false,
        show_cost: false,
        turn_timeout_s: 0,
        max_budget_usd: 0,
        idle_timeout_s: 3600,
      },
      channels: [],
      mcpServers: {},
      storePath: "",
      admin: {
        enabled: false,
        host: "127.0.0.1",
        port: 4242,
        tokenPath: "/home/op/.bantai/slack/admin-token",
        readOnly: false,
        sessionRingSize: 200,
      },
      source: "<inline>",
    }
    await expect(
      runSlackDoctor({
        async loadConfig() { return config },
        createApp: () => fakeApp as never,
      }),
    ).rejects.toThrow("invalid_auth")
    expect(calls).toEqual(["start", "stop"])
  })

  it("reports findings returned by the diagnostic probes", async () => {
    const fakeApp = {
      async start() {},
      async stop() {},
      client: {
        auth: {
          async test() {
            return { ok: true, bot_id: "B0B", user_id: "U0B", team_id: "T0T" }
          },
        },
        conversations: {
          async list() {
            return { ok: false, error: "missing_scope" }
          },
        },
        users: { async list() { return { ok: true } } },
        reactions: { async list() { return { ok: true } } },
      },
    }
    const config: ResolvedSlackConfig = {
      workspace: { mode: "socket", webhookPath: "/slack/events" },
      defaults: {
        backend: "claude",
        permission_mode: "default",
        require_mention: true,
        trigger_name: "bantai",
        verbosity: "normal",
        control_prefix: "!bantai",
        session_banner: true,
        approvers: [],
        auto_join_threads: true,
        thread_require_explicit_mention: false,
        thread_history_limit: 20,
        interactive_replies: false,
        debounce_ms: 0,
        native_streaming: false,
        show_cost: false,
        turn_timeout_s: 0,
        max_budget_usd: 0,
        idle_timeout_s: 3600,
      },
      channels: [],
      mcpServers: {},
      storePath: "",
      admin: {
        enabled: true,
        host: "0.0.0.0",
        port: 4242,
        tokenPath: "/home/op/.bantai/slack/admin-token",
        readOnly: false,
        sessionRingSize: 200,
      },
      source: "<inline>",
    }
    const report = await runSlackDoctor({
      async loadConfig() { return config },
      createApp: () => fakeApp as never,
    })
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]!.code).toBe("channels.read")
    expect(report.findings[0]!.message).toContain("missing_scope")
    // Enabled + non-loopback bind → doctor surfaces the warn.
    expect(report.admin.enabled).toBe(true)
    expect(report.admin.nonLoopbackWarning).toBeDefined()
    expect(report.admin.nonLoopbackWarning).toMatch(/not loopback/)
  })

  it("formats the admin section with bind + token when enabled", () => {
    const text = formatSlackDoctorReport({
      source: "<inline>",
      mode: "socket",
      persistenceEnabled: false,
      auth: { botUserId: "U0B", botId: "B0B" },
      findings: [],
      admin: {
        enabled: true,
        host: "127.0.0.1",
        port: 4242,
        tokenPath: "/home/op/.bantai/slack/admin-token",
        readOnly: true,
        sessionRingSize: 200,
      },
    })
    expect(text).toContain("admin:")
    expect(text).toContain("enabled:    yes")
    expect(text).toContain("bind:       127.0.0.1:4242")
    expect(text).toContain("token:      /home/op/.bantai/slack/admin-token (mode 0600)")
    expect(text).toContain("read-only:  yes")
    expect(text).toContain("ring size:  200")
    expect(text).not.toContain("WARNING:")
  })

  it("formats the admin section with a non-loopback WARNING when applicable", () => {
    const text = formatSlackDoctorReport({
      source: "<inline>",
      mode: "socket",
      persistenceEnabled: false,
      auth: { botUserId: "U0B", botId: "B0B" },
      findings: [],
      admin: {
        enabled: true,
        host: "0.0.0.0",
        port: 4242,
        tokenPath: "/t/token",
        readOnly: false,
        sessionRingSize: 200,
        nonLoopbackWarning: "admin.host=0.0.0.0 is not loopback",
      },
    })
    expect(text).toContain("WARNING:    admin.host=0.0.0.0 is not loopback")
  })

  it("omits detail lines when admin is disabled", () => {
    const text = formatSlackDoctorReport({
      source: "<inline>",
      mode: "socket",
      persistenceEnabled: false,
      auth: { botUserId: "U0B", botId: "B0B" },
      findings: [],
      admin: {
        enabled: false,
        host: "127.0.0.1",
        port: 4242,
        tokenPath: "/t/token",
        readOnly: false,
        sessionRingSize: 200,
      },
    })
    expect(text).toContain("admin:")
    expect(text).toContain("enabled:    no")
    expect(text).not.toContain("bind:")
    expect(text).not.toContain("token:")
  })
})
