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
import { type ScrollBoxRenderable } from "@opentui/core"
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
  // Ctrl+Up/Down scrolls the conversation
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
    if (event.ctrl && event.name === "up") {
      event.preventDefault()
      scrollboxRef?.scrollBy(-3)
      setScrolledAway(true)
    }
    if (event.ctrl && event.name === "down") {
      event.preventDefault()
      scrollboxRef?.scrollBy(3)
      if (scrollboxRef && isNearBottom(scrollboxRef)) {
        setScrolledAway(false)
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
              a single CollapsedToolGroup summary line. */}
          <box flexDirection="column">
            <Index each={grouped()}>
              {(item, index) => {
                // <Index> tracks by position. Items are unwrapped store proxies
                // (stable via reconcile()). prevTypes is a separate parallel memo
                // — no reactive coupling with the list reconciliation.
                const pt = () => prevTypes()[index]
                return (
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
                )
              }}
            </Index>
          </box>

          {/* Turn file change summary — shown when IDLE and files were changed */}
          <box flexDirection="column">
            <Show when={session.sessionState === "IDLE" && state.lastTurnFiles}>
              <TurnSummary files={state.lastTurnFiles!} />
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
              Inline TaskChecklist sits directly below the spinner during active runs. */}
          <box flexDirection="column">
            <Show when={spinnerVisible()}>
              <box marginTop={1} paddingLeft={2} flexDirection="column">
                <StreamingSpinner label={spinnerLabel()} elapsedSeconds={turnElapsed()} outputTokens={state.streamingOutputTokens || session.cost.outputTokens} />
                <Show when={state.todos.length > 0}>
                  <TaskChecklist todos={state.todos} />
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
              <TaskChecklist todos={state.todos} isStandalone={true} />
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
