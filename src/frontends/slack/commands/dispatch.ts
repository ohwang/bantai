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
      ctx.interrupt()
      await ctx.sendReply(":octagonal_sign: interrupted")
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
  "",
  "_more commands (backend, cost, resume, permissions, thinking, compact) land in later phases._",
].join("\n")
