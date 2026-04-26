import { describe, expect, it } from "bun:test"
import {
  checkProjectDirRealpaths,
  formatSlackDoctorReport,
  runSlackDoctor,
  type SlackDoctorReport,
} from "../../../src/frontends/slack/doctor"
import type {
  ChannelOverride,
  ResolvedSlackConfig,
} from "../../../src/frontends/slack/config/schema"

function makeConfig(channels: ChannelOverride[]): ResolvedSlackConfig {
  return {
    workspace: { mode: "socket", webhookPath: "/slack/events" },
    defaults: {
      backend: "claude",
      permission_mode: "default",
      require_mention: true,
      trigger_name: "bantai",
      verbosity: "normal",
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
    channels,
    mcpServers: {},
    storePath: "",
    admin: {
      enabled: false,
      host: "127.0.0.1",
      port: 4242,
      tokenPath: "/t/token",
      readOnly: false,
      sessionRingSize: 200,
    },
    source: "/etc/bantai/slack.json",
  }
}

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
      projectDirRealpath: [],
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
      projectDirRealpath: [],
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
      projectDirRealpath: [],
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

    // Two auth.test calls: one for identity (verifyAuth), one for the
    // commands-scope probe inside runBootDiagnostics.
    expect(calls).toEqual(["start", "auth.test", "auth.test", "stop"])
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
      projectDirRealpath: [],
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
      projectDirRealpath: [],
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

  it("renders the project_dir section as clean when no findings", () => {
    const text = formatSlackDoctorReport({
      source: "<inline>",
      mode: "socket",
      persistenceEnabled: false,
      auth: { botUserId: "U0B", botId: "B0B" },
      findings: [],
      projectDirRealpath: [],
      admin: {
        enabled: false,
        host: "127.0.0.1",
        port: 4242,
        tokenPath: "/t/token",
        readOnly: false,
        sessionRingSize: 200,
      },
    })
    expect(text).toContain("project_dir: every channel resolves to its realpath")
  })

  it("renders symlink-drift findings under the project_dir section", () => {
    const text = formatSlackDoctorReport({
      source: "<inline>",
      mode: "socket",
      persistenceEnabled: false,
      auth: { botUserId: "U0B", botId: "B0B" },
      findings: [],
      projectDirRealpath: [
        {
          channelId: "C0ATNA044TV",
          channelName: "proj-bantai",
          configured: "/sap/repos/bantai",
          realpath: "/parent/bantai",
          code: "differs",
          message:
            "project_dir resolves through a symlink: configured=/sap/repos/bantai realpath=/parent/bantai — JSONL session files will be keyed by the realpath, not the configured path.",
        },
        {
          channelId: "C0AU0TJQ9RQ",
          channelName: "chambernotes",
          configured: "/missing/path",
          code: "stat_error",
          message: "realpath(/missing/path) failed: ENOENT: no such file or directory",
        },
      ],
      admin: {
        enabled: false,
        host: "127.0.0.1",
        port: 4242,
        tokenPath: "/t/token",
        readOnly: false,
        sessionRingSize: 200,
      },
    })
    expect(text).toContain("project_dir: 2 symlink-drift finding(s)")
    expect(text).toContain("- proj-bantai (C0ATNA044TV) [differs]:")
    expect(text).toContain("realpath=/parent/bantai")
    expect(text).toContain("- chambernotes (C0AU0TJQ9RQ) [stat_error]:")
    expect(text).toContain("ENOENT")
  })

  it("omits detail lines when admin is disabled", () => {
    const text = formatSlackDoctorReport({
      source: "<inline>",
      mode: "socket",
      persistenceEnabled: false,
      auth: { botUserId: "U0B", botId: "B0B" },
      findings: [],
      projectDirRealpath: [],
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

describe("checkProjectDirRealpaths", () => {
  it("returns an empty array when every project_dir matches its realpath", async () => {
    const config = makeConfig([
      { id: "C1", name: "one", project_dir: "/abs/one" },
      { id: "C2", name: "two", project_dir: "/abs/two" },
    ])
    const findings = await checkProjectDirRealpaths(
      config,
      async (p) => p, // identity = no symlink traversal
    )
    expect(findings).toEqual([])
  })

  it("emits a `differs` finding when realpath drifts (the sapcli symlink case)", async () => {
    const config = makeConfig([
      {
        id: "C0ATNA044TV",
        name: "proj-bantai",
        project_dir: "/home/bantai/slack-agent-projects/repos/bantai",
      },
    ])
    const findings = await checkProjectDirRealpaths(config, async (p) => {
      // Simulate the legacy `repos/bantai -> ../../bantai` symlink.
      if (p === "/home/bantai/slack-agent-projects/repos/bantai") {
        return "/home/bantai/repos/bantai"
      }
      return p
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]!).toMatchObject({
      channelId: "C0ATNA044TV",
      channelName: "proj-bantai",
      configured: "/home/bantai/slack-agent-projects/repos/bantai",
      realpath: "/home/bantai/repos/bantai",
      code: "differs",
    })
    expect(findings[0]!.message).toContain("realpath=/home/bantai/repos/bantai")
  })

  it("emits a `stat_error` finding when realpath() throws", async () => {
    const config = makeConfig([
      { id: "C-missing", name: "missing", project_dir: "/no/such/dir" },
    ])
    const findings = await checkProjectDirRealpaths(config, async () => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException
      err.code = "ENOENT"
      throw err
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]!).toMatchObject({
      channelId: "C-missing",
      configured: "/no/such/dir",
      code: "stat_error",
    })
    expect(findings[0]!.realpath).toBeUndefined()
    expect(findings[0]!.message).toContain("ENOENT")
  })

  it("skips channels without a project_dir", async () => {
    const config = makeConfig([
      { id: "C-no-dir", name: "no-project-dir" },
      { id: "C-abs", name: "abs", project_dir: "/abs/here" },
    ])
    const findings = await checkProjectDirRealpaths(config, async (p) => p)
    expect(findings).toEqual([])
  })

  it("skips relative project_dir values (loader leaves these for inline configs)", async () => {
    const config = makeConfig([
      { id: "C-rel", name: "relative", project_dir: "./repos/bantai" },
    ])
    let realpathCalls = 0
    const findings = await checkProjectDirRealpaths(config, async (p) => {
      realpathCalls += 1
      return p
    })
    expect(findings).toEqual([])
    expect(realpathCalls).toBe(0)
  })

  it("populates channelName only when set on the channel", async () => {
    const config = makeConfig([
      { id: "C-noname", project_dir: "/abs/noname" },
    ])
    const findings = await checkProjectDirRealpaths(config, async () => "/abs/elsewhere")
    expect(findings).toHaveLength(1)
    expect(findings[0]!.channelName).toBeUndefined()
    expect(findings[0]!.channelId).toBe("C-noname")
  })
})
