/**
 * slack.json schema — zod validation for the Slack frontend config.
 *
 * The file layout is described in plan-slack-integration.md §3.1.
 */

import { z } from "zod"

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A secret field: either a literal string, or `{ "env": "VAR_NAME" }` indirecting
 * to an environment variable. Env form is preferred — it keeps tokens out of
 * the config file on disk.
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
    slack_api_url: z.url().optional(),
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
     * When true, the bot only reacts to explicit `<@bot>` mentions in a
     * channel thread — the thread-participation cache (which normally lets
     * the bot keep responding in a thread it already posted in) is
     * ignored for this channel. Leave false for ChatGPT-style UX where
     * the bot "stays in" a thread after the first reply.
     *
     * Has no effect in DMs (always triggered) or when `auto_join_threads`
     * is false.
     */
    thread_require_explicit_mention: z.boolean().default(false),
    /**
     * When the bot is @-mentioned mid-thread for the first time (no prior
     * session for this thread), fetch up to N most-recent prior messages
     * via `conversations.replies` and prepend them as a `<slack_thread_history>`
     * preamble on the first turn. Each prior message is annotated with
     * author display name, role (user/assistant), and timestamp so the
     * agent sees who said what when.
     *
     * Default 20 — enough for a typical discussion thread without blowing
     * the context window. Set to 0 to disable (previous behaviour: agent
     * only sees the triggering mention). Thread replies after the first
     * turn are not re-prefetched — the live session accumulates its own
     * history from that point on.
     *
     * Only runs on fresh sessions (not rehydrated from the persistent
     * store), so a restart doesn't double-include prior context. Fetch
     * failures are logged and skipped — the agent still gets the current
     * message.
     */
    thread_history_limit: z.number().int().nonnegative().default(20),
    /**
     * Compile `[[slack_buttons: …]]` / `[[slack_select: …]]` directives
     * and trailing `Options: a, b, c.` lines from the agent's final reply
     * into Block Kit interactive actions. Clicking a button feeds a new
     * turn with the button's value. Off by default — flip on for channels
     * where you want the agent to author rich prompts.
     */
    interactive_replies: z.boolean().default(false),
    /**
     * Milliseconds the inbox waits after the last message from a given
     * (channel, thread, sender) triple before dispatching a turn. Rapid-
     * fire messages within this window are combined into one agent
     * request, so a user typing three lines sees one turn, not three.
     * 0 or negative disables batching (every message dispatches
     * synchronously) — matches pre-debouncer behaviour.
     */
    debounce_ms: z.number().int().nonnegative().default(0),
    /**
     * Tier-1 streaming via `chat.startStream` / `appendStream` /
     * `stopStream`. Slack's Assistant API surface — streams tokens
     * word-by-word into a single message, noticeably better UX than
     * our tier-2 draft+update loop. Only exposed on paid workspaces
     * with the AI-apps capability. minislack also implements these
     * methods so integration tests can exercise tier-1 end-to-end;
     * on real Slack workspaces without the capability the outbox
     * auto-falls-back on the error.
     *
     * Off by default; requires live Slack workspace validation before
     * enabling in defaults (slack-int-gap.md §4).
     */
    native_streaming: z.boolean().default(false),
    /**
     * Off by default per plan §6. When true, a cost footer is posted after
     * every turn_complete; verbosity ≥ normal renders a one-liner, verbose
     * renders per-category token breakdowns.
     */
    show_cost: z.boolean().default(false),
    /**
     * Maximum seconds a single turn may run before the renderer interrupts
     * it via `backend.interrupt()`. 0 or undefined → disabled. Implemented
     * at the renderer level so per-channel overrides work naturally.
     */
    turn_timeout_s: z.number().int().nonnegative().default(0),
    /**
     * Hard session cost cap in USD. When cumulative session cost exceeds
     * this, the next turn is interrupted on turn_start and subsequent
     * turns refuse to run until `!bantai new`. 0 or undefined → disabled.
     */
    max_budget_usd: z.number().nonnegative().default(0),
    /**
     * Seconds of inactivity (no inbound user turn) before the registry
     * idle-closes a session and evicts it from memory. The on-disk
     * store is NOT touched, so the next inbound message in the thread
     * rehydrates the session transparently. Default: 3600 (60 minutes).
     * 0 disables idle eviction — sessions live forever in-process.
     */
    idle_timeout_s: z.number().int().nonnegative().default(60 * 60),
    /**
     * Per-post identity override fields. When set, every `chat.postMessage`
     * the bot makes rides with a custom username + icon — useful when a
     * channel hosts multiple bantai agents backed by the same bot user
     * ("Reviewer", "Refactor-bot") so humans can tell them apart at a
     * glance.
     *
     * Requires `chat:write.customize` on the bot token. When the scope
     * is missing, the send-adapter falls back to the default workspace
     * identity and logs one warning per process lifetime.
     */
    agent_username: z.string().optional(),
    agent_icon_url: z.url().optional(),
    agent_icon_emoji: z.string().optional(),
    /**
     * Workspace-wide default system prompt handed to the agent backend on
     * every session. Channels may override this entirely via
     * `system_prompt_replace` or extend it via `system_prompt_append` —
     * the append text is always concatenated last with a blank-line
     * separator. Omit to leave the backend's own default in effect.
     *
     * Accepts a single string or an array of strings. Arrays are joined
     * with a blank-line separator so a long workspace-wide prompt can be
     * authored as a list of small paragraphs rather than one line with
     * embedded `\n` escapes — JSON has no multi-line string literal, so
     * this is the idiomatic way to keep individual physical lines short.
     * An empty array, or an array whose entries are all empty strings,
     * normalises to undefined (no prompt set) — matches the behaviour of
     * `system_prompt_append`.
     */
    system_prompt: z
      .union([z.string(), z.array(z.string())])
      .transform((v) => {
        if (!Array.isArray(v)) return v
        const joined = v.filter((p) => p.length > 0).join("\n\n")
        return joined.length > 0 ? joined : undefined
      })
      .optional(),
    /**
     * Path to a file whose contents become `defaults.system_prompt`. Useful
     * for long prompts where inlining them as JSON strings — even as an
     * array — would clutter the config file. The file is read verbatim
     * (no template expansion) at load time.
     *
     * Path resolution:
     *   - Absolute path (e.g. `/etc/bantai/system-prompt.md`) → used as-is.
     *   - Tilde-prefixed (e.g. `~/bantai/prompt.md`) → expanded against
     *     `$HOME`.
     *   - Relative path (e.g. `./prompts/base.md`) → resolved against the
     *     directory of the config file on disk. Relative paths are NOT
     *     supported for inline configs (tests / in-process harnesses) —
     *     use an absolute path there.
     *
     * Mutually exclusive with `system_prompt`: setting both is a load-time
     * error so the operator doesn't accidentally mask one with the other.
     * Missing file → load-time error (fail-fast, the agent shouldn't
     * silently boot with no system prompt when the operator clearly
     * intended one).
     */
    system_prompt_file: z.string().optional(),
    /**
     * Optional Slack channel id (e.g. `C0ABCDEF`) that receives a one-line
     * diff summary after every non-noop config reload and the zod error
     * card on every reload rejection. When absent, the operator has no
     * in-Slack feedback surface — only `~/.bantai/logs/<session>.log`
     * and `bantai slack doctor` reflect reload outcomes. Set this to an
     * ops channel you already monitor.
     */
    reload_notify_channel: z.string().optional(),
  })
  .strict()
