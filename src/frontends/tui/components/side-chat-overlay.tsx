/**
 * SideChatOverlay — transient `/btw` overlay for side chat.
 *
 * Floats a single-tab Q&A box over the conversation pane. Streams the
 * answer from `backend.sideQuery()` into a parallel ephemeral store —
 * NEVER reduces into main `ConversationState`, NEVER persists to JSONL.
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
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { colors } from "../theme/tokens"
import { getSyntaxStyle } from "../theme/syntax"
import { Divider } from "./primitives"
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
  /** Streamed thinking chunks (collapsed in MVP — kept for future expansion). */
  thinking: string
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
    thinking: "",
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
            batch(() => {
              setActiveTab({ ...tab, thinking: tab.thinking + event.text })
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
 * Status line shown in the overlay header. `running` reads as a spinner
 * verb to make it obvious the stream hasn't stalled.
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

export function SideChatOverlay() {
  // Local Esc-handler. Runs alongside the global keyboard intercept; the
  // root handler in app.tsx only takes Esc when no overlay is registered,
  // so we register ourselves here and own the dismiss path.
  // MVP: single Esc cancels in-flight turn AND dismisses overlay.
  // Spec calls for double-Esc (first cancels, second dismisses); deferred.
  useKeyboard((event) => {
    if (!isSideChatOpen()) return
    if (event.name === "escape") {
      event.preventDefault()
      closeSideChatOverlay("user-esc")
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
        // `body` is what the markdown renderer streams into. Empty answer
        // when running shows a placeholder so the overlay isn't blank.
        const body = () => {
          const t = tab()
          if (t.answer) return t.answer
          if (t.status === "error") return `_${t.error ?? "Side chat failed."}_`
          if (t.status === "running") return "_thinking…_"
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
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            flexGrow={1}
          >
            {/* Header — title + status + dismiss hint.
                AGENTS.md OpenTUI rule 6: no borderTop/borderBottom on a box
                that contains a textarea. We don't have a textarea here, so
                a simple Divider for the visual rule is fine. */}
            <box flexDirection="row" height={1}>
              <text fg={colors.border.permission} attributes={TextAttributes.BOLD}>
                {"\u00AB Side chat \u00BB"}
              </text>
              <box flexGrow={1} />
              <text fg={colors.text.muted} attributes={TextAttributes.DIM}>
                {statusLabel(tab())}
              </text>
            </box>
            <Divider char={"\u254C"} fg={colors.border.permission} paddingLeft={0} />

            {/* Question echo — what the user asked, in muted color. */}
            <box flexDirection="row" paddingTop={0} paddingBottom={1}>
              <box width={2} flexShrink={0}>
                <text fg={colors.text.muted}>{"?"}</text>
              </box>
              <box flexGrow={1}>
                <text fg={colors.text.muted}>{tab().question}</text>
              </box>
            </box>

            {/* Answer body — markdown so fenced code, lists, tables render. */}
            <box flexDirection="row" flexGrow={1}>
              <box width={2} flexShrink={0}>
                <text fg={colors.text.primary}>{"\u23FA"}</text>
              </box>
              <box flexGrow={1}>
                <markdown
                  content={body()}
                  syntaxStyle={getSyntaxStyle()}
                  fg={colors.text.primary}
                  bg={colors.bg.primary}
                />
              </box>
            </box>

            {/* Footer — dismiss hint + error detail when relevant. */}
            <Divider char={"\u254C"} fg={colors.border.permission} paddingLeft={0} />
            <Show when={tab().status === "error" && tab().error}>
              <box paddingLeft={1}>
                <text fg={colors.status.error}>{tab().error}</text>
              </box>
            </Show>
            <box height={1} paddingLeft={1}>
              <text fg={colors.text.muted} attributes={TextAttributes.DIM}>
                {"Esc to dismiss"}
              </text>
            </box>
          </box>
        )
      }}
    </Show>
  )
}
