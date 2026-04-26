/**
 * Status Line Command — External command-controlled status bar
 *
 * Reads the statusLine config from the bantai settings loader (which
 * consults `~/.bantai/settings.json` first and falls back to
 * `~/.claude/settings.json` only when bantai hasn't set one), builds the
 * JSON payload matching Claude Code's schema, and executes the configured
 * shell command with JSON on stdin.
 *
 * This file must not read `~/.claude/` directly — all Claude Code fallback
 * reads go through `src/config/settings.ts`.
 */

import path from "node:path"
import os from "node:os"
import { log } from "./logger"
import { friendlyModelName, resolveContextWindow } from "../protocol/models"
import type { SessionContextState } from "../frontends/tui/context/session"
import type { PermissionMode, RateLimitEntry } from "../protocol/types"
import { loadConfigSync, type StatusLineSetting } from "../config/settings"

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Re-exported so existing callers don't need to learn a new type name. */
export type StatusLineConfig = StatusLineSetting

let cachedConfig: StatusLineConfig | null | undefined

/**
 * Read the statusLine config via the bantai settings loader.
 * Caches after first read (the file rarely changes mid-session).
 *
 * Synchronous so it can be called during component setup without forcing
 * callers into an async boundary.
 *
 * Precedence rule (important for UX parity with the theme / statusBar path):
 *   Claude's `~/.claude/settings.json` is a *fallback* — if the user has
 *   expressed any preference about rendering in bantai scope (CLI, project,
 *   or global `statusBar`), we ignore the Claude-fallback `statusLine`.
 *   Otherwise a Claude-installed statusline silently overrides the native
 *   preset the user explicitly picked in bantai.
 *
 *   Concretely:
 *     - If `statusLine` is explicitly set in cli/project/global bantai scope
 *       → honor it (bantai-scoped statusLine is always respected).
 *     - Else if `statusLine` is only set in claude-fallback AND `statusBar` is
 *       set in cli/project/global → ignore the statusLine (user picked native).
 *     - Else → fall through to the claude-fallback statusLine (preserves the
 *       "Claude Code statusline scripts just work" promise for users who
 *       haven't configured bantai at all).
 */
export function getStatusLineConfig(): StatusLineConfig | null {
  if (cachedConfig !== undefined) return cachedConfig

  try {
    const resolved = loadConfigSync()
    const sl = resolved.values.statusLine
    const slSource = resolved.sources.statusLine
    const sbSource = resolved.sources.statusBar

    // Bantai-scoped statusBar opts out of a Claude-fallback statusLine.
    const claudeFallbackOnly = slSource === "claude-fallback"
    const bantaiScopedStatusBar =
      sbSource === "cli" || sbSource === "project" || sbSource === "global"

    if (claudeFallbackOnly && bantaiScopedStatusBar) {
      log.info(
        "Ignoring claude-fallback statusLine because bantai statusBar is explicitly set",
        { statusBar: resolved.values.statusBar, statusBarSource: sbSource },
      )
      cachedConfig = null
      return cachedConfig
    }

    if (sl && sl.type === "command" && typeof sl.command === "string") {
      cachedConfig = {
        type: "command",
        command: sl.command,
        padding: typeof sl.padding === "number" ? sl.padding : undefined,
      }
    } else {
      cachedConfig = null
    }
  } catch (err) {
    log.warn("Failed to load statusLine config", { error: String(err) })
    cachedConfig = null
  }

  return cachedConfig
}

/** Force re-read of settings on next call (for hot-reload or test isolation). */
export function invalidateStatusLineConfig(): void {
  cachedConfig = undefined
}

// ---------------------------------------------------------------------------
// JSON payload builder — matches Claude Code's StatusLineCommandInput schema
// ---------------------------------------------------------------------------

export interface StatusLineInput {
  cwd: string
  session_id: string
  transcript_path: string
  model: { id: string; display_name: string }
  workspace: { current_dir: string; project_dir: string }
  version: string
  output_style: { name: string }
  cost: {
    total_cost_usd: number
    total_duration_ms: number
    total_api_duration_ms: number
    total_lines_added: number
    total_lines_removed: number
  }
  context_window: {
    total_input_tokens: number
    total_output_tokens: number
    context_window_size: number
    used_percentage: number | null
    remaining_percentage: number | null
    current_usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
    } | null
  }
  exceeds_200k_tokens: boolean
  rate_limits?: {
    five_hour?: { used_percentage: number; resets_at?: number }
    seven_day?: { used_percentage: number; resets_at?: number }
  }
  /** Backend identity so scripts can branch on backend type */
  backend?: { name: string }
  /** Backend-native rate limits with actual window durations (Codex) */
  backend_rate_limits?: {
    primary?: { used_percentage: number; resets_at?: number; window_duration_mins?: number }
    secondary?: { used_percentage: number; resets_at?: number; window_duration_mins?: number }
  }
  vim?: { mode: string }
  agent?: { name: string }
  worktree?: {
    name: string
    path: string
    branch?: string
    original_cwd: string
    original_branch?: string
  }
}

