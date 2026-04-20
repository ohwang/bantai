/**
 * SDK Message -> AgentEvent mapping
 *
 * Pure functions that convert Claude Agent SDK messages and stream events
 * into the protocol's AgentEvent type. Stateful tool input accumulation
 * is managed by the ToolStreamState class.
 */

import { log } from "../../utils/logger"
import type { AgentEvent, ModelInfo } from "../../protocol/types"

// ---------------------------------------------------------------------------
// Error message cleanup
// ---------------------------------------------------------------------------

/** Strip stack traces and dedup repeated error messages for clean display */
function cleanErrorMessage(errors: string[] | undefined): string | undefined {
  if (!errors || errors.length === 0) return undefined

  const cleaned = errors.map(e => {
    // Strip stack trace lines (lines starting with whitespace + "at ")
    const lines = e.split("\n")
    const meaningful = lines.filter(l => !l.match(/^\s+at\s/))
    return meaningful.join("\n").trim()
  })

  // Dedup identical messages (SDK often repeats the same error 3x)
  const unique = [...new Set(cleaned)].filter(Boolean)

  // Join unique errors, cap at 200 chars
  const joined = unique.join("; ")
  return joined.length > 200 ? joined.slice(0, 197) + "..." : joined
}

// ---------------------------------------------------------------------------
// Worktree output synthesis
//
// The Claude SDK ships built-in `EnterWorktree` and `ExitWorktree` tools.
// When they succeed, their JSON output carries everything the TUI needs
// (worktreePath, worktreeBranch, originalCwd, action). We translate those
// into synthetic `worktree_created` / `worktree_removed` / `cwd_changed`
// AgentEvents so the reducer can fold worktree state into ConversationState
// and the header bar can show a "(worktree: <name>)" badge.
//
// We do this here, at the event-mapper, rather than registering SDK hooks
// (WorktreeCreate / WorktreeRemove): those hooks REPLACE the SDK's default
// git-worktree creation, so returning an observer-style `{ continue: true }`
// from them causes the tool call to fail ("hook handled but provided no
// worktreePath"). Observing the tool_use_end output is non-intrusive.
// ---------------------------------------------------------------------------

/** Try to parse the tool_use_end `output` string as a JSON object.
 *  Returns null for anything that isn't a `{...}` payload so non-JSON
 *  outputs don't trigger false positives. */
