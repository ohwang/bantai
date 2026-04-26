/**
 * Diagnostics Panel — Ctrl+Shift+D toggle overlay
 *
 * Three-tab diagnostics view:
 *   [1] Info        — system, session, models, tokens, context, git, backend, config
 *   [2] Logs        — real-time streaming log viewer (current session)
 *   [3] Status Line — status line config, payload JSON, command output
 *
 * Toggled via Ctrl+Shift+D. Pressing again or Esc/q closes it.
 * Switch tabs with 1/2/3 or Tab.
 */

import { createSignal, createMemo, Show, For, Index, onCleanup } from "solid-js"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { ScrollView } from "./scroll-view"
import { useTerminalDimensions } from "@opentui/solid"
import { useSession } from "../context/session"
import { useAgent } from "../context/agent"
import { useMessages } from "../context/messages"
import { colors } from "../theme/tokens"
import { log } from "../../../utils/logger"
import { friendlyModelName, MODEL_NAMES, MODEL_CONTEXT_WINDOWS, modelContextWindow } from "../../../protocol/models"
import { getStatusLineDiagnostics } from "../../../utils/statusline"
import { listStatusBars } from "../status-bar/registry"
import { activeStatusBarId } from "../status-bar/active"

// ---------------------------------------------------------------------------
// Module-level callbacks — called from app.tsx keyboard handler
// ---------------------------------------------------------------------------
let _scrollDiagnostics: ((amount: number) => void) | undefined
let _scrollDiagnosticsToTop: (() => void) | undefined
let _scrollDiagnosticsToBottom: (() => void) | undefined
let _switchDiagnosticsTab: ((tab?: number) => void) | undefined

/** App start timestamp — captured at module load so Uptime survives
 *  the DiagnosticsPanel being closed and reopened. */
const APP_START_TIME = Date.now()

/**
 * Scroll the diagnostics panel by the given amount.
 * Positive = down, negative = up.
 */
export function scrollDiagnostics(amount: number): void {
  _scrollDiagnostics?.(amount)
}

/** Scroll the diagnostics panel to the very top (vim `gg`). */
export function scrollDiagnosticsToTop(): void {
  _scrollDiagnosticsToTop?.()
}

/** Scroll the diagnostics panel to the very bottom (vim `G`). */
export function scrollDiagnosticsToBottom(): void {
  _scrollDiagnosticsToBottom?.()
}

/**
 * Switch the diagnostics tab.
 * If no tab index given, cycles to the next tab.
 */
