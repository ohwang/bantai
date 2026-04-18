/**
 * Channel-to-project resolver.
 *
 * Given an inbound Slack `channel_id`, look up the `[[channels]]` override
 * in slack.toml. If a match is found, its per-channel fields take precedence
 * over `[defaults]` and fall back to defaults where omitted. If no match is
 * found, the frontend uses `[defaults]` with the process's cwd as the
 * project_dir — handy for a single-repo self-host where slack.toml only
 * specifies `[workspace]` + `[defaults]`.
 *
 * This module is pure: no I/O, no logging. The caller feeds in the
 * already-resolved slack config and receives a typed ProjectConfig back.
 */

import type { ResolvedSlackConfig, VerbosityLevel } from "../config/schema"

export type BackendId = "claude" | "codex" | "gemini" | "copilot" | "acp" | "mock"

export interface ProjectConfig {
  /** The channel id this config is for (e.g. `C0ABC123`). */
  channelId: string
  /** Human label for logs. May be undefined for channels without a declared name. */
  channelName?: string
  /** Working directory the backend cd's into before running. */
  projectDir: string
  /** Backend to spin up. */
  backend: BackendId
  /** Optional model override. Undefined → backend default. */
  model?: string
  /**
   * Directory to set as CLAUDE_CONFIG_DIR when the backend is Claude. Lets each
   * channel isolate skills, MCP tokens, and project-level settings. Undefined
   * → the default `~/.claude`.
   */
  claudeConfigDir?: string
  /** Appended to the system prompt. */
  systemPromptAppend?: string
  /** Narrow the tool set exposed to the backend. Undefined → no restriction. */
  allowedTools?: string[]
  /** Subset of MCP servers to load. Undefined → load all. */
  mcpServers?: string[]
  /** Slack user ids authorised to approve tool use. Empty → everyone can. */
  approvers: string[]
  /** Max verbosity of bot output in the channel. */
  verbosity: VerbosityLevel
  /** Does the bot require an @mention in channels? DMs are always triggered. */
  requireMention: boolean
  /** Name the bot reacts to (`@bantai` etc.). */
  triggerName: string
  /** Prefix for control commands in the channel. */
  controlPrefix: string
  /** Show the formal session banner on new sessions? */
  sessionBanner: boolean
  /** Post a cost footer after every turn_complete (off by default). */
  showCost: boolean
  /** Should the bot auto-attach to threads it's posted in without re-mention? */
  autoJoinThreads: boolean
  /** Extra env vars to pass to the backend process. Resolved from SecretRefs. */
  env: Record<string, string>
}

export interface ResolveProjectOpts {
  /** Fallback cwd when `project_dir` is not set on the channel and the defaults block doesn't specify one either. */
  launchCwd: string
  /**
   * Environment for resolving per-channel `env.XYZ = { env = "VAR" }` entries.
   * Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv
}

/**
 * Resolve a channel id to a full ProjectConfig. Always succeeds — when the
 * channel is not in `config.channels`, defaults + launchCwd fill in.
 *
 * The returned `requireMention` follows Slack semantics: DMs never require a
 * mention regardless of config. We cannot detect DMs from channel id alone,
 * so the caller (inbox/gate) is responsible for force-setting that to false
 * when it knows the channel is an IM.
 */
export function resolveProjectForChannel(
  config: ResolvedSlackConfig,
  channelId: string,
  opts: ResolveProjectOpts,
): ProjectConfig {
  const defaults = config.defaults
  const override = config.channels.find((c) => c.id === channelId)
  const env = opts.env ?? process.env

  const projectDir = override?.project_dir ?? opts.launchCwd
  const backend = (override?.backend ?? defaults.backend) as BackendId
  const model = override?.model ?? defaults.model
  const approvers = override?.approvers ?? defaults.approvers
  const verbosity = override?.verbosity ?? defaults.verbosity
  const requireMention = override?.require_mention ?? defaults.require_mention

  return {
    channelId,
    channelName: override?.name,
    projectDir,
    backend,
    model,
    claudeConfigDir: override?.claude_config_dir,
    systemPromptAppend: override?.system_prompt_append,
    allowedTools: override?.allowed_tools,
    mcpServers: override?.mcp_servers,
    approvers,
    verbosity,
    requireMention,
    triggerName: defaults.trigger_name,
    controlPrefix: defaults.control_prefix,
    sessionBanner: defaults.session_banner,
    showCost: defaults.show_cost,
    autoJoinThreads: defaults.auto_join_threads,
    env: resolveEnvRefs(override?.env, env),
  }
}

function resolveEnvRefs(
  refs: Record<string, string | { env: string }> | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!refs) return {}
  const out: Record<string, string> = {}
  for (const [key, ref] of Object.entries(refs)) {
    if (typeof ref === "string") {
      out[key] = ref
      continue
    }
    const resolved = env[ref.env]
    if (resolved && resolved.length > 0) out[key] = resolved
  }
  return out
}