/** Format model display name with context window abbreviation (e.g., "Opus 4.6 (1M)"). */
function formatModelDisplayName(rawModel: string, ctxWindow: number): string {
  if (!rawModel) return ""
  const friendly = friendlyModelName(rawModel)
  const ctxAbbrev = ctxWindow >= 1_000_000
    ? `${ctxWindow / 1_000_000}M`
    : `${ctxWindow / 1_000}K`
  return `${friendly} (${ctxAbbrev})`
}

/** Session start timestamp (set once on first build call). */
let sessionStartMs = 0

function toStatusLineRateLimit(entry: RateLimitEntry | undefined) {
  if (!entry) return undefined
  return {
    used_percentage: entry.usedPercentage,
    resets_at: entry.resetsAt,
    window_duration_mins: entry.windowDurationMins,
  }
}

export function buildStatusLineInput(
  sessionState: SessionContextState,
  opts: {
    permissionMode?: PermissionMode
    configModel?: string
    terminalWidth?: number
    backendName?: string
  },
): StatusLineInput {
  if (sessionStartMs === 0) sessionStartMs = Date.now()

  const cwd = process.cwd()
  const model = sessionState.session?.models?.[0]
  const rawModel = sessionState.currentModel || (model?.name ?? opts.configModel ?? "")
  // `resolveContextWindow` consults `model.id` before falling back to the
  // raw display name, so ACP backends (Gemini, Qwen) that ship `id != name`
  // still resolve to the right cap (otherwise the % math is 5x too high).
  const ctxWindow = resolveContextWindow(model, rawModel)

  // Context window percentages — lastTurnInputTokens is the input token count
  // from the most recent API response, matching Claude Code's used_percentage
  const lastInput = sessionState.lastTurnInputTokens
  let usedPct: number | null = null
  let remainingPct: number | null = null
  if (lastInput > 0 && ctxWindow > 0) {
    usedPct = (lastInput / ctxWindow) * 100
    remainingPct = Math.max(0, 100 - usedPct)
  }

  // Session ID
  const sessionId = sessionState.session?.sessionId ?? ""

  // Transcript path
  let transcriptPath = ""
  if (sessionId) {
    const projectDir = path.basename(cwd)
    transcriptPath = path.join(os.homedir(), ".claude", "projects", projectDir, `${sessionId}.jsonl`)
  }

  // Duration
  const durationMs = Date.now() - sessionStartMs

  // Codex compatibility: some external statusline scripts branch on backend
  // and only read backend_rate_limits. When Codex windows map cleanly to real
  // 5h/7d buckets, synthesize matching primary/secondary entries too.
  const synthesizedCodexBackendRateLimits = opts.backendName === "codex" && sessionState.rateLimits
    ? {
        ...(sessionState.rateLimits.primary
          ? { primary: toStatusLineRateLimit(sessionState.rateLimits.primary) }
          : sessionState.rateLimits.fiveHour
            ? {
                primary: {
                  ...toStatusLineRateLimit(sessionState.rateLimits.fiveHour),
                  window_duration_mins: sessionState.rateLimits.fiveHour.windowDurationMins ?? 300,
                },
              }
            : {}),
        ...(sessionState.rateLimits.secondary
          ? { secondary: toStatusLineRateLimit(sessionState.rateLimits.secondary) }
          : sessionState.rateLimits.sevenDay
            ? {
                secondary: {
                  ...toStatusLineRateLimit(sessionState.rateLimits.sevenDay),
                  window_duration_mins: sessionState.rateLimits.sevenDay.windowDurationMins ?? 10080,
                },
              }
            : {}),
      }
    : null

  return {
    cwd,
    session_id: sessionId,
    transcript_path: transcriptPath,
    model: {
      id: rawModel,
      display_name: formatModelDisplayName(rawModel, ctxWindow),
    },
    workspace: {
      current_dir: cwd,
      project_dir: cwd,
    },
    version: "bantai 0.0.1",
    output_style: { name: "default" },
    cost: {
      total_cost_usd: sessionState.cost.totalCostUsd,
      total_duration_ms: durationMs,
      total_api_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    },
    context_window: {
      total_input_tokens: sessionState.cost.inputTokens,
      total_output_tokens: sessionState.cost.outputTokens,
      context_window_size: ctxWindow,
      used_percentage: usedPct,
      remaining_percentage: remainingPct,
      current_usage: lastInput > 0 ? {
        input_tokens: lastInput,
        output_tokens: sessionState.cost.outputTokens,
        cache_creation_input_tokens: sessionState.cost.cacheWriteTokens,
        cache_read_input_tokens: sessionState.cost.cacheReadTokens,
      } : null,
    },
    exceeds_200k_tokens: lastInput > 200_000,
    // Claude-compatible rate limits (only for real 5h/7d windows)
    ...(sessionState.rateLimits && (sessionState.rateLimits.fiveHour || sessionState.rateLimits.sevenDay) && {
      rate_limits: {
        ...(sessionState.rateLimits.fiveHour && {
          five_hour: {
            used_percentage: sessionState.rateLimits.fiveHour.usedPercentage,
            resets_at: sessionState.rateLimits.fiveHour.resetsAt,
          },
        }),
        ...(sessionState.rateLimits.sevenDay && {
          seven_day: {
            used_percentage: sessionState.rateLimits.sevenDay.usedPercentage,
            resets_at: sessionState.rateLimits.sevenDay.resetsAt,
          },
        }),
      },
    }),
    // Backend identity
    ...(opts.backendName && { backend: { name: opts.backendName } }),
    // Backend-native rate limits with actual window durations (Codex)
    ...(synthesizedCodexBackendRateLimits && Object.keys(synthesizedCodexBackendRateLimits).length > 0 && {
      backend_rate_limits: {
        ...synthesizedCodexBackendRateLimits,
      },
    }),
  }
}

