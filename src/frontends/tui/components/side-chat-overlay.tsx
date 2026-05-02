/**
 * SideChatOverlay — transient `/btw` overlay for side chat.
 *
 * Floats a single-tab Q&A box over the conversation pane. Streams the
 * answer from `backend.sideQuery()` into a parallel ephemeral store —
 * NEVER reduces into main `ConversationState`, NEVER persists to JSONL.
 *
 * Layout (post-feedback, 2026-05):
 *   - Banner rows merge the title / dismiss-hint with the horizontal rule
 *     onto a single row each (no more title-on-top / divider-below split,
 *     no blank padding above the title or below the footer).
 *   - The answer body is independently scrollable via `<ScrollView>` so
 *     long answers don't push the dismiss footer off-screen.
 *   - The view is strictly text-only: tool_use_* and permission_request
 *     events are dropped with a warn (the Claude adapter already filters
 *     them upstream, but the component is the second guard); thinking
 *     content is not accumulated or rendered — the side chat view shows
 *     the assistant's reply text and nothing else.
 *
 * MVP scope (per team/backlog/side-chat-overlay.md MVP):
 *   - Single overlay (no tabs); architecture leaves Map<id, …> room for tabs.
 *   - `Esc` cancels the in-flight side turn AND dismisses the overlay in one
 *     keystroke.
 *   - Reuses the `<markdown>` renderer; no parallel renderer.
 *   - Cleanup-on-unmount: aborts the AbortController, which the Claude
 *     adapter's sideQuery() finally-block uses to close the SDK fork query
 *     and unlink the forked JSONL.
 *
 * Lives under `frontends/tui/components/` next to permission-dialog.tsx —
 * the closest reference for an inline conversation-pane overlay.
 */

import {
  createSignal,
  createEffect,
  onCleanup,
  Show,
  batch,
  type Accessor,
} from "solid-js"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { colors } from "../theme/tokens"
import { getSyntaxStyle } from "../theme/syntax"
import { ScrollView } from "./scroll-view"
import type { AgentBackend } from "../../../protocol/types"
import { log } from "../../../utils/logger"

// ---------------------------------------------------------------------------
// Side-chat store — module-level signals so the frontend bridge can drive
// open/close from outside the component tree. A Map keyed by an internal id
// is overkill for the single-overlay MVP, but the shape is left intact so
// multi-tab support can drop in without touching the bridge contract.
// ---------------------------------------------------------------------------

export interface SideChatTab {
  id: string
  question: string
  /** Streamed answer chunks accumulated in order. */
  answer: string
  status: "running" | "done" | "error" | "aborted"
  error?: string
}

const [activeTab, setActiveTab] = createSignal<SideChatTab | null>(null)

/** True when the overlay should render. */
export function isSideChatOpen(): boolean {
  return activeTab() !== null
}

let activeAbort: AbortController | null = null

/**
 * Open the overlay with a question and start the backend.sideQuery stream.
 * Returns false if the backend doesn't expose sideQuery — the /btw command
 * already gates on this, but the second guard keeps callers honest.
 */
