/**
 * Event-sourced ConversationState reducer.
 *
 * The TUI renders from ConversationState, never raw events.
 * State is reconstructable by replaying events through reduce().
 *
 * Note: eventLog is maintained by the caller, not the reducer.
 * The reducer does not copy events into eventLog to avoid O(n²) allocations.
 */

import type {
  Block,
  ConversationEvent,
  ConversationState,
  SkillToolUse,
  TaskInfo,
  ToolStatus,
  TurnFileChange,
} from "./types"
import { log } from "../utils/logger"

/** Strip SDK image placeholders that native Claude Code doesn't display */
function stripImagePlaceholders(text: string): string {
  return text
    .replace(/\[Image(?:\s*#?\s*\d+)?\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Strip raw XML tags emitted by the SDK for local command output (e.g. /compact responses) */
function stripSDKXmlTags(text: string): string {
  return text.replace(/<\/?local-command-\w+>/g, "")
}

/**
 * Commit streaming buffers to blocks. Called on tool_use_start, text_complete,
 * turn_complete, and interrupt to ensure chronological ordering.
 * Thinking is flushed before text (thinking precedes text chronologically).
 */
function flushBuffers(state: ConversationState): ConversationState {
  let streamingThinking = state.streamingThinking
  let streamingText = state.streamingText

  const flushed: Block[] = []
  if (streamingThinking) {
    flushed.push({ type: "thinking", text: streamingThinking })
    streamingThinking = ""
  }
  if (streamingText) {
    const cleanedText = stripImagePlaceholders(stripSDKXmlTags(streamingText))
    // Dedup guard: don't create a duplicate assistant block if the same text
    // already exists in the current turn. Scan backwards until hitting a user
    // block (turn boundary). This prevents double-flush scenarios where
    // multiple triggers (tool_use_start, text_complete, turn_complete) each
    // try to flush the same accumulated text.
    let alreadyFlushed = false
    for (let i = state.blocks.length - 1; i >= 0; i--) {
      const b = state.blocks[i]!
      if (b.type === "user") break // turn boundary
      if (b.type === "assistant" && b.text === cleanedText) {
        alreadyFlushed = true
        break
      }
    }
    if (alreadyFlushed) {
      streamingText = ""
    } else {
      flushed.push({ type: "assistant", text: cleanedText, timestamp: Date.now(), model: state.currentModel ?? undefined })
      streamingText = ""
    }
  }

  if (flushed.length === 0) return state // no changes

  // Insert flushed blocks before any queued user blocks so that the
  // assistant's streaming content (which was produced during the turn)
  // appears chronologically before messages the user queued mid-turn.
  const firstQueuedIdx = state.blocks.findIndex(
    b => b.type === "user" && b.queued,
  )
  let blocks: Block[]
  if (firstQueuedIdx === -1) {
    blocks = [...state.blocks, ...flushed]
  } else {
    blocks = [
      ...state.blocks.slice(0, firstQueuedIdx),
      ...flushed,
      ...state.blocks.slice(firstQueuedIdx),
    ]
  }

  return { ...state, blocks, streamingThinking, streamingText }
}

export function reduce(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  // eventLog maintained by caller if needed; not copied per-event to avoid
  // O(n²) allocation during streaming (eventLog was never consumed by TUI).
  const next: ConversationState = {
    ...state,
    eventLog: state.eventLog,
  }

  switch (event.type) {
    // ----- Session lifecycle -----

    case "session_init":
      return {
        ...next,
        sessionState: "IDLE",
        session: {
          tools: event.tools,
          models: event.models,
          account: event.account,
          sessionId: event.sessionId,
        },
        currentModel: event.models?.[0]?.name ?? next.currentModel,
        // Todos are per-session in-memory state — a new session_init always
        // starts from an empty list, even if the prior session left a
        // partial TodoWrite around (e.g. after resetSession / /new).
        todos: [],
      }

    // ----- Turn lifecycle -----

    case "turn_start": {
      // Guard: allow from IDLE, INITIALIZING, or RUNNING+awaitingTurnStart.
      // The last case handles user_message transitioning to RUNNING before
      // the SDK's turn_start arrives — we still need to increment the turn
      // number and reset buffers. Genuine duplicate turn_starts mid-stream
      // (RUNNING without awaitingTurnStart) are ignored.
      if (
        state.sessionState !== "IDLE" &&
        state.sessionState !== "INITIALIZING" &&
        !(state.sessionState === "RUNNING" && state.awaitingTurnStart)
      ) {
        return next
      }
      // Prune completed tasks from previous turn — kept visible during IDLE
      // so the sub-agent tree persists after turn_complete, cleaned up when
      // the next turn begins.
      const prunedTasks = new Map(state.activeTasks)
      for (const [id, task] of prunedTasks) {
        if (task.status === "completed") {
          prunedTasks.delete(id)
        }
      }

      return {
        ...next,
        sessionState: "RUNNING",
        awaitingTurnStart: false,
        turnNumber: state.turnNumber + 1,
        streamingText: "",
        streamingThinking: "",
        streamingOutputTokens: 0,
        _contextFromStream: false,
        // Clear TTFT for the new turn — turn_complete will set it from the
        // SDK's ttft_ms field (when reported). Keeping the previous turn's
        // value around would mislead the status bar during the next turn.
        lastTurnTtftMs: null,
        activeTasks: prunedTasks,
      }
    }

    case "turn_complete": {
      // Guard: ignore if not in RUNNING, INTERRUPTING, or ERROR
      // ERROR is accepted so that a turn_complete after a fatal error can recover to IDLE
      if (state.sessionState !== "RUNNING" && state.sessionState !== "INTERRUPTING" && state.sessionState !== "ERROR") {
        return next
      }

      // Flush any remaining buffers as committed blocks
      const flushed = flushBuffers({ ...next })

      // Unqueue any queued user blocks AND close any running tool blocks
      // (SDK doesn't emit explicit tool_use_end — tools finish internally).
      // Also close running skill sub-agent activities.
      const blocks = flushed.blocks.map(b =>
        b.type === "user" && b.queued ? { ...b, queued: undefined } : b
      ).map(b => {
        if (b.type !== "tool" || b.status !== "running") return b
        const closed: typeof b = { ...b, status: "done" as ToolStatus, duration: Date.now() - b.startTime }
        if (b.skillActivity?.some(a => a.status === "running")) {
          closed.skillActivity = b.skillActivity.map(a =>
            a.status === "running" ? { ...a, status: "done" as const } : a
          )
        }
        return closed
      })

      // Update cost totals
      const cost = { ...state.cost }
      if (event.usage) {
        cost.inputTokens += event.usage.inputTokens
        cost.outputTokens += event.usage.outputTokens
        cost.cacheReadTokens += event.usage.cacheReadTokens ?? 0
        cost.cacheWriteTokens += event.usage.cacheWriteTokens ?? 0
        cost.totalCostUsd += event.usage.totalCostUsd ?? 0
      }

      // Extract file changes from this turn's tool blocks
      const turnFiles: TurnFileChange[] = []
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]
        if (block === undefined) continue
        if (block.type === "user") break // Hit previous user message = end of turn
        if (block.type === "tool" && block.status === "done") {
          const input = block.input as Record<string, unknown> | null
          const filePath = input?.file_path as string | undefined
          if (filePath) {
            const action: TurnFileChange["action"] =
              block.tool === "Write" ? "create"
              : block.tool === "Edit" ? "edit"
              : "read"
            turnFiles.push({ path: filePath, action, tool: block.tool })
          }
        }
      }

      // Merge sessionId from turn_complete into the existing session if present,
      // but never clear a sessionId that was already set by session_init.
      // Priority: existing session preserved; turn_complete's sessionId overlays only if provided.
      const updatedSession = flushed.session
        ? event.sessionId
          ? { ...flushed.session, sessionId: event.sessionId }
          : flushed.session
        : event.sessionId
          ? { tools: [], models: [], sessionId: event.sessionId }
          : null

      return {
        ...flushed,
        blocks,
        sessionState: "IDLE",
        streamingText: "",
        streamingThinking: "",
        pendingPermission: null,
        pendingElicitation: null,
        cost,
        streamingOutputTokens: 0,
        backgrounded: false,
        awaitingTurnStart: false,
        session: updatedSession,
        // Context window fill: prefer per-API-call value from cost_update.contextTokens
        // (set by message_start during streaming) over the cumulative turn usage.
        // The result.usage sums ALL API calls in a multi-step agentic turn,
        // overcounting by num_turns×. Fall back to turn usage for backends
        // (Codex, Gemini) that don't emit per-API-call context tokens.
        lastTurnInputTokens: state._contextFromStream
          ? state.lastTurnInputTokens
          : event.usage && (event.usage.inputTokens > 0 || (event.usage.cacheReadTokens ?? 0) > 0)
            ? (event.usage.inputTokens + (event.usage.cacheReadTokens ?? 0) + (event.usage.cacheWriteTokens ?? 0))
            : state.lastTurnInputTokens,
        // TTFT: stamp the completed turn's time-to-first-token when the
        // backend reported one. Absence is legitimate (Codex/Gemini/mock
        // don't surface it today), so fall back to the existing value
        // rather than clearing it to null — the reset happens on turn_start.
        lastTurnTtftMs: event.ttftMs != null ? event.ttftMs : state.lastTurnTtftMs,
        _contextFromStream: false,
        lastTurnFiles: turnFiles.length > 0 ? turnFiles : undefined,
        // Capture a per-turn summary for the TUI "Baked for X" line. Only
        // recorded when the backend provides enough signal to render something
        // meaningful — duration, cost, or any token count. The TUI decides
        // which fields to show; missing fields are hidden, not synthesised.
        lastTurnSummary:
          event.durationMs != null ||
          (event.usage && (event.usage.inputTokens > 0 || event.usage.outputTokens > 0 || (event.usage.totalCostUsd ?? 0) > 0))
            ? {
                durationMs: event.durationMs,
                costUsd: event.usage?.totalCostUsd,
                usage: event.usage,
              }
            : null,
      }
    }

    // ----- User messages -----

    case "user_message": {
      // During active turns, show as queued
      if (
        state.sessionState === "RUNNING" ||
        state.sessionState === "WAITING_FOR_PERM" ||
        state.sessionState === "WAITING_FOR_ELIC" ||
        state.sessionState === "INTERRUPTING"
      ) {
        return {
          ...next,
          blocks: [...state.blocks, { type: "user", text: event.text, queued: true, images: event.images }],
        }
      }
      // ERROR state: auto-recover by clearing error and showing message
      if (state.sessionState === "ERROR") {
        return {
          ...next,
          sessionState: "IDLE",
          lastError: null,
          blocks: [...state.blocks, { type: "user", text: event.text, images: event.images }],
        }
      }
      // IDLE: show immediately + transition to RUNNING so the spinner
      // appears as soon as the user sends a message (before turn_start
      // arrives from the SDK). awaitingTurnStart allows the SDK's
      // turn_start to still process (increment turn, reset buffers).
      return {
        ...next,
        sessionState: "RUNNING",
        awaitingTurnStart: true,
        blocks: [...state.blocks, { type: "user", text: event.text, images: event.images }],
        streamingText: "",
        streamingThinking: "",
        streamingOutputTokens: 0,
      }
    }

    case "interrupt":
      if (
        state.sessionState === "RUNNING" ||
        state.sessionState === "WAITING_FOR_PERM" ||
        state.sessionState === "WAITING_FOR_ELIC"
      ) {
        const flushed = flushBuffers({ ...next })
        // Transition running tools to "canceled" on interrupt, and resolve any
        // in-progress compact spinner (no stuck boundary if user Ctrl+C's
        // during /compact).
        const blocks = flushed.blocks.map(b => {
          if (b.type === "tool" && b.status === "running") {
            return { ...b, status: "canceled" as ToolStatus, duration: Date.now() - b.startTime }
          }
          if (b.type === "compact" && b.inProgress) {
            return {
              ...b,
              inProgress: false,
              summary: b.summary === "Compacting conversation..." ? "Compaction interrupted." : b.summary,
            }
          }
          return b
        })
        return {
          ...flushed,
          blocks,
          sessionState: "INTERRUPTING",
          pendingPermission: null,
          pendingElicitation: null,
          backgrounded: false,
        }
      }
      return next

    // ----- Shutdown -----

    case "shutdown": {
      const flushed = flushBuffers({ ...next })
      // Cancel any running tools
      const blocks = flushed.blocks.map(b =>
        b.type === "tool" && b.status === "running"
          ? { ...b, status: "canceled" as ToolStatus, duration: Date.now() - b.startTime }
          : b
      )
      return {
        ...flushed,
        blocks,
        sessionState: "SHUTTING_DOWN",
        pendingPermission: null,
        pendingElicitation: null,
      }
    }

    // ----- Text streaming -----

    case "text_delta":
      return {
        ...next,
        streamingText: state.streamingText + event.text,
      }

    case "thinking_delta":
      return {
        ...next,
        streamingThinking: state.streamingThinking + event.text,
      }

    case "text_complete": {
      const cleanedText = stripImagePlaceholders(stripSDKXmlTags(event.text))

      // If streamingText is empty, a prior trigger (tool_use_start, interrupt, etc.)
      // may have already flushed and committed the text as a block. Check the current
      // turn's blocks to avoid creating a duplicate assistant block.
      if (!next.streamingText) {
        for (let i = state.blocks.length - 1; i >= 0; i--) {
          const b = state.blocks[i]!
          if (b.type === "user") break // turn boundary
          if (b.type === "assistant" && b.text === cleanedText) {
            // Already flushed — skip to prevent duplicate
            return next
          }
        }
      }

      // Flush buffers with the finalized text — commits as an assistant block
      const withFinalText = { ...next, streamingText: cleanedText }
      return flushBuffers(withFinalText)
    }

    // ----- Tool lifecycle -----

    case "tool_use_start": {
      // CRITICAL: flush buffers FIRST so text/thinking appear before this tool
      const flushedState = flushBuffers({ ...next })
      return {
        ...flushedState,
        blocks: [...flushedState.blocks, {
          type: "tool" as const,
          id: event.id,
          tool: event.tool,
          input: event.input,
          status: "running" as ToolStatus,
          output: "",
          startTime: Date.now(),
        }],
      }
    }

    case "tool_use_progress":
      return {
        ...next,
        blocks: state.blocks.map(b =>
          b.type === "tool" && b.id === event.id
            ? {
                ...b,
                output: (b.output ?? "") + event.output,
                ...(event.input !== undefined ? { input: event.input } : {}),
              }
            : b
        ),
      }

    case "tool_use_end": {
      let targetId = event.id

      // Sentinel: adapter couldn't determine tool_use_id — match the last running tool
      if (targetId === "__last_running__") {
        for (let i = state.blocks.length - 1; i >= 0; i--) {
          const b = state.blocks[i]
          if (b !== undefined && b.type === "tool" && b.status === "running") {
            targetId = b.id
            break
          }
        }
      }

      return {
        ...next,
        blocks: state.blocks.map(b =>
          b.type === "tool" && b.id === targetId
            ? {
                ...b,
                status: (event.error ? "error" : "done") as ToolStatus,
                output: event.output,
                error: event.error,
                duration: Date.now() - b.startTime,
              }
            : b
        ),
      }
    }

    // ----- Skill sub-agent activity -----

    case "skill_tool_activity": {
      // Find the Skill tool block that matches this event's parentToolUseId
      const blockIdx = state.blocks.findIndex(
        b => b.type === "tool" && b.tool === "Skill" && b.id === event.parentToolUseId
      )
      if (blockIdx < 0) {
        log.debug("skill_tool_activity for unknown Skill block", { parentToolUseId: event.parentToolUseId })
        return next
      }

      const block = state.blocks[blockIdx] as Extract<Block, { type: "tool" }>
      const existing = block.skillActivity ?? []

      // Find existing entry for this toolId (running → done transition)
      const existingIdx = existing.findIndex(a => a.toolId === event.toolId)

      let updated: SkillToolUse[]
      if (existingIdx >= 0) {
        updated = [...existing]
        updated[existingIdx] = {
          ...updated[existingIdx]!,
          status: event.status,
          toolName: event.toolName ?? updated[existingIdx]!.toolName,
        }
      } else if (event.toolName) {
        // New tool use — append
        updated = [...existing, {
          toolId: event.toolId,
          toolName: event.toolName,
          status: event.status,
        }]
      } else {
        // tool_result without a matching start — can't add without a name
        log.debug("skill_tool_activity without toolName for unknown toolId", { toolId: event.toolId })
        return next
      }

      const blocks = [...state.blocks]
      blocks[blockIdx] = { ...block, skillActivity: updated }
      return { ...next, blocks }
    }

    // ----- Permission flow -----

    case "permission_request": {
      // Guard: only transition from RUNNING (permission requests arrive during tool execution)
      if (state.sessionState !== "RUNNING") {
        return next
      }
      // Update the tool block's input with the full input from canUseTool
      const blocks = state.blocks.map(b =>
        b.type === "tool" && b.id === event.id
          ? { ...b, input: event.input }
          : b
      )
      return {
        ...next,
        blocks,
        sessionState: "WAITING_FOR_PERM",
        pendingPermission: event,
      }
    }

    case "permission_response": {
      // Guard: only transition from WAITING_FOR_PERM
      if (state.sessionState !== "WAITING_FOR_PERM") {
        return next
      }
      return {
        ...next,
        sessionState: "RUNNING",
        pendingPermission: null,
      }
    }

    // ----- Elicitation flow -----

    case "elicitation_request": {
      // Guard: only transition from RUNNING (elicitations arrive during tool execution)
      if (state.sessionState !== "RUNNING") {
        return next
      }
      return {
        ...next,
        sessionState: "WAITING_FOR_ELIC",
        pendingElicitation: event,
      }
    }

    case "elicitation_response": {
      // Guard: only transition from WAITING_FOR_ELIC
      if (state.sessionState !== "WAITING_FOR_ELIC") {
        return next
      }
      return {
        ...next,
        sessionState: "RUNNING",
        pendingElicitation: null,
      }
    }

    // ----- Errors -----

    case "error": {
      const severity = event.severity ?? "fatal"

      // During interrupt, errors are expected artifacts (SDK in-flight operations failing).
      // Don't show them to the user — the "Interrupted" system message already displayed.
      if (state.sessionState === "INTERRUPTING") {
        log.info("Suppressing error during interrupt", { code: event.code, message: event.message?.slice(0, 100) })
        return { ...next, lastError: event }
      }

      if (severity === "fatal") {
        // Prefer attaching the error to the user message that triggered the
        // current turn — matches Claude Code's UX of showing "this user
        // message failed to be processed" rather than a detached error block.
        // Fall back to a standalone error block when there is no user block
        // in the current turn (e.g. history_load_failed, startup errors).
        let attachedIdx = -1
        for (let i = state.blocks.length - 1; i >= 0; i--) {
          const b = state.blocks[i]!
          if (b.type === "user" && !b.queued) {
            attachedIdx = i
            break
          }
        }

        if (attachedIdx >= 0) {
          const target = state.blocks[attachedIdx] as Extract<Block, { type: "user" }>
          const blocks = [...state.blocks]
          blocks[attachedIdx] = { ...target, error: { code: event.code, message: event.message } }
          return {
            ...next,
            sessionState: "ERROR",
            lastError: event,
            blocks,
          }
        }

        return {
          ...next,
          sessionState: "ERROR",
          lastError: event,
          blocks: [...state.blocks, { type: "error", code: event.code, message: event.message }],
        }
      }
      // Recoverable: stay in current state, just record
      return { ...next, lastError: event }
    }

    // ----- Cost tracking -----

    case "cost_update": {
      // Authoritative cost is handled by turn_complete usage to prevent
      // double-counting. But we track streaming output tokens separately
      // for real-time display in the spinner.
      // Per-API-call context fill from message_start is more accurate than
      // the cumulative turn_complete usage for multi-step agentic turns.
      //
      // contextWindow: when the backend reports a live per-model cap (Codex
      // 0.122+ in thread/tokenUsage/updated.modelContextWindow), patch it
      // onto the matching session.models entry so downstream consumers
      // (header bar, status bar, diagnostics) pick up the live value via
      // their existing `model?.contextWindow ?? MODEL_CONTEXT_WINDOWS[id]`
      // fallback chain. Only writes when the value actually changes to
      // avoid spurious re-renders.
      let session = next.session
      if (event.contextWindow && event.contextWindow > 0 && session?.models?.length) {
        const target = next.currentModel
        const idx = session.models.findIndex(
          (m) => m.id === target || m.name === target,
        )
        if (idx >= 0 && session.models[idx]!.contextWindow !== event.contextWindow) {
          const models = [...session.models]
          models[idx] = { ...models[idx]!, contextWindow: event.contextWindow }
          session = { ...session, models }
        }
      }
      return {
        ...next,
        session,
        streamingOutputTokens: state.streamingOutputTokens + (event.outputTokens ?? 0),
        ...(event.contextTokens !== undefined && event.contextTokens > 0
          ? { lastTurnInputTokens: event.contextTokens, _contextFromStream: true }
          : {}),
      }
    }

    // ----- Tasks / subagents -----

    case "task_start": {
      const activeTasks = new Map(state.activeTasks)
      activeTasks.set(event.taskId, {
        taskId: event.taskId,
        description: event.description,
        output: "",
        status: "running",
        startTime: Date.now(),
        toolUseId: event.toolUseId,
        taskType: event.taskType,
        source: event.source,
        backendName: event.backendName,
        model: event.model,
        sessionId: event.sessionId,
        skipTranscript: event.skipTranscript,
      })
      return { ...next, activeTasks }
    }

    case "task_progress": {
      const activeTasks = new Map(state.activeTasks)
      const task = activeTasks.get(event.taskId)
      if (task) {
        activeTasks.set(event.taskId, {
          ...task,
          output: event.output,
          lastToolName: event.lastToolName ?? task.lastToolName,
          summary: event.summary ?? task.summary,
          turnCount: event.turnCount ?? task.turnCount,
          toolUseCount: event.toolUseCount ?? task.toolUseCount,
          tokenUsage: event.tokenUsage ?? task.tokenUsage,
          thinkingActive: event.thinkingActive ?? task.thinkingActive,
          activeTurn: event.activeTurn ?? task.activeTurn,
          recentTools: event.recentTools ?? task.recentTools,
        })
      }
      return { ...next, activeTasks }
    }

    case "task_complete": {
      const activeTasks = new Map(state.activeTasks)
      const task = activeTasks.get(event.taskId)
      if (task) {
        activeTasks.set(event.taskId, {
          ...task,
          output: event.output,
          status: (event.state === "error" ? "error" : "completed") as TaskInfo["status"],
          endTime: Date.now(),
          errorMessage: event.errorMessage,
          skipTranscript: event.skipTranscript ?? task.skipTranscript,
        })
      }
      return { ...next, activeTasks }
    }

    case "task_updated": {
      // SDK 0.2.107+: granular task state patch — merge into existing task.
      const activeTasks = new Map(state.activeTasks)
      const task = activeTasks.get(event.taskId)
      if (task) {
        const patch = event.patch
        // Map SDK statuses to TaskInfo's narrower status union:
        // "pending" → "running" (pending is pre-running), "failed"/"killed" → "error"
        let status = task.status
        if (patch.status != null) {
          switch (patch.status) {
            case "running": status = "running"; break
            case "completed": status = "completed"; break
            case "failed":
            case "killed": status = "error"; break
            case "pending": status = "running"; break
          }
        }
        activeTasks.set(event.taskId, {
          ...task,
          status,
          ...(patch.description != null ? { description: patch.description } : {}),
          ...(patch.endTime != null ? { endTime: patch.endTime } : {}),
          ...(patch.totalPausedMs != null ? { totalPausedMs: patch.totalPausedMs } : {}),
          ...(patch.error != null ? { errorMessage: patch.error } : {}),
          ...(patch.isBackgrounded != null ? { isBackgrounded: patch.isBackgrounded } : {}),
        })
      } else {
        log.debug("task_updated for unknown task", { taskId: event.taskId })
      }
      return { ...next, activeTasks }
    }

    // ----- Todos (V1 TodoWrite) -----

    case "todos_updated": {
      // Full replacement semantics — mirrors Claude Code's TodoWrite tool,
      // which rewrites the entire list on every invocation. V1 is in-memory
      // only; no persistence, no owner/blocking metadata.
      //
      // Auto-hide is handled in the UI layer (see TaskChecklist component),
      // which keeps the all-completed list visible for a short delay before
      // hiding the panel — matching Claude Code's V2 hide timer
      // (see team/backlog/done/task-view.md §6.3). The reducer simply stores
      // whatever the agent sent, including all-completed lists.
      return {
        ...next,
        todos: event.todos,
      }
    }

    // ----- Plan updates (ACP structured plan) -----

    case "plan_update": {
      // Plan updates replace the entire plan (per ACP spec).
      // Find existing plan block and replace, or create new.
      const planBlock: Block = { type: "plan", entries: event.entries }

      const lastPlanIdx = state.blocks.findLastIndex(b => b.type === "plan")
      if (lastPlanIdx >= 0) {
        const blocks = [...state.blocks]
        blocks[lastPlanIdx] = planBlock
        return { ...next, blocks }
      }

      return {
        ...next,
        blocks: [...state.blocks, planBlock],
      }
    }

    // ----- Compact -----

    case "compact": {
      // If this is an "in progress" event, add a placeholder block that the
      // completed event will replace. If it's a completion event, find the
      // last in-progress compact block and replace it, or append a new one.
      //
      // Dedup (Codex): `thread/compacted` and `item/started:contextCompaction`
      // fire for the same auto-compaction. When two completion compact events
      // arrive back-to-back (adjacent in the block list), coalesce into one
      // block — preferring token metadata and richer summaries from whichever
      // event supplies them. Compact blocks separated by other activity
      // (user/assistant/tool) are treated as distinct compactions.
      const cleanSummary = stripSDKXmlTags(event.summary)
      const compactBlock: Block = {
        type: "compact",
        summary: cleanSummary,
        trigger: event.trigger,
        preTokens: event.preTokens,
        postTokens: event.postTokens,
        inProgress: event.inProgress,
        durationMs: event.durationMs,
      }

      if (!event.inProgress) {
        // Completion: replace the last in-progress compact block if one exists
        const lastInProgressIdx = state.blocks.findLastIndex(
          b => b.type === "compact" && b.inProgress,
        )
        if (lastInProgressIdx >= 0) {
          const blocks = [...state.blocks]
          blocks[lastInProgressIdx] = compactBlock
          return { ...next, blocks }
        }

        // Dedup adjacent back-to-back completion compacts (Codex dual-event).
        const lastBlock = state.blocks[state.blocks.length - 1]
        if (
          lastBlock &&
          lastBlock.type === "compact" &&
          !lastBlock.inProgress &&
          lastBlock.trigger === event.trigger
        ) {
          const merged: Block = {
            type: "compact",
            summary: cleanSummary || lastBlock.summary,
            trigger: event.trigger ?? lastBlock.trigger,
            preTokens: event.preTokens ?? lastBlock.preTokens,
            postTokens: event.postTokens ?? lastBlock.postTokens,
            durationMs: event.durationMs ?? lastBlock.durationMs,
          }
          const blocks = [...state.blocks]
          blocks[blocks.length - 1] = merged
          return { ...next, blocks }
        }
      }

      return {
        ...next,
        blocks: [...state.blocks, compactBlock],
      }
    }

    // ----- Model changed -----

    case "model_changed":
      return {
        ...next,
        currentModel: event.model,
      }

    case "effort_changed":
      return {
        ...next,
        currentEffort: event.effort,
      }

    // ----- System messages -----

    case "system_message":
      return {
        ...next,
        blocks: [...state.blocks, {
          type: "system",
          text: event.text,
          ...(event.ephemeral ? { ephemeral: true } : {}),
        }],
      }

    // ----- Shell commands -----

    case "shell_start": {
      return {
        ...next,
        blocks: [...state.blocks, {
          type: "shell" as const,
          id: event.id,
          command: event.command,
          output: "",
          status: "running" as const,
          startTime: Date.now(),
        }],
      }
    }

    case "shell_end": {
      return {
        ...next,
        blocks: state.blocks.map(b =>
          b.type === "shell" && b.id === event.id
            ? {
                ...b,
                status: event.error ? "error" as const : "done" as const,
                output: event.output,
                error: event.error,
                exitCode: event.exitCode,
                duration: Date.now() - b.startTime,
              }
            : b
        ),
      }
    }

    // ----- Task backgrounding -----

    case "task_background":
      // Only allow backgrounding during RUNNING state
      if (state.sessionState !== "RUNNING") return next
      return { ...next, backgrounded: true }

    case "task_foreground":
      // Only allow foregrounding when backgrounded
      if (!state.backgrounded) return next
      return { ...next, backgrounded: false }

    // ----- Config options -----

    case "config_options":
      return {
        ...next,
        configOptions: event.options,
      }

    // ----- Worktree / cwd lifecycle -----
    //
    // Synthesized by the Claude event-mapper when the agent's built-in
    // EnterWorktree / ExitWorktree tools finish. These are pure metadata
    // events — no blocks are appended, keeping the transcript clean. The
    // header bar consumes `worktree` and `currentCwd` via SessionContextState.

    case "worktree_created":
      return {
        ...next,
        worktree: { path: event.path, name: event.name },
      }

    case "worktree_removed":
      // Only clear if the removed path matches the active worktree. Guards
      // against stale events (e.g. a sub-agent removing a different worktree
      // after the user already exited the primary one).
      if (next.worktree?.path === event.path) {
        return { ...next, worktree: null }
      }
      return next

    case "cwd_changed":
      return { ...next, currentCwd: event.newCwd }

    // ----- Informational / passthrough -----

    case "session_state":
      return next

    // ----- Session resume lifecycle (SystemEvent) -----
    //
    // These events are emitted by the TUI sync layer (or, for native-replay
    // backends like Gemini, by the adapter itself). They have no equivalent
    // in any backend's protocol — they exist to coordinate the resume UX.

    case "history_load_started":
      return { ...next, resuming: true }

    case "history_loaded": {
      // Append the resume summary as the boundary marker between loaded-from-
      // disk history and whatever the user does next. The component rendering
      // this block shows tokens, context %, cost, last-active — the signal
      // the user needs to decide whether continuing is worthwhile.
      const block: Block = {
        type: "session_resume_summary",
        ...event.summary,
        // `summary` on the wire repeats sessionId/origin/target; make sure
        // the event-level values win so a mismatch (e.g. target inferred
        // late) doesn't leak stale data.
        sessionId: event.sessionId,
        origin: event.origin,
        target: event.target,
      }
      return {
        ...next,
        resuming: false,
        blocks: [...next.blocks, block],
      }
    }

    case "history_load_failed": {
      const detailLine = event.details ? `\n     Details: ${event.details}` : ""
      const pathLine = event.filePath ? `\n     File:     ${event.filePath}` : ""
      const errorBlock: Block = {
        type: "error",
        code: "history_load_failed",
        message:
          `Failed to resume session` +
          `\n     Session:  ${event.sessionId}` +
          pathLine +
          `\n     Error:    ${event.error}` +
          detailLine +
          `\n\n     Starting a fresh session instead.`,
      }
      return {
        ...next,
        resuming: false,
        blocks: [...next.blocks, errorBlock],
      }
    }

    case "backend_specific": {
      const data = event.data as Record<string, unknown> | null

      // Handle ACP agent slash commands
      if (data && (data as { type?: string }).type === "available_commands") {
        const commands = (data as { commands?: unknown[] }).commands
        if (Array.isArray(commands)) {
          return {
            ...next,
            agentCommands: commands
              .map((c: unknown) => {
                const cmd = c as Record<string, unknown>
                return {
                  name: String(cmd.name ?? ""),
                  description: cmd.description ? String(cmd.description) : undefined,
                }
              })
              .filter((c) => c.name),
          }
        }
      }

      return next
    }

    case "rate_limit_update": {
      // Fold a single window's usage snapshot into ConversationState.rateLimits.
      //
      //  - `utilization` (0–1) is the preferred signal; we multiply by 100 for
      //    the status bar's usedPercentage scale.
      //  - `surpassedThreshold` (0–1) is a fallback hint when the SDK hasn't
      //    computed utilization yet.
      //  - `status` gives us a best-effort floor when neither number is set:
      //    rejected ⇒ 100%, allowed_warning ⇒ 80% (conservative estimate).
      //
      // If we can't derive any usedPercentage, we drop the update — the status
      // bar has no meaningful way to render "unknown %" alongside real numbers.
      let usedPct: number | undefined
      if (typeof event.utilization === "number") {
        usedPct = event.utilization * 100
      } else if (typeof event.surpassedThreshold === "number") {
        usedPct = event.surpassedThreshold * 100
      } else if (event.status === "rejected") {
        usedPct = 100
      } else if (event.status === "allowed_warning") {
        usedPct = 80
      }
      if (usedPct === undefined) return next

      const entry: import("./types").RateLimitEntry = {
        usedPercentage: usedPct,
        resetsAt: event.resetsAt,
        windowDurationMins: event.windowDurationMins,
      }
      const rl = next.rateLimits ? { ...next.rateLimits } : {}
      switch (event.rateLimitType) {
        case "five_hour":
          rl.fiveHour = entry
          break
        case "seven_day":
        case "seven_day_opus":
        case "seven_day_sonnet":
          rl.sevenDay = entry
          break
        case "primary":
          rl.primary = entry
          break
        case "secondary":
          rl.secondary = entry
          break
        case "overage":
          // Overage credits live alongside the primary 5h/7d window — we
          // don't have a dedicated slot today, so stash them on `primary`
          // unless a real primary entry already exists. Keeps the data
          // reachable without reshaping RateLimits.
          if (!rl.primary) rl.primary = entry
          break
      }
      next.rateLimits = rl
      return next
    }

    default:
      // Unknown event type: record but don't crash
      return next
  }
}
