/**
 * Conversation View — Single scrollbox containing all content
 *
 * Everything (blocks, streaming content, input area, status bar) lives
 * inside one scrollbox. When scrolled up, the entire UI — including the
 * input area and status bar — scrolls off-screen, matching Claude Code.
 * A flex spacer + minHeight="100%" keeps the footer pinned to the bottom
 * of the viewport when conversation content is short.
 *
 * Auto-scrolls using OpenTUI's native stickyScroll={true} + stickyStart="bottom".
 * The Zig layout engine pins the viewport to the bottom during its own render
 * frame — no timers or timing hacks needed for streaming, resume, or content
 * changes. When the user scrolls away (Ctrl+Up or mouse wheel), stickyScroll
 * is disabled so the viewport stays in place. Re-enables on Ctrl+Down back to
 * bottom, printable input, or sending a new message.
 * Ctrl+O toggles tool view level, Ctrl+E shows all.
 */

import type { JSX } from "solid-js"
import { createSignal, createEffect, createMemo, onCleanup, Show, For, Index, batch } from "solid-js"
import { type KeyEvent, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { ScrollView } from "./scroll-view"
import { useMessages } from "../context/messages"
import { useSession } from "../context/session"
import { useSync } from "../context/sync"
import { ThinkingBlock } from "./thinking-block"
import { TaskView } from "./task-view"
import { NativeSubagentView } from "./native-subagent-view"
import { getSyntaxStyle } from "../theme"
import { colors } from "../theme/tokens"
import { HeaderBar } from "./header-bar"
import type { Block } from "../../../protocol/types"
import { hideCursor, showCursor, registerScrollToBottom } from "./input-area"
import { StreamingSpinner } from "./streaming-spinner"
import { type ViewLevel } from "./tool-view"
import { isMcpTool, parseMcpToolName } from "./mcp-tool-view"
import { BlockView } from "./block-view"
import { CollapsedToolGroup } from "./collapsed-tool-group"
import { EphemeralLine } from "./ephemeral-line"
import { ToastDisplay } from "./toast"
import { groupConsecutiveTools, isToolGroup, filterTodoWriteBlocks, type GroupedItem, type ToolGroup } from "../utils/tool-grouping"
import { TurnSummary } from "./turn-summary"
import { QueuedMessage } from "./blocks/queued-message"
import { TaskChecklist } from "./task-checklist"
import { createThrottledValue } from "../../../utils/throttled-value"

export type { ViewLevel }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check whether a scrollbox is at or near the bottom of its content */
function isNearBottom(ref: ScrollBoxRenderable, threshold = 3): boolean {
  const viewportHeight = ref.viewport.height
  return ref.scrollTop + viewportHeight >= ref.scrollHeight - threshold
}

/**
 * Hop "mode" — which set of blocks counts as a hop target.
 *
 *   - "any":            every user / assistant message is an anchor.
 *                       Default for the punctuation and Ctrl+Shift+J/K
 *                       bindings — turn-by-turn (every message)
 *                       navigation.
 *   - "turn-anchors":   each *turn* contributes up to two anchors —
 *                       its leading user message AND its trailing
 *                       assistant message (the last assistant block
 *                       before the next user message, or before
 *                       end-of-conversation for the final turn). Hops
 *                       the pattern user → end-of-turn reply → user →
 *                       end-of-turn reply → ... Intermediate assistant
 *                       blocks within a turn (e.g. a paragraph before
 *                       and after a tool use) are skipped, so a long
 *                       multi-tool turn collapses into one stop.
 */
export type HopMode = "any" | "turn-anchors"

/** A successful hop match: which direction, and which anchor set to use. */
export type HopMatch = { dir: "next" | "prev"; mode: HopMode }

/**
 * Map a keyboard event to a message-hop direction + anchor-set mode.
 *
 * Three accepted shapes:
 *   1. Ctrl+. / Ctrl+,                       — original "less / vim" punctuation.
 *                                              mode = "any".
 *   2. Ctrl+Shift+J / Ctrl+Shift+K           — vim-direction at the message
 *                                              granularity. mode = "any"
 *                                              (alias for shape 1).
 *   3. Ctrl+Shift+Cmd+J / Ctrl+Shift+Cmd+K   — vim-direction with Cmd as a
 *                                              "skip mid-turn replies" modifier.
 *                                              mode = "turn-anchors".
 *
 * The `<` / `>` punctuation pair (shape 1) is the conventional "prev / next
 * item" affordance from `less`, vim, browsers (Cmd+Shift+[ / ]) and YouTube
 * playback. Picked over Alt+N / Alt+P because macOS Option is a dead-key
 * compose by default — Alt+letter would force users to flip "Use Option as
 * Meta" in Terminal.app or "Esc+" mode in iTerm2.
 *
 * Shape 2 mirrors the per-line scroll bindings (Ctrl+J / Ctrl+K, vim
 * convention: j=down=next, k=up=prev) at the next granularity up — the same
 * visual relationship vim uses between j/k (line) and Ctrl+D/U (half-page).
 *
 * Shape 3 reuses the same vim-direction keys but layers Cmd on top to mean
 * "skip past the mid-turn noise" — each turn collapses to its user prompt
 * and its trailing assistant reply, so a long tool-heavy turn is one stop
 * instead of many. Cmd was the natural extra modifier given shapes 1/2
 * already own Ctrl alone and Ctrl+Shift; the choice also leans into the
 * "Cmd = higher-level / app-wide action" mental model from macOS Cmd+arrow.
 *
 * Disambiguation depends on the Kitty keyboard protocol (we enable it via
 * `useKittyKeyboard: {}` in app.tsx). Works on Ghostty / iTerm2 / WezTerm
 * / Kitty; on default Terminal.app the bindings silently no-op because
 * the terminal drops the Ctrl modifier on punctuation and on j/k.
 *
 * Pure helper so it's unit-testable without booting OpenTUI.
 */
export function matchMessageHopKey(
  event: Pick<KeyEvent, "name" | "ctrl" | "option" | "meta" | "super" | "shift">,
): HopMatch | null {
  // Shape 1 — Ctrl+. / Ctrl+,. Disallow shift / option / meta / super because
  // those select different glyphs (`<` / `>`) or are platform compose keys.
  if (
    event.ctrl &&
    !event.shift &&
    !event.option &&
    !event.meta &&
    !event.super
  ) {
    if (event.name === ".") return { dir: "next", mode: "any" }
    if (event.name === ",") return { dir: "prev", mode: "any" }
  }
  // Option is rejected for both shapes 2/3 (macOS dead-key compose).
  if (event.ctrl && event.shift && !event.option) {
    // Shape 3 — Cmd held → turn-anchor skip mode.
    // (macOS Cmd → super under Kitty protocol; Linux/Win Cmd-equivalent → meta.)
    if (event.meta || event.super) {
      if (event.name === "j") return { dir: "next", mode: "turn-anchors" }
      if (event.name === "k") return { dir: "prev", mode: "turn-anchors" }
    } else {
      // Shape 2 — Ctrl+Shift+J/K (no Cmd) → plain "any" hop.
      if (event.name === "j") return { dir: "next", mode: "any" }
      if (event.name === "k") return { dir: "prev", mode: "any" }
    }
  }
  return null
}

/**
 * Pick the next/previous message-hop target relative to the current viewport.
 *
 * Inputs are the y-offsets of all message anchors (in render order) and the
 * viewport's top y. Returns:
 *   - `{ kind: "anchor", y }` — scroll so this anchor lands at the top.
 *   - `{ kind: "edge" }`     — already past the boundary; caller scrolls to
 *                              the very top (prev) or very bottom (next).
 *   - `null`                  — no anchors at all (empty conversation).
 *
 * The 1-cell tolerance avoids no-op hops when the current anchor is already
 * exactly at the viewport top (a hop would otherwise re-target itself).
 *
 * Pure so it's unit-testable without an OpenTUI render context.
 */
export function pickMessageHopTarget(
  anchorYs: readonly number[],
  viewportY: number,
  dir: "next" | "prev",
): { kind: "anchor"; y: number } | { kind: "edge" } | null {
  if (anchorYs.length === 0) return null
  const sorted = [...anchorYs].sort((a, b) => a - b)
  if (dir === "prev") {
    for (let i = sorted.length - 1; i >= 0; i--) {
      const y = sorted[i]
      if (y !== undefined && y < viewportY - 1) return { kind: "anchor", y }
    }
    return { kind: "edge" }
  }
  for (const y of sorted) {
    if (y > viewportY + 1) return { kind: "anchor", y }
  }
  return { kind: "edge" }
}

/** Stable id for the wrapper box around a top-level user/assistant block.
 *  Looked up at hop-time via `scrollboxRef.findDescendantById(...)`. */
const messageAnchorId = (index: number) => `bantai-msg-anchor-${index}`

/** Whether a Block is a top-level "message" — user or assistant. Tool calls,
 *  tool results, thinking blocks, system, compact, shell, error, plan, and
 *  resume-summary blocks are noise between turns and are skipped. */
function isMessageBlock(b: Block): boolean {
  return b.type === "user" || b.type === "assistant"
}

/**
 * Pick hop anchor indices for "any" mode (Ctrl+,/. and Ctrl+Shift+J/K):
 * every user-or-assistant block in `grouped()` order. Tool groups, tools,
 * thinking, system, compact, shell, error, plan, and resume-summary blocks
 * are skipped (they're noise between turns).
 *
 * Pure helper so it's unit-testable without booting OpenTUI / SolidJS.
 */
export function pickAllMessageHopIndices(
  items: ReadonlyArray<Block | ToolGroup | undefined>,
): number[] {
  const out: number[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it === undefined || isToolGroup(it)) continue
    if (isMessageBlock(it as Block)) out.push(i)
  }
  return out
}