function parseToolOutputJson(output: string): Record<string, unknown> | null {
  if (!output) return null
  const trimmed = output.trim()
  if (!trimmed.startsWith("{")) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Derive a short display name from an absolute worktree path:
 *    /repo/.claude/worktrees/auth-refactor -> "auth-refactor". */
function worktreeNameFromPath(path: string): string {
  if (!path) return ""
  const segs = path.split("/").filter(Boolean)
  return segs[segs.length - 1] ?? ""
}

/** Strip trailing sentence punctuation from a path captured by regex
 *  (paths can't end in `.`, `,`, `;`, `:`, `!`, `?`). */
function trimPathPunctuation(path: string): string {
  return path.replace(/[.,;:!?]+$/, "")
}

/**
 * Extract `{ worktreePath, originalCwd?, action? }` from the tool's output.
 *
 * The SDK declares structured types for these tools in sdk-tools.d.ts
 * (EnterWorktreeOutput / ExitWorktreeOutput), but what actually reaches the
 * agent via `tool_result` is the tool's plain-text message, e.g.
 *
 *   EnterWorktree: "Created worktree at /repo/.claude/worktrees/feature-x
 *                   on branch worktree-feature-x. The session is now working
 *                   in the worktree."
 *
 *   ExitWorktree (keep):   "Exited worktree. Your work is preserved at
 *                           /repo/.claude/worktrees/feature-x on branch
 *                           worktree-feature-x. Session is now back in /repo."
 *
 *   ExitWorktree (remove): "Removed worktree at /repo/.claude/worktrees/…
 *                           Session is now back in /repo."
 *
 * This parser handles both the (unlikely) JSON envelope and the common
 * message-text form via regex. Field absence is communicated with empty
 * strings — the caller decides whether that's a fatal gap.
 *
 * Regex notes:
 *   - Paths are matched greedily up to whitespace (NOT up to `.`) because
 *     worktree paths contain dots inside segments (`.claude/worktrees/…`).
 *   - Trailing sentence punctuation is stripped post-match.
 *   - `back in /path` specifically targets the "session is now back in …"
 *     phrase common to both keep and remove exits, giving us originalCwd.
 */
function parseWorktreeOutput(
  toolName: string,
  output: string,
): { worktreePath: string; originalCwd: string; action: string } {
  // Prefer structured JSON if the SDK ever starts returning it.
  const json = parseToolOutputJson(output)
  if (json) {
    return {
      worktreePath: typeof json.worktreePath === "string" ? json.worktreePath : "",
      originalCwd: typeof json.originalCwd === "string" ? json.originalCwd : "",
      action: typeof json.action === "string" ? json.action : "",
    }
  }

  const text = output.trim()

  // Worktree path: "(created|preserved|kept|removed) … at /path …"
  const pathMatch = text.match(/\bat\s+(\/\S+)/)
  const worktreePath = pathMatch ? trimPathPunctuation(pathMatch[1]!) : ""

  // Original cwd (ExitWorktree only): "back in /path"
  let originalCwd = ""
  if (toolName === "ExitWorktree") {
    const backMatch = text.match(/\bback in\s+(\/\S+)/i)
    if (backMatch) originalCwd = trimPathPunctuation(backMatch[1]!)
  }

  // Action (ExitWorktree only). `Removed worktree` is unambiguous remove;
  // "preserved" / "Kept worktree" / bare "Exited worktree" all mean keep.
  // We default to "keep" when we see Exit-style text but no remove signal,
  // so the worktree state clears in every success case.
  let action = ""
  if (toolName === "ExitWorktree") {
    if (/\bRemoved worktree\b/i.test(text)) action = "remove"
    else if (/\b(Kept worktree|preserved|Exited worktree)\b/i.test(text)) action = "keep"
  }

  return { worktreePath, originalCwd, action }
}

/**
 * Synthesize worktree / cwd events from a completed EnterWorktree or
 * ExitWorktree tool call's output. Returns an empty array when the output
 * can't be parsed or the tool isn't worktree-related.
 *
 * EnterWorktree always chdir's into the worktree, so we emit cwd_changed
 * alongside worktree_created. ExitWorktree returns the agent to its
 * original cwd (whether action is "keep" or "remove"), so we would emit
 * cwd_changed there too — but the tool's text output doesn't carry the
 * originalCwd, so we skip cwd_changed on exit and rely on the header
 * falling back to `agent.config.cwd` once `worktree` is null again.
 * We emit worktree_removed only on "remove".
 */
export function synthesizeWorktreeEvents(
  toolName: string,
  output: string,
): AgentEvent[] {
  if (toolName !== "EnterWorktree" && toolName !== "ExitWorktree") return []

  const { worktreePath, originalCwd, action } = parseWorktreeOutput(toolName, output)
  const events: AgentEvent[] = []

  if (toolName === "EnterWorktree") {
    if (!worktreePath) return []
    events.push({
      type: "worktree_created",
      name: worktreeNameFromPath(worktreePath),
      path: worktreePath,
    })
    // oldCwd isn't known from the tool's output alone; the reducer only
    // cares about newCwd. Passing "" is faithful — we really don't know.
    events.push({ type: "cwd_changed", oldCwd: "", newCwd: worktreePath })
    return events
  }

  // ExitWorktree
  if (originalCwd) {
    events.push({ type: "cwd_changed", oldCwd: worktreePath, newCwd: originalCwd })
  }
  if (action === "remove" && worktreePath) {
    events.push({ type: "worktree_removed", path: worktreePath })
  } else if (action === "keep" && worktreePath) {
    // "Keep" also exits the worktree (agent is back at originalCwd), so the
    // badge should disappear. We emit worktree_removed to clear state even
    // though the directory physically remains on disk — the state field
    // tracks the *active* worktree, not just existence.
    events.push({ type: "worktree_removed", path: worktreePath })
  }
  return events
}

// ---------------------------------------------------------------------------
// Tool input JSON accumulation state
// ---------------------------------------------------------------------------

export class ToolStreamState {
  toolInputJsons = new Map<string, string>()
  currentToolIds = new Map<number, string>()
  /** Maps tool_use_id -> tool name so the matching `tool_use_end` handler
   *  can recognize specific tools (today: EnterWorktree / ExitWorktree) and
   *  synthesize side-effect events from their JSON outputs. The SDK's
   *  `tool_result` message carries the id but not the name, so we stash
   *  the name at both `tool_use_start` emission sites (stream_event path
   *  and mapAssistantMessage path) and look it up on completion. */
  toolNamesById = new Map<string, string>()
  /** Set to true once the first stream_event is received (live streaming mode).
   *  Before this, assistant messages are treated as replayed history. */
  hasReceivedStreamEvent = false
  /** Stream events observed since the last `result` message (i.e. for the
   *  current turn). Used to decide whether a final `assistant` message is
   *  redundant with already-streamed deltas (skip) or the sole source of
   *  content for this turn (fall back to mapAssistantMessage).
   *
   *  Why we need this in addition to hasReceivedStreamEvent: that flag is
   *  sticky for the adapter's lifetime. The SDK can stop streaming partials
   *  mid-session (observed in the wild after tool-use turns) and without this
   *  per-turn counter every subsequent assistant message gets silently dropped
   *  — the UI hangs on user_message → turn_complete with nothing between. */
  streamEventsThisTurn = 0
  /** Time-to-first-token (ms) for the current turn, captured from the first
   *  `SDKPartialAssistantMessage.ttft_ms` we observe and held until the next
   *  `result` (turn_complete) flushes it onto the outgoing event. SDK 0.2.112+
   *  attaches `ttft_ms` to partial assistant messages; we only need the first
   *  non-null value per turn (subsequent partials in the same turn carry the
   *  same figure). Reset on `result` alongside streamEventsThisTurn. */
  ttftMsThisTurn: number | undefined = undefined
}

// ---------------------------------------------------------------------------
// SDK message -> AgentEvent[]
// ---------------------------------------------------------------------------

export interface MapperOptions {
  /** Map assistant messages to text/tool events. V2 needs this (no stream_events). V1 does not (would double-emit). */
  mapAssistant?: boolean
}

export function mapSDKMessage(msg: any, streamState: ToolStreamState, options?: MapperOptions): AgentEvent[] {
  const events: AgentEvent[] = []

  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        // Extract context window from model string suffix.
        // Formats seen in the wild:
        //   "claude-opus-4-6 [1M context]"   — SDK display format
        //   "claude-opus-4-6[1m]"            — claude-code internal format
        //   "opus[1m]"                       — short alias with suffix
        //   "claude-opus-4-6 (1M context)"   — parenthetical variant
        let contextWindow: number | undefined
        const ctxMatch = msg.model?.match(/[\[(](\d+)([KkMm])\s*(?:context|tokens?)?[\])]/)
        if (ctxMatch) {
          const num = parseInt(ctxMatch[1])
          const unit = ctxMatch[2].toUpperCase()
          contextWindow = unit === "M" ? num * 1_000_000 : num * 1_000
        }
        const cleanModel = msg.model?.replace(/\s*[\[(]\d+[KkMm]\s*(?:context|tokens?)?[\])]\s*$/, "").trim()
        const models: ModelInfo[] = cleanModel
          ? [{ id: cleanModel, name: cleanModel, provider: "anthropic", contextWindow }]
          : []
        const initEvent: AgentEvent = {
          type: "session_init",
          tools: (msg.tools ?? []).map((t: string) => ({
            name: t,
          })),
          models,
          account: msg.account,
        }
        // Extract session ID if present on init message
        if (msg.session_id) {
          (initEvent as any).sessionId = msg.session_id
        }
        events.push(initEvent)
      } else if (msg.subtype === "status") {
        if (msg.status === "compacting") {
          // Emit an in-progress compact event so the TUI can show a spinner.
          // The definitive compact_boundary event below replaces this block
          // with the final summary once compaction completes.
          events.push({
            type: "compact",
            summary: "Compacting conversation...",
            inProgress: true,
            trigger: "user",
          })
        } else if (msg.compact_result || msg.compact_error) {
          // SDK 0.2.107+: status transitioned from compacting — compact_result/compact_error
          // on the status message tells us the outcome before compact_boundary arrives.
          const summary = msg.compact_error
            ? `Compaction failed: ${msg.compact_error}`
            : msg.compact_result === "success"
              ? "Conversation compacted."
              : String(msg.compact_result ?? "Conversation compacted.")
          events.push({
            type: "compact",
            summary,
            inProgress: false,
            trigger: "user",
          })
        } else if (msg.status === "requesting") {
          // SDK 0.2.112+: backend is making an API request — informational status
          log.debug("SDK status: requesting", { session_id: msg.session_id })
        } else {
          log.debug("Unhandled system status", { status: msg.status })
        }
      } else if (msg.subtype === "compact_boundary") {
        const meta = msg.compact_metadata ?? {}
        const trigger = meta.trigger === "auto" ? "auto" as const : "user" as const
        const preTokens = typeof meta.pre_tokens === "number" ? meta.pre_tokens : undefined
        const postTokens = typeof meta.post_tokens === "number" ? meta.post_tokens : undefined
        const durationMs = typeof meta.duration_ms === "number" ? meta.duration_ms : undefined

        // Build summary from metadata
        const parts: string[] = []
        if (meta.summary) {
          parts.push(String(meta.summary))
        } else {
          parts.push("Conversation compacted.")
        }

        events.push({
          type: "compact",
          summary: parts.join(" "),
          trigger,
          preTokens,
          postTokens,
          durationMs,
        })
      } else if (msg.subtype === "local_command_output") {
        // Strip SDK XML tags (e.g., <local-command-stdout>Compacted </local-command-stdout>)
        // and suppress empty/trivial output (compact already has its own UI block)
        const cleaned = (msg.content ?? "").replace(/<\/?local-command-\w+>/g, "").trim()
        if (cleaned && cleaned.toLowerCase() !== "compacted") {
          events.push({
            type: "system_message",
            text: cleaned,
          })
        } else {
          log.debug("Suppressed trivial local_command_output", { raw: msg.content })
        }
      } else if (msg.subtype === "memory_recall") {
        // SDK 0.2.107+: memory recall supervisor surfaced relevant memories
        const memories = msg.memories ?? []
        if (memories.length > 0) {
          const lines = memories.map((m: any) => {
            const scope = m.scope === "team" ? "[team]" : "[personal]"
            const path = m.path ?? "unknown"
            return `  ${scope} ${path}`
          })
          const mode = msg.mode === "synthesize" ? "Synthesized" : "Recalled"
          const noun = memories.length === 1 ? "memory" : "memories"
          events.push({
            type: "system_message",
            text: `${mode} ${memories.length} ${noun}:\n${lines.join("\n")}`,
          })
        } else {
          log.debug("memory_recall with empty memories array", { mode: msg.mode })
        }
      } else if (msg.subtype === "notification") {
        // SDK 0.2.107+: text notification from the loop side
        const priority = msg.priority ?? "medium"
        const text = msg.text ?? msg.key ?? "Notification"
        if (priority === "low") {
          log.debug("Low-priority notification", { key: msg.key, text })
        }
        events.push({
          type: "system_message",
          text,
          ephemeral: true,
        })
      } else if (msg.subtype === "task_updated") {
        // SDK 0.2.107+: granular task state patch
        const taskId = msg.task_id
        if (taskId && msg.patch) {
          const patch: Record<string, unknown> = {}
          if (msg.patch.status != null) patch.status = msg.patch.status
          if (msg.patch.description != null) patch.description = msg.patch.description
          if (msg.patch.end_time != null) patch.endTime = msg.patch.end_time
          if (msg.patch.total_paused_ms != null) patch.totalPausedMs = msg.patch.total_paused_ms
          if (msg.patch.error != null) patch.error = msg.patch.error
          if (msg.patch.is_backgrounded != null) patch.isBackgrounded = msg.patch.is_backgrounded
          events.push({
            type: "task_updated",
            taskId,
            patch,
          })
        } else {
          log.warn("task_updated missing task_id or patch", { keys: Object.keys(msg).join(",") })
        }
      } else if (msg.subtype === "task_started") {
        // Real SDK shape: { type: "system", subtype: "task_started", task_id, tool_use_id,
        //                   description, task_type, workflow_name, prompt, skip_transcript }
        events.push(mapTaskStartedMessage(msg))
      } else if (msg.subtype === "task_progress") {
        // Real SDK shape: { type: "system", subtype: "task_progress", task_id, tool_use_id,
        //                   description, usage: { total_tokens, tool_uses, duration_ms },
        //                   last_tool_name, summary }
        events.push(mapTaskProgressMessage(msg))
      } else if (msg.subtype === "task_notification") {
        // Real SDK shape: { type: "system", subtype: "task_notification", task_id, tool_use_id,
        //                   status: "completed"|"failed"|"stopped", output_file, summary, usage,
        //                   skip_transcript }
        events.push(mapTaskNotificationMessage(msg))
      } else if (msg.subtype === "plugin_install") {
        // SDK 0.2.112+: headless plugin installation progress.
        // status: started → installed/failed (per plugin) → completed
        if (msg.status === "failed") {
          log.warn("Plugin install failed", { name: msg.name, error: msg.error })
          events.push({
            type: "system_message",
            text: `Plugin install failed: ${msg.name ?? "unknown"}${msg.error ? ` — ${msg.error}` : ""}`,
          })
        } else if (msg.status === "installed") {
          log.info("Plugin installed", { name: msg.name })
          events.push({
            type: "system_message",
            text: `Plugin installed: ${msg.name}`,
          })
        } else {
          // started / completed — bookend events, debug-level
          log.debug("Plugin install status", { status: msg.status, name: msg.name })
        }
      } else if (msg.subtype === "api_retry") {
        // SDK 0.2.112+: retryable API error — the backend will retry after
        // retry_delay_ms. Shape: SDKAPIRetryMessage. error_status is null for
        // connection-layer errors (timeouts) that never got an HTTP response.
        // Retries are a normal, expected condition so we log at info (not warn,
        // which per AGENTS.md is reserved for protocol drift) and surface an
        // ephemeral system_message so the user knows why the turn is stalling.
        const attempt = typeof msg.attempt === "number" ? msg.attempt : undefined
        const maxRetries = typeof msg.max_retries === "number" ? msg.max_retries : undefined
        const delaySec = typeof msg.retry_delay_ms === "number"
          ? (msg.retry_delay_ms / 1000).toFixed(1)
          : undefined
        const reason = msg.error ?? "unknown"
        const statusPart = msg.error_status != null ? ` (HTTP ${msg.error_status})` : ""
        const attemptPart = attempt != null && maxRetries != null ? ` ${attempt}/${maxRetries}` : ""
        const delayPart = delaySec != null ? ` in ${delaySec}s` : ""

        log.info("API retry", {
          attempt,
          maxRetries,
          retryDelayMs: msg.retry_delay_ms,
          errorStatus: msg.error_status,
          error: reason,
        })
        events.push({
          type: "system_message",
          text: `Retrying API request${attemptPart}${delayPart} — ${reason}${statusPart}`,
          ephemeral: true,
        })
      } else if (msg.subtype === "request_user_dialog") {
        // SDK 0.2.107+: tool-driven blocking dialog request. bantai does not yet
        // render these dialogs — log a warning and pass through as backend_specific
        // so the event is not silently dropped.
        log.warn("Unhandled control request: request_user_dialog", {
          dialogKind: msg.dialog_kind,
          toolUseId: msg.tool_use_id,
          keys: Object.keys(msg).join(","),
        })
        events.push({
          type: "backend_specific",
          backend: "claude",
          data: msg,
        })
      } else if (msg.subtype === "mirror_error") {
        // SDK 0.2.114+: SessionStore.append() rejected or timed out for a
        // transcript-mirror batch. The batch is dropped (at-most-once delivery);
        // bantai does not configure a sessionStore today, so this is effectively
        // dead code — but log at warn so we notice if a future config path
        // enables mirroring and the adapter is silently failing.
        log.warn("Session transcript mirror batch dropped", {
          error: msg.error,
          projectKey: msg.key?.projectKey,
          sessionId: msg.key?.sessionId,
          subpath: msg.key?.subpath,
        })
        events.push({
          type: "system_message",
          text: `Session transcript mirror failed: ${msg.error ?? "unknown error"}`,
          ephemeral: true,
        })
      } else {
        // Catch-all for unknown system subtypes — never silently drop events
        log.warn("Unhandled system subtype", { subtype: msg.subtype, keys: Object.keys(msg).join(",") })
        events.push({
          type: "backend_specific",
          backend: "claude",
          data: msg,
        })
      }
      break

    case "stream_event":
      streamState.hasReceivedStreamEvent = true
      streamState.streamEventsThisTurn++
      // Capture time-to-first-token (SDK 0.2.112+). We keep the first
      // reported value per turn; subsequent partials usually carry the same
      // number, and we want the earliest one we see. Sub-agent partials
      // carry their own ttft but we don't separate them today — the main
      // turn's ttft is what the status bar surfaces.
      if (
        streamState.ttftMsThisTurn === undefined &&
        typeof msg.ttft_ms === "number" &&
        !msg.parent_tool_use_id
      ) {
        streamState.ttftMsThisTurn = msg.ttft_ms
      }
      if (msg.parent_tool_use_id) {
        // Sub-agent stream event — extract tool activity for skill/agent progress
        events.push(...mapSkillStreamEvent(msg.event, msg.parent_tool_use_id))
      } else {
        events.push(...mapStreamEvent(msg.event, msg.parent_tool_use_id, streamState))
      }
      break

    case "assistant":
      if (msg.parent_tool_use_id) {
        // Sub-agent assistant message — extract tool_use blocks for skill progress.
        // These carry the sub-agent's tool invocations (Read, Bash, Edit, etc.).
        const content = msg.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use") {
              events.push({
                type: "skill_tool_activity",
                parentToolUseId: msg.parent_tool_use_id,
                toolName: block.name,
                toolId: block.id,
                status: "running",
              })
            }
          }
        }
        if (events.length === 0) {
          log.debug("Sub-agent assistant message without tool_use blocks", { parentToolUseId: msg.parent_tool_use_id })
        }
      } else if (options?.mapAssistant) {
        // Full assistant message (contains complete content blocks).
        // V2 live mode — result message handles turn_complete
        events.push(...mapAssistantMessage(msg, streamState))
      } else if (!streamState.hasReceivedStreamEvent) {
        // Replay mode (resume/continue) — no stream_events yet, so assistant
        // messages are historical. Map content and add synthetic turn_complete
        // so the reducer transitions RUNNING → IDLE between replayed turns.
        events.push(...mapAssistantMessage(msg, streamState))
        events.push({
          type: "turn_complete",
          usage: { inputTokens: 0, outputTokens: 0 },
        })
      } else if (streamState.streamEventsThisTurn === 0) {
        // V1 live mode fallback: the SDK is in live mode (we've received
        // stream_events earlier in the session) but THIS turn arrived with
        // no stream_events at all — just the final assistant message. If we
        // skip here the user sees user_message → turn_complete with no
        // response content. Observed in the wild after tool-use turns where
        // the SDK collapses partials into a single final message.
        //
        // Map the assistant message directly. The result message that
        // follows will emit turn_complete, so no synthetic one here.
        const content = msg.message?.content
        log.warn("V1 assistant arrived with no stream events this turn — mapping final message", {
          contentBlocks: Array.isArray(content) ? content.length : 0,
          textChars: Array.isArray(content)
            ? content
                .filter((b: any) => b?.type === "text" && typeof b.text === "string")
                .reduce((n: number, b: any) => n + b.text.length, 0)
            : 0,
          toolUses: Array.isArray(content)
            ? content.filter((b: any) => b?.type === "tool_use").length
            : 0,
        })
        events.push(...mapAssistantMessage(msg, streamState))
      }
      // V1 live mode with streams this turn: skip — deltas already handled content
      break

    case "result": {
      // Extract session ID from result messages (matches claude-go's ResultMessage.SessionID)
      const resultSessionId: string | undefined = msg.session_id || undefined
      // Flush captured time-to-first-token onto the turn_complete event so
      // the reducer can expose it on ConversationState. Undefined is fine —
      // the reducer preserves the previous value when the field is absent.
      const ttftMs = streamState.ttftMsThisTurn
      if (msg.subtype === "success" || !msg.is_error) {
        events.push({
          type: "turn_complete",
          sessionId: resultSessionId,
          ttftMs,
          usage: {
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
            cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0,
            cacheWriteTokens: msg.usage?.cache_creation_input_tokens ?? 0,
            totalCostUsd: msg.total_cost_usd ?? 0,
          },
        })
      } else {
        events.push({
          type: "error",
          code: msg.subtype ?? "error_during_execution",
          message: cleanErrorMessage(msg.errors) ?? "Unknown error",
          severity: "fatal",
        })
        events.push({
          type: "turn_complete",
          sessionId: resultSessionId,
          ttftMs,
          usage: {
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
            totalCostUsd: msg.total_cost_usd ?? 0,
          },
        })
      }
      // Reset per-turn stream event counter and ttft capture — the next turn
      // gets a clean slate so the assistant-fallback check (see `case "assistant"`)
      // correctly detects turns where the SDK emits no stream events, and so
      // stale TTFT doesn't leak across turns when the SDK ever omits ttft_ms.
      streamState.streamEventsThisTurn = 0
      streamState.ttftMsThisTurn = undefined
      break
    }

    case "tool_progress":
      events.push({
        type: "tool_use_progress",
        id: msg.tool_use_id,
        output: msg.content ?? `[${msg.tool_name}] ${msg.elapsed_time_seconds}s elapsed`,
      })
      if (msg.parent_tool_use_id) {
        events.push({
          type: "skill_tool_activity",
          parentToolUseId: msg.parent_tool_use_id,
          toolName: msg.tool_name,
          toolId: msg.tool_use_id,
          status: "running",
        })
      }
      break

    // NOTE: These top-level cases handle the legacy pre-0.2.107 SDK shape where
    // task events were emitted as first-class types. Current SDKs emit them as
    // { type: "system", subtype: "task_started" | "task_progress" | "task_notification" }
    // which is handled in the `case "system"` branch above. Kept here for
    // backwards compatibility so both shapes route through the same mappers.
    case "task_started":
      events.push(mapTaskStartedMessage(msg))
      break

    case "task_progress":
      events.push(mapTaskProgressMessage(msg))
      break

    case "task_notification":
      events.push(mapTaskNotificationMessage(msg))
      break

    case "rate_limit":
      events.push({
        type: "error",
        code: "rate_limit",
        message: "Rate limited by API",
        severity: "recoverable",
      })
      break

    case "user": {
      // Sub-agent tool result — extract tool completion for skill progress.
      // Must come before main-conversation tool_use_result handling.
      if (msg.tool_use_result && msg.parent_tool_use_id) {
        const content = msg.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              events.push({
                type: "skill_tool_activity",
                parentToolUseId: msg.parent_tool_use_id,
                toolId: block.tool_use_id,
                status: block.is_error ? "error" : "done",
              })
            }
          }
        }
        break
      }

      // Tool result message — the SDK sends this when a tool completes.
      // Extract tool output to emit tool_use_end for result summary display.
      if (msg.tool_use_result) {
        // Find the tool_use_id from the message content blocks
        const content = msg.message?.content
        let toolUseId: string | undefined
        let output = ""
        let isError = false

        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              toolUseId = block.tool_use_id
              isError = block.is_error ?? false
              // Extract text from content
              if (typeof block.content === "string") {
                output = block.content
              } else if (Array.isArray(block.content)) {
                output = block.content
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text)
                  .join("\n")
              }
            }
          }
        }

        // Fallback 1: tool_use_id on the message itself (some SDK versions)
        if (!toolUseId && msg.tool_use_id) {
          toolUseId = msg.tool_use_id
        }

        // Fallback 2: extract output from tool_use_result directly
        if (!toolUseId || !output) {
          if (typeof msg.tool_use_result === "string") {
            output = output || msg.tool_use_result
          } else if (typeof msg.tool_use_result === "object" && msg.tool_use_result !== null) {
            // SDK may wrap result in an object with content/error fields
            const r = msg.tool_use_result as Record<string, unknown>
            if (r.tool_use_id && !toolUseId) toolUseId = String(r.tool_use_id)
            if (r.is_error) isError = true
            if (r.content && !output) output = String(r.content)
            if (r.error) {
              isError = true
              output = output || String(r.error)
            }
          }
        }

        // Fallback 3: check msg-level is_error flag
        if (msg.is_error === true) {
          isError = true
        }

        if (toolUseId) {
          events.push({
            type: "tool_use_end",
            id: toolUseId,
            output,
            error: isError ? output : undefined,
          })
          // Worktree side-effect synthesis: EnterWorktree / ExitWorktree are
          // SDK built-ins. When they succeed, emit synthetic worktree_* and
          // cwd_changed events so the reducer can update ConversationState
          // and the header bar can render a "(worktree: <name>)" badge.
          // Skipped on error — a failed tool call leaves no worktree.
          const toolName = streamState.toolNamesById.get(toolUseId)
          if (!isError && (toolName === "EnterWorktree" || toolName === "ExitWorktree")) {
            const synthesized = synthesizeWorktreeEvents(toolName, output)
            if (synthesized.length > 0) {
              events.push(...synthesized)
              log.info("Worktree events synthesized", {
                toolName,
                count: synthesized.length,
                types: synthesized.map(e => e.type),
              })
            } else {
              log.warn("Worktree tool finished but output was unparseable", {
                toolName,
                outputHead: output.slice(0, 200),
              })
            }
          }
          streamState.toolNamesById.delete(toolUseId)
        } else {
          // Last resort: find the most recently started tool that's still
          // running and close it. Without this, the tool block spins forever
          // because we can't match the result to its tool_use_start.
          log.warn("Tool result missing tool_use_id — closing last running tool", {
            keys: Object.keys(msg).join(","),
            resultType: typeof msg.tool_use_result,
            hasMessage: !!msg.message,
            contentLength: Array.isArray(content) ? content.length : 0,
          })
          events.push({
            type: "tool_use_end",
            id: "__last_running__",
            output,
            error: isError ? output : undefined,
          })
        }
      } else if (msg.parent_tool_use_id) {
        // Sub-agent prompt (no tool_use_result) — already displayed by
        // AgentToolView/SkillToolView via the parent tool block.
        log.debug("Suppressed sub-agent prompt", { parentToolUseId: msg.parent_tool_use_id })
        break
      } else if (msg.isSynthetic) {
        // Synthetic user message — SDK-internal injection (e.g., inline skill
        // prompt content, meta-messages). Hidden in Claude Code's own UI;
        // should not render as a user message block in bantai either.
        log.debug("Suppressed synthetic user message", { uuid: msg.uuid })
        break
      } else {
        // Replayed user message (resume/continue) — extract text content.
        // During live operation the SDK doesn't echo user messages back,
        // so this path only fires for historical replay.
        const content = msg.message?.content
        let text = ""
        if (typeof content === "string") {
          text = content
        } else if (Array.isArray(content)) {
          text = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n")
        }
        if (text) {
          events.push({ type: "user_message", text })
        }
      }
      break
    }

    case "rate_limit_event": {
      // Informational event showing current claude.ai subscription usage for
      // one bucket (5hr / 7day / 7day_opus / 7day_sonnet / overage). Not an
      // error. Forward as a typed rate_limit_update so the reducer can fold
      // it into ConversationState.rateLimits.
      const info = (msg.rate_limit_info ?? {}) as Record<string, unknown>
      log.debug("Rate limit info", { data: info })
      const rateLimitType = info.rateLimitType
      if (
        rateLimitType === "five_hour" ||
        rateLimitType === "seven_day" ||
        rateLimitType === "seven_day_opus" ||
        rateLimitType === "seven_day_sonnet" ||
        rateLimitType === "overage"
      ) {
        events.push({
          type: "rate_limit_update",
          rateLimitType,
          status: typeof info.status === "string" ? (info.status as any) : undefined,
          utilization: typeof info.utilization === "number" ? info.utilization : undefined,
          surpassedThreshold: typeof info.surpassedThreshold === "number" ? info.surpassedThreshold : undefined,
          resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : undefined,
          isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : undefined,
          overageStatus: typeof info.overageStatus === "string" ? (info.overageStatus as any) : undefined,
          overageResetsAt: typeof info.overageResetsAt === "number" ? info.overageResetsAt : undefined,
          overageDisabledReason: typeof info.overageDisabledReason === "string" ? info.overageDisabledReason : undefined,
          source: "claude",
        })
      } else {
        // Missing / unknown rateLimitType — keep the raw payload around via
        // backend_specific so we can diagnose upstream shape changes.
        log.warn("rate_limit_event without a recognizable rateLimitType", { rateLimitType, info })
        events.push({
          type: "backend_specific",
          backend: "claude",
          data: msg,
        })
      }
      break
    }

    default:
      // Log unhandled message types as warnings so we can add handlers
      log.warn("Unhandled SDK message type", { type: msg.type, subtype: msg.subtype, keys: Object.keys(msg).join(",") })
      events.push({
        type: "backend_specific",
        backend: "claude",
        data: msg,
      })
  }

  return events
}

