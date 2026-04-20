/**
 * Channel-to-project resolver.
 *
 * Given an inbound Slack `channel_id`, look up the matching entry in
 * `channels[]` in slack.json. If a match is found, its per-channel fields
 * take precedence over `defaults` and fall back to defaults where omitted.
 * If no match is found, the frontend uses `defaults` with the process's cwd
 * as the project_dir — handy for a single-repo self-host where slack.json
 * only specifies `workspace` + `defaults`.
 *
 * This module is pure: no I/O, no logging. The caller feeds in the
 * already-resolved slack config and receives a typed ProjectConfig back.
 */

import type { McpServerSpec, ResolvedSlackConfig, VerbosityLevel } from "../config/schema"
import { log } from "../../../utils/logger"

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
  /**
   * Final composed system prompt handed to the backend. Built from
   * `defaults.system_prompt`, optionally replaced by the channel's
   * `system_prompt_replace`, with the channel's `system_prompt_append`
   * concatenated last (see `composeSystemPrompt`). Undefined → no
   * system prompt configured; backends fall back to their own default.
   */
  systemPrompt?: string
  /** Narrow the tool set exposed to the backend. Undefined → no restriction. */
  allowedTools?: string[]
  /** Subset of MCP servers to load. Undefined → load all. */
  mcpServers?: string[]
  /**
   * Fully-resolved MCP server map, ready to hand to
   * `SessionConfig.mcpServers`. Empty map → use backend defaults.
   * Populated by `resolveProjectForChannel` from the global
   * `[mcp_servers.<name>]` registry, filtered by `mcpServers` above.
   */
  resolvedMcpServers?: Record<string, McpServerSpec>
  /** Slack user ids authorised to approve tool use. Empty → everyone can. */
  approvers: string[]
  /**
   * Backend permission mode: "default" (prompt on mutating tools),
   * "plan" (read-only), "acceptEdits" (auto-accept edits), or
   * "bypassPermissions" (no prompts). Strings rather than a literal
   * union so new SDK modes don't require a schema bump.
   */
  permissionMode: string
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
  /**
   * When true, ignore the thread-participation cache — only explicit
   * `<@bot>` mentions or a live session drive follow-up turns in threads.
   * See schema comment for `thread_require_explicit_mention`.
   */
  threadRequireExplicitMention: boolean
  /**
   * Max prior thread messages to fetch + prepend as context on a fresh
   * session created by a mid-thread @-mention. 0 disables the fetch.
   * See schema comment for `thread_history_limit`.
   */
  threadHistoryLimit: number
  /**
   * Compile `[[slack_buttons:…]]` / `[[slack_select:…]]` directives
   * and trailing `Options: …` lines from agent final text into Block
   * Kit interactive actions.
   */
  interactiveReplies: boolean
  /** Inbox debounce window in ms. 0 disables batching. */
  debounceMs: number
  /** Try tier-1 `chat.startStream` before falling back to draft+update. */
  nativeStreaming: boolean
  /** Max seconds a single turn may run before auto-interrupt. 0 → disabled. */
  turnTimeoutS: number
  /** Max cumulative USD per session. 0 → disabled. */
  maxBudgetUsd: number
  /**
   * Per-post identity override. Undefined when the channel + defaults
   * both leave it blank — then the bot posts under the workspace
   * default, unchanged from pre-identity behaviour. When set, every
   * `chat.postMessage` from this channel's renderer/outbox applies
   * these fields (requires `chat:write.customize`).
   */
  agentIdentity?: {
    username?: string
    iconUrl?: string
    iconEmoji?: string
  }
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
 * Is the channel explicitly declared in `config.channels`?
 *
 * The routing layer uses this to distinguish two cases that
 * `resolveProjectForChannel` collapses together:
 *
 *   1. `channels: []` — self-host mode, every channel intentionally uses
 *      `defaults` + launchCwd. Unconfigured channels are expected.
 *   2. `channels: [...]` with at least one entry — the workspace has
 *      set up per-channel mappings, but this particular channel wasn't
 *      added. Silently falling back to defaults here is almost always a
 *      misconfiguration (e.g. the bot ends up running in the wrong
 *      repository), so the router posts a helpful "add me to slack.json"
 *      reply instead of invoking the agent.
 *
 * Pure lookup — no I/O, no logging. Safe to call inside hot paths.
 */
