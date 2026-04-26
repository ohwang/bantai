/**
 * Slash Command Registry
 *
 * Manages slash commands. Components check for '/' at position 0
 * and dispatch through this registry.
 *
 * Supports prefix/substring matching for autocomplete.
 */

import type { AgentBackend, Block, ConfigOption, CostTotals, SessionMetadata, SessionState } from "../protocol/types"
import type { FrontendBridge } from "./frontend"
export type { FrontendBridge } from "./frontend"

export interface CommandContext {
  backend: AgentBackend
  pushEvent: (event: any) => void
  clearConversation: () => void
  resetCost: () => void
  /** Reset the backend session (create a fresh server-side session). */
  resetSession: () => Promise<void>
  setModel: (model: string) => Promise<void>
  exit?: () => void
  toggleDiagnostics?: () => void
  getSessionState?: () => { cost: CostTotals; turnNumber: number; currentModel: string; currentEffort: string; session: SessionMetadata | null; configOptions?: ConfigOption[]; sessionState?: SessionState }
  getBlocks?: () => Block[]
  registry?: CommandRegistry
  /**
   * Frontend-specific capability surface (open panel, screenshot, copy, …).
   *
   * Commands MUST route any UI-affecting side effect through this bridge
   * rather than importing from `src/frontends/tui/` or `@opentui/*`. Optional so
   * pure-CLI tests can omit it — commands should gracefully degrade.
   */
  frontend?: FrontendBridge
  /**
   * Hot-swap the active backend mid-conversation. Resolves once the new
   * backend reports ready (session_init received). Only expected to be
   * present when invoked from the TUI — CLI-only tests may leave it
   * undefined, in which case /switch surfaces a user-friendly error.
   */
  switchBackend?: (opts: {
    backendId: string
    model?: string
    adapter: AgentBackend
  }) => Promise<void>
  /** Working directory of the active session (project root). */
  getCwd?: () => string
}

export interface SlashCommand {
  name: string
  description: string
  aliases?: string[]
  /** 'local' runs in TUI (default), 'prompt' sends text to the model as a user message */
  type?: "local" | "prompt"
  /** Hint text shown after the command name in autocomplete (e.g., "<file path>") */
  argumentHint?: string
  execute: (args: string, ctx: CommandContext) => void | Promise<void>
}

/** Create a prompt command — sends a fixed prompt (optionally with user args) to the model */
export function createPromptCommand(opts: {
  name: string
  description: string
  aliases?: string[]
  prompt: string | ((args: string) => string)
  argumentHint?: string
}): SlashCommand {
  return {
    name: opts.name,
    description: opts.description,
    aliases: opts.aliases,
    type: "prompt",
    argumentHint: opts.argumentHint,
    execute: (args, ctx) => {
      const text = typeof opts.prompt === "function" ? opts.prompt(args) : (args ? `${opts.prompt} ${args}` : opts.prompt)
      ctx.pushEvent({ type: "user_message", text })
      ctx.backend.sendMessage({ text })
    },
  }
}

export class CommandRegistry {
  private commands = new Map<string, SlashCommand>()

