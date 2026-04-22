/**
 * Convert `SessionConfig.stdioMcpServers` into Codex CLI `--config` flags.
 *
 * The Codex CLI supports `[mcp_servers.<name>]` TOML sections via either
 * `~/.codex/config.toml` or per-invocation `--config key=value` overrides.
 * `@openai/codex-sdk`'s `CodexOptions.config` flattens nested objects into
 * those overrides — but we don't go through the Codex class; we spawn
 * `codex app-server` directly (see `jsonrpc-transport.ts`). So we replicate
 * the flattening here.
 *
 * Output format matches Codex CLI expectations (TOML values on the right):
 *
 *   mcp_servers.bantai-slack-upload.command="bantai"
 *   mcp_servers.bantai-slack-upload.args=["slack","mcp-upload-server"]
 *   mcp_servers.bantai-slack-upload.env.BANTAI_SLACK_CHANNEL="C1"
 *
 * Each `--config k=v` is a separate argv pair (two entries each).
 */

import { log } from "../../utils/logger"
import type { SessionConfig } from "../../protocol/types"

/** Build a flat list of `--config k=v` argv pairs. Returns `[]` when no
 *  stdio MCP servers are configured so callers can blindly spread the result
 *  into a larger argv array. */
export function buildCodexMcpConfigArgs(
  stdioMcpServers: SessionConfig["stdioMcpServers"],
): string[] {
  if (!stdioMcpServers) return []
  const names = Object.keys(stdioMcpServers)
  if (names.length === 0) return []
  const args: string[] = []
  for (const name of names) {
    const spec = stdioMcpServers[name]
    if (!spec) continue
    if (!TOML_BARE_KEY.test(name)) {
      // Codex's config-override parser rejects non-bare keys in the dotted
      // prefix. We log + skip rather than silently drop (per CLAUDE.md's
      // "never silently drop external data" rule).
      log.warn(`Codex: skipping stdio MCP server with non-bare name: ${name}`)
      continue
    }
    const prefix = `mcp_servers.${name}`
    args.push("--config", `${prefix}.command=${toTomlValue(spec.command)}`)
    if (spec.args && spec.args.length > 0) {
      args.push("--config", `${prefix}.args=${toTomlArray(spec.args)}`)
    }
    if (spec.env && Object.keys(spec.env).length > 0) {
      for (const [k, v] of Object.entries(spec.env)) {
        if (!TOML_BARE_KEY.test(k)) {
          log.warn(
            `Codex: skipping stdio MCP env var with non-bare key: ${k} (server: ${name})`,
          )
          continue
        }
        args.push("--config", `${prefix}.env.${k}=${toTomlValue(v)}`)
      }
    }
  }
  return args
}

// ---------------------------------------------------------------------------
// TOML formatting — minimal subset sufficient for MCP server specs.
// Kept in-module because the Codex SDK does not export its formatter.
// ---------------------------------------------------------------------------

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/

function toTomlValue(value: string): string {
  // TOML basic string: double quotes, backslash-escape a conservative set.
  return JSON.stringify(value)
}

function toTomlArray(values: string[]): string {
  return `[${values.map(toTomlValue).join(", ")}]`
}
