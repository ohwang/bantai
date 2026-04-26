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
import { realpath } from "node:fs/promises"
import path from "node:path"
import {
  createBoltApp,
  runBootDiagnostics,
  verifyAuth,
  type DiagnosticFinding,
} from "./transport/bolt"
import { loadSlackConfig } from "./config/loader"
import type { ResolvedSlackConfig } from "./config/schema"

/**
 * Per-channel `project_dir` symlink-drift finding. `configured` is the
 * (already-resolved-to-absolute) path the loader handed us; `realpath`
 * is what `realpath()` returned. They differ iff the configured path
 * traverses at least one symlink. `code` is one of:
 *   - "differs"    — paths differ; this is the real footgun signal.
 *   - "stat_error" — `realpath()` threw (path missing, permission, …).
 *                    Surfaced as a finding so the operator at least
 *                    knows the path is broken at config-load time
 *                    instead of finding out on the first message.
 */
export interface ProjectDirRealpathFinding {
  channelId: string
  channelName?: string
  configured: string
  realpath?: string
  code: "differs" | "stat_error"
  message: string
}

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
   * One entry per channel whose resolved `project_dir` differs from its
   * `realpath()`. The most common cause is the slack-agent-projects
   * `./repos/<repo>` symlinks that sapcli used to create — they routed
   * through `../../<repo>` so the kernel landed bantai on a different
   * absolute path than the config referred to. Empty array means every
   * channel is symlink-clean. Channels without `project_dir` are skipped.
   */
  projectDirRealpath: ProjectDirRealpathFinding[]
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
    const projectDirRealpath = await checkProjectDirRealpaths(config)
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
      projectDirRealpath,
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
  if (report.projectDirRealpath.length === 0) {
    lines.push("project_dir: every channel resolves to its realpath")
  } else {
    lines.push(
      `project_dir: ${report.projectDirRealpath.length} symlink-drift finding(s)`,
    )
    for (const f of report.projectDirRealpath) {
      const id = f.channelName ? `${f.channelName} (${f.channelId})` : f.channelId
      lines.push(`  - ${id} [${f.code}]: ${f.message}`)
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
 * For each channel with a `project_dir`, compare the loader-resolved
 * absolute path to its `realpath()`. Differences mean the cwd bantai
 * chdirs into is not the cwd the config refers to — exactly the symlink
 * footgun the sapcli sibling-symlink removal addressed.
 *
 * Inline configs (`source === "<inline>"`) skip relative-path channels
 * because the loader returns those unresolved (no on-disk dir to anchor
 * against); the test harness asserts on the absolute-path branch.
 *
 * Exported for test injection — `checkProjectDirRealpaths(config, fakeRealpath)`
 * lets tests drive specific path/realpath outcomes without touching the
 * real filesystem.
 */
export async function checkProjectDirRealpaths(
  config: ResolvedSlackConfig,
  realpathFn: (p: string) => Promise<string> = realpath,
): Promise<ProjectDirRealpathFinding[]> {
  const out: ProjectDirRealpathFinding[] = []
  for (const channel of config.channels) {
    const projectDir = channel.project_dir
    if (projectDir === undefined) continue
    // Skip relative paths that the loader couldn't anchor (inline-config
    // case). They will eventually be resolved by the routing layer
    // against process.cwd, but that's not a stable input for the doctor.
    if (!path.isAbsolute(projectDir)) continue
    let resolved: string
    try {
      resolved = await realpathFn(projectDir)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      out.push({
        channelId: channel.id,
        ...(channel.name ? { channelName: channel.name } : {}),
        configured: projectDir,
        code: "stat_error",
        message: `realpath(${projectDir}) failed: ${reason}`,
      })
      continue
    }
    if (resolved !== projectDir) {
      out.push({
        channelId: channel.id,
        ...(channel.name ? { channelName: channel.name } : {}),
        configured: projectDir,
        realpath: resolved,
        code: "differs",
        message:
          `project_dir resolves through a symlink: configured=${projectDir} ` +
          `realpath=${resolved} — JSONL session files will be keyed by the ` +
          `realpath, not the configured path.`,
      })
    }
  }
  return out
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