  register(command: SlashCommand): void {
    this.commands.set(command.name, command)
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.commands.set(alias, command)
      }
    }
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name)
  }

  all(): SlashCommand[] {
    // Deduplicate (aliases point to same command)
    const seen = new Set<SlashCommand>()
    const result: SlashCommand[] = []
    for (const cmd of this.commands.values()) {
      if (!seen.has(cmd)) {
        seen.add(cmd)
        result.push(cmd)
      }
    }
    return result
  }

  /**
   * Match commands against a query across name, aliases, and description.
   *
   * Ranking (best match first):
   *   0. name prefix match        — `/mod` → `model`
   *   1. alias prefix match       — `/q`   → `exit` (alias "q")
   *   2. name substring match     — `del` → `model` (contains "del")
   *   3. alias substring match
   *   4. description match only   — `switch` → `/model` (description "Switch model")
   *
   * Within each rank, results are sorted alphabetically by name for
   * stability. Empty query returns all commands in alphabetical order.
   */
  search(query: string): SlashCommand[] {
    const q = query.toLowerCase()
    if (!q) {
      return this.all().sort((a, b) => a.name.localeCompare(b.name))
    }
    const scored: { cmd: SlashCommand; rank: number }[] = []
    for (const cmd of this.all()) {
      const name = cmd.name.toLowerCase()
      const aliases = cmd.aliases?.map((a) => a.toLowerCase()) ?? []
      const description = cmd.description.toLowerCase()

      let rank = -1
      if (name.startsWith(q)) rank = 0
      else if (aliases.some((a) => a.startsWith(q))) rank = 1
      else if (name.includes(q)) rank = 2
      else if (aliases.some((a) => a.includes(q))) rank = 3
      else if (description.includes(q)) rank = 4

      if (rank >= 0) scored.push({ cmd, rank })
    }
    return scored
      .sort((a, b) => a.rank - b.rank || a.cmd.name.localeCompare(b.cmd.name))
      .map((s) => s.cmd)
  }

  /** Parse input and execute if it starts with '/' */
  async tryExecute(
    input: string,
    ctx: CommandContext,
  ): Promise<boolean> {
    if (!input.startsWith("/")) return false

    const parts = input.slice(1).split(/\s+/)
    const name = parts[0] ?? ""
    const args = parts.slice(1).join(" ")

    const command = this.get(name)
    if (!command) return false

    // Inject registry reference so commands like /help can enumerate all commands
    if (!ctx.registry) ctx.registry = this
    await command.execute(args, ctx)
    return true
  }
}

import { copyCommand } from "./builtin/copy"
import { helpCommand } from "./builtin/help"
import { clearCommand } from "./builtin/clear"
import { newCommand } from "./builtin/new"
import { compactCommand } from "./builtin/compact"
import { modelCommand } from "./builtin/model"
import { costCommand } from "./builtin/cost"
import { usageCommand } from "./builtin/usage"
import { hotkeysCommand } from "./builtin/hotkeys"
import { diagnosticsCommand } from "./builtin/diagnostics"
import { exitCommand } from "./builtin/exit"
import { bugCommand, reviewCommand, commitCommand, testCommand } from "./builtin/prompts"
import { aboutCommand } from "./builtin/about"
import { screenshotCommand } from "./builtin/screenshot"
import { thinkingCommand } from "./builtin/thinking"
import { themeCommand } from "./builtin/theme"
import { statusBarCommand } from "./builtin/status-bar"
import { configCommand } from "./builtin/config"
import { settingsCommand } from "./builtin/settings"
import { backendCommand } from "./builtin/backend"
import { switchCommand } from "./builtin/switch"
import { abCommand } from "./builtin/ab"
import { btwCommand } from "./builtin/btw"
import { crossagentCommand } from "../subagents/commands"

/** Create a registry with all built-in commands */
export function createCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry()

  registry.register(copyCommand)
  registry.register(helpCommand)
  registry.register(clearCommand)
  registry.register(newCommand)
  registry.register(compactCommand)
  registry.register(modelCommand)
  registry.register(costCommand)
  registry.register(usageCommand)
  registry.register(hotkeysCommand)
  registry.register(diagnosticsCommand)
  registry.register(exitCommand)

  // Prompt commands — send prompts to the model
  registry.register(bugCommand)
  registry.register(reviewCommand)
  registry.register(commitCommand)
  registry.register(testCommand)
  registry.register(aboutCommand)
  registry.register(screenshotCommand)
  registry.register(thinkingCommand)
  registry.register(themeCommand)
  registry.register(statusBarCommand)
  registry.register(configCommand)
  registry.register(settingsCommand)
  registry.register(backendCommand)
  registry.register(switchCommand)
  registry.register(abCommand)
  registry.register(btwCommand)
  registry.register(crossagentCommand)

  return registry
}
