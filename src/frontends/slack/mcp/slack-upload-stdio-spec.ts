/**
 * Builder for the stdio-MCP-server spec that both the Codex adapter
 * (TOML `[mcp_servers.*]`) and Claude SDK (`McpStdioServerConfig`) consume.
 *
 * Keeping this in a standalone file — separate from `slack-upload-stdio.ts`
 * which carries the McpServer runtime import — lets the launcher build
 * specs cheaply without eagerly loading the MCP SDK in the main process.
 *
 * The spec is fully self-contained: it carries the bot token, channel,
 * thread, cwd, and byte cap in its `env` map. The child process reads
 * these via `parseStdioEnv` in `slack-upload-stdio.ts`.
 *
 * Security note: the bot token lives in the child process's env. This is
 * the same trust boundary we already accept for `process.env.SLACK_BOT_TOKEN`
 * in the Bolt App — the subprocess runs on the same host with the same
 * user — and is strictly better than giving the token to the agent
 * itself, since a compromised agent prompt cannot exfiltrate the token
 * from an env-bound subprocess.
 */

export interface StdioMcpSpec {
  /** Absolute path or bare name of the executable to spawn. */
  command: string
  /** Positional args to append after the command. */
  args?: string[]
  /** Env vars to pass to the subprocess. Replaces, does not extend, the
   *  parent env unless a caller merges explicitly. */
  env?: Record<string, string>
}

export interface BuildSlackUploadStdioSpecOpts {
  /** Target channel id (Slack `C…`). */
  channel: string
  /** Thread anchor ts (Slack message ts string). */
  threadTs: string
  /** Bot token with `files:write` — NOT forwarded to the agent. */
  botToken: string
  /** Session working directory. `null` disables the cwd containment
   *  check (operator opt-out). `undefined` is rejected so callers can't
   *  accidentally forget to think about it. */
  cwd: string | null
  /** Hard cap on upload bytes (default 20 MiB). */
  maxBytes?: number
  /** Slack Web API base override (minislack/tests). Omit for prod. */
  apiBase?: string
  /** The bantai CLI invocation that spawns the stdio server. Defaults to
   *  the current process (`process.argv[0]` + `process.argv[1]`), which
   *  re-enters bantai at `slack mcp-upload-server`. Override when the
   *  parent process isn't bantai (e.g. tests running under bun directly
   *  without the CLI harness). */
  cliCommand?: string
  cliLeadingArgs?: string[]
  /** Additional env to forward (e.g. `NODE_OPTIONS`, proxy vars). Merged
   *  with the bantai-specific env block produced from the binding. */
  extraEnv?: Record<string, string>
}

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

/**
 * Produce a backend-agnostic stdio MCP spec for the slack_upload tool.
 * The returned shape plugs directly into:
 *
 *   - Claude SDK:  `mcpServers: { "bantai-slack-upload": { type: "stdio", ...spec } }`
 *   - Codex SDK:   `config: { mcp_servers: { "bantai-slack-upload": spec } }`
 *
 * Both runtimes pass `env` into the child process; we put the Slack
 * binding there so the agent never sees the bot token or the channel
 * binding in its tool arguments.
 */
export function buildSlackUploadStdioSpec(
  opts: BuildSlackUploadStdioSpecOpts,
): StdioMcpSpec {
  if (!opts.channel) throw new Error("buildSlackUploadStdioSpec: channel is required")
  if (!opts.threadTs) throw new Error("buildSlackUploadStdioSpec: threadTs is required")
  if (!opts.botToken) throw new Error("buildSlackUploadStdioSpec: botToken is required")
  const command = opts.cliCommand ?? process.argv[0] ?? "bun"
  const leading = opts.cliLeadingArgs ?? [
    // argv[1] may be undefined in pure-bun tests; fall back to the bantai
    // bin path relative to this source so the subprocess can still be
    // spawned. This is a best-effort default — production callers pass
    // cliCommand/cliLeadingArgs explicitly via the launcher.
    process.argv[1] ?? new URL("../../../index.ts", import.meta.url).pathname,
  ]
  const args = [...leading, "slack", "mcp-upload-server"]

  const env: Record<string, string> = {
    BANTAI_SLACK_CHANNEL: opts.channel,
    BANTAI_SLACK_THREAD_TS: opts.threadTs,
    BANTAI_SLACK_BOT_TOKEN: opts.botToken,
    BANTAI_SLACK_CWD: opts.cwd ?? "",
    BANTAI_SLACK_MAX_BYTES: String(opts.maxBytes ?? DEFAULT_MAX_BYTES),
    ...(opts.apiBase ? { BANTAI_SLACK_API_BASE: opts.apiBase } : {}),
    ...(opts.extraEnv ?? {}),
  }

  return { command, args, env }
}