export function openSideChatOverlay(
  backend: AgentBackend,
  question: string,
): boolean {
  if (typeof backend.sideQuery !== "function") return false

  // Tear down any prior in-flight side turn before starting a new one.
  closeSideChatOverlay("replaced")

  const id = `side-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const controller = new AbortController()
  activeAbort = controller

  setActiveTab({
    id,
    question,
    answer: "",
    status: "running",
  })

  log.debug("side chat: opening overlay", { id, questionChars: question.length })

  // Drive the stream in the background. Mutations stay inside batch()
  // so the renderer only repaints once per micro-batch.
  void (async () => {
    try {
      // sideQuery's AsyncIterable type is checked by the early return above,
      // but TS narrows lost across the async boundary; assert non-null.
      const stream = backend.sideQuery!(question, { signal: controller.signal })
      for await (const event of stream) {
        if (controller.signal.aborted) break
        const tab = activeTab()
        // The user may have closed the overlay; if so the tab is null and
        // we should silently drain the stream until it ends.
        if (!tab || tab.id !== id) continue
        switch (event.type) {
          case "text_delta":
            batch(() => {
              setActiveTab({ ...tab, answer: tab.answer + event.text })
            })
            break
          case "thinking_delta":
            // Side chat is strictly text-only — thinking content is never
            // surfaced to the user. The Claude adapter still emits these
            // events for parity with the main turn shape; we drop them at
            // the component as the second guard. Logged at debug so a
            // future regression is traceable.
            log.debug("side chat: dropping thinking_delta", {
              chars: event.text?.length ?? 0,
            })
            break
          case "turn_start":
            // Already in "running" — nothing to do.
            break
          case "turn_complete":
            batch(() => {
              setActiveTab({ ...tab, status: "done" })
            })
            break
          case "error":
            batch(() => {
              setActiveTab({
                ...tab,
                status: "error",
                error: event.message,
              })
            })
            break
          case "permission_request":
          case "tool_use_start":
          case "tool_use_progress":
          case "tool_use_end":
            // The Claude adapter's sideQuery() runs the fork in dontAsk
            // mode with an empty allowedTools list — the model cannot
            // invoke tools and these events should never reach us. If one
            // does (e.g. a future backend wires sideQuery without the
            // allowlist), drop it loudly so the leak surfaces in logs
            // rather than turning into rendered noise the user can see.
            log.warn(
              "side chat: tool/permission event leaked into overlay — dropping",
              { eventType: event.type, sideTabId: id },
            )
            break
          default:
            log.debug("side chat: ignoring non-side event in overlay", {
              eventType: event.type,
            })
            break
        }
      }
      // Stream ended naturally — if we're still "running", mark done so the
      // status line settles to a final state. This handles backends that
      // close the iterable without emitting a turn_complete (defensive).
      const final = activeTab()
      if (final && final.id === id && final.status === "running") {
        setActiveTab({ ...final, status: "done" })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn("side chat: stream loop threw", { error: message })
      const tab = activeTab()
      if (tab && tab.id === id) {
        setActiveTab({ ...tab, status: "error", error: message })
      }
    }
  })()

  return true
}

/**
 * Close the overlay. Aborts the in-flight side turn so the Claude adapter's
 * finally-block tears down the fork query and unlinks the JSONL.
 *
 * Safe to call when the overlay is already closed.
 */
export function closeSideChatOverlay(reason: string): void {
  if (activeAbort) {
    log.debug("side chat: aborting in-flight side turn", { reason })
    activeAbort.abort()
    activeAbort = null
  }
  setActiveTab(null)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Status line shown in the top banner. `running` reads as a spinner verb
 * to make it obvious the stream hasn't stalled.
 */
function statusLabel(tab: SideChatTab): string {
  switch (tab.status) {
    case "running":
      return "answering…"
    case "done":
      return "done"
    case "error":
      return "error"
    case "aborted":
      return "aborted"
  }
}

const DASH = "─"

/** Pre-allocated dash string longer than any realistic terminal width. */
const DASH_FILL = DASH.repeat(512)

export function SideChatOverlay() {
  // Scrollbox ref — populated by the ScrollView's ref callback below.
  // Used by the keyboard handler to forward pgup / pgdn / ctrl+J/K to the
  // answer body's scrollbox while the input textarea retains keyboard focus.
  let scrollRef: ScrollBoxRenderable | undefined
  // Track whether the user has scrolled away from the bottom. Mirrors the
  // main conversation pane's behaviour: while at the bottom we keep
  // sticky-scroll engaged so streaming chunks pull the view down; once the
  // user pgups, we release sticky-scroll so they can read history without
  // being yanked back on every text_delta.
  const [scrolledAway, setScrolledAway] = createSignal(false)

  // Local key handler. Runs alongside the global keyboard intercept; the
  // root handler in app.tsx doesn't have a side-chat branch, so we register
  // ourselves here and own dismiss + scroll bindings. Mounted only while
  // the overlay is visible (the parent gates with <Show when={isSideChatOpen()}>).
  // MVP: single Esc cancels in-flight turn AND dismisses overlay.
  // Spec calls for double-Esc (first cancels, second dismisses); deferred.
  useKeyboard((event) => {
    if (!isSideChatOpen()) return
    if (event.name === "escape") {
      event.preventDefault()
      closeSideChatOverlay("user-esc")
      return
    }
    // Page-scroll the answer body. We capture pgup/pgdn (mouse-less keyboards)
    // and Ctrl+J/K (parity with the main conversation pane's line-scroll
    // bindings) — the textarea would otherwise eat or ignore these keys
    // since focus stays on the composer while the overlay is open.
    if (event.name === "pageup") {
      event.preventDefault()
      try { scrollRef?.scrollBy({ x: 0, y: -10 }) } catch { /* ref not yet attached */ }
      setScrolledAway(true)
      return
    }
    if (event.name === "pagedown") {
      event.preventDefault()
      try { scrollRef?.scrollBy({ x: 0, y: 10 }) } catch { /* ref not yet attached */ }
      // If pgdn lands us at/near bottom, re-engage sticky-scroll so streaming
      // continues to follow. Mirrors conversation.tsx's behaviour.
      if (scrollRef && scrollRef.scrollTop + scrollRef.viewport.height >= scrollRef.scrollHeight - 3) {
        setScrolledAway(false)
      }
      return
    }
    if (event.ctrl && !event.shift && !event.option && !event.meta && !event.super && event.name === "k") {
      event.preventDefault()
      try { scrollRef?.scrollBy(-1) } catch { /* ref not yet attached */ }
      setScrolledAway(true)
      return
    }
    if (event.ctrl && !event.shift && !event.option && !event.meta && !event.super && event.name === "j") {
      event.preventDefault()
      try { scrollRef?.scrollBy(1) } catch { /* ref not yet attached */ }
      if (scrollRef && scrollRef.scrollTop + scrollRef.viewport.height >= scrollRef.scrollHeight - 3) {
        setScrolledAway(false)
      }
      return
    }
  })

  // Defensive cleanup: if the overlay component unmounts while a turn is
  // still in flight (e.g. session shutdown), abort the controller so the
  // adapter's finally-block runs.
  onCleanup(() => {
    if (activeAbort) {
      log.debug("side chat: overlay unmounting — aborting in-flight turn")
      activeAbort.abort()
      activeAbort = null
    }
  })

  // Render-ready state derived once per signal change (per OpenTUI rule 10:
  // pure render callbacks). The component returns null when no tab is
  // active; the parent uses <Show> to gate mounting.
  return (
    <Show when={activeTab()}>
      {(getTab: Accessor<SideChatTab>) => {
        const tab = () => getTab()
        // `body` is what the markdown renderer streams into. While running
        // and empty, we render an empty string — the top banner already
        // says "answering…" so a duplicate placeholder inside the body
        // would be redundant (and looked enough like a "thinking…" block
        // to confuse users). The "(no answer)" fallback covers the rare
        // case where the stream completed without emitting any text.
        const body = () => {
          const t = tab()
          if (t.answer) return t.answer
          if (t.status === "error") return `_${t.error ?? "Side chat failed."}_`
          if (t.status === "running") return ""
          return "_(no answer)_"
        }

        // Re-mount markdown when content/answer changes — needed because
        // OpenTUI's <markdown> caches its parsed AST per props snapshot.
        // A `key`-style remount via createEffect-on-id is unnecessary here
        // because Solid's prop reactivity handles it.
        createEffect(() => {
          // Touch body() so this effect re-runs on stream chunks; useful
          // for future hooks (auto-scroll, progress flicker). No-op in MVP.
          body()
        })

        return (
          <box
            flexDirection="column"
            backgroundColor={colors.bg.primary}
            flexGrow={1}
          >
            {/* Top banner — title + dashes + status on a single row.
                Replaces the old title-on-top / divider-below split so the
                overlay opens flush against its container with no blank
                lead-in row. The TextAttributes.BOLD attribute is scoped
                to the title text only (mixing attributes inside a single
                <text> element isn't supported), with separate dash
                elements on either side so the rule reads continuously. */}
            <TopBanner status={statusLabel(tab())} />

            {/* Question echo — what the user asked, in muted color.
                Stays outside the scrollbox so the question is always
                visible no matter how far the user has scrolled in the
                answer below. */}
            <box flexDirection="row" paddingLeft={1} paddingRight={1} paddingTop={0} paddingBottom={0}>
              <box width={2} flexShrink={0}>
                <text fg={colors.text.muted}>{"?"}</text>
              </box>
              <box flexGrow={1}>
                <text fg={colors.text.muted}>{tab().question}</text>
              </box>
            </box>

            {/* Answer body — markdown so fenced code, lists, tables render.
                Wrapped in <ScrollView> so long answers (>viewport height)
                are independently scrollable without pushing the bottom
                banner off-screen. Sticky-scroll keeps the view pinned to
                the bottom while the model is streaming, but disengages
                once the user scrolls up so they can read what's already
                been written. */}
            <box flexDirection="row" flexGrow={1} paddingLeft={1} paddingRight={1}>
              <box width={2} flexShrink={0}>
                <text fg={colors.text.primary}>{"⏺"}</text>
              </box>
              <box flexGrow={1}>
                <ScrollView
                  ref={(el: ScrollBoxRenderable) => { scrollRef = el }}
                  stickyScroll={!scrolledAway()}
                  stickyStart="bottom"
                  flexGrow={1}
                  backgroundColor={colors.bg.primary}
                  onScroll={(el) => {
                    const atBottom = el.scrollTop + el.viewport.height >= el.scrollHeight - 3
                    if (atBottom) {
                      if (scrolledAway()) setScrolledAway(false)
                    } else if (!scrolledAway()) {
                      // Mouse-wheel scroll up — release sticky.
                      setScrolledAway(true)
                    }
                  }}
                >
                  <markdown
                    content={body()}
                    syntaxStyle={getSyntaxStyle()}
                    fg={colors.text.primary}
                    bg={colors.bg.primary}
                  />
                </ScrollView>
              </box>
            </box>

            {/* Optional error — shown above the bottom banner so the
                dismiss hint stays visible. Only renders on error status. */}
            <Show when={tab().status === "error" && tab().error}>
              <box paddingLeft={1} paddingRight={1}>
                <text fg={colors.status.error}>{tab().error}</text>
              </box>
            </Show>

            {/* Bottom banner — dismiss hint embedded inside the horizontal
                rule. Same single-row construction as the top banner, with
                the hint slotted in just-right-of-centre so the dashes
                bracket it visually. */}
            <BottomBanner />
          </box>
        )
      }}
    </Show>
  )
}

// ---------------------------------------------------------------------------
// Banner rows — single-row construction with inline dashes around the label.
// The dashes use a flex-grow box around a long pre-allocated string with
// `wrapMode="none"`; OpenTUI clips horizontal overflow at render time so the
// visible width always matches the box's allotted space. Same pattern as the
// Divider primitive but with embedded label text.
//
// Layout (matching the example provided by the user):
//
//   ─ « Side chat » ───────────────── answering… ─
//   ─────────────────────────── Esc to dismiss ──
//
// Top banner: left-aligned title with a short lead dash, dashes filling
// to a right-aligned status. Bottom banner: long dashes filling to a
// right-aligned dismiss hint with a 2-dash tail.
// ---------------------------------------------------------------------------

function TopBanner(props: { status: string }) {
  return (
    <box flexDirection="row" height={1} width="100%" flexShrink={0}>
      <text fg={colors.border.permission}>{`${DASH} `}</text>
      <text fg={colors.border.permission} attributes={TextAttributes.BOLD}>
        {"« Side chat »"}
      </text>
      <text fg={colors.border.permission}>{" "}</text>
      <box flexGrow={1} height={1}>
        <text wrapMode="none" fg={colors.border.permission}>{DASH_FILL}</text>
      </box>
      <text fg={colors.text.muted} attributes={TextAttributes.DIM}>
        {` ${props.status} `}
      </text>
      <text fg={colors.border.permission}>{DASH}</text>
    </box>
  )
}

function BottomBanner() {
  return (
    <box flexDirection="row" height={1} width="100%" flexShrink={0}>
      <box flexGrow={1} height={1}>
        <text wrapMode="none" fg={colors.border.permission}>{DASH_FILL}</text>
      </box>
      <text fg={colors.border.permission}>{" "}</text>
      <text fg={colors.text.muted} attributes={TextAttributes.DIM}>
        {"Esc to dismiss"}
      </text>
      <text fg={colors.border.permission}>{" "}</text>
      <text fg={colors.border.permission}>{`${DASH}${DASH}`}</text>
    </box>
  )
}
