/**
 * Control-command dispatcher.
 *
 * Given a parsed `ControlCommand`, run the right side-effect. The dispatcher
 * doesn't know about Slack directly — it takes a `CommandContext` with
 * narrow operations (`sendReply`, `interrupt`, `setModel`, `resetSession`)
 * so tests can inject fakes and the same dispatch can later be triggered
 * from Block Kit buttons or emoji reactions.
 *
 * S3 scope — minimum viable command set per plan §7.1:
 *
 *   !bantai help           list all commands + short descriptions
 *   !bantai status         post session state + project info
 *   !bantai stop           interrupt the active turn
 *   !bantai model [id]     list models, or set the active model
 *   !bantai verbosity <l>  change verbosity for this channel
 *   !bantai new            reset the thread's session (destructive; confirm in S4)
 *
 * `backend`, `cost`, `resume`, `permissions`, `thinking`, `compact`, the
 * emoji-reaction surface, and the Block Kit banner actions layer on top of
 * this same dispatcher in later phases.
 */

import type { ControlCommand } from "./parser"
import type { VerbosityLevel } from "../config/schema"
import type { ProjectConfig } from "../router/resolver"

export interface CommandContext {
  /** Post a reply back in the session's thread. */
  sendReply(text: string): Promise<void>
  /** Interrupt the active turn. */
  interrupt(): void
  /** Change the active model. */
  setModel(model: string): Promise<void>
  /** Reset the thread's session (new history). */
  resetSession(): Promise<void>
  /** Change verbosity — persisted by the launcher. */
  setVerbosity(level: VerbosityLevel): void
  /** Snapshot of the current project config for status reads. */
  project: ProjectConfig
  /** Workspace team id. */
  workspace: string
  /** Channel id. */
  channel: string
  /** Thread anchor ts. */
  threadTs: string
  /** Names of available models for the "model" command listing. */
  availableModels?: () => Promise<string[]>
  /**
   * Cumulative usage for the current session — drives `!bantai cost`. When
   * absent, the cost command reports "not tracked yet" rather than failing.
   */
  cumulativeUsage?: () => SessionUsageSnapshot
}

export interface SessionUsageSnapshot {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number
}

export type DispatchResult =
  | { kind: "handled" }
  | { kind: "unknown"; cmd: string }
  | { kind: "invalid"; reason: string }

const VALID_VERBOSITIES: VerbosityLevel[] = ["silent", "concise", "normal", "verbose", "debug"]

export async function dispatchCommand(
  command: ControlCommand,
  ctx: CommandContext,
): Promise<DispatchResult> {
  switch (command.cmd) {
    case "help":
      await ctx.sendReply(HELP_TEXT)
      return { kind: "handled" }

    case "status": {
      const lines = [
        `*bantai status*`,
        `• backend: \`${ctx.project.backend}\``,
        `• model: \`${ctx.project.model ?? "<default>"}\``,
        `• cwd: \`${ctx.project.projectDir}\``,
        `• verbosity: \`${ctx.project.verbosity}\``,
        `• require_mention: \`${ctx.project.requireMention}\``,
        `• channel: \`${ctx.channel}\``,
        `• thread: \`${ctx.threadTs}\``,
      ]
      await ctx.sendReply(lines.join("\n"))
      return { kind: "handled" }
    }

    case "stop":
    case "cancel":
    case "interrupt": {
      // :watermelon: matches the reaction surface for user-triggered
      // interrupts. :octagonal_sign: is reserved for internal errors
      // (session state compromised — connection lost, backend crash).
      ctx.interrupt()
      await ctx.sendReply(":watermelon: interrupted")
      return { kind: "handled" }
    }

    case "model": {
      if (command.args.length === 0) {
        const models = ctx.availableModels ? await ctx.availableModels() : []
        const body =
          models.length === 0
            ? `current model: \`${ctx.project.model ?? "<default>"}\` (listing unavailable)`
            : `current: \`${ctx.project.model ?? "<default>"}\`\navailable:\n${models.map((m) => `• \`${m}\``).join("\n")}`
        await ctx.sendReply(body)
        return { kind: "handled" }
      }
      try {
        await ctx.setModel(command.args)
        await ctx.sendReply(`model set to \`${command.args}\``)
        return { kind: "handled" }
      } catch (err) {
        await ctx.sendReply(`failed to set model: ${String(err)}`)
        return { kind: "invalid", reason: String(err) }
      }
    }

    case "verbosity": {
      const level = command.args as VerbosityLevel
      if (!VALID_VERBOSITIES.includes(level)) {
        await ctx.sendReply(
          `usage: \`!bantai verbosity <${VALID_VERBOSITIES.join("|")}>\``,
        )
        return { kind: "invalid", reason: "unknown-verbosity" }
      }
      ctx.setVerbosity(level)
      await ctx.sendReply(`verbosity set to \`${level}\``)
      return { kind: "handled" }
    }

    case "new":
    case "reset": {
      await ctx.resetSession()
      await ctx.sendReply(":recycle: session reset")
      return { kind: "handled" }
    }

    case "settings": {
      await ctx.sendReply(renderSettingsDump(ctx.project))
      return { kind: "handled" }
    }

    case "cost": {
      await ctx.sendReply(renderCostReport(ctx.cumulativeUsage?.()))
      return { kind: "handled" }
    }

    default:
      await ctx.sendReply(
        `unknown command \`${command.cmd}\`. try \`!bantai help\`.`,
      )
      return { kind: "unknown", cmd: command.cmd }
  }
}

