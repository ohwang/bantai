/**
 * Sync Context — Event stream → signal updates
 *
 * Owns the event loop:
 * 1. Starts the backend generator on mount
 * 2. Iterates events through the EventBatcher (16ms coalescing)
 * 3. Batcher flushes → reducer → batch update all SolidJS stores
 *
 * Pattern follows OpenCode's sdk.tsx.
 */

import {
  createContext,
  useContext,
  onMount,
  onCleanup,
  createEffect,
  createSignal,
  batch,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { reconcile } from "solid-js/store"
import { reduce } from "../../../protocol/reducer"
import {
  createInitialState,
  resetVolatileSessionState,
  type ConversationEvent,
} from "../../../protocol/types"
import { EventBatcher } from "../../../utils/event-batcher"
import { log } from "../../../utils/logger"
import { friendlyBackendName } from "../../../protocol/models"
import { useAgent } from "./agent"
import { useMessages } from "./messages"
import { useSession } from "./session"
import { usePermissions } from "./permissions"
import { readSessionHistory, getSessionFilePath } from "../../../backends/claude/session-reader"
import { setConversationState, getSubagentManagerBridge } from "../../../mcp/state-bridge"
import {
  detectSessionOrigin,
  findCodexSessionFile,
  findGeminiSessionFile,
  findMostRecentSessionForBackend,
  formatFullHistory,
  parseCodexSessionWithSummary,
  parseGeminiSessionWithSummary,
} from "../../../session/cross-backend"
import type { ParsedSession } from "../../../protocol/types"

export interface SwitchBackendOptions {
  /** Registry id of the backend to switch to. */
  backendId: string
  /** Optional model to apply immediately after the swap. */
  model?: string
  /** Pre-built adapter — when provided, callers have already instantiated
   *  the new backend and just need sync.tsx to swap it in. */
  adapter: import("../../../protocol/types").AgentBackend
}

/** User-visible progress while a /switch is in flight. Consumed by the
 *  conversation view to render an inline spinner with phase labels so the
 *  user knows work is still happening between "Switched to X" and "ready
 *  to type". null once the switch completes (success or failure). */
export interface SwitchProgress {
  /** Registry id of the target backend ("codex", "claude", ...) */
  backendId: string
  /** Human-readable backend name shown alongside the phase (e.g. "Codex") */
  backendName: string
  /** Current phase label: "Starting X...", "Replaying history...", etc. */
  phase: string
}

export interface SyncContextValue {
  /** Manually push an event (for slash commands, synthetic events, etc.) */
  pushEvent: (event: ConversationEvent) => void
  /** Start consuming the backend event stream */
  startEventLoop: () => void
  /** Reset conversation state (messages, streaming, tools) while preserving session/cost */
  clearConversation: () => void
  /** Reset session cost counters to zero */
  resetCost: () => void
  /**
   * Swap the active backend in place. Only valid when the session is IDLE —
   * callers must enforce that gate. Closes the previous adapter, stashes the
   * full block history onto the new adapter's replayContext (to ride along
   * with the next real user message), restarts the event loop, and resolves
   * only once the new adapter reports ready (subprocess alive, handshake
   * complete, replay stashed, message loop listening).
   *
   * Rejects on adapter startup failure (with the underlying error, including
   * subprocess stderr from the Codex transport) or a 15s timeout. The caller
   * can use this to sequence a "Switched to X" message safely: when the
   * promise resolves, user typing is guaranteed to reach a ready backend.
   */
  switchBackend: (opts: SwitchBackendOptions) => Promise<void>
  /** Live progress signal for an in-flight /switch — null when no switch is
   *  running. Consumed by the conversation view to render an inline spinner
   *  with phase labels. */
  switchProgress: Accessor<SwitchProgress | null>
}

export const SyncContext = createContext<SyncContextValue>()

export function SyncProvider(props: ParentProps) {
  const agent = useAgent()
  const messages = useMessages()
  const session = useSession()
  const permissions = usePermissions()

  // Reducer state (mutable, not reactive — stores are the reactive layer)
  let conversationState = createInitialState()
  let aborted = false
  let initTimeoutId: ReturnType<typeof setTimeout> | null = null
  let firstMessageSent = false

  // Each call to startEventLoop() bumps this generation. When `/switch` swaps
  // the backend, the in-flight loop sees its generation no longer matches and
  // exits cleanly without surfacing an error event. Without this counter,
  // closing the old adapter from inside switchBackend() would race with the
  // for-await loop and could push a `stream_error` for the supersedence.
  let loopGeneration = 0
  // Resolves once the next session_init lands. switchBackend() awaits this
  // so callers can sequence "Switched to X" only after the new backend is up.
  let pendingInitResolvers: Array<() => void> = []

  // Reactive progress signal for an in-flight /switch. Written inside
  // switchBackend() at each phase boundary; read by the conversation view
  // to render an inline spinner with phase labels (bug #5 — no user-visible
  // progress during post-switch init).
  const [switchProgress, setSwitchProgress] = createSignal<SwitchProgress | null>(null)

  // Apply a batch of events through the reducer, then update all stores
  const applyEvents = (events: ConversationEvent[]) => {
    let historyLoadedInBatch = false
    for (const event of events) {
      // Log lifecycle events at info, streaming deltas at debug
      if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "tool_use_progress") {
        log.debug(`Event: ${event.type}`)
      } else {
        log.info(`Event: ${event.type}`, event.type === "error" ? { code: event.code, message: event.message } : undefined)
      }
      if (event.type === "history_loaded") historyLoadedInBatch = true
      if (event.type === "session_init" && pendingInitResolvers.length > 0) {
        const resolvers = pendingInitResolvers
        pendingInitResolvers = []
        for (const r of resolvers) r()
      }
      conversationState = reduce(conversationState, event)
    }
    setConversationState(conversationState)

    batch(() => {
      // Use reconcile() for arrays/objects so unchanged items keep stable
      // proxy references. This lets <For> efficiently track identity and
      // prevents mass element recreation on every event batch.
      // Matches OpenCode's reconcile() + produce() update pattern.
      messages.setState("blocks", reconcile(conversationState.blocks))
      messages.setState("streamingText", conversationState.streamingText)
      messages.setState("streamingThinking", conversationState.streamingThinking)
      messages.setState("activeTasks", reconcile(Array.from(conversationState.activeTasks.entries())))
      messages.setState("backgrounded", conversationState.backgrounded)
      messages.setState("streamingOutputTokens", conversationState.streamingOutputTokens)
      messages.setState("lastTurnFiles", reconcile(conversationState.lastTurnFiles ?? undefined as any))

      session.setState("sessionState", conversationState.sessionState)
      session.setState("session", reconcile(conversationState.session))
      session.setState("cost", reconcile(conversationState.cost))
      session.setState("lastError", reconcile(conversationState.lastError))
      session.setState("turnNumber", conversationState.turnNumber)
      session.setState("lastTurnInputTokens", conversationState.lastTurnInputTokens)
      session.setState("lastTurnTtftMs", conversationState.lastTurnTtftMs)
      session.setState("currentModel", conversationState.currentModel ?? "")
      session.setState("currentEffort", conversationState.currentEffort ?? "")
      session.setState("rateLimits", reconcile(conversationState.rateLimits))
      session.setState("agentCommands", reconcile(conversationState.agentCommands))
      session.setState("configOptions", reconcile(conversationState.configOptions))
      session.setState("resuming", conversationState.resuming)
      session.setState("currentCwd", conversationState.currentCwd)
      session.setState("worktree", reconcile(conversationState.worktree))

      permissions.setState("pendingPermission", reconcile(conversationState.pendingPermission))
      permissions.setState("pendingElicitation", reconcile(conversationState.pendingElicitation))
    })

    // When a resume just completed, nudge the scrollbox to the bottom so the
    // user lands on the SessionResumeSummary marker (and the most recent turn
    // is visible) instead of the top of the seeded history.
    if (historyLoadedInBatch) {
      import("../components/input-utils").then(m => m._scrollToBottom?.())
    }
  }

  // Create the batcher with applyEvents as the flush handler
  const batcher = new EventBatcher(
    applyEvents,
    16,
    (error) => {
      log.error("Event processing error in batcher", { error: error.message })
    },
  )

  const pushEvent = (event: ConversationEvent) => {
    // Start init timeout on first user message, not on mount.
    // With the query() API, session_init doesn't arrive until the first message is sent,
    // so starting the timeout earlier would cause false positives.
    if (!firstMessageSent && event.type === "user_message") {
      firstMessageSent = true
      if (session.state.sessionState === "INITIALIZING") {
        log.info("First user message sent — starting 30s init timeout")
        initTimeoutId = setTimeout(() => {
          if (session.state.sessionState === "INITIALIZING") {
            log.error("Session initialization timed out after 30s")
            pushEvent({
              type: "error",
              code: "init_timeout",
              message: "Session initialization timed out. Check that your API key is valid and the backend is reachable.",
              severity: "fatal",
            })
          }
        }, 30_000)
      }
    }
    batcher.push(event)
  }

  // Reset conversation state (messages, streaming, tools) while preserving session/cost
  const clearConversation = () => {
    // Flush any pending events first so we don't lose them
    batcher.flush()

    // Reset conversationState but preserve session metadata, cost, and session state
    conversationState = {
      ...createInitialState(),
      sessionState: conversationState.sessionState,
      session: conversationState.session,
      cost: { ...conversationState.cost },
      currentModel: conversationState.currentModel,
      currentEffort: conversationState.currentEffort,
    }

    // Clear the SolidJS stores to match
    batch(() => {
      messages.setState("blocks", reconcile([]))
      messages.setState("streamingText", "")
      messages.setState("streamingThinking", "")
      messages.setState("activeTasks", reconcile([]))
      messages.setState("backgrounded", false)
      messages.setState("streamingOutputTokens", 0)
      messages.setState("lastTurnFiles", undefined)
      session.setState("lastTurnInputTokens", 0)
      session.setState("lastTurnTtftMs", null)
      session.setState("turnNumber", 0)
      session.setState("rateLimits", null)
    })
  }

  // Reset session cost counters to zero (also resets context fill + turn number)
  const resetCost = () => {
    const zeroCost = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0,
    }
    conversationState = {
      ...conversationState,
      cost: zeroCost,
      lastTurnInputTokens: 0,
      _contextFromStream: false,
      turnNumber: 0,
    }
    batch(() => {
      session.setState("cost", reconcile(zeroCost))
      session.setState("lastTurnInputTokens", 0)
      session.setState("turnNumber", 0)
    })
  }

  // Start the backend and iterate its event generator
  const startEventLoop = async () => {
    if (aborted) return

    const generation = ++loopGeneration
    const backendForLoop = agent.backendAccessor()
    const mode = agent.config.resume ? "resume" : agent.config.continue ? "continue" : "start"
    log.info(`Event loop starting (${mode})`, {
      generation,
      backend: backendForLoop.capabilities().name,
      sessionId: agent.config.resume,
    })

    // Resume/continue support is validated by each adapter inside runSession().
    // We don't pre-flight via capabilities() here because ACP-based backends only
    // learn their agent capabilities after the initialize handshake — a pre-flight
    // check would falsely block same-backend resume for gemini/copilot/acp.
    // Adapters emit a fatal `unsupported_resume`/`unsupported_continue` error if
    // the requested mode isn't supported once the handshake completes.

    try {
      // Always use start() — it handles resume/continue via config.resume
      // and config.continue in buildOptions() and createMessageIterable().
      // The separate resume() method creates a bare config missing cwd,
      // permissionMode, etc., which causes the SDK subprocess to fail.
      const generator = backendForLoop.start(agent.config)

      for await (const event of generator) {
        if (aborted) break
        // Stop forwarding events from a superseded loop. switchBackend()
        // bumps the generation before closing the old adapter, so any
        // straggler events here are obsolete by the time we see them.
        if (generation !== loopGeneration) break
        try {
          batcher.push(event)
        } catch (e) {
          if (!aborted) log.warn("Failed to push event to batcher", { error: String(e) })
          break
        }
      }

      log.info("Event loop ended", { generation, superseded: generation !== loopGeneration })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const superseded = generation !== loopGeneration
      log.error("Event loop error", { error: message, generation, superseded })
      // Don't surface stream_error from a backend we just swapped away from —
      // the close() call inside switchBackend() can race the for-await loop
      // and produce a benign rejection. Only fresh-loop errors are user-facing.
      if (!aborted && !superseded) {
        batcher.push({
          type: "error",
          code: "stream_error",
          message,
          severity: "fatal",
        })
      }
    }

    // Flush any remaining events
    batcher.flush()
  }

  /**
   * Hot-swap the active backend. The caller is responsible for gating on IDLE
   * — we don't re-check here because the command layer needs to format the
   * rejection message anyway.
   *
   * Readiness contract: this resolves only after the new adapter reports
   * ready via whenReady() — subprocess alive, handshake done, replayContext
   * stashed, message loop listening. Before that point, any user typing
   * would race the replay-prepend path. See bug #4 in
   * team/backlog/done/switch-backend-broken-first-message.md.
   *
   * Progress: `switchProgress` is set at each phase transition so the UI
   * can render "Starting Codex...", etc. Always cleared on return (success
   * or failure) via the finally block.
   */
  const switchBackend = async (opts: SwitchBackendOptions): Promise<void> => {
    const oldBackend = agent.backendAccessor()
    const oldName = oldBackend.capabilities().name
    const newName = opts.adapter.capabilities().name
    const friendlyNewName = friendlyBackendName(newName)
    log.info("Switching backend", { from: oldName, to: newName, model: opts.model })

    // Phase: closing previous
    setSwitchProgress({
      backendId: opts.backendId,
      backendName: friendlyNewName,
      phase: `Closing ${friendlyBackendName(oldName)}...`,
    })

    try {
      // Step 1: bump the generation so the running for-await loop stops
      // forwarding events as soon as it next yields.
      loopGeneration++

      // Step 2: close the old backend. This drains its EventChannel and breaks
      // the for-await loop. Done before swapping the signal so any in-flight
      // events from the dying adapter still see the old reference if anything
      // reads it during teardown.
      try {
        oldBackend.close()
      } catch (e) {
        log.warn("Old backend close threw during switch", { error: String(e) })
      }

      // Step 3: build a full-history replay so the new adapter has the
      // conversation in its model context. We deliberately use formatFullHistory
      // (the same primitive used for cross-backend resume) instead of a one-line
      // summary — a previous attempt at a single-prompt summarization lost
      // tool-call fidelity. See team/backlog/done/cross-backend-session-resume.md.
      const blocks = conversationState.blocks
      let replayText: string | undefined
      if (blocks.length > 0) {
        const { contextText } = formatFullHistory(blocks, oldName)
        replayText = contextText
      }

      // Step 4: stash the replay text on config.replayContext. The contract
      // there (see SessionConfig.replayContext) is that adapters MUST NOT
      // send it as a user turn — they stash it and prepend it, marked as
      // historical, to the next real user message. Clear resume/continue
      // and initialPrompt to avoid leaking prior CLI-session state.
      agent.config.replayContext = replayText
      agent.config.initialPrompt = undefined
      agent.config.resume = undefined
      agent.config.continue = undefined
      agent.config.sessionOrigin = newName as any

      // When switching WITHOUT an explicit model, clear the inherited model
      // so the new backend uses its own default. Without this, a Claude-specific
      // model alias (e.g., "opus[1m]" from ~/.claude/settings.json) leaks into
      // non-Claude backends and causes API errors.
      if (!opts.model) {
        agent.config.model = undefined
      }

      // Step 5: swap the backend signal so every reactive reader (status bar,
      // header, diagnostics) re-renders with the new backend's name.
      agent.setBackend(opts.adapter)

      // Step 6: reset session-level reducer state so the status bar doesn't
      // show stale cost / rate-limits / context / turn counters from the old
      // backend during the gap. The block history is preserved deliberately
      // — the user wants to see prior turns.
      //
      // `resetVolatileSessionState` reads defaults from `createInitialState()`,
      // so adding a new per-backend field to ConversationState later just
      // means extending the helper's pick list (and we won't silently skip
      // resetting it here). If the caller passed an explicit `opts.model`,
      // apply it on top of the reset defaults so the status bar shows the
      // target model immediately rather than "unknown" for the boot gap.
      conversationState = {
        ...resetVolatileSessionState(conversationState),
        currentModel: opts.model ?? null,
      }
      batch(() => {
        session.setState("sessionState", "INITIALIZING")
        session.setState("session", reconcile(null))
        session.setState("currentModel", opts.model ?? "")
        session.setState("currentEffort", "")
        session.setState("configOptions", reconcile([]))
        session.setState("agentCommands", reconcile([]))
        session.setState("cost", reconcile(conversationState.cost))
        session.setState("rateLimits", reconcile(null))
        session.setState("lastTurnInputTokens", 0)
        session.setState("lastTurnTtftMs", null)
        session.setState("turnNumber", 0)
        messages.setState("streamingOutputTokens", 0)
        messages.setState("lastTurnFiles", undefined)
      })

      // Phase: starting subprocess + handshake
      setSwitchProgress({
        backendId: opts.backendId,
        backendName: friendlyNewName,
        phase: `Starting ${friendlyNewName}...`,
      })

      // Step 7: kick off the new event loop. Don't await — startEventLoop runs
      // for the lifetime of the session.
      startEventLoop()

      // Step 8: wait for the new backend to be TRULY ready to accept messages.
      //
      // We prefer whenReady() (the explicit gate adapters signal after
      // stashing replayContext + entering runMessageLoop). If an adapter
      // doesn't expose it — shouldn't happen for our three current ones, but
      // the interface marks it optional — we fall back to awaiting
      // session_init, matching the pre-fix behavior.
      //
      // The 15s timeout is deliberately generous: Codex app-server spawn
      // alone can take ~2-3s on cold start, the handshake another ~1s,
      // leaving comfortable headroom. Errors during startup surface via
      // whenReady() rejection (carrying subprocess stderr from ae7c53b's
      // fix) rather than as a hollow timeout.
      const ready: Promise<void> = opts.adapter.whenReady
        ? opts.adapter.whenReady()
        : new Promise<void>((resolve) => { pendingInitResolvers.push(resolve) })

      const timeout = new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error(`${friendlyNewName} did not become ready within 15s`)),
          15_000,
        )
      })

      await Promise.race([ready, timeout])

      // Phase: replay staged (brief — model override is the last gate)
      if (replayText) {
        setSwitchProgress({
          backendId: opts.backendId,
          backendName: friendlyNewName,
          phase: `Staged conversation history for ${friendlyNewName}...`,
        })
      }

      // Step 9: apply the model override now that the backend is ready.
      //   setModel doesn't race the SDK's startup sequence, but we keep it
      //   inside the progress window so any UI dropdown/status flicker is
      //   covered by the spinner.
      if (opts.model) {
        try {
          await opts.adapter.setModel(opts.model)
        } catch (err) {
          log.warn("setModel after switch failed", {
            backend: newName,
            model: opts.model,
            error: String(err),
          })
        }
      }
    } finally {
      setSwitchProgress(null)
    }
  }

  onMount(() => {
    // Wire SubagentManager's pushEvent so subagent events flow into the main stream
    const mgr = getSubagentManagerBridge()
    if (mgr) {
      mgr.setPushEvent(pushEvent)
    }

    // Pre-populate conversation history for resume/continue.
    //
    // Unified flow across all backends (Claude / Codex / Gemini):
    //   1. Detect the session's origin backend from its on-disk location.
    //   2. Parse the native session file into { blocks, summary }.
    //   3. Seed conversationState.blocks *before* starting the event loop.
    //   4. Emit history_load_started → history_loaded (or history_load_failed)
    //      so the UI shows a spinner, then appends a resume summary and
    //      scrolls to the bottom.
    //
    // For cross-backend resume (origin !== target), the parsed blocks are
    // rendered as-is AND a formatted-text version is injected as the initial
    // prompt so the target backend actually has the history in-context.
    //
    // Special case: for native-replay backends (Gemini) the history_loaded
    // event is emitted by the adapter after it finishes draining the
    // backend's replay stream — not here.
    const backendName = agent.backend.capabilities().name
    const resumeId = agent.config.resume
    const continueMode = agent.config.continue
    if ((resumeId || continueMode) && agent.config.cwd) {
      const cwd = agent.config.cwd
      const sessionId = resumeId || findMostRecentSessionForBackend(backendName, cwd)
      if (sessionId) {
        const origin = detectSessionOrigin(sessionId, cwd)
        const target = agent.config.sessionOrigin ?? backendName
        const isCrossBackend = origin !== null && origin !== target

        // Resolve the file path we'll be reading, purely for telemetry and
        // error surfacing. Null means the origin couldn't be detected.
        let filePath: string | null = null
        if (origin === "claude") {
          filePath = getSessionFilePath(sessionId, cwd)
        } else if (origin === "codex") {
          filePath = findCodexSessionFile(sessionId)
        } else if (origin === "gemini") {
          filePath = findGeminiSessionFile(sessionId)
        }

        // Signal resume-in-progress so the UI can show a spinner and block input.
        pushEvent({
          type: "history_load_started",
          sessionId,
          filePath: filePath ?? "(unknown)",
          origin: origin ?? "unknown",
        })

        try {
          let parsed: ParsedSession
          if (origin === "claude") {
            parsed = readSessionHistory(sessionId, cwd)
          } else if (origin === "codex" && filePath) {
            parsed = parseCodexSessionWithSummary(filePath)
          } else if (origin === "gemini" && filePath) {
            parsed = parseGeminiSessionWithSummary(filePath)
          } else {
            throw new Error(
              origin === null
                ? `Session "${sessionId}" could not be located in any known backend's storage.`
                : `Session file for origin "${origin}" was not found.`,
            )
          }

          const { blocks, summary } = parsed
          // Parser always stamps target=origin; the sync layer overrides it
          // to reflect which backend is actually rendering the resume.
          summary.target = target

          if (isCrossBackend && origin) {
            // Cross-backend: also format the history as an injected prompt so
            // the target backend has the full conversation in its context
            // window. The rendered blocks above are the user-visible copy;
            // the prompt is the model-visible copy.
            const { contextText, toolCallCount } = formatFullHistory(blocks, origin)
            if (toolCallCount > 0) {
              summary.crossBackendCaveat = `${toolCallCount} tool call(s) from the original session are shown for context but may not be available in ${target}`
            }

            agent.config.initialPrompt = agent.config.initialPrompt
              ? contextText + "\n\n---\n\n" + agent.config.initialPrompt
              : contextText

            // Clear config.resume so the target backend uses start() with
            // the injected context instead of a native resume of a session
            // ID that doesn't belong to its storage.
            agent.config.resume = undefined
          }

          // Seed blocks synchronously so they're visible before the backend
          // session spins up. Matches the pre-existing Claude-resume fast path.
          if (blocks.length > 0) {
            conversationState = { ...conversationState, blocks: [...blocks] }
            batch(() => {
              messages.setState("blocks", reconcile([...blocks]))
            })
          }

          // Emit history_loaded now for backends that don't stream a replay
          // stream of their own (Claude and Codex both silently load context
          // inside the backend — we already have the full history on disk).
          //
          // For Gemini same-backend, AcpAdapter emits history_loaded itself
          // after it finishes draining the backend's replay window. Stash
          // the parsed summary on config so the adapter knows what to emit.
          const emitNow = isCrossBackend || target !== "gemini"
          if (emitNow) {
            pushEvent({
              type: "history_loaded",
              sessionId: summary.sessionId,
              origin: summary.origin,
              target: summary.target,
              summary,
            })
          } else {
            agent.config._pendingResumeSummary = summary
          }

          log.info("Resume history loaded", {
            sessionId,
            origin,
            target,
            blocks: blocks.length,
            crossBackend: isCrossBackend,
            emittedNow: emitNow,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const stack = err instanceof Error ? err.stack : undefined
          log.error("Failed to load session history", {
            sessionId,
            filePath,
            origin,
            error: message,
          })
          pushEvent({
            type: "history_load_failed",
            sessionId,
            filePath: filePath ?? undefined,
            origin: origin ?? undefined,
            error: message,
            details: stack,
          })
        }
      }
    }

    startEventLoop()

    // Clear the init timeout once we leave INITIALIZING
    createEffect(() => {
      if (session.state.sessionState !== "INITIALIZING" && initTimeoutId !== null) {
        clearTimeout(initTimeoutId)
        initTimeoutId = null
      }
    })

    onCleanup(() => {
      if (initTimeoutId !== null) clearTimeout(initTimeoutId)
    })

    // Send initial prompt after backend is ready (session_init received)
    if (agent.config.initialPrompt) {
      const text = agent.config.initialPrompt
      let sent = false
      createEffect(() => {
        if (!sent && session.state.sessionState === "IDLE") {
          sent = true
          pushEvent({ type: "user_message", text })
          agent.backend.sendMessage({ text })
        }
      })
    }
  })

  onCleanup(() => {
    log.info("SyncProvider cleanup")
    aborted = true
    // Nullify SubagentManager's pushEvent to prevent events into a destroyed tree
    const mgr = getSubagentManagerBridge()
    if (mgr) {
      mgr.setPushEvent(() => {})
    }
    batcher.destroy()
    agent.backend.close()
  })

  return (
    <SyncContext.Provider value={{ pushEvent, startEventLoop, clearConversation, resetCost, switchBackend, switchProgress }}>
      {props.children}
    </SyncContext.Provider>
  )
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSync must be used within SyncProvider")
  return ctx
}