export type DefaultsConfig = z.infer<typeof DefaultsSchema>

// ---------------------------------------------------------------------------
// mcp_servers.<name>  — global registry of available MCP servers.
//
// Per-channel configs list names from this registry to opt in; an unlisted
// channel sees the SDK's default (claude's built-in MCP set, nothing for
// other backends). Three shapes are supported, matching the Claude SDK's
// discriminated union: stdio (the common case), http, and sse. Every
// secret-bearing field (env values, HTTP headers) accepts the SecretRef
// indirection so tokens stay out of the config file on disk.
// ---------------------------------------------------------------------------

const McpStdioServerSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), SecretRefSchema).optional(),
  })
  .strict()

const McpHttpServerSchema = z
  .object({
    type: z.literal("http"),
    url: z.url(),
    headers: z.record(z.string(), SecretRefSchema).optional(),
  })
  .strict()

const McpSseServerSchema = z
  .object({
    type: z.literal("sse"),
    url: z.url(),
    headers: z.record(z.string(), SecretRefSchema).optional(),
  })
  .strict()

export const McpServerSpecSchema = z.union([
  McpStdioServerSchema,
  McpHttpServerSchema,
  McpSseServerSchema,
])
export type McpServerSpec = z.infer<typeof McpServerSpecSchema>