// ---------------------------------------------------------------------------
// Command executor — runs the configured shell command with JSON on stdin
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Diagnostic state — last payload + output for the diagnostics panel
// ---------------------------------------------------------------------------

export interface StatusLineDiagnostics {
  config: StatusLineConfig | null
  lastInput: StatusLineInput | null
  lastInputJson: string | null
  lastOutput: string | null
  lastError: string | null
  lastUpdateTime: number | null
  lastDurationMs: number | null
}

const diagState: StatusLineDiagnostics = {
  config: null,
  lastInput: null,
  lastInputJson: null,
  lastOutput: null,
  lastError: null,
  lastUpdateTime: null,
  lastDurationMs: null,
}

/** Get diagnostic snapshot of the last status line execution. */
export function getStatusLineDiagnostics(): StatusLineDiagnostics {
  diagState.config = getStatusLineConfig()
  return { ...diagState }
}

const COMMAND_TIMEOUT_MS = 5_000

/** Active child process for cancellation. */
let activeProc: { proc: ReturnType<typeof Bun.spawn>; aborted: boolean } | null = null

/**
 * Execute the status line command, piping the JSON payload to stdin.
 * Returns the first line of stdout, or null on error/timeout.
 *
 * Cancels any in-flight command before starting a new one.
 */
export async function executeStatusLineCommand(
  command: string,
  input: StatusLineInput,
): Promise<string | null> {
  // Cancel previous in-flight execution
  if (activeProc) {
    activeProc.aborted = true
    try { activeProc.proc.kill() } catch { /* already dead */ }
    activeProc = null
  }

  const jsonStr = JSON.stringify(input)

  // Store diagnostics (pretty-printed for readability)
  diagState.lastInput = input
  diagState.lastInputJson = JSON.stringify(input, null, 2)
  diagState.lastError = null
  diagState.lastOutput = null

  try {
    const proc = Bun.spawn(["sh", "-c", command], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })

    const entry = { proc, aborted: false }
    activeProc = entry

    // Write compact JSON to stdin and close
    proc.stdin.write(jsonStr + "\n")
    proc.stdin.end()

    // Race between process completion and timeout
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => {
        if (!entry.aborted) {
          entry.aborted = true
          try { proc.kill() } catch { /* already dead */ }
        }
        resolve(null)
      }, COMMAND_TIMEOUT_MS)
    })

    const outputPromise = (async (): Promise<string | null> => {
      const exitCode = await proc.exited
      if (entry.aborted) return null
      if (exitCode !== 0) return null

      const raw = await new Response(proc.stdout).text()
      const trimmed = raw.trim()
      if (!trimmed) return null

      // Process output: trim each line, filter empty, join
      const lines = trimmed
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .join("\n")

      return lines || null
    })()

    const startMs = Date.now()
    const result = await Promise.race([outputPromise, timeoutPromise])

    // Store diagnostics
    diagState.lastDurationMs = Date.now() - startMs
    diagState.lastUpdateTime = Date.now()
    if (result) {
      diagState.lastOutput = result
    } else if (!entry.aborted) {
      diagState.lastError = "Command returned no output or non-zero exit"
    } else {
      diagState.lastError = "Command timed out"
    }

    // Clean up active ref if we're still the current one
    if (activeProc === entry) activeProc = null

    return result
  } catch (err) {
    diagState.lastError = String(err)
    diagState.lastDurationMs = null
    diagState.lastUpdateTime = Date.now()
    log.debug("Status line command failed", { error: String(err) })
    activeProc = null
    return null
  }
}
