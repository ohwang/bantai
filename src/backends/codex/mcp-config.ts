/**
 * Convert `SessionConfig.{stdioMcpServers, httpMcpServers}` into Codex CLI
 * `--config` flags.
 *
 * The Codex CLI supports `[mcp_servers.<name>]` TOML sections via either
 * `~/.codex/config.toml` or per-invocation `--config key=value` overrides.
 * `@openai/codex-sdk`'s `CodexOptions.config` flattens nested objects into
 * those overrides — but we don't go through the Codex class; we spawn
 * `codex app-server` directly (see `jsonrpc-transport.ts`). So we replicate
 * the flattening here.
 *
 * Output format matches Codex CLI expectations (TOML values on the right).
 *
 * Stdio entries:
 *
 *   mcp_servers.bantai-slack-upload.command="bantai"
 *   mcp_servers.bantai-slack-upload.args=["slack","mcp-upload-server"]
 *   mcp_servers.bantai-slack-upload.env.BANTAI_SLACK_CHANNEL="C1"
 *
 * HTTP entries (Codex's `streamable_http` transport — see
 * `codex-rs/config/src/mcp_types.rs`):
 *
 *   mcp_servers.bantai-slack.url="http://127.0.0.1:53412/mcp"
 *   mcp_servers.bantai-slack.bearer_token_env_var="BANTAI_SLACK_MCP_TOKEN"
 *   mcp_servers.bantai-slack.http_headers.X-Foo="bar"
 *
 * Each `--config k=v` is a separate argv pair (two entries each).
 *
 * Codex's parser rejects mixing stdio + http fields under the same name
 * ("<field> is not supported for stdio" / "...for streamable_http"), so the
 * caller must keep stdio and HTTP entries under disjoint names. Same-name
 * collisions across the two records resolve in favour of the stdio entry
 * with a `log.warn` — silent drop would violate AGENTS.md.
 */

import { log } from "../../utils/logger"
import type { SessionConfig } from "../../protocol/types"

/** Build a flat list of `--config k=v` argv pairs. Returns `[]` when no
 *  MCP servers are configured so callers can blindly spread the result
 *  into a larger argv array. */
export function buildCodexMcpConfigArgs(
  stdioMcpServers: SessionConfig["stdioMcpServers"],
  httpMcpServers?: SessionConfig["httpMcpServers"],
): string[] {
  const stdioNames = stdioMcpServers ? Object.keys(stdioMcpServers) : []
  const httpNames = httpMcpServers ? Object.keys(httpMcpServers) : []
  if (stdioNames.length === 0 && httpNames.length === 0) return []

  const args: string[] = []
  const seen = new Set<string>()

  for (const name of stdioNames) {
    const spec = stdioMcpServers?.[name]
    if (!spec) continue
    if (!TOML_BARE_KEY.test(name)) {
      // Codex's config-override parser rejects non-bare keys in the dotted
      // prefix. We log + skip rather than silently drop (per AGENTS.md's
      // "never silently drop external data" rule).
      log.warn(`Codex: skipping stdio MCP server with non-bare name: ${name}`)
      continue
    }
    seen.add(name)
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

  for (const name of httpNames) {
    const spec = httpMcpServers?.[name]
    if (!spec) continue
    if (!TOML_BARE_KEY.test(name)) {
      log.warn(`Codex: skipping http MCP server with non-bare name: ${name}`)
      continue
    }
    if (seen.has(name)) {
      // A name collision means the same `mcp_servers.<name>.*` namespace would
      // get both stdio fields (`command`/`args`/`env`) AND http fields
      // (`url`/`bearer_token_env_var`), which Codex rejects at parse time.
      // Resolve in favour of the stdio entry already emitted and warn.
      log.warn(
        `Codex: skipping http MCP server "${name}" — name also present in stdioMcpServers`,
      )
      continue
    }
    const prefix = `mcp_servers.${name}`
    args.push("--config", `${prefix}.url=${toTomlValue(spec.url)}`)
    if (spec.bearerTokenEnvVar !== undefined) {
      if (!TOML_BARE_KEY.test(spec.bearerTokenEnvVar)) {
        log.warn(
          `Codex: skipping http MCP bearerTokenEnvVar with non-bare value: ${spec.bearerTokenEnvVar} (server: ${name})`,
        )
      } else {
        args.push(
          "--config",
          `${prefix}.bearer_token_env_var=${toTomlValue(spec.bearerTokenEnvVar)}`,
        )
      }
    }
    if (spec.httpHeaders && Object.keys(spec.httpHeaders).length > 0) {
      for (const [k, v] of Object.entries(spec.httpHeaders)) {
        // HTTP header names allow more characters than bare TOML keys
        // (e.g. `X-Foo`), so quote the dotted segment by emitting `"<name>"`
        // — this matches Codex's accepted form (`http_headers."X-Foo"`).
        const headerKey = TOML_BARE_KEY.test(k) ? k : `"${k.replace(/"/g, "\\\"")}"`
        args.push(
          "--config",
          `${prefix}.http_headers.${headerKey}=${toTomlValue(v)}`,
        )
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
