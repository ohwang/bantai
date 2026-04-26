/**
 * useStatusBarData — Shared reactive data consumed by every status bar preset.
 *
 * Presets are pure components of this data. Extracting it here means:
 *   - Token-rate sampling, git refresh, and context-pct memos are singletons
 *     (computed once, shared across all presets).
 *   - Swapping the active preset doesn't re-run expensive setup (git spawn).
 *   - Preset authors don't have to re-wire into session/agent/messages
 *     contexts — they just read fields off `StatusBarData`.
 *
 * The data hook is called once by the outer `StatusBar` component and passed
 * down to the active preset via `props.data`.
 */
import { createEffect, createMemo, createSignal, onCleanup, on, type Accessor } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import path from "node:path"
import { useAgent } from "../context/agent"
import { useMessages } from "../context/messages"
import { useSession } from "../context/session"
import type { PermissionMode, SandboxInfo, RateLimitEntry } from "../../../protocol/types"
import { findCurrentModel, friendlyModelName, resolveContextWindow } from "../../../protocol/models"
import { setTerminalProgress } from "../../../utils/terminal-notify"
import { toast } from "../context/toast"
import { colors } from "../theme/tokens"

// ---------------------------------------------------------------------------
// Token-rate tracking constants
// ---------------------------------------------------------------------------

const SAMPLE_WINDOW_MS = 3_000
const TICK_INTERVAL_MS = 300

interface TokenSample {
  timestamp: number
  totalTokens: number
}

// ---------------------------------------------------------------------------
// Git info
// ---------------------------------------------------------------------------

/**
 * Git status snapshot. Both the legacy aggregate counts (`modified`,
 * `untracked`, `ahead`, `hasUpstream`) and the richer posh-git-style split
 * (`staged`, `working`, `behind`, `detached`, `conflict`) are populated so
 * that existing presets keep working unchanged while the claude-compat
 * preset can render the full `[branch ↑1↓2 idx wt]` segment.
 */
export interface GitInfo {
  branch: string
  /** Sum of all changed files (index + working tree). Legacy aggregate. */
  modified: number
  /** Untracked file count (working-tree only). */
  untracked: number
  /** Commits ahead of upstream (0 when no upstream). */
  ahead: number
  /** Commits behind upstream (0 when no upstream). */
  behind: number
  /** True if the current branch has a tracked upstream. */
  hasUpstream: boolean
  /** True if HEAD is detached; `branch` holds the short sha in parentheses. */
  detached: boolean
  /** Staged changes (tracked by `--porcelain=v2` index status). */
  staged: { added: number; modified: number; deleted: number }
  /** Working-tree changes (modified/deleted/untracked/conflicts). */
  working: { modified: number; deleted: number; untracked: number; conflict: number }
}

/**
 * Snapshot git status in one invocation using `--porcelain=v2 --branch`.
 * Matches the logic of the external statusline script so the native preset
 * can reproduce the `[branch ↑↓ idx wt]` segment bit-for-bit.
 */