export function switchDiagnosticsTab(tab?: number): void {
  _switchDiagnosticsTab?.(tab)
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

interface DiagSection {
  title: string
  entries: DiagEntry[]
}

interface DiagEntry {
  key: string
  /** Static string OR a getter for values that change over time. Using a
   *  getter lets live values (heap, rss, uptime) re-render their <text>
   *  node without invalidating the surrounding `sections()` memo — which
   *  would otherwise rebuild every section and destroy the selection
   *  state each second. */
  value: string | (() => string)
  color?: string
}

function formatTokenCount(n: number): string {
  if (n === 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s"
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  if (mins < 60) return `${mins}m ${secs}s`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hrs}h ${remMins}m ${secs}s`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getGitBranch(): string {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    if (result.exitCode === 0) return result.stdout.toString().trim()
  } catch { /* ignore */ }
  return ""
}

function getGitDirtyCount(): number {
  try {
    const result = Bun.spawnSync(["git", "status", "--porcelain"])
    if (result.exitCode === 0) {
      const lines = result.stdout.toString().trim()
      if (!lines) return 0
      return lines.split("\n").filter(l => l.trim()).length
    }
  } catch { /* ignore */ }
  return 0
}

// ---------------------------------------------------------------------------
// Diagnostics Panel Component
// ---------------------------------------------------------------------------

const TAB_COUNT = 3
const TAB_NAMES = ["Info", "Logs", "Status Line"] as const

// `onClose` is retained on the signature for API symmetry (storybook and
// future in-panel close affordances) even though closure is currently
// driven by app-level Esc handling that flips `showDiagnostics`.
export function DiagnosticsPanel(_props: { onClose: () => void }) {
  const { state: session } = useSession()
  const agent = useAgent()
  const { state: messages } = useMessages()
  const dims = useTerminalDimensions()

  // Tick signal — fuels the `liveMem` / `liveUptime` memos below so the
  // Heap/RSS/Uptime values refresh every second. NOTE: only those two
  // derived signals depend on `tick` — the main `sections()` memo does
  // NOT, so ticking does not rebuild every row (which would destroy the
  // user's text selection every second; see the backlog item
  // scope-reactivity-to-visible-ui).
  const [tick, setTick] = createSignal(0)
  const tickInterval = setInterval(() => setTick(t => t + 1), 1_000)
  onCleanup(() => clearInterval(tickInterval))

  const liveMem = createMemo(() => { tick(); return process.memoryUsage() })
  const liveUptime = createMemo(() => { tick(); return Date.now() - APP_START_TIME })

  // ---------------------------------------------------------------------------
  // Tab state
  // ---------------------------------------------------------------------------
  const [activeTab, setActiveTab] = createSignal(0)

  // Expose tab switching to app.tsx keyboard handler
  _switchDiagnosticsTab = (tab?: number) => {
    if (tab !== undefined) {
      setActiveTab(Math.max(0, Math.min(tab, TAB_COUNT - 1)))
    } else {
      setActiveTab(prev => (prev + 1) % TAB_COUNT)
    }
  }

  // ---------------------------------------------------------------------------
  // Log lines (real-time)
  // ---------------------------------------------------------------------------
  const [logLines, setLogLines] = createSignal<string[]>(log.getLines().slice())
  const hasLogLines = createMemo(() => logLines().length > 0)

  const MAX_DISPLAY_LINES = 2000
  const unsubscribe = log.subscribe((line: string) => {
    setLogLines(prev => {
      const next = [...prev, line]
      return next.length > MAX_DISPLAY_LINES ? next.slice(-MAX_DISPLAY_LINES) : next
    })
  })
  onCleanup(() => unsubscribe())

  // Scroll refs — one per tab, only the active one is connected
  let infoScrollRef: ScrollBoxRenderable | undefined
  let logsScrollRef: ScrollBoxRenderable | undefined
  let statusLineScrollRef: ScrollBoxRenderable | undefined

  // Helper to get the scroll ref for the active tab
  const activeScrollRef = () => {
    switch (activeTab()) {
      case 0: return infoScrollRef
      case 1: return logsScrollRef
      case 2: return statusLineScrollRef
      default: return undefined
    }
  }

  // Update the module-level scroll callbacks to route to the active tab
  const updateScrollRef = () => {
    _scrollDiagnostics = (n: number) => { activeScrollRef()?.scrollBy(n) }
    _scrollDiagnosticsToTop = () => { activeScrollRef()?.scrollTo(0) }
    _scrollDiagnosticsToBottom = () => { activeScrollRef()?.scrollTo(999_999) }
  }

  // Clean up module-level refs when component unmounts
  onCleanup(() => {
    _scrollDiagnostics = undefined
    _scrollDiagnosticsToTop = undefined
    _scrollDiagnosticsToBottom = undefined
    _switchDiagnosticsTab = undefined
  })

  // Collect all diagnostic sections as a reactive memo.
  // Deliberately does NOT depend on `tick` — per-second values use the
  // getter form of DiagEntry.value (reading liveMem / liveUptime) so only
  // those cells re-render on each tick. See scope-reactivity-to-visible-ui.
  const sections = createMemo((): DiagSection[] => {
    const result: DiagSection[] = []

    // -- SYSTEM --
    result.push({
      title: "SYSTEM",
      entries: [
        { key: "Version:", value: "v0.0.1" },
        { key: "Runtime:", value: `Bun ${Bun.version}` },
        { key: "Platform:", value: `${process.platform}/${process.arch}` },
        { key: "Terminal:", value: `${dims()?.width ?? 0}x${dims()?.height ?? 0}` },
        { key: "Heap used:", value: () => formatBytes(liveMem().heapUsed) },
        { key: "RSS:", value: () => formatBytes(liveMem().rss) },
      ],
    })

    // -- SESSION --
    const sessionId = session.session?.sessionId ?? "(none)"
    result.push({
      title: "SESSION",
      entries: [
        { key: "Session ID:", value: sessionId },
        { key: "State:", value: session.sessionState, color: stateColor(session.sessionState) },
        { key: "Uptime:", value: () => formatDuration(liveUptime()) },
        { key: "Permission mode:", value: agent.config.permissionMode ?? "default" },
        { key: "Backend:", value: agent.backend.capabilities().name },
      ],
    })

    // -- MODEL --
    const rawModel = session.currentModel || session.session?.models?.[0]?.name || ""
    const modelDisplay = rawModel ? friendlyModelName(rawModel) : "(none)"
    result.push({
      title: "MODEL",
      entries: [
        { key: "Model:", value: modelDisplay },
        { key: "Model ID:", value: rawModel || "(none)" },
      ],
    })

    // -- AVAILABLE MODELS --
    const activeModel = rawModel
    const modelEntries: DiagEntry[] = []
    // Session models from backend (if available)
    const sessionModels = session.session?.models
    if (sessionModels && sessionModels.length > 0) {
      for (const m of sessionModels) {
        const display = friendlyModelName(m.name)
        const ctxStr = m.contextWindow
          ? ` (${formatTokenCount(m.contextWindow)} ctx)`
          : ""
        const isActive = m.name === activeModel
        modelEntries.push({
          key: isActive ? "  ▸" : "   ",
          value: `${display}${ctxStr}  ${m.name}`,
          color: isActive ? colors.accent.primary : undefined,
        })
      }
    } else {
      // Fall back to static model registry
      for (const [id, display] of Object.entries(MODEL_NAMES)) {
        const ctxWindow = MODEL_CONTEXT_WINDOWS[id]
        const ctxStr = ctxWindow ? ` (${formatTokenCount(ctxWindow)} ctx)` : ""
        const isActive = id === activeModel
        modelEntries.push({
          key: isActive ? "  ▸" : "   ",
          value: `${display}${ctxStr}  ${id}`,
          color: isActive ? colors.accent.primary : undefined,
        })
      }
    }
    result.push({ title: "AVAILABLE MODELS", entries: modelEntries })

    // -- TOKENS & COST --
    const cost = session.cost
    const tokenEntries: DiagEntry[] = [
      { key: "Input tokens:", value: formatTokenCount(cost.inputTokens) },
      { key: "Output tokens:", value: formatTokenCount(cost.outputTokens) },
    ]
    if (cost.cacheReadTokens > 0) {
      tokenEntries.push({ key: "Cache read:", value: formatTokenCount(cost.cacheReadTokens) })
    }
    if (cost.cacheWriteTokens > 0) {
      tokenEntries.push({ key: "Cache create:", value: formatTokenCount(cost.cacheWriteTokens) })
    }
    tokenEntries.push({ key: "Total cost:", value: `$${cost.totalCostUsd.toFixed(4)}`, color: "green" })
    result.push({ title: "TOKENS & COST", entries: tokenEntries })

    // -- CONTEXT WINDOW --
    const ctxModel = session.session?.models?.[0]
    const ctxWindow = ctxModel?.contextWindow ?? modelContextWindow(rawModel)
    const ctxFill = session.lastTurnInputTokens
    const ctxPct = ctxWindow > 0 && ctxFill > 0 ? ((ctxFill / ctxWindow) * 100).toFixed(1) : "0.0"
    result.push({
      title: "CONTEXT WINDOW",
      entries: [
        { key: "Current tokens:", value: formatTokenCount(ctxFill) },
        { key: "Max tokens:", value: formatTokenCount(ctxWindow) },
        { key: "Utilization:", value: `${ctxPct}%` },
      ],
    })

    // -- ACTIVITY --
    result.push({
      title: "ACTIVITY",
      entries: [
        { key: "Turns:", value: String(session.turnNumber) },
      ],
    })

    // -- CONVERSATION --
    const blocks = messages.blocks
    const blockCounts: Record<string, number> = {}
    for (const b of blocks) {
      blockCounts[b.type] = (blockCounts[b.type] || 0) + 1
    }
    const convEntries: DiagEntry[] = [
      { key: "Total blocks:", value: String(blocks.length) },
    ]
    for (const [kind, count] of Object.entries(blockCounts).sort(([a], [b]) => a.localeCompare(b))) {
      convEntries.push({ key: `  ${kind}:`, value: String(count) })
    }
    const isStreaming = !!(messages.streamingText || messages.streamingThinking)
    convEntries.push({ key: "Streaming:", value: isStreaming ? "yes" : "no", color: isStreaming ? "cyan" : undefined })
    if (messages.streamingText) {
      convEntries.push({ key: "  text buffer:", value: `${messages.streamingText.length} chars` })
    }
    if (messages.streamingThinking) {
      convEntries.push({ key: "  thinking buf:", value: `${messages.streamingThinking.length} chars` })
    }
    convEntries.push({ key: "Active tasks:", value: String(messages.activeTasks.length) })
    result.push({ title: "CONVERSATION", entries: convEntries })

    // -- GIT --
    const branch = getGitBranch()
    if (branch) {
      result.push({
        title: "GIT",
        entries: [
          { key: "Branch:", value: branch },
          { key: "Dirty files:", value: String(getGitDirtyCount()) },
        ],
      })
    }

    // -- BACKEND --
    const caps = agent.backend.capabilities()
    result.push({
      title: "BACKEND",
      entries: [
        { key: "Name:", value: caps.name },
        { key: "Streaming:", value: caps.supportsStreaming ? "yes" : "no" },
        { key: "Thinking:", value: caps.supportsThinking ? "yes" : "no" },
        { key: "Resume:", value: caps.supportsResume ? "yes" : "no" },
        { key: "Subagents:", value: caps.supportsSubagents ? "yes" : "no" },
      ],
    })

    // -- CONFIG --
    result.push({
      title: "CONFIG",
      entries: [
        { key: "CWD:", value: process.cwd() },
        { key: "Effort:", value: session.currentEffort || "high (default)" },
        { key: "Thinking:", value: agent.config.thinking ? agent.config.thinking.type + (agent.config.thinking.type === "enabled" && agent.config.thinking.budgetTokens ? ` (${agent.config.thinking.budgetTokens} tokens)` : "") : "adaptive (default)" },
        { key: "Log file:", value: log.getLogFile() },
      ],
    })

    // -- ERROR (if any) --
    if (session.lastError) {
      result.push({
        title: "LAST ERROR",
        entries: [
          { key: "Code:", value: session.lastError.code, color: "red" },
          { key: "Message:", value: session.lastError.message, color: "red" },
        ],
      })
    }

    return result
  })

  const separatorWidth = () => dims()?.width ? dims()!.width - 4 : 70

  return (
    <>
      {/* Diagnostics panel — fills the entire terminal, replacing the
       *  conversation. Mount is gated by <Show> in app.tsx, so any timer
       *  / subscription in this component only lives while the panel is
       *  on screen. */}
      <box
        flexGrow={1}
        width="100%"
        backgroundColor={colors.bg.overlay}
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        {/* Title bar with tabs */}
        <box flexDirection="row" flexShrink={0}>
          <text fg={colors.text.primary} attributes={TextAttributes.BOLD}>
            {"Diagnostics"}
          </text>
          <text fg={colors.text.secondary}>{"  "}</text>
          <For each={TAB_NAMES as unknown as string[]}>
            {(name, i) => (
              <box flexDirection="row">
                <text fg={activeTab() === i() ? colors.accent.primary : colors.text.secondary} attributes={activeTab() === i() ? TextAttributes.BOLD : 0}>
                  {`[${i() + 1}] ${name}`}
                </text>
                <text fg={colors.text.secondary}>{i() < TAB_COUNT - 1 ? "  " : ""}</text>
              </box>
            )}
          </For>
        </box>

        {/* Separator line */}
        <box height={1} flexShrink={0}>
          <text fg={colors.border.default}>{"─".repeat(separatorWidth())}</text>
        </box>

        {/* Tab: Info */}
        <Show when={activeTab() === 0}>
          <ScrollView
            ref={(el: ScrollBoxRenderable) => { infoScrollRef = el; updateScrollRef() }}
            flexGrow={1}
            stickyScroll={false}
            backgroundColor={colors.bg.overlay}
          >
            <For each={sections()}>
              {(section) => (
                <box flexDirection="column">
                  <box marginTop={1}>
                    <text fg={colors.accent.primary} attributes={TextAttributes.BOLD}>
                      {section.title}
                    </text>
                  </box>
                  <box height={1} />
                  <For each={section.entries}>
                    {(entry) => (
                      <box flexDirection="row">
                        <text fg={colors.text.secondary}>{padRight(entry.key, 22)}</text>
                        {/* Resolve getter-form values on every frame so
                         *  per-tick changes (Heap/RSS/Uptime) update this
                         *  <text> without replacing the surrounding node
                         *  — which would destroy any active selection. */}
                        <text fg={entry.color ?? colors.text.primary}>
                          {() => " " + (typeof entry.value === "function" ? entry.value() : entry.value)}
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              )}
            </For>
          </ScrollView>
        </Show>

        {/* Tab: Logs */}
        <Show when={activeTab() === 1}>
          <ScrollView
            ref={(el: ScrollBoxRenderable) => { logsScrollRef = el; updateScrollRef() }}
            flexGrow={1}
            stickyScroll={true}
            backgroundColor={colors.bg.overlay}
          >
            <Show when={hasLogLines()} fallback={
              <box marginTop={1}>
                <text fg={colors.text.secondary}>{"(no log entries yet)"}</text>
              </box>
            }>
              <Index each={logLines()}>
                {(line) => {
                  const parsed = createMemo(() => parseLogLine(line()))
                  return (
                    <text fg={logLevelColor(parsed().level)}>
                      {parsed().timestamp + " " + padRight(parsed().level, 6) + parsed().message}
                    </text>
                  )
                }}
              </Index>
            </Show>
          </ScrollView>
        </Show>

        {/* Tab: Status Line */}
        <Show when={activeTab() === 2}>
          <ScrollView
            ref={(el: ScrollBoxRenderable) => { statusLineScrollRef = el; updateScrollRef() }}
            flexGrow={1}
            stickyScroll={false}
            backgroundColor={colors.bg.overlay}
          >
            {(() => {
              // Re-read on each tick so it refreshes
              tick()
              const diag = getStatusLineDiagnostics()
              const cfg = diag.config

              const activeId = activeStatusBarId()
              const allPresets = listStatusBars()
              const activePreset = allPresets.find(p => p.id === activeId)

              return (
                <box flexDirection="column">
                  {/* NATIVE PRESET section — which preset is rendering line 1 when
                       no external command is configured (or as a fallback). */}
                  <box marginTop={1}>
                    <text fg={colors.accent.primary} attributes={TextAttributes.BOLD}>
                      {"NATIVE PRESET"}
                    </text>
                  </box>
                  <box height={1} />
                  <box flexDirection="row">
                    <text fg={colors.text.secondary}>{padRight("Active:", 22)}</text>
                    <text fg={colors.text.primary}>
                      {" " + (activePreset ? `${activePreset.id} — ${activePreset.name}` : activeId)}
                    </text>
                  </box>
                  <Show when={activePreset}>
                    <box flexDirection="row">
                      <text fg={colors.text.secondary}>{padRight("Description:", 22)}</text>
                      <text fg={colors.text.muted}>{" " + activePreset!.description}</text>
                    </box>
                  </Show>
                  <box flexDirection="row">
                    <text fg={colors.text.secondary}>{padRight("Available:", 22)}</text>
                    <text fg={colors.text.muted}>
                      {" " + allPresets.map(p => p.id).join(", ")}
                    </text>
                  </box>
                  <Show when={cfg}>
                    <box flexDirection="row">
                      <text fg={colors.text.muted}>
                        {"(external statusLine command is configured — it takes precedence over the native preset)"}
                      </text>
                    </box>
                  </Show>

                  {/* CONFIG section */}
                  <box marginTop={1}>
                    <text fg={colors.accent.primary} attributes={TextAttributes.BOLD}>
                      {"CONFIG"}
                    </text>
                  </box>
                  <box height={1} />
                  <Show when={cfg} fallback={
                    <text fg={colors.text.secondary}>{"(no status line configured in ~/.claude/settings.json)"}</text>
                  }>
                    <box flexDirection="column">
                      <box flexDirection="row">
                        <text fg={colors.text.secondary}>{padRight("Command:", 22)}</text>
                        <text fg={colors.text.primary}>{" " + cfg!.command}</text>
                      </box>
                      <Show when={cfg!.padding !== undefined}>
                        <box flexDirection="row">
                          <text fg={colors.text.secondary}>{padRight("Padding:", 22)}</text>
                          <text fg={colors.text.primary}>{" " + String(cfg!.padding)}</text>
                        </box>
                      </Show>
                    </box>
                  </Show>

                  {/* EXECUTION section */}
                  <box marginTop={1}>
                    <text fg={colors.accent.primary} attributes={TextAttributes.BOLD}>
                      {"EXECUTION"}
                    </text>
                  </box>
                  <box height={1} />
                  <box flexDirection="row">
                    <text fg={colors.text.secondary}>{padRight("Last update:", 22)}</text>
                    <text fg={colors.text.primary}>
                      {" " + (diag.lastUpdateTime ? new Date(diag.lastUpdateTime).toISOString().slice(11, 23) : "(never)")}
                    </text>
                  </box>
                  <box flexDirection="row">
                    <text fg={colors.text.secondary}>{padRight("Duration:", 22)}</text>
                    <text fg={colors.text.primary}>
                      {" " + (diag.lastDurationMs !== null ? `${diag.lastDurationMs}ms` : "—")}
                    </text>
                  </box>
                  <Show when={diag.lastError}>
                    <box flexDirection="row">
                      <text fg={colors.text.secondary}>{padRight("Error:", 22)}</text>
                      <text fg={colors.status.error}>{" " + diag.lastError}</text>
                    </box>
                  </Show>

                  {/* OUTPUT section — raw output contains ANSI escape sequences
                       that can't be rendered as plain text, so we just show
                       the byte length as a sanity check. */}
                  <box marginTop={1}>
                    <text fg={colors.accent.primary} attributes={TextAttributes.BOLD}>
                      {"OUTPUT"}
                    </text>
                  </box>
                  <box height={1} />
                  <Show when={diag.lastOutput} fallback={
                    <text fg={colors.text.secondary}>{"(no output yet)"}</text>
                  }>
                    <text fg={colors.text.secondary}>
                      {`(${diag.lastOutput!.length} bytes, contains ANSI escape sequences — rendered in status bar)`}
                    </text>
                  </Show>

                  {/* PAYLOAD section — the JSON sent to the command */}
                  <box marginTop={1}>
                    <text fg={colors.accent.primary} attributes={TextAttributes.BOLD}>
                      {"PAYLOAD (JSON sent to stdin)"}
                    </text>
                  </box>
                  <box height={1} />
                  <Show when={diag.lastInputJson} fallback={
                    <text fg={colors.text.secondary}>{"(no payload sent yet)"}</text>
                  }>
                    <Index each={diag.lastInputJson!.split("\n")}>
                      {(line) => (
                        <text fg={colors.text.thinking}>{line()}</text>
                      )}
                    </Index>
                  </Show>
                </box>
              )
            })()}
          </ScrollView>
        </Show>

        {/* Footer — keyboard hints */}
        <box height={1} flexShrink={0}>
          <text fg={colors.border.default}>{"─".repeat(separatorWidth())}</text>
        </box>
        <box flexShrink={0}>
          <text fg={colors.text.muted}>
            {"j/k scroll, d/u page, gg/G top/bottom, 1/2/3 or Tab switch tab, Esc to close"}
          </text>
        </box>
      </box>
    </>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length)
}

function stateColor(state: string): string {
  switch (state) {
    case "IDLE": return colors.state.idle
    case "RUNNING": return colors.state.running
    case "WAITING_FOR_PERM":
    case "WAITING_FOR_ELIC":
    case "INTERRUPTING": return colors.state.waiting
    case "ERROR": return colors.state.error
    default: return colors.text.muted
  }
}

// ---------------------------------------------------------------------------
// Log line parsing
// ---------------------------------------------------------------------------

interface ParsedLogLine {
  timestamp: string
  level: string
  message: string
}

/**
 * Parse a structured log line: `[ISO_TIMESTAMP] [LEVEL] message [data]`
 * Falls back gracefully for malformed lines.
 */
function parseLogLine(line: string): ParsedLogLine {
  // Match: [2026-04-08T10:30:45.123Z] [INFO ] rest of message
  const match = line.match(/^\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.*)$/)
  if (match && match[1] && match[2] && match[3]) {
    const ts = match[1]
    // Show only HH:MM:SS.mmm for compactness
    const short = ts.includes("T") ? ts.slice(11, 23) : ts
    return { timestamp: short, level: match[2].trim(), message: match[3] }
  }
  // Unparseable — show raw
  return { timestamp: "", level: "???", message: line }
}

/** Map log level to a semantic color. */
function logLevelColor(level: string): string {
  switch (level) {
    case "DEBUG": return colors.text.thinking
    case "INFO":  return colors.text.primary
    case "WARN":  return colors.status.warning
    case "ERROR": return colors.status.error
    default:      return colors.text.muted
  }
}