// ---------------------------------------------------------------------------
// channels[]  — per-channel overrides.
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
    /**
     * Replace the workspace-wide `defaults.system_prompt` for this channel.
     * If both `system_prompt_replace` and `system_prompt_append` are set,
     * the replace text becomes the base and the append text is concatenated
     * after it with a blank-line separator.
     */
    system_prompt_replace: z.string().optional(),
    /**
     * Appended to whatever base system prompt is in effect for this channel
     * — either `defaults.system_prompt` or this channel's
     * `system_prompt_replace`. When no base is set, the append text becomes
     * the full system prompt. The append text is always concatenated last.
     *
     * Accepts a single string or an array of strings. Arrays are joined with
     * a blank-line separator so per-channel guidance can be authored as a
     * list of small, independent instructions rather than one monolithic
     * paragraph.
     */
    system_prompt_append: z.union([z.string(), z.array(z.string())]).optional(),
    approvers: z.array(z.string()).optional(),
    verbosity: VerbosityLevelSchema.optional(),
    require_mention: z.boolean().optional(),
    thread_require_explicit_mention: z.boolean().optional(),
    thread_history_limit: z.number().int().nonnegative().optional(),
    interactive_replies: z.boolean().optional(),
    debounce_ms: z.number().int().nonnegative().optional(),
    native_streaming: z.boolean().optional(),
    permission_mode: z.string().optional(),
    turn_timeout_s: z.number().int().nonnegative().optional(),
    max_budget_usd: z.number().nonnegative().optional(),
    agent_username: z.string().optional(),
    agent_icon_url: z.url().optional(),
    agent_icon_emoji: z.string().optional(),
    env: z.record(z.string(), SecretRefSchema).optional(),
  })
  .strict()
export type ChannelOverride = z.infer<typeof ChannelOverrideSchema>

// ---------------------------------------------------------------------------
// [admin]  — optional admin HTTP+WebSocket API.
//
// Off by default. When `enabled = true`, the launcher stands up a dedicated
// `Bun.serve()` on its own host/port (independent of Bolt's HTTP receiver so
// Socket Mode deployments still get admin). The `bantai slack monitor` TUI
// is the primary client, but the protocol is framework-agnostic — curl and a
// future browser viewer can consume it too.
//
// See team/bantai-slack-monitor-tui.md for the full rationale.
// ---------------------------------------------------------------------------

export const AdminConfigSchema = z
  .object({
    /** Stand up the admin server. Off by default. */
    enabled: z.boolean().default(false),
    /** Bind host. 127.0.0.1 is the security-conservative default. */
    host: z.string().default("127.0.0.1"),
    /**
     * Bind port. 0 tells the OS to pick an ephemeral port — useful for
     * integration tests that need a free port without hard-coding.
     */
    port: z.number().int().min(0).max(65535).default(4242),
    /**
     * Where the bearer token is stored on disk, mode 0600. The monitor
     * reads this file by default. `~` is expanded at load time.
     */
    token_path: z.string().default("~/.bantai/slack/admin-token"),
    /**
     * When true, every write endpoint (approve / deny / reset / interrupt /
     * close) rejects with 403 read_only. Useful for "watch but don't touch"
     * deployments.
     */
    read_only: z.boolean().default(false),
    /**
     * How many recent events to retain per session for back-fill. A monitor
     * connecting mid-session gets the tail of this buffer before switching
     * to live frames. Defaults to 200 — see plan §"Why the ring buffer".
     */
    session_ring_size: z.number().int().min(10).max(5000).default(200),
  })
  .strict()
export type AdminConfig = z.infer<typeof AdminConfigSchema>

// ---------------------------------------------------------------------------
// Top-level SlackConfig
// ---------------------------------------------------------------------------