// ---------------------------------------------------------------------------
// Task event mappers (SDK task_started / task_progress / task_notification)
// ---------------------------------------------------------------------------
//
// Modern SDKs (0.2.107+) emit these as { type: "system", subtype: "task_*" }.
// Legacy SDKs emitted them as first-class { type: "task_*" } messages. Both
// shapes carry the same fields; these helpers normalize them into AgentEvents.

function mapTaskStartedMessage(msg: any): AgentEvent {
  return {
    type: "task_start",
    taskId: msg.task_id ?? msg.uuid,
    description: msg.description ?? "Background task",
    toolUseId: msg.tool_use_id ?? undefined,
    taskType: msg.task_type ?? undefined,
    skipTranscript: msg.skip_transcript ?? undefined,
  }
}

function mapTaskProgressMessage(msg: any): AgentEvent {
  // Prefer `description` (current SDK field) over `content` (legacy) for output.
  const output = msg.description ?? msg.content ?? msg.summary ?? ""
  const progressEvent: AgentEvent = {
    type: "task_progress",
    taskId: msg.task_id ?? msg.uuid,
    output,
    lastToolName: msg.last_tool_name ?? undefined,
    summary: msg.summary ?? undefined,
  }
  if (msg.usage?.total_tokens) {
    (progressEvent as any).tokenUsage = {
      inputTokens: msg.usage.input_tokens ?? 0,
      outputTokens: msg.usage.output_tokens ?? 0,
      totalTokens: msg.usage.total_tokens,
    }
  }
  if (msg.tool_use_count != null) {
    (progressEvent as any).toolUseCount = msg.tool_use_count
  } else if (msg.usage?.tool_uses != null) {
    (progressEvent as any).toolUseCount = msg.usage.tool_uses
  }
  if (msg.turn_count != null) {
    (progressEvent as any).turnCount = msg.turn_count
  }
  return progressEvent
}

