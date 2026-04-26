/**
 * Session Picker V2 — Multi-Backend, Fuzzy Search, Enriched Metadata
 *
 * Full-screen picker shown when --resume is used without a session ID.
 * Renders BEFORE the main app mounts (no SyncProvider, no event loop).
 *
 * Features:
 * - Tabbed backend switching (current → all → other backends)
 * - Fuzzy search via fuzzysort (same library as file-autocomplete)
 * - Two-line session rows with rich metadata (turns, tools, branch, tokens, cost)
 * - Filter chips (min turns, branch, date range)
 * - Cross-backend resume indicator (⇄)
 * - Ctrl+V preview mode (text-only, Phase 2)
 */

import { createSignal, createMemo, Show, Index, batch } from "solid-js"
import fuzzysort from "fuzzysort"
import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/solid"
import type { SessionInfo, SessionOrigin, MultiBackendSessions } from "../../../protocol/types"
import { listSessionFileBackends } from "../../../protocol/registry"
import { colors } from "../theme/tokens"
import { log } from "../../../utils/logger"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum sessions visible without scrolling (each is 2 lines + 1 gap = 3) */
const MAX_VISIBLE = 12

/**
 * Backend badge colors.
 *
 * Keyed by `BackendId` — the registry is the source of truth (Cluster 1).
 * Backends without an explicit color fall back to a neutral palette via
 * `badgeColor()`. Adding a new backend with `sessionFile.listFromDisk` does
 * not require an edit here unless you want a distinctive color.
 */
const BADGE_COLORS: Record<string, () => string> = {
  claude: () => colors.accent.primary,
  codex: () => colors.status.success,
  gemini: () => colors.status.warning,
  qwen: () => colors.status.info,
  copilot: () => colors.text.secondary,
}

function badgeColor(origin: string | undefined): string {
  if (!origin) return colors.text.muted
  const fn = BADGE_COLORS[origin]
  return fn ? fn() : colors.text.secondary
}

/** Min turns filter cycle */
const TURN_CYCLE = [0, 3, 5, 10] as const

/** Date filter cycle (days, 0 = all) */
const DATE_CYCLE = [0, 7, 30] as const