export const SlackConfigSchema = z
  .object({
    workspace: WorkspaceSchema,
    // `prefault` (zod 4) replaces `.optional().default({})` (zod 3) —
    // supplies the missing-key default to the INPUT so every field-level
    // default inside DefaultsSchema fires during parse.
    defaults: DefaultsSchema.prefault({}),
    channels: z.array(ChannelOverrideSchema).default([]),
    /**
     * Global MCP server registry. Channels reference these by name via
     * `channels[].mcp_servers: ["git", "brave-search"]`. Empty by
     * default — most self-hosts rely on the backend's built-in MCP set.
     */
    mcp_servers: z.record(z.string(), McpServerSpecSchema).default({}),
    /**
     * SQLite path for per-session persistence (plan §S8 crash recovery).
     * Tilde-expansion and default resolution happen in the loader.
     *
     * Three cases:
     *   - Key omitted entirely → default to `~/.bantai/slack.db`
     *     (persistence on — the common case, so threads survive
     *     restarts without any explicit config).
     *   - Explicit `""` → persistence disabled (restarts start every
     *     thread fresh). Required for tests that want in-memory-only
     *     behaviour.
     *   - Any other string → used verbatim (with `~` expansion).
     */
    store_path: z.string().optional(),
    /**
     * Admin HTTP+WS surface. Omitted / empty → admin disabled, which is
     * the secure default. See `AdminConfigSchema` above for fields.
     */
    admin: AdminConfigSchema.prefault({}),
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
  /**
   * Global MCP registry — name → server spec (stdio/http/sse). Channels
   * opt in by listing names in `mcp_servers = [...]`. Secrets in env/
   * headers are NOT yet resolved here — `resolveMcpServersForChannel`
   * resolves them lazily per-session so process.env mutations between
   * boot and first turn are picked up.
   */
  mcpServers: Record<string, McpServerSpec>
  /**
   * Resolved absolute path to the session-persistence SQLite file. Empty
   * string → persistence disabled (registry uses a no-op store).
   */
  storePath: string
  /**
   * Resolved admin surface config. Always present (per-field defaults fire
   * on an absent `admin` block), but `admin.enabled` gates the launcher:
   * when false, no Bun.serve is started and no code path touches the port.
   * `tokenPath` is tilde-expanded at load time so downstream code can read
   * the file directly.
   */
  admin: ResolvedAdminConfig
  /** Where the config was loaded from, for log lines + diagnostics. */
  source: string
}

export interface ResolvedAdminConfig {
  enabled: boolean
  host: string
  port: number
  tokenPath: string
  readOnly: boolean
  sessionRingSize: number
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
    mcpServers: parsed.mcp_servers,
    storePath: resolveStorePath(parsed.store_path, env),
    admin: resolveAdminConfig(parsed.admin, env),
    source,
  }
}

function resolveAdminConfig(
  raw: AdminConfig,
  env: NodeJS.ProcessEnv,
): ResolvedAdminConfig {
  return {
    enabled: raw.enabled,
    host: raw.host,
    port: raw.port,
    tokenPath: expandHome(raw.token_path, env),
    readOnly: raw.read_only,
    sessionRingSize: raw.session_ring_size,
  }
}

/**
 * Resolve the session-store path:
 *   - `undefined` (key absent from JSON) → default `~/.bantai/slack.db`,
 *     tilde-expanded. Persistence-on is the intended default so Slack
 *     threads survive a `bantai slack` restart without opt-in config.
 *   - Empty string (`""` — explicit) → persistence disabled. Used by
 *     tests that want no on-disk side effects, and by operators who
 *     genuinely want fresh-every-restart behaviour.
 *   - `~/...` → expanded against `$HOME` (or returned verbatim on odd
 *     envs without `HOME`).
 *   - Any other absolute or relative path → returned verbatim.
 */
function resolveStorePath(raw: string | undefined, env: NodeJS.ProcessEnv): string {
  if (raw === undefined) return expandHome("~/.bantai/slack.db", env)
  if (raw === "") return ""
  return expandHome(raw, env)
}

function expandHome(p: string, env: NodeJS.ProcessEnv): string {
  if (!p.startsWith("~")) return p
  const home = env.HOME ?? env.USERPROFILE ?? ""
  if (!home) return p
  return `${home}${p.slice(1)}`
}