function getGitInfo(): GitInfo | null {
  try {
    const result = Bun.spawnSync([
      "git",
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "--branch",
    ])
    if (result.exitCode !== 0) return null
    const out = result.stdout.toString()
    if (!out) return null

    let branch = ""
    let ahead = 0
    let behind = 0
    let hasUpstream = false
    let detached = false

    const staged = { added: 0, modified: 0, deleted: 0 }
    const working = { modified: 0, deleted: 0, untracked: 0, conflict: 0 }

    for (const line of out.split("\n")) {
      if (line.startsWith("# branch.head ")) {
        branch = line.slice("# branch.head ".length)
      } else if (line.startsWith("# branch.ab ")) {
        const ab = line.slice("# branch.ab ".length).split(" ")
        const a = (ab[0] ?? "").replace(/^\+/, "")
        const b = (ab[1] ?? "").replace(/^-/, "")
        ahead = parseInt(a, 10) || 0
        behind = parseInt(b, 10) || 0
        hasUpstream = true
      } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
        const xy = line.slice(2, 4)
        const x = xy[0]
        const y = xy[1]
        if (line.startsWith("1 ")) {
          if (x === "A") staged.added += 1
          else if (x === "M" || x === "T") staged.modified += 1
          else if (x === "D") staged.deleted += 1
        } else {
          if (x === "R" || x === "C" || x === "M" || x === "T") staged.modified += 1
          else if (x === "A") staged.added += 1
          else if (x === "D") staged.deleted += 1
        }
        if (y === "M" || y === "T") working.modified += 1
        else if (y === "D") working.deleted += 1
      } else if (line.startsWith("u ")) {
        working.conflict += 1
      } else if (line.startsWith("? ")) {
        working.untracked += 1
      }
    }

    if (!branch) return null

    if (branch === "(detached)") {
      detached = true
      const headResult = Bun.spawnSync([
        "git",
        "--no-optional-locks",
        "rev-parse",
        "--short",
        "HEAD",
      ])
      const sha = headResult.stdout.toString().trim()
      branch = sha ? `(${sha})` : "(detached)"
    }

    const modified =
      staged.added + staged.modified + staged.deleted +
      working.modified + working.deleted + working.conflict
    const untracked = working.untracked

    return {
      branch,
      modified,
      untracked,
      ahead,
      behind,
      hasUpstream,
      detached,
      staged,
      working,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Duration + token formatting helpers
// ---------------------------------------------------------------------------

/** Format a duration in seconds as `5s` / `3m` / `1h2m` / `2d3h`. */
export function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86400) {
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    return m > 0 ? `${h}h${m}m` : `${h}h`
  }
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  return h > 0 ? `${d}d${h}h` : `${d}d`
}

