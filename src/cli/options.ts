/**
 * CLI Options — Shared option definitions and CLIFlags type
 *
 * Defines the Commander.js options that are shared across commands
 * (global options, TUI options) and the CLIFlags interface that
 * downstream code consumes.
 *
 * Replaces the hand-rolled parser in flags.ts.
 */

import type { Command } from "commander"
import type { SessionConfig, PermissionMode } from "../protocol/types"

// ---------------------------------------------------------------------------
// CLIFlags — the stability contract consumed by config resolution, backend
// creation, and TUI launch. Shape is identical to the old parseFlags() output.
// ---------------------------------------------------------------------------

export interface CLIFlags {
  /** Session config derived from flags */
  config: SessionConfig

  /** Initial prompt (positional arg or --prompt) */
  prompt?: string

  /** Backend selection */
  backend: string

  /** Print help and exit */
  help: boolean

  /** Print version and exit */
  version: boolean

  /** Enable debug output */
  debug: boolean

  /** Enable raw backend JSONL tracing */
  debugBackend: boolean

  /** Disable the MCP diagnostics server */
  noDiagnosticsMcp: boolean

  /** Theme preset ID */
  theme?: string

  /** Native status bar preset ID */
  statusBar?: string

  /** ACP command (for --backend acp) */
  acpCommand?: string

  /** ACP args (for --backend acp) */
  acpArgs?: string[]

  /**
   * Experimental — set by `bantai follow <session-id>`. When present,
   * `launchTui` routes the TUI into read-only follow mode rather than
   * creating a normal backend. See `team/bantai-follow-tui.md`.
   */
  follow?: { sessionId: string }
}

// ---------------------------------------------------------------------------
// Option attachment helpers — called by program.ts to configure commands
// ---------------------------------------------------------------------------

/**
 * Attach global options shared across ALL commands.
 * These go on the root program so they're inherited by subcommands.
 */
export function addGlobalOptions(cmd: Command): Command {
  return cmd
    .option("--debug", "Enable debug output")
    .option("--debug-backend", "Write raw backend JSONL trace")
    .option("--cwd <path>", "Working directory")
}

/**
 * Attach TUI-specific options. Used by the default command and backend
 * subcommands (claude, codex, gemini).
 */
export function addTuiOptions(cmd: Command): Command {
  return cmd
    .option("-m, --model <model>", "Set the model")
    .option("-p, --prompt <text>", "Initial prompt")
    .option("-c, --continue", "Continue most recent session")
    .option("-r, --resume [id]", "Resume a session (omit id for interactive picker)")
    .option("-b, --backend <name>", "Backend (claude, codex, gemini, copilot, acp, mock)")
    .option("--permission-mode <mode>", "Permission mode (default, acceptEdits, bypassPermissions, plan, dontAsk, auto)")
    .option("--dangerously-skip-permissions", "Shorthand for full-access bypass mode")
    .option("--max-turns <n>", "Maximum turns", parseIntPositive)
    .option("--max-budget <usd>", "Maximum budget in USD", parseFloatPositive)
    .option("--no-session-persistence", "Disable session persistence to disk")
    .option("--thinking <mode>", "Thinking mode (adaptive, enabled, disabled)")
    .option("--max-thinking-tokens <n>", "Fixed thinking token budget (sets thinking to enabled)", parseIntPositive)
    .option("--effort <level>", "Reasoning effort (low, medium, high, xhigh, max)")
    .option("--system-prompt <text>", "System prompt")
    .option("--theme <id>", "Theme preset (dark, high-contrast, catppuccin, dracula, solarized, light, one-light)")
    .option("--status-bar <id>", "Native status bar preset (default, minimal, detailed)")
    .option("--no-diagnostics-mcp", "Disable the MCP diagnostics server")
    .option("--acp-command <cmd>", "ACP agent command (for --backend acp)")
    .option("--acp-args <arg>", "ACP agent args (repeatable, for --backend acp)", collectArgs, [])
}

// ---------------------------------------------------------------------------
// resolveFlags — transform Commander parsed options into CLIFlags
// ---------------------------------------------------------------------------