/**
 * Pick hop anchor indices for "turn-anchors" mode: each *turn* contributes
 * up to two anchors — its leading user message AND its trailing assistant
 * message (the last assistant block before the next user message, or before
 * end-of-conversation for the final turn).
 *
 * The traversal pattern this produces:
 *
 *     user₁ → asst₁_last → user₂ → asst₂_last → user₃ → asst₃_last → …
 *
 * Intermediate assistant blocks within a turn (e.g. if the model emitted
 * text, then a tool, then more text — the reducer represents that as
 * multiple consecutive `assistant` blocks) are skipped. Tool groups,
 * thinking, system, compact, shell, error, plan, and resume-summary blocks
 * are skipped as well — same as the "any" mode.
 *
 * Edge cases:
 *
 *   - Leading assistant blocks before any user message (e.g. a synthetic
 *     "Resumed session" block from the resume flow) are NOT anchored —
 *     they don't belong to any user-led turn. The first anchor is always
 *     the first user message.
 *   - A turn whose assistant response hasn't started yet (just the user
 *     message, no following assistant) contributes only the user anchor.
 *   - The very last turn's trailing assistant IS anchored, even though
 *     there's no following user message — it's the "final answer" of the
 *     conversation.
 *
 * Receives the items in the same shape `grouped()` produces: a mixed array
 * of `Block` and `ToolGroup`. Returns indices into that array, ascending
 * (so it can be consumed identically to `pickAllMessageHopIndices`).
 *
 * Pure helper so it's unit-testable without booting OpenTUI / SolidJS.
 */
