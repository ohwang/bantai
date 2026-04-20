/**
 * `bantai slack doctor` — one-shot pre-flight check for a Slack install.
 *
 * Spins up Bolt just long enough to run `auth.test` + the same boot-time
 * scope probes the launcher runs, prints a human-readable summary, and
 * exits. Designed for operators who want to verify their `slack.json` +
 * workspace setup WITHOUT actually starting the server and accepting
 * traffic. Complements the `runBootDiagnostics` warn lines the launcher
 * emits on every start.
 *
 * Every IO surface is injectable so tests drive the doctor without a
 * live Slack workspace:
 *   - `createApp` builds the Bolt instance (defaults to `createBoltApp`).
 *   - `loadConfig` reads slack.json (defaults to `loadSlackConfig`).
 * Minislack-backed tests override both to feed canned auth / diagnostic
 * results through.
 */

import type { App } from "@slack/bolt"
import {
  createBoltApp,
  runBootDiagnostics,
  verifyAuth,
  type DiagnosticFinding,
} from "./transport/bolt"
import { loadSlackConfig } from "./config/loader"
import type { ResolvedSlackConfig } from "./config/schema"

export interface SlackDoctorReport {
  /** Where the config was loaded from. */
  source: string
  mode: "socket" | "http"
  /** True when the loaded config has a `store_path` configured. */
  persistenceEnabled: boolean
  auth: {
    botUserId: string
    botId: string
    userId?: string
    teamId?: string
    url?: string
  }
  findings: DiagnosticFinding[]
  /**
   * Admin surface findings — always present (defaults fire on absent
   * `admin` block) but `enabled=false` means nothing will bind.
   */
  admin: {
    enabled: boolean
    host: string
    port: number
    tokenPath: string
    readOnly: boolean
    sessionRingSize: number
    /** Warn-level note when binding to a non-loopback host. */
    nonLoopbackWarning?: string
  }
}

export interface RunSlackDoctorOpts {
  /** Explicit slack.json path (same as `bantai slack --slack-config`). */
  configPath?: string
  /** Working directory for slack.json search. Defaults to process.cwd(). */
  cwd?: string
  /** Override [workspace].slack_api_url — mirrors the launcher flag. */
  slackApiUrlOverride?: string
  /** Test hook — returns a Bolt-like App instance. */
  createApp?: (config: ResolvedSlackConfig) => App
  /** Test hook — returns the resolved config. */
  loadConfig?: (opts: {
    path?: string
    cwd?: string
  }) => Promise<ResolvedSlackConfig>
}

export async function runSlackDoctor(
  opts: RunSlackDoctorOpts = {},
): Promise<SlackDoctorReport> {
  const load = opts.loadConfig ?? loadSlackConfig
  const config = await load({
    ...(opts.configPath !== undefined ? { path: opts.configPath } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  })
  if (opts.slackApiUrlOverride) {
    config.workspace.slackApiUrl = opts.slackApiUrlOverride
  }

  const app = opts.createApp
    ? opts.createApp(config)
    : createBoltApp({ config })
  await app.start()
  try {
    const auth = await verifyAuth(app)
    const findings = await runBootDiagnostics(app)
    const admin: SlackDoctorReport["admin"] = {
      enabled: config.admin.enabled,
      host: config.admin.host,
      port: config.admin.port,
      tokenPath: config.admin.tokenPath,
      readOnly: config.admin.readOnly,
      sessionRingSize: config.admin.sessionRingSize,
    }
    if (
      config.admin.enabled &&
      !isLoopbackHost(config.admin.host)
    ) {
      admin.nonLoopbackWarning =
        `admin.host=${config.admin.host} is not loopback — ensure the port ` +
        "is firewalled or tunnelled. See team/bantai-slack-monitor-tui.md."
    }
    return {
      source: config.source,
      mode: config.workspace.mode,
      persistenceEnabled: config.storePath !== "",
      auth: {
        botUserId: auth.botUserId,
        botId: auth.botId,
        ...(auth.userId ? { userId: auth.userId } : {}),
        ...(auth.teamId ? { teamId: auth.teamId } : {}),
        ...(auth.url ? { url: auth.url } : {}),
      },
      findings,
      admin,
    }
  } finally {
    try {
      await app.stop()
    } catch {
      // best-effort — we're about to exit the process anyway
    }
  }
}

/**
 * Render the report as aligned plain text. The launcher itself logs each
 * finding at warn level on every start; this formatter exists purely so
 * the `doctor` subcommand prints something readable.
 */
export function formatSlackDoctorReport(report: SlackDoctorReport): string {
  const lines: string[] = []
  lines.push(`config:     ${report.source}`)
  lines.push(`mode:       ${report.mode}`)
  lines.push(`bot user:   ${report.auth.botUserId}`)
  if (report.auth.botId) lines.push(`bot id:     ${report.auth.botId}`)
  if (report.auth.teamId) lines.push(`team:       ${report.auth.teamId}`)
  if (report.auth.url) lines.push(`url:        ${report.auth.url}`)
  lines.push(
    `persist:    ${report.persistenceEnabled ? "enabled" : "disabled"}`,
  )
  lines.push("")
  if (report.findings.length === 0) {
    lines.push("diagnostics: all probes ok")
  } else {
    lines.push(`diagnostics: ${report.findings.length} finding(s)`)
    for (const f of report.findings) {
      lines.push(`  - ${f.code}: ${f.message}`)
    }
  }
  lines.push("")
  lines.push("admin:")
  lines.push(`  enabled:    ${report.admin.enabled ? "yes" : "no"}`)
  if (report.admin.enabled) {
    lines.push(`  bind:       ${report.admin.host}:${report.admin.port}`)
    lines.push(`  token:      ${report.admin.tokenPath} (mode 0600)`)
    lines.push(`  read-only:  ${report.admin.readOnly ? "yes" : "no"}`)
    lines.push(`  ring size:  ${report.admin.sessionRingSize}`)
    if (report.admin.nonLoopbackWarning) {
      lines.push(`  WARNING:    ${report.admin.nonLoopbackWarning}`)
    }
  }
  return lines.join("\n")
}

/**
 * Loopback detection — used to decide whether an admin host deserves a
 * warn line. Accepts 127.0.0.0/8, IPv6 ::1 / [::1], "localhost". Anything
 * else falls through to "non-loopback" (triggers the warn).
 */
function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true
  if (host === "::1" || host === "[::1]") return true
  if (/^127(\.\d{1,3}){3}$/.test(host)) return true
  return false
}