/** Compact token count formatter matching the external script (`1.2k` / `45k` / `1.2M`). */
export function formatTokensCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n < 1000) return String(Math.floor(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// ---------------------------------------------------------------------------
// Rate-limit display helpers (exported so presets can reuse)
// ---------------------------------------------------------------------------

export interface RateLimitDisplay {
  label: string
  usedPercentage: number
}

export function formatRateLimitWindowLabel(
  windowDurationMins: number | undefined,
  fallback: string,
): string {
  if (typeof windowDurationMins !== "number") return fallback
  if (windowDurationMins < 60) return `${windowDurationMins}m`
  if (windowDurationMins < 1440) return `${Math.round(windowDurationMins / 60)}h`
  const days = Math.round(windowDurationMins / 1440)
  return `${days}d`
}

export function rateLimitColor(usedPercentage: number): string {
  if (usedPercentage >= 80) return colors.status.error
  if (usedPercentage >= 50) return colors.status.warning
  return colors.status.success
}

// ---------------------------------------------------------------------------
// StatusBarData — the shape passed to presets
// ---------------------------------------------------------------------------

export interface StatusBarData {
  // Static (no change mid-session)
  projectName: string

  // Direct pass-through accessors (reactive, but no derivation needed)
  permMode: Accessor<PermissionMode>
  sessionState: Accessor<string>
  backgrounded: Accessor<boolean>
  termWidth: Accessor<number>
  sandboxHint: Accessor<string>
  sandboxInfo: Accessor<SandboxInfo | undefined>
  backendName: Accessor<string>
  worktreeName: Accessor<string | null>

  // Derived scalars
  isRunning: Accessor<boolean>
  modelDisplay: Accessor<string>
  effortBadge: Accessor<string>
  costStr: Accessor<string>
  /** Formatted session cost as `$N.NN` (two decimals, empty when zero). */
  costShortStr: Accessor<string>
  gitInfo: Accessor<GitInfo | null>
  gitStr: Accessor<string>
  ctxPct: Accessor<number>
  ctxStr: Accessor<string>
  ctxBar: Accessor<string>
  ctxColor: Accessor<string>
  tokPerSecStr: Accessor<string>
  /** Raw time-to-first-token in milliseconds for the last completed turn,
   *  or `null` when the backend didn't report one (non-Claude or pre-0.2.112). */
  lastTurnTtftMs: Accessor<number | null>
  /** Pre-formatted TTFT for the last completed turn (e.g. `TTFT: 1.2s`,
   *  `TTFT: 450ms`). Empty string when unknown or while a turn is running —
   *  the figure is a per-turn summary, not a live indicator. */
  ttftStr: Accessor<string>
  /** Color for the TTFT segment — green <1s, info 1-3s, warning ≥3s. */
  ttftColor: Accessor<string>
  turnNumber: Accessor<number>

  /** Total tokens consumed in the session (input + output, running). */
  totalTokens: Accessor<number>
  /** Compact formatting: `0` / `1.2k` / `45k` / `1.2M`. */
  totalTokensStr: Accessor<string>
  /** Cost accumulated in the current turn (0 when idle / no growth). */
  turnCost: Accessor<number>
  /** Formatted current-turn cost delta (e.g. `0.12`, empty when 0). */
  turnCostStr: Accessor<string>
  /** Token count accumulated in the current turn. */
  turnTokens: Accessor<number>
  /** Compact formatting for `turnTokens` (empty when 0). */
  turnTokensStr: Accessor<string>

  /** Session wall-clock duration in seconds since the TUI started. */
  sessionAgeSec: Accessor<number>
  /** Human-readable session age (`5s` / `3m` / `1h2m` / `2d3h`). */
  sessionAgeStr: Accessor<string>

  rateLimits: Accessor<RateLimitDisplay[]>
  rawRateLimits: Accessor<{
    fiveHour?: RateLimitEntry
    sevenDay?: RateLimitEntry
    primary?: RateLimitEntry
    secondary?: RateLimitEntry
  } | undefined>

  // Responsive breakpoint helpers (consistent across presets)
  showCtx: Accessor<boolean>
  showGit: Accessor<boolean>
  showCost: Accessor<boolean>

  // Computed state color / icon (for state dot across presets)
  stateIcon: Accessor<string>
  stateColor: Accessor<string>
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/**
 * Build the reactive data bundle consumed by status bar presets.
 *
 * Call once from the outer `StatusBar` component. The returned object's
 * accessors are live — read them inside JSX / memos / effects of the preset.
 */
export function useStatusBarData(permMode: Accessor<PermissionMode>): StatusBarData {
  const { state } = useSession()
  const { state: messagesState } = useMessages()
  const agent = useAgent()

  const dims = useTerminalDimensions()
  const projectName = path.basename(process.cwd())

  // -- Git info (refreshed on RUNNING -> IDLE edge) --
  const [gitInfo, setGitInfo] = createSignal<GitInfo | null>(getGitInfo())
  let prevStateForGit: string = state.sessionState
  createEffect(() => {
    const current = state.sessionState
    if (current === "IDLE" && prevStateForGit === "RUNNING") {
      setGitInfo(getGitInfo())
    }
    prevStateForGit = current
  })

  // -- Token-rate tracking + terminal progress --
  const [tokPerSec, setTokPerSec] = createSignal(0)
  let tokenSamples: TokenSample[] = []
  let prevSessionState: string = state.sessionState

  // On backend swap (`/switch`), drop the sample window even if we're not
  // transitioning through RUNNING. Without this, the reading for the old
  // backend sticks around until the next IDLE → RUNNING edge on the new
  // backend — visually nonsensical once `agent.backend` is a different
  // adapter. The `on(..., { defer: true })` form skips the initial read
  // so we don't clear samples on first mount.
  createEffect(
    on(
      agent.backendAccessor,
      () => {
        tokenSamples = []
        setTokPerSec(0)
      },
      { defer: true },
    ),
  )

  const tickerHandle = setInterval(() => {
    const currentState = state.sessionState
    const isRunning = currentState === "RUNNING"

    if (isRunning && prevSessionState !== "RUNNING") {
      tokenSamples = []
      setTokPerSec(0)
    }
    if (!isRunning && prevSessionState === "RUNNING") {
      tokenSamples = []
      setTokPerSec(0)
    }

    prevSessionState = currentState

    if (isRunning) {
      const now = Date.now()
      const totalTokens = state.cost.inputTokens + state.cost.outputTokens
      tokenSamples.push({ timestamp: now, totalTokens })
      const cutoff = now - SAMPLE_WINDOW_MS
      tokenSamples = tokenSamples.filter((s) => s.timestamp >= cutoff)

      if (tokenSamples.length >= 2) {
        const oldest = tokenSamples[0]
        const newest = tokenSamples[tokenSamples.length - 1]
        if (oldest && newest) {
          const dtSec = (newest.timestamp - oldest.timestamp) / 1000
          if (dtSec > 0) {
            const rate = (newest.totalTokens - oldest.totalTokens) / dtSec
            setTokPerSec(Math.round(rate))
          }
        }
      }

      // Update terminal progress (context window fill)
      const fill = state.lastTurnInputTokens
      if (fill > 0) {
        const model = findCurrentModel(state.session?.models, state.currentModel)
        const raw = state.currentModel || model?.name || ""
        const ctxWindow = resolveContextWindow(model, raw)
        const pct = Math.min(100, Math.round((fill / ctxWindow) * 100))
        setTerminalProgress("running", pct)
      }
    }
  }, TICK_INTERVAL_MS)
  onCleanup(() => clearInterval(tickerHandle))

  // ---------------------------------------------------------------------------
  // Accessors / memos
  // ---------------------------------------------------------------------------

  const sessionState = () => state.sessionState
  const backgrounded = () => messagesState.backgrounded
  const termWidth = () => dims()?.width ?? 120
  const backendName = () => agent.backend.capabilities().name

  const isRunning = createMemo(() => state.sessionState === "RUNNING")

  const showCost = () => termWidth() >= 60
  const showGit = () => termWidth() >= 80
  const showCtx = () => termWidth() >= 100

  // Model display — friendly name + context abbrev. Falls back to the
  // configured model before the SDK's session_init lands so the status bar
  // doesn't flash "unknown model" on startup (mirrors the external bash
  // statusline which uses `.model.display_name` from the input payload).
  const modelDisplay = () => {
    const model = findCurrentModel(state.session?.models, state.currentModel)
    const raw = state.currentModel || model?.name || agent.config.model || ""
    if (!raw) return `unknown model (${backendName()})`
    const friendly = friendlyModelName(raw)
    const ctxWindow = resolveContextWindow(model, raw)
    const ctxAbbrev = ctxWindow >= 1_000_000
      ? `${ctxWindow / 1_000_000}M`
      : `${ctxWindow / 1_000}K`
    return `${friendly} (${ctxAbbrev})`
  }

  const effortBadge = createMemo(() => {
    // Fall back to the CLI-configured effort before the SDK reports
    // `effort_change` (mirrors `modelDisplay`'s agent.config fallback).
    const e = state.currentEffort || agent.config.effort || ""
    if (!e || e === "high") return ""
    return e === "medium" ? "med" : e
  })

  const costStr = createMemo(() => {
    const c = state.cost.totalCostUsd
    if (c === 0) return ""
    return `$${c.toFixed(4)}`
  })

  const costShortStr = createMemo(() => {
    // Matches the external bash statusline — always shows `$N.NN` (two
    // decimals, zero-friendly) so the segment is present from session start.
    return `$${state.cost.totalCostUsd.toFixed(2)}`
  })

  const totalTokens = createMemo(
    () => state.cost.inputTokens + state.cost.outputTokens,
  )
  const totalTokensStr = createMemo(() => {
    const n = totalTokens()
    return n > 0 ? formatTokensCompact(n) : ""
  })

  // Turn delta tracking — snapshot cost/tokens on each turn boundary so the
  // preset can show `$total (+delta)` / `tokens (+delta)` during live turns.
  const [turnStartCost, setTurnStartCost] = createSignal(state.cost.totalCostUsd)
  const [turnStartTokens, setTurnStartTokens] = createSignal(totalTokens())
  let prevTurnNumber = state.turnNumber
  createEffect(() => {
    const t = state.turnNumber
    if (t !== prevTurnNumber) {
      setTurnStartCost(state.cost.totalCostUsd)
      setTurnStartTokens(totalTokens())
      prevTurnNumber = t
    }
  })

  const turnCost = createMemo(() => {
    const d = state.cost.totalCostUsd - turnStartCost()
    return d > 0.0001 ? d : 0
  })
  const turnCostStr = createMemo(() => {
    const d = turnCost()
    return d > 0 ? d.toFixed(2) : ""
  })
  const turnTokens = createMemo(() => {
    const d = totalTokens() - turnStartTokens()
    return d > 0 ? d : 0
  })
  const turnTokensStr = createMemo(() => {
    const d = turnTokens()
    return d > 0 ? formatTokensCompact(d) : ""
  })

  // Wall-clock session age — recomputed off the 300ms ticker via a coarse
  // 1s-granularity signal so presets re-render at most once per second.
  const startedAt = Date.now()
  const [sessionAgeSec, setSessionAgeSec] = createSignal(0)
  const ageHandle = setInterval(() => {
    setSessionAgeSec(Math.floor((Date.now() - startedAt) / 1000))
  }, 1000)
  onCleanup(() => clearInterval(ageHandle))
  const sessionAgeStr = createMemo(() => formatDuration(sessionAgeSec()))

  const worktreeName = (): string | null => state.worktree?.name ?? null

  const gitStr = createMemo(() => {
    const info = gitInfo()
    if (!info) return ""
    const parts: string[] = [info.branch]
    if (info.ahead > 0) parts.push(`\u2191${info.ahead}`)
    else if (info.hasUpstream) parts.push("\u2261")
    const statusParts: string[] = []
    if (info.modified > 0) statusParts.push(`~${info.modified}`)
    if (info.untracked > 0) statusParts.push(`+${info.untracked}`)
    if (statusParts.length > 0) parts.push("| " + statusParts.join(" "))
    return `[${parts.join(" ")}]`
  })

  const ctxPct = createMemo(() => {
    const fill = state.lastTurnInputTokens
    if (fill === 0) return 0
    const model = findCurrentModel(state.session?.models, state.currentModel)
    const raw = state.currentModel || model?.name || ""
    const ctxWindow = resolveContextWindow(model, raw)
    return Math.round((fill / ctxWindow) * 100)
  })

  const ctxStr = createMemo(() => {
    const pct = ctxPct()
    if (pct === 0) {
      return state.lastTurnInputTokens > 0 ? "ctx:<1%" : ""
    }
    return `ctx:${pct}%`
  })

  const ctxColor = createMemo(() => {
    const pct = ctxPct()
    if (pct >= 80) return colors.status.error
    if (pct >= 50) return colors.status.warning
    return colors.status.success
  })

  const ctxBar = createMemo(() => {
    const pct = ctxPct()
    if (pct === 0 && state.lastTurnInputTokens === 0) return ""
    const filled = Math.min(
      10,
      Math.max(pct > 0 ? 1 : (state.lastTurnInputTokens > 0 ? 1 : 0), Math.round(pct / 10)),
    )
    const empty = 10 - filled
    return "\u25B0".repeat(filled) + "\u25B1".repeat(empty)
  })

  // Toast warnings on 80% / 95% thresholds (once per reset)
  let lastWarningLevel = 0
  createEffect(on(ctxPct, (pct) => {
    if (pct === 0) {
      lastWarningLevel = 0
    } else if (pct >= 95 && lastWarningLevel < 2) {
      lastWarningLevel = 2
      toast.error("Context window 95% full \u2014 /compact recommended")
    } else if (pct >= 80 && lastWarningLevel < 1) {
      lastWarningLevel = 1
      toast.warn("Context window 80% full \u2014 consider using /compact")
    }
  }))

  const tokPerSecStr = createMemo(() => {
    if (!isRunning()) return ""
    const rate = tokPerSec()
    if (rate <= 0) return ""
    return `${rate} tok/s`
  })

  // Time-to-first-token for the most recent completed turn. We only show
  // the value while IDLE: during a live turn the TUI already surfaces
  // `tok/s`, and swapping to TTFT mid-stream would misrepresent the figure
  // as "current" rather than "last turn". `null` means the backend didn't
  // report TTFT (non-Claude today, or pre-0.2.112 SDK).
  const lastTurnTtftMs = (): number | null => state.lastTurnTtftMs
  const ttftStr = createMemo(() => {
    const ms = state.lastTurnTtftMs
    if (ms == null || ms <= 0) return ""
    if (isRunning()) return ""
    // <1s → ms with no decimals (`450ms`). >=1s → seconds with one decimal
    // (`1.2s`, `12.4s`). Matches the existing status bar's compactness.
    if (ms < 1000) return `TTFT: ${Math.round(ms)}ms`
    return `TTFT: ${(ms / 1000).toFixed(1)}s`
  })
  const ttftColor = createMemo(() => {
    const ms = state.lastTurnTtftMs
    if (ms == null) return colors.status.info
    if (ms >= 3000) return colors.status.warning
    if (ms < 1000) return colors.status.success
    return colors.status.info
  })

  const turnNumber = () => state.turnNumber

  const rawRateLimits = () => state.rateLimits ?? undefined

  const rateLimits = createMemo<RateLimitDisplay[]>(() => {
    const rl = state.rateLimits
    if (!rl) return []
    const displays: RateLimitDisplay[] = []
    if (rl.fiveHour) displays.push({ label: "5h", usedPercentage: rl.fiveHour.usedPercentage })
    if (rl.sevenDay) displays.push({ label: "7d", usedPercentage: rl.sevenDay.usedPercentage })
    if (rl.primary) {
      displays.push({
        label: formatRateLimitWindowLabel(rl.primary.windowDurationMins, "primary"),
        usedPercentage: rl.primary.usedPercentage,
      })
    }
    if (rl.secondary) {
      displays.push({
        label: formatRateLimitWindowLabel(rl.secondary.windowDurationMins, "secondary"),
        usedPercentage: rl.secondary.usedPercentage,
      })
    }
    return displays
  })

  const sandboxInfo = (): SandboxInfo | undefined => agent.backend.capabilities().sandboxInfo

  const sandboxHint = createMemo((): string => {
    const info = sandboxInfo()
    if (!info) return ""
    const modeDetail = info.modeDetails[permMode()]
    if (modeDetail?.separateSandbox) return info.statusHint
    if (backendName() !== "claude") return info.statusHint
    return ""
  })

  const stateIcon = () => {
    if (messagesState.backgrounded) return "\u2B21"
    switch (state.sessionState) {
      case "INITIALIZING": return "\u25CC"
      case "IDLE": return "\u25CF"
      case "RUNNING": return "\u27F3"
      case "WAITING_FOR_PERM": return "\u26A0"
      case "WAITING_FOR_ELIC": return "?"
      case "INTERRUPTING": return "\u23F8"
      case "ERROR": return "\u2717"
      case "SHUTTING_DOWN": return "\u25CC"
      default: return "\u25CF"
    }
  }

  const stateColor = () => {
    if (messagesState.backgrounded) return colors.status.warning
    switch (state.sessionState) {
      case "IDLE": return colors.state.idle
      case "RUNNING": return colors.state.running
      case "WAITING_FOR_PERM":
      case "WAITING_FOR_ELIC":
      case "INTERRUPTING":
        return colors.state.waiting
      case "ERROR": return colors.state.error
      case "SHUTTING_DOWN": return colors.state.shuttingDown
      default: return colors.state.shuttingDown
    }
  }

  return {
    projectName,
    permMode,
    sessionState,
    backgrounded,
    termWidth,
    sandboxHint,
    sandboxInfo,
    backendName,
    worktreeName,
    isRunning,
    modelDisplay,
    effortBadge,
    costStr,
    costShortStr,
    gitInfo,
    gitStr,
    ctxPct,
    ctxStr,
    ctxBar,
    ctxColor,
    tokPerSecStr,
    lastTurnTtftMs,
    ttftStr,
    ttftColor,
    turnNumber,
    totalTokens,
    totalTokensStr,
    turnCost,
    turnCostStr,
    turnTokens,
    turnTokensStr,
    sessionAgeSec,
    sessionAgeStr,
    rateLimits,
    rawRateLimits,
    showCtx,
    showGit,
    showCost,
    stateIcon,
    stateColor,
  }
}