function mapTaskNotificationMessage(msg: any): AgentEvent {
  // SDK's `status` is "completed" | "failed" | "stopped". Anything that isn't
  // a clean completion maps to our "error" state so the UI reflects failure.
  const rawStatus = msg.status
  const state: "completed" | "error" | undefined =
    rawStatus === "completed"
      ? "completed"
      : rawStatus === "failed" || rawStatus === "stopped"
        ? "error"
        : undefined
  // Output precedence: explicit content/result (legacy) → summary (current SDK)
  // → a human-readable fallback derived from status.
  const output = msg.content ?? msg.result ?? msg.summary ?? (rawStatus ? `Task ${rawStatus}` : "")
  const errorMessage =
    state === "error"
      ? msg.error ?? msg.summary ?? (rawStatus === "stopped" ? "Task stopped" : "Task failed")
      : undefined

  const completeEvent: AgentEvent = {
    type: "task_complete",
    taskId: msg.task_id ?? msg.uuid,
    output,
    toolUseId: msg.tool_use_id ?? undefined,
    skipTranscript: msg.skip_transcript ?? undefined,
  }
  if (state) {
    (completeEvent as any).state = state
  }
  if (errorMessage) {
    (completeEvent as any).errorMessage = errorMessage
  }
  return completeEvent
}