type TabId = SessionOrigin | "all"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SessionPickerProps {
  sessions: MultiBackendSessions
  currentBackend: SessionOrigin
  currentCwd: string
  onSelect: (sessionId: string, origin?: SessionOrigin) => void
  onCancel: () => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a Unix timestamp (ms) into a relative or absolute date string */
function formatTimestamp(ts: number): string {
  const now = Date.now()
  const diffMs = now - ts
  const diffMins = Math.floor(diffMs / 60_000)
  const diffHours = Math.floor(diffMs / 3_600_000)
  const diffDays = Math.floor(diffMs / 86_400_000)

  if (diffMins < 1) return "just now"
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`

  const d = new Date(ts)
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${month}-${day}`
}

/** Truncate to first line, capped at maxWidth */
function truncateTitle(title: string, maxWidth: number): string {
  const firstLine = title.split("\n")[0] ?? title
  if (firstLine.length <= maxWidth) return firstLine
  return firstLine.slice(0, maxWidth - 1) + "\u2026"
}

/** Format token count compactly: 1234 -> "1.2K", 1234567 -> "1.2M" */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

/** Format cost: 0.42 -> "$0.42" */
function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/** Build the metadata line (line 2 of each session row) */
function buildMetaLine(session: SessionInfo, maxWidth: number): string {
  const parts: string[] = []

  // Always show relative time
  parts.push(formatTimestamp(session.updatedAt))

  // Turn count
  if (session.turnCount != null) {
    parts.push(`${session.turnCount} turns`)
  }

  // Tool count (only if > 0)
  if (session.toolCallCount != null && session.toolCallCount > 0) {
    parts.push(`${session.toolCallCount} tools`)
  }

  // Git branch
  if (session.gitBranch) {
    parts.push(session.gitBranch)
  }

  // Token total
  if (session.totalTokens != null) {
    parts.push(`${formatTokens(session.totalTokens)} tok`)
  }

  // Cost (if available and > 0)
  if (session.totalCostUsd != null && session.totalCostUsd > 0) {
    parts.push(formatCost(session.totalCostUsd))
  }

  const full = parts.join(" \u00b7 ")
  if (full.length <= maxWidth) return full
  // Truncate from the right, dropping least important fields
  return full.slice(0, maxWidth - 1) + "\u2026"
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SessionPicker(props: SessionPickerProps) {
  const dims = useTerminalDimensions()
  const renderer = useRenderer()

  // ── State ──────────────────────────────────────────────────────────────

  const [activeTab, setActiveTab] = createSignal<TabId>(props.currentBackend)
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [minTurnIdx, setMinTurnIdx] = createSignal(0)
  const [branchOnly, setBranchOnly] = createSignal(false)
  const [dateIdx, setDateIdx] = createSignal(0)

  // Detect current git branch for branch filter
  const currentBranch = (() => {
    try {
      const { execSync } = require("child_process")
      return (execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: props.currentCwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }) as string).trim()
    } catch {
      return undefined
    }
  })()

  // ── Derived ────────────────────────────────────────────────────────────

  /**
   * Backend ids that contribute sessions — sourced from the registry rather
   * than a hardcoded literal so that adding a new backend with
   * `sessionFile.listFromDisk` automatically appears in the picker (Cluster 1).
   */
  const fileBackendIds = createMemo<string[]>(() =>
    listSessionFileBackends().map((b) => b.id),
  )

  /** Tab order: current backend → all → others (alphabetical) */
  const tabs = createMemo<TabId[]>(() => {
    const current = props.currentBackend
    const others = fileBackendIds()
      .filter((b) => b !== current)
      .sort()
    return [current, "all", ...others]
  })

  /** Tab counts (unfiltered) */
  const tabCounts = createMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    let total = 0
    for (const id of fileBackendIds()) {
      const n = (props.sessions[id] ?? []).length
      counts[id] = n
      total += n
    }
    counts.all = total
    return counts
  })

  /** Raw sessions for the active tab (sorted by updatedAt) */
  const tabSessions = createMemo<SessionInfo[]>(() => {
    const tab = activeTab()
    if (tab === "all") {
      const all: SessionInfo[] = []
      for (const id of fileBackendIds()) {
        const list = props.sessions[id]
        if (list) all.push(...list)
      }
      return all.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    return props.sessions[tab] ?? []
  })

  /** Active filter values */
  const minTurns = () => TURN_CYCLE[minTurnIdx()] ?? 0
  const dateDays = () => DATE_CYCLE[dateIdx()] ?? 0
  const hasActiveFilters = () => minTurns() > 0 || branchOnly() || dateDays() > 0

  /** Apply hard filters */
  const filteredSessions = createMemo<SessionInfo[]>(() => {
    let sessions = tabSessions()
    const mt = minTurns()
    if (mt > 0) {
      sessions = sessions.filter(s => (s.turnCount ?? s.messageCount ?? 0) >= mt)
    }
    if (branchOnly() && currentBranch) {
      sessions = sessions.filter(s => s.gitBranch === currentBranch)
    }
    const dd = dateDays()
    if (dd > 0) {
      const cutoff = Date.now() - dd * 86_400_000
      sessions = sessions.filter(s => s.updatedAt >= cutoff)
    }
    return sessions
  })

  /** Apply fuzzy search or return as-is */
  const searchResults = createMemo<SessionInfo[]>(() => {
    const query = searchQuery().trim()
    const sessions = filteredSessions()

    if (!query) return sessions

    const results = fuzzysort.go(query, sessions, {
      key: "title",
      limit: 50,
    })

    return results.map(r => ({
      ...r.obj,
      _matchIndexes: [...r.indexes],
      _score: r.score,
    }))
  })

  /** Total session count for display */
  const totalCount = () => searchResults().length

  // ── Scrolling ──────────────────────────────────────────────────────────

  const visibleCount = () => Math.min(MAX_VISIBLE, totalCount())

  const scrollOffset = createMemo(() => {
    const idx = selectedIndex()
    const visible = visibleCount()
    const maxOffset = Math.max(0, totalCount() - visible)
    const idealStart = idx - Math.floor(visible / 2)
    return Math.max(0, Math.min(maxOffset, idealStart))
  })

  const visibleSessions = createMemo(() => {
    const offset = scrollOffset()
    return searchResults().slice(offset, offset + visibleCount())
  })

  // ── Layout ─────────────────────────────────────────────────────────────

  const contentWidth = () => Math.min((dims()?.width ?? 80) - 6, 120)
  const badgeWidth = 10 // " claude" right-aligned
  const titleWidth = () => contentWidth() - badgeWidth - 4 // 4 = left indicator + spacing
  const metaWidth = () => contentWidth() - 4 // left indicator + spacing

  // ── Actions ────────────────────────────────────────────────────────────

  const cancelWithCleanup = () => {
    try {
      renderer.destroy()
    } catch (e) {
      log.error("renderer.destroy() failed during picker cancel", { error: String(e) })
    }
    props.onCancel()
  }

  const clampSelection = (count: number) => {
    setSelectedIndex(i => Math.min(Math.max(0, i), Math.max(0, count - 1)))
  }

  const cycleTab = (dir: 1 | -1) => {
    const t = tabs()
    const curIdx = t.indexOf(activeTab())
    const next = (curIdx + dir + t.length) % t.length
    batch(() => {
      setActiveTab(t[next]!)
      setSelectedIndex(0)
    })
  }

  // ── Keyboard ───────────────────────────────────────────────────────────

  useKeyboard((event) => {
    // Ctrl+C: immediate cancel
    if (event.ctrl && event.name === "c") {
      event.preventDefault()
      cancelWithCleanup()
      return
    }

    // Escape: clear search first, then cancel
    if (event.name === "escape") {
      event.preventDefault()
      if (searchQuery()) {
        setSearchQuery("")
        clampSelection(searchResults().length)
      } else {
        cancelWithCleanup()
      }
      return
    }

    // Navigation
    if (event.name === "up" || event.name === "k") {
      event.preventDefault()
      setSelectedIndex(i => Math.max(0, i - 1))
      return
    }
    if (event.name === "down" || event.name === "j") {
      event.preventDefault()
      setSelectedIndex(i => Math.min(totalCount() - 1, i + 1))
      return
    }
    if (event.name === "pageup") {
      event.preventDefault()
      setSelectedIndex(i => Math.max(0, i - visibleCount()))
      return
    }
    if (event.name === "pagedown") {
      event.preventDefault()
      setSelectedIndex(i => Math.min(totalCount() - 1, i + visibleCount()))
      return
    }
    if (event.name === "home") {
      event.preventDefault()
      setSelectedIndex(0)
      return
    }
    if (event.name === "end") {
      event.preventDefault()
      setSelectedIndex(Math.max(0, totalCount() - 1))
      return
    }

    // Enter: select session
    if (event.name === "return") {
      event.preventDefault()
      const session = searchResults()[selectedIndex()]
      if (session) {
        props.onSelect(session.id, session.origin)
      }
      return
    }

    // Tab / Shift+Tab: cycle backend tabs
    if (event.name === "tab") {
      event.preventDefault()
      cycleTab(event.shift ? -1 : 1)
      return
    }

    // Number keys 1-4: jump to tab
    if (!event.ctrl && !event.meta && event.raw >= "1" && event.raw <= "4") {
      event.preventDefault()
      const idx = parseInt(event.raw) - 1
      const t = tabs()
      if (idx < t.length) {
        batch(() => {
          setActiveTab(t[idx]!)
          setSelectedIndex(0)
        })
      }
      return
    }

    // Ctrl+T: cycle min turns filter
    if (event.ctrl && event.name === "t") {
      event.preventDefault()
      batch(() => {
        setMinTurnIdx(i => (i + 1) % TURN_CYCLE.length)
        clampSelection(searchResults().length)
      })
      return
    }

    // Ctrl+B: toggle branch filter
    if (event.ctrl && event.name === "b") {
      event.preventDefault()
      batch(() => {
        setBranchOnly(v => !v)
        clampSelection(searchResults().length)
      })
      return
    }

    // Ctrl+D: cycle date range filter
    if (event.ctrl && event.name === "d") {
      event.preventDefault()
      batch(() => {
        setDateIdx(i => (i + 1) % DATE_CYCLE.length)
        clampSelection(searchResults().length)
      })
      return
    }

    // Backspace: delete from search
    if (event.name === "backspace") {
      event.preventDefault()
      batch(() => {
        setSearchQuery(q => q.slice(0, -1))
        clampSelection(searchResults().length)
      })
      return
    }

    // Printable characters: append to search
    if (event.raw && event.raw.length === 1 && !event.ctrl && !event.meta && event.raw >= " ") {
      event.preventDefault()
      batch(() => {
        setSearchQuery(q => q + event.raw)
        setSelectedIndex(0) // jump to best match
      })
      return
    }

    // Block all other keys
    event.preventDefault()
  })

  // ── Render helpers ─────────────────────────────────────────────────────

  /** Is the selected session from a different backend? */
  const isCrossBackend = createMemo(() => {
    const session = searchResults()[selectedIndex()]
    if (!session?.origin) return false
    return session.origin !== props.currentBackend
  })

  /** Build filter chip text */
  const filterChips = createMemo(() => {
    const chips: string[] = []
    const mt = minTurns()
    if (mt > 0) chips.push(`\u2265${mt} turns`)
    if (branchOnly() && currentBranch) chips.push(currentBranch)
    const dd = dateDays()
    if (dd > 0) chips.push(`${dd}d`)
    return chips.join(" \u00b7 ")
  })

  // ── JSX ────────────────────────────────────────────────────────────────

  return (
    <box flexDirection="column" padding={2} width="100%" height="100%" backgroundColor={colors.bg.primary}>
      {/* Title */}
      <text fg={colors.accent.primary} attributes={TextAttributes.BOLD}>
        {"Resume Session"}
      </text>

      {/* Tab bar */}
      <box flexDirection="row" marginTop={1} height={2}>
        <Index each={tabs()}>
          {(tab) => {
            const isActive = createMemo(() => tab() === activeTab())
            const count = createMemo(() => tabCounts()[tab()])
            const label = createMemo(() => {
              const t = tab()
              const name = t === "all" ? "All" : t.charAt(0).toUpperCase() + t.slice(1)
              return `${name} (${count()})`
            })

            return (
              <box flexDirection="column" marginRight={2}>
                <text
                  fg={isActive()
                    ? (tab() !== "all" ? badgeColor(tab() as string) : colors.text.primary)
                    : colors.text.secondary}
                  attributes={isActive() ? TextAttributes.BOLD : 0}
                >
                  {label()}
                </text>
                <text fg={isActive() ? colors.accent.primary : colors.text.muted}>
                  {isActive() ? "\u2501".repeat(label().length) : "\u2500".repeat(label().length)}
                </text>
              </box>
            )
          }}
        </Index>
      </box>

      {/* Search bar + filter chips */}
      <box flexDirection="row" marginTop={1} height={1}>
        <text fg={colors.text.muted}>
          {"\ud83d\udd0d "}
        </text>
        <text fg={searchQuery() ? colors.text.primary : colors.text.muted}>
          {searchQuery() || "Type to search\u2026"}
        </text>
        <text fg={colors.text.primary}>
          {searchQuery() ? "\u2588" : ""}
        </text>
        <box flexGrow={1} />
        <Show when={hasActiveFilters()}>
          <text fg={colors.status.info}>
            {filterChips()}
          </text>
        </Show>
        <Show when={searchQuery()}>
          <text fg={colors.text.muted}>
            {`  ${totalCount()} match${totalCount() !== 1 ? "es" : ""}`}
          </text>
        </Show>
      </box>

      {/* Session list */}
      <box marginTop={1} flexDirection="column" flexGrow={1}>
        <Show
          when={totalCount() > 0}
          fallback={
            <box flexDirection="column" marginTop={1}>
              <Show
                when={searchQuery() || hasActiveFilters()}
                fallback={
                  <text fg={colors.text.muted}>
                    {activeTab() === "all"
                      ? "No sessions found across any backend."
                      : `No ${activeTab()} sessions found.`}
                  </text>
                }
              >
                <text fg={colors.text.muted}>
                  {`No sessions match${searchQuery() ? ` "${searchQuery()}"` : ""}.`}
                </text>
                <text fg={colors.text.muted} marginTop={0}>
                  {"Try a different search term or clear filters (Esc)."}
                </text>
              </Show>
            </box>
          }
        >
          <Index each={visibleSessions()}>
            {(session, localIndex) => {
              const globalIndex = () => localIndex + scrollOffset()
              const isSelected = createMemo(() => globalIndex() === selectedIndex())
              const origin = createMemo(() => session().origin)
              const isCross = createMemo(() =>
                origin() != null && origin() !== props.currentBackend,
              )
              const showBadge = createMemo(() => activeTab() === "all" || isCross())

              // Build badge text
              const badge = createMemo(() => {
                if (!showBadge()) return ""
                const o = origin()
                if (!o) return ""
                return isCross() ? `\u21c4 ${o}` : o
              })

              return (
                <box flexDirection="column" height={3}>
                  {/* Line 1: selection indicator + title + badge */}
                  <box flexDirection="row" height={1}>
                    <text
                      fg={isSelected() ? colors.accent.highlight : colors.text.muted}
                      attributes={isSelected() ? TextAttributes.BOLD : 0}
                    >
                      {isSelected() ? "\u258c " : "  "}
                    </text>
                    <text
                      fg={isSelected() ? colors.accent.highlight : colors.text.primary}
                      attributes={isSelected() ? TextAttributes.BOLD : 0}
                    >
                      {truncateTitle(session().title, titleWidth() - (showBadge() ? badge().length + 2 : 0))}
                    </text>
                    <Show when={showBadge()}>
                      <box flexGrow={1} />
                      <text fg={badgeColor(origin())}>
                        {badge()}
                      </text>
                    </Show>
                  </box>

                  {/* Line 2: metadata */}
                  <box flexDirection="row" height={1}>
                    <text fg={colors.text.muted}>
                      {isSelected() ? "\u258c " : "  "}
                    </text>
                    <text fg={isSelected() ? colors.text.secondary : colors.text.muted}>
                      {buildMetaLine(session(), metaWidth())}
                    </text>
                  </box>
                </box>
              )
            }}
          </Index>

          {/* Scroll / count indicator */}
          <box marginTop={1} height={1}>
            <text fg={colors.text.muted}>
              {totalCount() > visibleCount()
                ? `  ${selectedIndex() + 1}/${totalCount()} sessions${hasActiveFilters() ? " (filtered)" : ""}`
                : `  ${totalCount()} session${totalCount() !== 1 ? "s" : ""}`}
            </text>
          </box>
        </Show>
      </box>

      {/* Cross-backend warning */}
      <Show when={isCrossBackend()}>
        <text fg={colors.status.warning} marginTop={0}>
          {`  \u21c4 Cross-backend resume: ${searchResults()[selectedIndex()]?.origin} \u2192 ${props.currentBackend} (context injection)`}
        </text>
      </Show>

      {/* Footer */}
      <box marginTop={1} height={1}>
        <text fg={colors.text.muted}>
          {"\u2191/\u2193 navigate \u00b7 Tab switch backend \u00b7 Enter resume \u00b7 Ctrl+T/B/D filter \u00b7 Esc cancel"}
        </text>
      </box>
    </box>
  )
}