export function isChannelConfigured(
  config: ResolvedSlackConfig,
  channelId: string,
): boolean {
  return config.channels.some((c) => c.id === channelId)
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
  const permissionMode = override?.permission_mode ?? defaults.permission_mode

  const resolvedMcpServers = resolveMcpServersForChannel(
    config.mcpServers,
    override?.mcp_servers,
    channelId,
  )

  return {
    channelId,
    channelName: override?.name,
    projectDir,
    backend,
    model,
    claudeConfigDir: override?.claude_config_dir,
    systemPrompt: composeSystemPrompt(
      defaults.system_prompt,
      override?.system_prompt_replace,
      override?.system_prompt_append,
    ),
    allowedTools: override?.allowed_tools,
    mcpServers: override?.mcp_servers,
    ...(resolvedMcpServers ? { resolvedMcpServers } : {}),
    approvers,
    verbosity,
    requireMention,
    permissionMode,
    triggerName: defaults.trigger_name,
    controlPrefix: defaults.control_prefix,
    sessionBanner: defaults.session_banner,
    showCost: defaults.show_cost,
    autoJoinThreads: defaults.auto_join_threads,
    threadRequireExplicitMention:
      override?.thread_require_explicit_mention ??
      defaults.thread_require_explicit_mention,
    threadHistoryLimit:
      override?.thread_history_limit ?? defaults.thread_history_limit,
    interactiveReplies:
      override?.interactive_replies ?? defaults.interactive_replies,
    debounceMs: override?.debounce_ms ?? defaults.debounce_ms,
    nativeStreaming: override?.native_streaming ?? defaults.native_streaming,
    turnTimeoutS: override?.turn_timeout_s ?? defaults.turn_timeout_s,
    maxBudgetUsd: override?.max_budget_usd ?? defaults.max_budget_usd,
    ...((): { agentIdentity?: ProjectConfig["agentIdentity"] } => {
      const username = override?.agent_username ?? defaults.agent_username
      const iconUrl = override?.agent_icon_url ?? defaults.agent_icon_url
      const iconEmoji = override?.agent_icon_emoji ?? defaults.agent_icon_emoji
      if (!username && !iconUrl && !iconEmoji) return {}
      const identity: NonNullable<ProjectConfig["agentIdentity"]> = {}
      if (username) identity.username = username
      if (iconUrl) identity.iconUrl = iconUrl
      if (iconEmoji) identity.iconEmoji = iconEmoji
      return { agentIdentity: identity }
    })(),
    env: resolveEnvRefs(override?.env, env),
  }
}

/**
 * Resolve the per-channel MCP server subset against the global registry.
 *
 * - If the channel doesn't list any names (`undefined`) → `undefined`
 *   (use backend defaults — don't touch `SessionConfig.mcpServers`).
 * - If the channel lists `[]` → `{}` (explicitly empty — disable every
 *   registered server for this channel).
 * - Otherwise → pick the subset by name. Unknown names log a single
 *   `log.warn` so misconfiguration is visible without crashing the
 *   launcher.
 */
export function resolveMcpServersForChannel(
  registry: Record<string, McpServerSpec>,
  requestedNames: string[] | undefined,
  channelIdForLog: string,
): Record<string, McpServerSpec> | undefined {
  if (requestedNames === undefined) return undefined
  const out: Record<string, McpServerSpec> = {}
  const unknown: string[] = []
  for (const name of requestedNames) {
    const spec = registry[name]
    if (!spec) {
      unknown.push(name)
      continue
    }
    out[name] = spec
  }
  if (unknown.length > 0) {
    log.warn(
      `slack: channel ${channelIdForLog} references unknown MCP servers: ${unknown.join(", ")} (registry keys: ${Object.keys(registry).join(", ") || "<empty>"})`,
    )
  }
  return out
}

/**
 * Compose the final system prompt for a channel from:
 *   - `defaultPrompt`      — `defaults.system_prompt`, the workspace-wide base
 *   - `channelReplace`     — `channels[].system_prompt_replace`; when set, it
 *                            swaps out the defaultPrompt entirely
 *   - `channelAppend`      — `channels[].system_prompt_append`; always
 *                            concatenated LAST with a blank-line separator,
 *                            so per-channel guidance overrides anything
 *                            earlier in the composed prompt. May be a single
 *                            string or an array of strings — array entries
 *                            are joined with a blank-line separator and
 *                            empty entries are skipped.
 *
 * Returns undefined when no component is set — backends then fall back to
 * their own default system prompt. Exported for unit tests.
 */
export function composeSystemPrompt(
  defaultPrompt: string | undefined,
  channelReplace: string | undefined,
  channelAppend: string | string[] | undefined,
): string | undefined {
  const base = channelReplace ?? defaultPrompt
  const appendText = normalizeAppend(channelAppend)
  if (appendText) {
    return base ? `${base}\n\n${appendText}` : appendText
  }
  return base
}

function normalizeAppend(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined
  const parts = Array.isArray(raw) ? raw : [raw]
  const joined = parts.filter((p) => p.length > 0).join("\n\n")
  return joined.length > 0 ? joined : undefined
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