export function pickTurnAnchorHopIndices(
  items: ReadonlyArray<Block | ToolGroup | undefined>,
): number[] {
  const out: number[] = []
  // Index of the most recent assistant block seen *within the current
  // turn* (i.e. since the last user message). Flushed onto `out` when the
  // next user message starts a new turn, or at end-of-loop for the final
  // turn's trailing assistant.
  let pendingAssistantIdx: number | null = null
  let seenUser = false
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it === undefined || isToolGroup(it)) continue
    const block = it as Block
    if (block.type === "user") {
      // Close out the previous turn (if any) by flushing its trailing
      // assistant. The first user message has nothing to flush — it
      // opens turn 1.
      if (seenUser && pendingAssistantIdx !== null) {
        out.push(pendingAssistantIdx)
      }
      out.push(i)
      seenUser = true
      pendingAssistantIdx = null
    } else if (block.type === "assistant") {
      // Only track assistants that follow at least one user message —
      // pre-user "leading" assistant blocks (e.g. resume-banner synthetic
      // text) don't belong to any user-led turn.
      if (seenUser) pendingAssistantIdx = i
    }
  }
  // Flush the final turn's trailing assistant (the "final answer").
  if (seenUser && pendingAssistantIdx !== null) out.push(pendingAssistantIdx)
  return out
}

// ---------------------------------------------------------------------------
// ConversationView — main export
// ---------------------------------------------------------------------------