/**
 * Build a CLIFlags object from Commander's parsed options.
 *
 * @param opts - The options object from Commander (cmd.opts())
 * @param prompt - Positional prompt argument (if any)
 * @param backendOverride - Force a specific backend (used by backend subcommands)
 */
export function resolveFlags(
  opts: Record<string, unknown>,
  prompt?: string,
  backendOverride?: string,
): CLIFlags {
  const config: SessionConfig = {}

  // Model
  if (opts.model !== undefined) {
    config.model = opts.model as string
  }

  // Session management
  if (opts.continue) {
    config.continue = true
  }
  if (opts.resume !== undefined) {
    // Commander returns `true` for optional arg without value
    if (opts.resume === true) {
      config.resumeInteractive = true
    } else {
      config.resume = opts.resume as string
    }
  }

  // Permission mode
  if (opts.dangerouslySkipPermissions) {
    config.permissionMode = "bypassPermissions"
  } else if (opts.permissionMode !== undefined) {
    config.permissionMode = opts.permissionMode as PermissionMode
  }

  // Limits
  if (opts.maxTurns !== undefined) {
    config.maxTurns = opts.maxTurns as number
  }
  if (opts.maxBudget !== undefined) {
    config.maxBudgetUsd = opts.maxBudget as number
  }

  // Session persistence — Commander's --no-X pattern sets X to false
  if (opts.sessionPersistence === false) {
    config.persistSession = false
  }

  // Working directory
  if (opts.cwd !== undefined) {
    config.cwd = opts.cwd as string
  }

  // Thinking
  if (opts.maxThinkingTokens !== undefined) {
    config.thinking = { type: "enabled", budgetTokens: opts.maxThinkingTokens as number }
  } else if (opts.thinking !== undefined) {
    const val = opts.thinking as string
    if (val === "adaptive") {
      config.thinking = { type: "adaptive" }
    } else if (val === "enabled") {
      config.thinking = { type: "enabled" }
    } else if (val === "disabled") {
      config.thinking = { type: "disabled" }
    } else {
      console.error("Error: --thinking must be adaptive, enabled, or disabled")
      process.exit(1)
    }
  }

  // Effort
  if (opts.effort !== undefined) {
    const val = opts.effort as string
    if (val === "low" || val === "medium" || val === "high" || val === "max") {
      config.effort = val
    } else {
      console.error("Error: --effort must be low, medium, high, or max")
      process.exit(1)
    }
  }

  // System prompt
  if (opts.systemPrompt !== undefined) {
    config.systemPrompt = opts.systemPrompt as string
  }

  // Prompt — --prompt flag takes precedence over positional
  const resolvedPrompt = (opts.prompt as string | undefined) ?? prompt

  // Backend — override wins, then --backend flag, then default
  const backend = backendOverride ?? (opts.backend as string | undefined) ?? "claude"

  // ACP options
  const acpArgs = (opts.acpArgs as string[] | undefined)
  const resolvedAcpArgs = acpArgs && acpArgs.length > 0 ? acpArgs : undefined

  return {
    config,
    prompt: resolvedPrompt,
    backend,
    help: false,   // Commander handles --help itself
    version: false, // Commander handles --version itself
    debug: !!opts.debug,
    debugBackend: !!opts.debugBackend,
    noDiagnosticsMcp: opts.diagnosticsMcp === false, // --no-diagnostics-mcp
    theme: opts.theme as string | undefined,
    statusBar: opts.statusBar as string | undefined,
    acpCommand: opts.acpCommand as string | undefined,
    acpArgs: resolvedAcpArgs,
  }
}

// ---------------------------------------------------------------------------
// Argument parsers for Commander
// ---------------------------------------------------------------------------

function parseIntPositive(value: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n <= 0) {
    console.error(`Error: expected a positive integer, got "${value}"`)
    process.exit(1)
  }
  return n
}

function parseFloatPositive(value: string): number {
  const n = parseFloat(value)
  if (isNaN(n) || n <= 0) {
    console.error(`Error: expected a positive number, got "${value}"`)
    process.exit(1)
  }
  return n
}

/** Collector for repeatable --acp-args */
function collectArgs(value: string, previous: string[]): string[] {
  return [...previous, value]
}