const HELP_TEXT = [
  "*bantai control commands*",
  "",
  "• `!bantai help` — list commands",
  "• `!bantai status` — show backend, model, cwd, verbosity, channel binding",
  "• `!bantai stop` — interrupt the active turn",
  "• `!bantai model [id]` — list available models, or set the active one",
  "• `!bantai verbosity <silent|concise|normal|verbose|debug>` — change bot verbosity",
  "• `!bantai new` — reset this thread's session (destructive)",
  "• `!bantai settings` — dump the resolved per-channel config",
  "• `!bantai cost` — session token + cost totals",
  "",
  "_more commands (backend, resume, permissions, thinking, compact) land in later phases._",
].join("\n")

/**
 * Render the resolved ProjectConfig as a mrkdwn-formatted block. Secrets
 * (env values) are redacted — we show the keys so operators can verify the
 * plumbing without leaking tokens back into chat. Arrays land as comma
 * joins with an `<empty>` marker so empty state is visible.
 */
export function renderSettingsDump(project: ProjectConfig): string {
  const envKeys = Object.keys(project.env)
  const lines = [
    "*bantai settings* — resolved config for this channel",
    "",
    `• channel: \`${project.channelId}\`${project.channelName ? ` (#${project.channelName})` : ""}`,
    `• backend: \`${project.backend}\``,
    `• model: \`${project.model ?? "<backend default>"}\``,
    `• project_dir: \`${project.projectDir}\``,
    `• permission_mode: \`${project.permissionMode}\``,
    `• verbosity: \`${project.verbosity}\``,
    `• show_cost: \`${project.showCost}\``,
    `• session_banner: \`${project.sessionBanner}\``,
    `• require_mention: \`${project.requireMention}\``,
    `• auto_join_threads: \`${project.autoJoinThreads}\``,
    `• trigger_name: \`${project.triggerName}\``,
    `• control_prefix: \`${project.controlPrefix}\``,
    `• approvers: ${formatList(project.approvers)}`,
    `• allowed_tools: ${formatList(project.allowedTools)}`,
    `• mcp_servers: ${formatList(project.mcpServers)}`,
    `• claude_config_dir: \`${project.claudeConfigDir ?? "<default>"}\``,
    `• system_prompt_append: ${project.systemPromptAppend ? `\`${truncate(project.systemPromptAppend, 80)}\`` : "`<none>`"}`,
    `• env keys: ${formatList(envKeys)} (values redacted)`,
  ]
  return lines.join("\n")
}

/**
 * Render a compact per-session cost report. When no cost has been tracked
 * yet (or the renderer didn't expose the hook), we say so explicitly so
 * the operator knows the answer is "zero, so far" rather than "broken".
 */
export function renderCostReport(
  usage: SessionUsageSnapshot | undefined,
): string {
  if (!usage || usage.turns === 0) {
    return ":moneybag: no cost tracked yet for this session (run a turn first)"
  }
  const lines = [
    `:moneybag: *bantai cost* — session totals (${usage.turns} turn${usage.turns === 1 ? "" : "s"})`,
    `• total: \`$${usage.totalCostUsd.toFixed(4)}\``,
    `• input tokens: \`${formatTokens(usage.inputTokens)}\``,
    `• output tokens: \`${formatTokens(usage.outputTokens)}\``,
  ]
  if (usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0) {
    lines.push(
      `• cache: \`read ${formatTokens(usage.cacheReadTokens)} · write ${formatTokens(usage.cacheCreationTokens)}\``,
    )
  }
  return lines.join("\n")
}

function formatTokens(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function formatList(xs: readonly string[] | undefined): string {
  if (!xs || xs.length === 0) return "`<empty>`"
  return xs.map((x) => `\`${x}\``).join(", ")
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}