export function ConversationView(props: { children?: JSX.Element; footerHint?: string | null }) {
  const { state } = useMessages()
  const { state: session } = useSession()
  const { switchProgress } = useSync()
  const [viewLevel, setViewLevel] = createSignal<ViewLevel>("collapsed")
  const [showThinking, setShowThinking] = createSignal(true)
  const [viewLevelHint, setViewLevelHint] = createSignal<string | null>(null)
  let viewLevelHintTimer: ReturnType<typeof setTimeout> | undefined
  let scrollboxRef: ScrollBoxRenderable | undefined
  const [userScrolledAway, setUserScrolledAway] = createSignal(false)

  // Helper: sync userScrolledAway and cursor visibility.
  // stickyScroll is reactively bound in JSX via !userScrolledAway().
  const setScrolledAway = (away: boolean) => {
    setUserScrolledAway(away)
    if (away) hideCursor()
    else showCursor()
  }

  // --- Memo chain: store → committed → grouped → prevTypes ---
  // Each stage is a separate memo. Items are never wrapped in new objects —
  // store proxies pass through with stable identity (via reconcile() in sync).
  // Matches OpenCode's filtered → grouped → flat → selected pattern.

  // Stage 1: Filter out queued user blocks.
  // TodoWrite is rendered as a standalone TaskChecklist panel, not inline.
  const committed = createMemo(() =>
    filterTodoWriteBlocks(state.blocks.filter(b => !(b.type === "user" && b.queued)))
  )
  const queuedBlocks = createMemo(() =>
    state.blocks.filter(b => b.type === "user" && b.queued) as Array<Extract<Block, { type: "user" }>>
  )

  // Stage 2: Group consecutive collapsible tools (collapsed view only)
  const grouped = createMemo((): GroupedItem[] =>
    viewLevel() !== "collapsed" ? committed() : groupConsecutiveTools(committed())
  )

  // Stage 3: Pre-compute prevType for each position (separate parallel array).
  // Read inside <Index> callback for margin logic — safe because it's a
  // separate memo from the list, no dual-update with reconciliation.
  const prevTypes = createMemo(() =>
    grouped().map((_item, i) => {
      const prev = i > 0 ? grouped()[i - 1] : undefined
      return prev ? (isToolGroup(prev) ? "tool" : (prev as Block).type) : undefined
    })
  )

  // Hop anchor sets are computed on demand in the keypress handler (see
  // `pickAllMessageHopIndices` and `pickTurnAnchorHopIndices` above the
  // component). No memo wrappers: SolidJS's `createMemo` is eager, so a
  // memo here would recompute on every grouped() invalidation (every
  // streaming text_delta, turn_start, turn_complete, …) but the result is
  // only ever read on a Ctrl+,/. or Ctrl+Shift+(Cmd+)J/K keypress —
  // ~100x more recomputes than reads. Computing in the handler is O(n)
  // over grouped() per keypress; n is small (50–500 items in long
  // conversations), so this is microseconds — and we trade the wasted
  // streaming-time recomputes for a single computation per actual hop.

  // Line-buffered streaming text: only show text up to the last newline.
  // Hides the in-progress partial line so text streams line-by-line, not
  // char-by-char. This prevents layout reflow jitter (partial lines constantly
  // change width), markdown mis-parsing of incomplete lines, and gives a
  // polished visual cadence. Same approach as Claude Code (REPL.tsx).
  const lineBufferedText = createMemo(() => {
    const raw = state.streamingText
    if (!raw) return null
    const lastNewline = raw.lastIndexOf("\n")
    if (lastNewline === -1) return null // No complete line yet
    return raw.substring(0, lastNewline + 1) || null
  })

  // Render throttle: decouple state-update rate (16ms) from visual-update
  // rate (~100ms). Prevents intermediate states that flash for <100ms from
  // ever being painted. Same approach as OpenCode (message-part.tsx).
  const visibleStreamingText = createThrottledValue<string | null>(() => lineBufferedText())
  const visibleThinking = createThrottledValue<string>(() => state.streamingThinking)

  // Split active tasks: native subagents get their own component, backend tasks use TaskView
  const orphanTasks = createMemo((): [string, import("../../../protocol/types").TaskInfo][] => {
    const tasks = state.activeTasks
    if (tasks.length === 0) return []
    // Collect all Agent tool block IDs
    const agentToolIds = new Set<string>()
    for (const b of state.blocks) {
      if (b.type === "tool" && b.tool === "Agent") {
        agentToolIds.add(b.id)
      }
    }
    return tasks.filter(([, task]) => {
      // Skip tasks correlated with an Agent tool block
      if (task.toolUseId && agentToolIds.has(task.toolUseId)) return false
      // Skip native subagents — they have their own view
      if (task.source === "native") return false
      return true
    })
  })

  // Native subagent tasks — rendered by NativeSubagentView with distinct styling
  const nativeSubagentTasks = createMemo((): [string, import("../../../protocol/types").TaskInfo][] => {
    const tasks = state.activeTasks
    if (tasks.length === 0) return []
    return tasks.filter(([, task]) => task.source === "native")
  })

  // -- Turn elapsed time for the spinner --
  const [turnStartTime, setTurnStartTime] = createSignal<number | null>(null)
  const [turnElapsed, setTurnElapsed] = createSignal(0)
  let prevSessionState: string = session.sessionState

  const turnTickHandle = setInterval(() => {
    const currentState = session.sessionState
    // Detect transition into RUNNING
    if (currentState === "RUNNING" && prevSessionState !== "RUNNING") {
      setTurnStartTime(Date.now())
      setTurnElapsed(0)
    }
    // Detect transition out of RUNNING
    if (currentState !== "RUNNING" && prevSessionState === "RUNNING") {
      setTurnStartTime(null)
      setTurnElapsed(0)
    }
    prevSessionState = currentState
    // Update elapsed while running
    if (currentState === "RUNNING") {
      const start = turnStartTime()
      if (start !== null) {
        setTurnElapsed(Math.floor((Date.now() - start) / 1000))
      }
    }
  }, 1000)

  onCleanup(() => clearInterval(turnTickHandle))

  // Spinner label — fallback order matches Claude Code (spec §5.1):
  //   1. In-progress todo's activeForm (if any)
  //   2. Last running tool from blocks
  //   3. "Thinking…"
  // Uses the single-char ellipsis (U+2026) to match Claude Code's Spinner.
  const spinnerLabel = () => {
    const todos = state.todos
    for (const t of todos) {
      if (t.status === "in_progress" && t.activeForm && t.activeForm.length > 0) {
        return `${t.activeForm}\u2026`
      }
    }
    const blocks = state.blocks
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b !== undefined && b.type === "tool" && b.status === "running") {
        if (isMcpTool(b.tool)) {
          const parsed = parseMcpToolName(b.tool)
          return `Running ${parsed.server} \u203A ${parsed.tool.replace(/_/g, " ")}\u2026`
        }
        return `Running ${b.tool}\u2026`
      }
    }
    return "Thinking\u2026"
  }

  // Reactive accessor: whether the inline spinner block is currently rendered.
  // Used to pick which TaskChecklist variant (inline vs standalone) shows, so
  // the checklist stays visible continuously — including mid-stream — instead
  // of flashing out each time assistant text streams in. Matches Claude Code.
  const spinnerVisible = () =>
    session.sessionState === "RUNNING" &&
    !state.backgrounded &&
    !state.streamingText

  // Auto-scroll to bottom when permission/elicitation dialog appears
  // so the user can see and interact with it immediately.
  // Uses queueMicrotask to defer until after the current reactive pass
  // completes, avoiding the race between a 50ms setTimeout and layout
  // recalculation that caused visual jumps.
  createEffect(() => {
    const s = session.sessionState
    if (s === "WAITING_FOR_PERM" || s === "WAITING_FOR_ELIC") {
      setScrolledAway(false)
      queueMicrotask(() => scrollboxRef?.scrollBy(999999))
    }
  })

  // View-level notification helper — transient hint, not a permanent message
  const showViewLevelHint = (level: ViewLevel) => {
    const text = level === "collapsed"
      ? "Showing collapsed view · ctrl+o to expand · ctrl+e to show all"
      : level === "expanded"
      ? "Showing detailed transcript · ctrl+o to toggle · ctrl+e to show all"
      : "Showing detailed transcript · ctrl+o to toggle · ctrl+e to collapse"
    setViewLevelHint(text)
    clearTimeout(viewLevelHintTimer)
    viewLevelHintTimer = setTimeout(() => setViewLevelHint(null), 3000)
  }
  onCleanup(() => clearTimeout(viewLevelHintTimer))

  // Ctrl+O toggles collapsed/expanded, Ctrl+Shift+E shows all, Ctrl+Shift+T toggles thinking
  // (Ctrl+E and Ctrl+T freed for Emacs end-of-line and transpose-chars)
  // Ctrl+Up/Down scrolls line-by-line.
  // Ctrl+, / Ctrl+. hop to previous / next user-or-assistant message boundary
  // (`<` / `>` "prev / next item" idiom from less, vim, browsers).
  useKeyboard((event) => {
    if (event.ctrl && event.name === "o") {
      event.preventDefault()
      const next: ViewLevel = viewLevel() === "collapsed" ? "expanded" : "collapsed"
      // Snapshot whether the user was at the bottom before the content
      // height changes. After layout recalculates, re-anchor to bottom
      // so the viewport doesn't jump to earlier messages.
      const wasAtBottom = !userScrolledAway() || (scrollboxRef ? isNearBottom(scrollboxRef) : false)
      // Batch both signal updates so the block list and hint re-render
      // in a single reactive pass, preventing a flash between states.
      batch(() => {
        setViewLevel(next)
        showViewLevelHint(next)
      })
      if (wasAtBottom) {
        queueMicrotask(() => scrollboxRef?.scrollBy(999999))
      }
    }
    if (event.ctrl && event.shift && event.name === "e") {
      event.preventDefault()
      const next: ViewLevel = viewLevel() === "show_all" ? "collapsed" : "show_all"
      const wasAtBottom = !userScrolledAway() || (scrollboxRef ? isNearBottom(scrollboxRef) : false)
      batch(() => {
        setViewLevel(next)
        showViewLevelHint(next)
      })
      if (wasAtBottom) {
        queueMicrotask(() => scrollboxRef?.scrollBy(999999))
      }
    }
    if (event.ctrl && event.shift && event.name === "t") {
      event.preventDefault()
      const next = !showThinking()
      const wasAtBottom = !userScrolledAway() || (scrollboxRef ? isNearBottom(scrollboxRef) : false)
      batch(() => {
        setShowThinking(next)
        const text = next ? "Thinking: visible" : "Thinking: hidden"
        setViewLevelHint(text)
      })
      clearTimeout(viewLevelHintTimer)
      viewLevelHintTimer = setTimeout(() => setViewLevelHint(null), 2000)
      if (wasAtBottom) {
        queueMicrotask(() => scrollboxRef?.scrollBy(999999))
      }
    }
    // Conversation scroll — Ctrl+J (down) / Ctrl+K (up), vim convention.
    //
    // Plain Ctrl (no shift / option / meta / super); Ctrl+Shift+J/K is
    // reserved for the message-hop binding below (one granularity up).
    //
    // We rely on this handler running BEFORE the focused textarea's
    // renderable handlers (OpenTUI dispatches global `useKeyboard` listeners
    // first, then renderable handlers). `event.preventDefault()` here stops
    // the textarea's built-in Ctrl+K → delete-to-line-end and any
    // Ctrl+J → newline interpretation in one step. Disambiguation requires
    // the Kitty keyboard protocol (enabled in app.tsx); on plain Terminal.app
    // these bindings silently no-op (Ctrl+J arrives as a `linefeed` event).
    if (
      event.ctrl &&
      !event.shift &&
      !event.option &&
      !event.meta &&
      !event.super &&
      event.name === "k"
    ) {
      event.preventDefault()
      scrollboxRef?.scrollBy(-1)
      setScrolledAway(true)
    }
    if (
      event.ctrl &&
      !event.shift &&
      !event.option &&
      !event.meta &&
      !event.super &&
      event.name === "j"
    ) {
      event.preventDefault()
      scrollboxRef?.scrollBy(1)
      if (scrollboxRef && isNearBottom(scrollboxRef)) {
        setScrolledAway(false)
      }
    }

    // Conversation message hop — Ctrl+, / Ctrl+. (the `<` / `>` "prev /
    // next item" idiom from less, vim, browsers).
    // Jumps to the next / previous user-or-assistant turn boundary, skipping
    // tool calls, tool results, and thinking blocks.
    //
    // Boundary handling:
    //   - Ctrl+, past the first message → scroll to the very top.
    //   - Ctrl+. past the last message  → scroll to the bottom AND re-engage
    //     sticky-bottom (the "I'm caught up, follow streaming" state).
    //   - Empty conversation             → no-op (pickMessageHopTarget → null).
    //
    // Anchor lookup: each grouped() item is wrapped in a `<box id={...}>`
    // (see the Index callback below). We resolve the y-offset of each
    // message-type wrapper at hop-time, so the math is independent of view
    // level (collapsed / expanded / show_all) — the user-or-assistant block
    // identity is what's invariant, not the rendered noise around it.
    const hop = matchMessageHopKey(event)
    if (hop !== null && scrollboxRef) {
      event.preventDefault()
      // Mode picks the anchor set: "any" hops every user/assistant message;
      // "turn-anchors" hops user msgs + each turn's trailing assistant
      // (Ctrl+Shift+Cmd+J/K — skip mid-turn replies). Computed on the spot
      // — see the comment near the top of the component for why these
      // aren't memos.
      const items = grouped()
      const idxs = hop.mode === "turn-anchors"
        ? pickTurnAnchorHopIndices(items)
        : pickAllMessageHopIndices(items)
      const anchorYs: number[] = []
      for (const i of idxs) {
        const el = scrollboxRef.findDescendantById(messageAnchorId(i))
        if (el) anchorYs.push(el.y)
      }
      const target = pickMessageHopTarget(anchorYs, scrollboxRef.viewport.y, hop.dir)
      if (target === null) {
        // Empty conversation — nothing to hop to.
      } else if (target.kind === "edge" && hop.dir === "prev") {
        // At/above the first message — scroll to the very top.
        scrollboxRef.scrollTo(0)
        setScrolledAway(true)
      } else if (target.kind === "edge" && hop.dir === "next") {
        // At/below the last message — scroll to the bottom and re-engage
        // sticky-bottom if we land within the near-bottom threshold.
        scrollboxRef.scrollBy({ x: 0, y: 999999 })
        if (isNearBottom(scrollboxRef)) {
          setScrolledAway(false)
        }
      } else if (target.kind === "anchor") {
        // Top-align the target: shift the viewport by the anchor's offset
        // relative to the current viewport top. Lands the next item at (or
        // near) the top of the visible area.
        scrollboxRef.scrollBy({ x: 0, y: target.y - scrollboxRef.viewport.y })
        // Sticky-bottom: if top-aligning the anchor still leaves us within
        // the near-bottom threshold (short tail content), re-engage sticky
        // so streaming text continues to follow. Otherwise treat the hop as
        // a deliberate move-away (mirrors Ctrl+Up's behaviour).
        if (hop.dir === "next" && isNearBottom(scrollboxRef)) {
          setScrolledAway(false)
        } else {
          setScrolledAway(true)
        }
      }
    }

    // Auto-scroll to bottom and refocus on any printable input while scrolled away.
    // Modifier-key combos (Ctrl/Alt/Cmd+<key>) are NOT typed input — they're
    // shortcuts (e.g. Cmd+C to copy a selection) and must not re-engage sticky
    // scroll. In the Kitty keyboard protocol, macOS Cmd maps to `super`, so we
    // must exclude both `meta` and `super` to keep copy from jumping the view.
    if (
      userScrolledAway() &&
      !event.ctrl &&
      !event.option &&
      !event.meta &&
      !event.super &&
      event.name.length === 1
    ) {
      scrollboxRef?.scrollBy(999999)
      setScrolledAway(false)
      // Don't preventDefault — let the keystroke reach the textarea
    }
  })

  // Scroll change handler — passed to ScrollView's onScroll callback.
  // Tracks user scroll-away state for sticky scroll and cursor visibility.
  const handleScroll = (el: ScrollBoxRenderable) => {
    if (isNearBottom(el)) {
      // At bottom: likely auto-scroll. If user was scrolled away, snap back.
      if (userScrolledAway()) setScrolledAway(false)
    } else if (!userScrolledAway()) {
      // Scrolled away from bottom — user-initiated (mouse wheel)
      setScrolledAway(true)
    }
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <ScrollView ref={(el: ScrollBoxRenderable) => { scrollboxRef = el; registerScrollToBottom(() => { setScrolledAway(false); queueMicrotask(() => el.scrollBy(999999)) }) }} stickyScroll={!userScrolledAway()} stickyStart="bottom" onScroll={handleScroll} flexGrow={1} backgroundColor={colors.bg.primary}>
        <box flexDirection="column" paddingRight={1} minHeight="100%" backgroundColor={colors.bg.primary}>
          {/* Header bar — scrolls with content */}
          <HeaderBar />

          {/*
            IMPORTANT: Every dynamic section (<For>, <Show>) is wrapped in a
            stable <box> so the parent layout always has a fixed set of children.
            Without wrappers, SolidJS's reactive primitives dynamically
            insert/remove direct children and OpenTUI's Zig layout engine can
            place them at the wrong position (e.g., streaming text above committed
            blocks instead of below).
          */}

          {/* Quick-start tips — shown when conversation is empty */}
          <box flexDirection="column">
            <Show when={committed().length === 0 && !state.streamingText}>
              <box flexDirection="column" paddingLeft={2} marginTop={1}>
                <text fg={colors.text.muted}>
                  {"Tips to get started:"}
                </text>
                <box marginTop={1} flexDirection="column">
                  <text fg={colors.text.secondary}>{"  \u2022  Ask a question or describe a task"}</text>
                  <text fg={colors.text.secondary}>{"  \u2022  Use @ to reference files: @src/index.ts"}</text>
                  <text fg={colors.text.secondary}>{"  \u2022  Type / for slash commands"}</text>
                  <text fg={colors.text.secondary}>{"  \u2022  Ctrl+O to expand tool details"}</text>
                  <text fg={colors.text.secondary}>{"  \u2022  Ctrl+Shift+P to switch models"}</text>
                </box>
              </box>
            </Show>
          </box>

          {/* Committed blocks (non-queued) — each block renders itself based on view level.
              In collapsed view, consecutive collapsible tools are merged into
              a single CollapsedToolGroup summary line.

              Each item is wrapped in a `<box id={...}>` so Ctrl+, / Ctrl+. can
              find user/assistant message boundaries via
              `scrollboxRef.findDescendantById(messageAnchorId(index))`. The id
              is purely a function of position (Index keys positionally) — the
              hop logic only consults wrappers whose underlying block is a
              user-or-assistant message (see `pickAllMessageHopIndices` and
              `pickTurnAnchorHopIndices`). */}
          <box flexDirection="column">
            <Index each={grouped()}>
              {(item, index) => {
                // <Index> tracks by position. Items are unwrapped store proxies
                // (stable via reconcile()). prevTypes is a separate parallel memo
                // — no reactive coupling with the list reconciliation.
                const pt = () => prevTypes()[index]
                return (
                  <box id={messageAnchorId(index)} flexDirection="column">
                    <Show
                      when={!isToolGroup(item()) && item()}
                      fallback={
                        <box marginTop={pt() !== "tool" ? 1 : 0}>
                          <CollapsedToolGroup group={item() as ToolGroup} />
                        </box>
                      }
                    >
                      <BlockView
                        block={item() as Block}
                        viewLevel={viewLevel()}
                        prevType={pt()}
                        showThinking={showThinking()}
                      />
                    </Show>
                  </box>
                )
              }}
            </Index>
          </box>

          {/* Turn epilogue — files changed + "Baked for X · Y tokens · $Z"
              line, shown when IDLE and the reducer captured something worth
              rendering for the last turn. The component decides which of the
              two sub-sections to show; both are optional and a missing
              backend field hides the corresponding part rather than
              synthesising it. */}
          <box flexDirection="column">
            <Show when={session.sessionState === "IDLE" && (state.lastTurnFiles || state.lastTurnSummary)}>
              <TurnSummary files={state.lastTurnFiles} summary={state.lastTurnSummary} />
            </Show>
          </box>

          {/* Streaming thinking (transient) — hidden when backgrounded, collapsed view, or thinking toggle off */}
          <box flexDirection="column">
            <Show when={!state.backgrounded && showThinking() && visibleThinking() && viewLevel() !== "collapsed"}>
              <box marginTop={1}>
                <ThinkingBlock text={visibleThinking()} collapsed={false} />
              </box>
            </Show>
          </box>

          {/* Streaming text (transient) — hidden when backgrounded.
              Uses visible={false} instead of <Show> to avoid destroying/recreating
              the <markdown> component at flush boundaries (tool_use_start,
              text_complete, turn_complete). Destroying forces all internal
              CodeRenderable sub-blocks to re-highlight from scratch, leaving
              text invisible for 1+ frames while async tree-sitter completes. */}
          <box flexDirection="column">
            <box flexDirection="row" marginTop={1} visible={!state.backgrounded && !!visibleStreamingText()}>
              <box width={2} flexShrink={0}>
                <text fg={colors.text.primary}>{"\u23FA"}</text>
              </box>
              <box flexGrow={1}>
                <markdown content={visibleStreamingText() ?? undefined} syntaxStyle={getSyntaxStyle()} streaming={true} fg={colors.text.primary} bg={colors.bg.primary} />
              </box>
            </box>
          </box>

          {/* Queued user messages (muted, after streaming) */}
          <box flexDirection="column">
            <For each={queuedBlocks()}>
              {(block) => <QueuedMessage block={block} />}
            </For>
          </box>

          {/* Transient view-level hint — replaces itself, auto-clears after 3s.
              Wrapped in Show so it takes 0 space when empty — the spinner's
              marginTop={1} provides the single blank-line gap. */}
          <Show when={viewLevelHint()}>
            <EphemeralLine message={viewLevelHint()} />
          </Show>

          {/* Background task indicator — compact single-line when backgrounded */}
          <box flexDirection="column">
            <Show when={state.backgrounded && session.sessionState === "RUNNING"}>
              <box marginTop={1} paddingLeft={2} flexDirection="row">
                <StreamingSpinner label={"Running in background..."} elapsedSeconds={turnElapsed()} outputTokens={state.streamingOutputTokens || session.cost.outputTokens} />
              </box>
            </Show>
          </box>

          {/* Spinner — visible during RUNNING when there's no other visual activity.
              Hidden while text is actively streaming since that already signals progress.
              Inline TaskChecklist sits directly below the spinner during active runs.
              `sessionActive` defers the 5s all-completed auto-hide until the
              session returns to IDLE, so users keep task context during
              ongoing work even when the agent doesn't re-emit TodoWrite. */}
          <box flexDirection="column">
            <Show when={spinnerVisible()}>
              <box marginTop={1} paddingLeft={2} flexDirection="column">
                <StreamingSpinner label={spinnerLabel()} elapsedSeconds={turnElapsed()} outputTokens={state.streamingOutputTokens || session.cost.outputTokens} />
                <Show when={state.todos.length > 0}>
                  <TaskChecklist
                    todos={state.todos}
                    sessionActive={session.sessionState !== "IDLE"}
                  />
                </Show>
              </box>
            </Show>
          </box>

          {/* Standalone TaskChecklist — shown whenever the inline spinner is
              NOT rendered but todos exist: mid-stream, during permission
              dialogs, while backgrounded, and while idle. Keeps the checklist
              visible continuously, matching Claude Code. */}
          <box flexDirection="column">
            <Show when={!spinnerVisible() && state.todos.length > 0}>
              <TaskChecklist
                todos={state.todos}
                isStandalone={true}
                sessionActive={session.sessionState !== "IDLE"}
              />
            </Show>
          </box>

          {/* Switch-in-progress spinner — shown while /switch is mid-swap.
              Reuses StreamingSpinner for visual consistency; its label
              updates from sync.tsx as phases transition ("Starting Codex...",
              "Staged conversation history...", etc.). Clears the instant
              switchBackend() resolves. Fixes bug #5 — no user-visible
              progress during post-switch init. */}
          <box flexDirection="column">
            <Show when={switchProgress()}>
              <box marginTop={1} paddingLeft={2}>
                <StreamingSpinner label={switchProgress()?.phase ?? ""} />
              </box>
            </Show>
          </box>

          {/* Native subagents — cross-backend, visually distinct from backend tasks */}
          <box flexDirection="column">
            <Show when={nativeSubagentTasks().length > 0}>
              <NativeSubagentView tasks={nativeSubagentTasks()} />
            </Show>
          </box>

          {/* Background tasks / subagents — only show tasks NOT already
              rendered inline by AgentToolView (those with a matching tool block) */}
          <box flexDirection="column">
            <Show when={orphanTasks().length > 0}>
              <TaskView tasks={orphanTasks()} />
            </Show>
          </box>

          {/* Spacer — pushes footer to bottom when content is short.
              Combined with minHeight="100%" on the parent, this ensures
              the input area stays at the bottom of the viewport until
              conversation content pushes it further down — then scrolling
              up moves everything (including the input) off-screen. */}
          <box flexGrow={1} />

          {/* Toast notifications — above input area */}
          <box flexDirection="column" flexShrink={0}>
            <ToastDisplay />
          </box>

          {/* Ephemeral hint line — always 1 row tall, sits between content and input */}
          <EphemeralLine message={props.footerHint} />

          {/* Input area, status bar, dialogs — scrolls with content */}
          <box flexDirection="column" flexShrink={0} paddingBottom={1}>
            {props.children}
          </box>
        </box>
      </ScrollView>
    </box>
  )
}