// ---------------------------------------------------------------------------
// Assistant message -> AgentEvent[] (used by V2 adapter)
// ---------------------------------------------------------------------------

/**
 * Extract events from a complete assistant message.
 * V2's stream() yields these instead of stream_event deltas.
 * V1 also yields them but after stream_events — the reducer
 * handles any duplication via text_complete overwriting streamingText.
 *
 * `streamState` is optional because some call sites (tests, replay) don't
 * have one; when present, we stash tool_use_id -> tool name so the matching
 * tool_use_end can recognize specific tools (e.g. EnterWorktree) for
 * side-effect synthesis.
 */
export function mapAssistantMessage(
  msg: any,
  streamState?: ToolStreamState,
): AgentEvent[] {
  const events: AgentEvent[] = []
  const content = msg.message?.content
  if (!Array.isArray(content)) return events

  // Emit turn_start for the assistant response
  events.push({ type: "turn_start" })

  for (const block of content) {
    switch (block.type) {
      case "text":
        if (block.text) {
          events.push({ type: "text_delta", text: block.text })
        }
        break

      case "thinking":
        if (block.thinking) {
          events.push({ type: "thinking_delta", text: block.thinking })
        }
        break

      case "tool_use":
        streamState?.toolNamesById.set(block.id, block.name)
        events.push({
          type: "tool_use_start",
          id: block.id,
          tool: block.name,
          input: block.input ?? {},
        })
        // Emit progress with the full input immediately
        if (block.input) {
          events.push({
            type: "tool_use_progress",
            id: block.id,
            output: "",
            input: block.input,
          })
        }
        break

      default:
        log.warn("Unhandled assistant content block type", { type: block.type, blockId: block.id })
    }
  }

  return events
}

