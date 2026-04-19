/**
 * Boot-time audit of the resolved Slack config. Surfaces misconfigurations
 * (unsafe approver defaults, missing backend tokens, unknown MCP server
 * references) as `log.warn` lines the operator will see on launch. Pure:
 * returns the list of findings so tests can assert on them without intercepting
 * the logger.
 *
 * We intentionally only warn — never throw — so a slightly-broken config
 * still boots. Operators can tighten their security posture without rolling
 * back the launch if an older channel was added with empty approvers.
 */

import type { ResolvedSlackConfig } from "../config/schema"
import { resolveProjectForChannel } from "./resolver"

export type AuditSeverity = "warn" | "info"

export interface AuditFinding {
  severity: AuditSeverity
  code: string
  message: string
  /** Channel id if the finding is channel-scoped; undefined for defaults. */
  channelId?: string
}

export interface AuditOpts {
  /** Fallback cwd when we need to materialise a project config to read permissionMode. */
  launchCwd: string
  env?: NodeJS.ProcessEnv
}

/**
 * Modes where the backend can ask for a permission at runtime (so the
 * approver list matters). "plan" is read-only, and "bypassPermissions"
 * skips every approval — neither benefits from an approver allow-list.
 */
const PERMISSION_GATED_MODES = new Set(["default", "acceptEdits"])

/**
 * Run every audit rule against the config. Returns every finding; the caller
 * decides whether to log (default behaviour in the launcher) or suppress.
 */
export function auditSlackConfig(
  config: ResolvedSlackConfig,
  opts: AuditOpts,
): AuditFinding[] {
  const findings: AuditFinding[] = []

  // Defaults audit — every "inherit from defaults" channel picks these up,
  // so flag once against the defaults rather than once per channel.
  //
  // Severity is tiered deliberately:
  //   - permission_mode="default" + empty approvers → info. This is the stock
  //     minimal config; every approval still requires a live human click, so
  //     the blast radius is "anyone in the channel can click Allow" — real,
  //     but not worth a boot-time warn on every launch. The finding stays
  //     visible to `bantai slack audit` so CI can still tighten it.
  //   - permission_mode="acceptEdits" + empty approvers → warn. The operator
  //     has deliberately widened the trust boundary without listing anyone
  //     to vouch for the agent. That combination deserves a loud hint.
  const defaultMode = config.defaults.permission_mode
  const defaultApprovers = config.defaults.approvers
  if (
    PERMISSION_GATED_MODES.has(defaultMode) &&
    defaultApprovers.length === 0
  ) {
    const severity: AuditSeverity = defaultMode === "default" ? "info" : "warn"
    findings.push({
      severity,
      code: "approvers.defaults_empty",
      message:
        severity === "warn"
          ? `defaults.approvers is empty with permission_mode="${defaultMode}" — any user in a gated channel can approve tool use; set defaults.approvers or per-channel approvers`
          : `defaults.approvers is empty with permission_mode="default" — stock config; any channel member can approve tool use. Populate defaults.approvers or per-channel approvers once you open it up to more people.`,
    })
  }

  // Per-channel audit — warn when a channel overrides mode/approvers in a
  // way that introduces a gap the defaults didn't create.
  for (const ch of config.channels) {
    const proj = resolveProjectForChannel(config, ch.id, opts)
    if (
      PERMISSION_GATED_MODES.has(proj.permissionMode) &&
      proj.approvers.length === 0 &&
      // Only flag channels that explicitly override approvers to []; the
      // defaults case is already covered above.
      ch.approvers !== undefined
    ) {
      findings.push({
        severity: "warn",
        code: "approvers.channel_empty",
        message: `channel ${ch.id}${ch.name ? ` (#${ch.name})` : ""} explicitly sets approvers=[] with permission_mode="${proj.permissionMode}"`,
        channelId: ch.id,
      })
    }

    // Unknown MCP server names — the resolver already logs these, but we
    // surface them as a finding too so `bantai slack audit` can exit
    // non-zero in a CI check later.
    if (ch.mcp_servers) {
      const unknown = ch.mcp_servers.filter((name) => !config.mcpServers[name])
      for (const name of unknown) {
        findings.push({
          severity: "warn",
          code: "mcp.unknown_server",
          message: `channel ${ch.id} references unknown MCP server "${name}"`,
          channelId: ch.id,
        })
      }
    }
  }

  // Workspace token audit — socket mode needs both bot and app tokens;
  // http mode needs bot + signing secret. We don't enforce this at load
  // time (tests/dev can run without tokens), but we flag it so real deploys
  // don't silently boot with a broken transport.
  const ws = config.workspace
  if (ws.mode === "socket") {
    if (!ws.botToken) findings.push({ severity: "warn", code: "workspace.bot_token_missing", message: "workspace.mode=socket but bot_token resolved to empty" })
    if (!ws.appToken) findings.push({ severity: "warn", code: "workspace.app_token_missing", message: "workspace.mode=socket but app_token resolved to empty" })
  } else {
    if (!ws.botToken) findings.push({ severity: "warn", code: "workspace.bot_token_missing", message: "workspace.mode=http but bot_token resolved to empty" })
    if (!ws.signingSecret) findings.push({ severity: "warn", code: "workspace.signing_secret_missing", message: "workspace.mode=http but signing_secret resolved to empty" })
  }

  return findings
}
