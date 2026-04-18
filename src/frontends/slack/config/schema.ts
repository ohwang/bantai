/**
 * slack.toml schema — zod validation for the Slack frontend config.
 *
 * Phase S0 shape: workspace connection only (+ minimal defaults). Channel
 * overrides land in S1+; we reserve the keys now so adopters can write the
 * full config from day one and additional runtime knobs degrade gracefully.
 *
 * The file layout is described in plan-slack-integration.md §3.1.
 */

import { z } from "zod"

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A secret field: either a literal string, or `{ env = "VAR_NAME" }` indirecting
 * to an environment variable. Env form is preferred — it keeps tokens out of
 * the TOML on disk.
 */
export const SecretRefSchema = z.union([
  z.string().min(1),
  z
    .object({ env: z.string().min(1) })
    .strict(),
])
export type SecretRef = z.infer<typeof SecretRefSchema>

/** Resolve a SecretRef to its concrete string value at load time. */
export function resolveSecret(
  ref: SecretRef | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (ref === undefined) return undefined
  if (typeof ref === "string") return ref
  const value = env[ref.env]
  return value && value.length > 0 ? value : undefined
}

// ---------------------------------------------------------------------------
// [workspace]
// ---------------------------------------------------------------------------

export const WorkspaceSchema = z
  .object({
    /** "socket" uses Slack Socket Mode; "http" runs an HTTP receiver. */
    mode: z.enum(["socket", "http"]).default("socket"),
    bot_token: SecretRefSchema.optional(),
    app_token: SecretRefSchema.optional(),
    signing_secret: SecretRefSchema.optional(),
    /** HTTP mode only — path for Events API callbacks. */
    webhook_path: z.string().default("/slack/events"),
    /** HTTP mode only — port for the receiver server. */
    port: z.number().int().positive().optional(),
    /**
     * For tests and local dev: point Bolt's Web API + Socket Mode WS at a
     * minislack instance instead of api.slack.com. Must end with `/api/`
     * when set (matches WebClientOptions.slackApiUrl).
     */
    slack_api_url: z.string().url().optional(),
  })
  .strict()
export type WorkspaceConfig = z.infer<typeof WorkspaceSchema>

// ---------------------------------------------------------------------------
// [defaults]
// ---------------------------------------------------------------------------

export const VerbosityLevelSchema = z.enum([
  "silent",
  "concise",
  "normal",
  "verbose",
  "debug",
])
export type VerbosityLevel = z.infer<typeof VerbosityLevelSchema>

export const DefaultsSchema = z
  .object({
    backend: z.enum(["claude", "codex", "gemini", "acp", "mock"]).default("claude"),
    model: z.string().optional(),
    permission_mode: z.string().default("default"),
    require_mention: z.boolean().default(true),
    trigger_name: z.string().default("bantai"),
    verbosity: VerbosityLevelSchema.default("normal"),
    control_prefix: z.string().default("!bantai"),
    session_banner: z.boolean().default(true),
    approvers: z.array(z.string()).default([]),
    auto_join_threads: z.boolean().default(true),
    /**
     * Off by default per plan §6. When true, a cost footer is posted after
     * every turn_complete; verbosity ≥ normal renders a one-liner, verbose
     * renders per-category token breakdowns.
     */
    show_cost: z.boolean().default(false),
  })
  .strict()
export type DefaultsConfig = z.infer<typeof DefaultsSchema>

// ---------------------------------------------------------------------------
// [[channels]]  — reserved for S1+; validated but unused in S0.
// ---------------------------------------------------------------------------

export const ChannelOverrideSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    project_dir: z.string().optional(),
    claude_config_dir: z.string().optional(),
    backend: z.enum(["claude", "codex", "gemini", "acp", "mock"]).optional(),
    model: z.string().optional(),
    allowed_tools: z.array(z.string()).optional(),
    mcp_servers: z.array(z.string()).optional(),
    system_prompt_append: z.string().optional(),
    approvers: z.array(z.string()).optional(),
    verbosity: VerbosityLevelSchema.optional(),
    require_mention: z.boolean().optional(),
    env: z.record(z.string(), SecretRefSchema).optional(),
  })
  .strict()
export type ChannelOverride = z.infer<typeof ChannelOverrideSchema>

// ---------------------------------------------------------------------------
// Top-level SlackConfig
// ---------------------------------------------------------------------------

export const SlackConfigSchema = z
  .object({
    workspace: WorkspaceSchema,
    defaults: DefaultsSchema.optional().default({}),
    channels: z.array(ChannelOverrideSchema).default([]),
  })
  .strict()
export type SlackConfig = z.infer<typeof SlackConfigSchema>

/**
 * Resolved form of SlackConfig after secrets and defaults have been applied.
 * This is the shape the Bolt transport + routing layer consume.
 */
export interface ResolvedSlackConfig {
  workspace: {
    mode: "socket" | "http"
    botToken?: string
    appToken?: string
    signingSecret?: string
    webhookPath: string
    port?: number
    slackApiUrl?: string
  }
  defaults: DefaultsConfig
  channels: ChannelOverride[]
  /** Where the config was loaded from, for log lines + diagnostics. */
  source: string
}

export function resolveSlackConfig(
  parsed: SlackConfig,
  source: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSlackConfig {
  return {
    workspace: {
      mode: parsed.workspace.mode,
      botToken: resolveSecret(parsed.workspace.bot_token, env),
      appToken: resolveSecret(parsed.workspace.app_token, env),
      signingSecret: resolveSecret(parsed.workspace.signing_secret, env),
      webhookPath: parsed.workspace.webhook_path,
      port: parsed.workspace.port,
      slackApiUrl: parsed.workspace.slack_api_url,
    },
    defaults: parsed.defaults,
    channels: parsed.channels,
    source,
  }
}