// ---------------------------------------------------------------------------
// Sub-agent stream event -> skill_tool_activity events
// ---------------------------------------------------------------------------

/**
 * Extract tool activity from sub-agent stream events (parent_tool_use_id set).
 * These must NOT go through mapStreamEvent — doing so would inject sub-agent
 * text_deltas and tool_use_starts into the main conversation.
 */
function mapSkillStreamEvent(
  event: any,
  parentToolUseId: string,
): AgentEvent[] {
  const events: AgentEvent[] = []

  if (event.type === "content_block_start") {
    const block = event.content_block
    if (block?.type === "tool_use") {
      events.push({
        type: "skill_tool_activity",
        parentToolUseId,
        toolName: block.name,
        toolId: block.id,
        status: "running",
      })
    }
  }
  // Other sub-agent stream events (text deltas, thinking, etc.) are intentionally
  // suppressed — the skill's text output arrives in the tool_use_end result.

  return events
}

// ---------------------------------------------------------------------------
// Stream event -> AgentEvent[]
// ---------------------------------------------------------------------------

export function mapStreamEvent(
  event: any,
  _parentToolUseId: string | null,
  streamState: ToolStreamState,
): AgentEvent[] {
  const events: AgentEvent[] = []

  switch (event.type) {
    case "message_start": {
      events.push({ type: "turn_start" })
      // Extract per-API-call input tokens for accurate context window fill.
      // The result message's usage is CUMULATIVE across all API calls in a
      // multi-step turn, so using it directly overcounts by num_turns×.
      const msgUsage = event.message?.usage
      if (msgUsage) {
        const contextFill =
          (msgUsage.input_tokens ?? 0) +
          (msgUsage.cache_read_input_tokens ?? 0) +
          (msgUsage.cache_creation_input_tokens ?? 0)
        if (contextFill > 0) {
          events.push({
            type: "cost_update",
            inputTokens: 0,
            outputTokens: 0,
            contextTokens: contextFill,
          })
        }
      }
      break
    }

    case "content_block_start": {
      const block = event.content_block
      if (block?.type === "tool_use") {
        streamState.currentToolIds.set(event.index, block.id)
        streamState.toolInputJsons.set(block.id, "")
        streamState.toolNamesById.set(block.id, block.name)
        events.push({
          type: "tool_use_start",
          id: block.id,
          tool: block.name,
          input: {},
        })
      }
      // text and thinking blocks are just markers; content comes via deltas
      break
    }

    case "content_block_delta": {
      const delta = event.delta
      if (delta?.type === "text_delta") {
        events.push({ type: "text_delta", text: delta.text })
      } else if (delta?.type === "thinking_delta") {
        events.push({ type: "thinking_delta", text: delta.thinking })
      } else if (delta?.type === "input_json_delta") {
        // Accumulate tool input JSON fragments
        const toolId = streamState.currentToolIds.get(event.index)
        if (toolId) {
          const prev = streamState.toolInputJsons.get(toolId) ?? ""
          streamState.toolInputJsons.set(toolId, prev + delta.partial_json)
        }
      }
      break
    }

    case "content_block_stop": {
      const toolId = streamState.currentToolIds.get(event.index)
      if (toolId) {
        const jsonStr = streamState.toolInputJsons.get(toolId)
        if (jsonStr) {
          try {
            const parsedInput = JSON.parse(jsonStr)
            events.push({
              type: "tool_use_progress",
              id: toolId,
              output: "",
              input: parsedInput,
            })
          } catch {
            log.warn("Failed to parse tool input JSON", { toolId, json: jsonStr.slice(0, 200) })
            // Still emit progress with the raw JSON string so the user can see inputs
            events.push({
              type: "tool_use_progress",
              id: toolId,
              output: "",
              input: jsonStr,  // Raw string instead of parsed object
            })
          }
        }
        streamState.currentToolIds.delete(event.index)
        streamState.toolInputJsons.delete(toolId)
      }
      break
    }

    case "message_delta":
      // Contains stop_reason and usage delta. Cost update.
      if (event.usage) {
        events.push({
          type: "cost_update",
          inputTokens: 0,
          outputTokens: event.usage.output_tokens ?? 0,
        })
      }
      break

    case "message_stop":
      // Message is complete. The result message follows with full usage.
      log.debug("Stream message_stop received")
      break

    default:
      log.warn("Unhandled stream event type", { type: event.type })
  }

  return events
}
