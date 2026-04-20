/**
 * Codex App-Server Event Mapper
 *
 * Maps Codex app-server notifications to the unified AgentEvent type.
 *
 * Codex's model:
 *   Thread → Turn → Item (agentMessage, commandExecution, fileChange, reasoning, etc.)
 *
 * Key mapping:
 *   thread/started       → session_init
 *   turn/started         → turn_start
 *   item/agentMessage/delta    → text_delta
 *   item/reasoning/summaryTextDelta → thinking_delta
 *   item/started (commandExecution)  → tool_use_start
 *   item/commandExecution/outputDelta → tool_use_progress
 *   item/completed (commandExecution) → tool_use_end
 *   item/started (fileChange)  → tool_use_start
 *   item/fileChange/outputDelta → tool_use_progress
 *   item/completed (fileChange) → tool_use_end
 *   item/started (mcpToolCall) → tool_use_start
 *   item/completed (mcpToolCall) → tool_use_end
 *   turn/completed       → turn_complete
 *   thread/tokenUsage/updated → cost_update
 *   thread/compacted     → compact
 *   error                → error
 */

import { log } from "../../utils/logger"
import type { AgentEvent, ModelInfo } from "../../protocol/types"
import type { CodexFileChangeEntry, CodexMcpToolResult, CodexMcpToolError, CodexMcpContentBlock } from "./codex-types"

// ---------------------------------------------------------------------------
// Codex item types (subset of the full ThreadItem union)
// ---------------------------------------------------------------------------

export interface CodexItem {
  type: string
  id: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Notification → AgentEvent mapping
// ---------------------------------------------------------------------------

export function mapCodexNotification(
  method: string,
  params: any,
): AgentEvent[] {
  const events: AgentEvent[] = []

  switch (method) {
    // ----- Thread lifecycle -----

    case "thread/started": {
      const thread = params?.thread
      const models: ModelInfo[] = []
      if (thread?.modelProvider) {
        models.push({
          id: thread.modelProvider,
          name: thread.modelProvider,
          provider: "openai",
        })
      }
      // Use Codex's real thread id as the session id — NOT a synthetic
      // crypto.randomUUID(). The synthetic id was the original shape and
      // silently broke resume everywhere: bantai persisted it into the
      // Slack store (and displayed it in the TUI session picker), but no
      // backend — not even Codex itself — could look it up. Feeding the
      // ghost id back into `thread/resume` just got a "thread not found"
      // and every cross-backend resume failed with the same "id exists
      // nowhere on disk" symptom. If `thread.id` is missing, leave
      // sessionId undefined (the type allows it) instead of inventing one.
      const threadId = typeof thread?.id === "string" && thread.id.length > 0
        ? thread.id
        : undefined
      events.push({
        type: "session_init",
        ...(threadId ? { sessionId: threadId } : {}),
        tools: [],  // Codex doesn't enumerate tools at init; they appear as items
        models,
        account: undefined,
      })
      break
    }

    case "thread/status/changed": {
      const status = params?.status
      if (status === "idle") {
        events.push({ type: "session_state", state: "idle" })
      } else if (status === "active") {
        events.push({ type: "session_state", state: "running" })
      }
      break
    }

    case "thread/name/updated":
      log.debug("Codex thread renamed", { name: params?.name })
      break

    case "thread/tokenUsage/updated": {
      const tokenUsage = params?.tokenUsage
      const usage = tokenUsage?.last ?? tokenUsage?.total
      if (usage) {
        // For OpenAI models, inputTokens already INCLUDES cachedInputTokens
        // (it's a subset, not disjoint like Anthropic's cache categories).
        // Use the "last" API call's inputTokens as contextTokens for accurate
        // context window fill — "total" is cumulative across all API calls.
        const lastUsage = tokenUsage?.last
        events.push({
          type: "cost_update",
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.cachedInputTokens ?? 0,
          contextTokens: lastUsage?.inputTokens ?? undefined,
        })
      }
      break
    }

    case "thread/compacted":
      events.push({
        type: "compact",
        summary: params?.summary ?? "Conversation compacted by Codex.",
        trigger: "auto",
        preTokens: typeof params?.preTokens === "number" ? params.preTokens : undefined,
        postTokens: typeof params?.postTokens === "number" ? params.postTokens : undefined,
      })
      break

    // ----- Turn lifecycle -----

    case "turn/started":
      events.push({ type: "turn_start" })
      break

    case "turn/completed": {
      const turn = params?.turn
      const usage = turn?.usage
      events.push({
        type: "turn_complete",
        usage: usage
          ? {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              cacheReadTokens: usage.cachedInputTokens ?? 0,
            }
          : undefined,
      })
      // If the turn failed, emit a fatal error so it appears in the TUI.
      if (turn?.status === "failed" && turn.error) {
        events.push({
          type: "error",
          code: turn.error.codexErrorInfo ?? "codex_turn_failed",
          message: turn.error.message ?? "Turn failed",
          severity: "fatal",
        })
      }
      break
    }

    // ----- Item lifecycle -----

    case "item/started": {
      const item = params?.item as CodexItem | undefined
      if (!item) break
      events.push(...mapItemStarted(item))
      break
    }

    case "item/completed": {
      const item = params?.item as CodexItem | undefined
      if (!item) break
      events.push(...mapItemCompleted(item))
      break
    }

    // ----- Streaming deltas -----

    case "item/agentMessage/delta":
      if (params?.delta) {
        events.push({ type: "text_delta", text: params.delta })
      }
      break

    case "item/reasoning/summaryTextDelta":
      if (params?.delta) {
        events.push({ type: "thinking_delta", text: params.delta })
      }
      break

    case "item/reasoning/textDelta":
      // Raw reasoning content — also map to thinking_delta
      if (params?.delta) {
        events.push({ type: "thinking_delta", text: params.delta })
      }
      break

    case "item/commandExecution/outputDelta":
      if (params?.itemId && params?.delta) {
        events.push({
          type: "tool_use_progress",
          id: params.itemId,
          output: params.delta,
        })
      }
      break

    case "item/fileChange/outputDelta":
      if (params?.itemId && params?.delta) {
        events.push({
          type: "tool_use_progress",
          id: params.itemId,
          output: params.delta,
        })
      }
      break

    case "item/plan/delta":
      // Plan text — surface as thinking since it's the agent's planning
      if (params?.delta) {
        events.push({ type: "thinking_delta", text: params.delta })
      }
      break

    // ----- Turn plan/diff updates -----

    case "turn/diff/updated":
    case "turn/plan/updated":
      // Informational — backend_specific passthrough
      events.push({
        type: "backend_specific",
        backend: "codex",
        data: { method, params },
      })
      break

    // ----- Guardian/auto-approval review -----

    case "item/guardianApprovalReview/started":
      events.push({
        type: "system_message",
        text: "Safety review in progress...",
      })
      break

    case "item/autoApprovalReview/started":
      // Auto-approval is routine — keep as backend_specific for trace observability
      events.push({
        type: "backend_specific",
        backend: "codex",
        data: { method, params },
      })
      break

    case "item/autoApprovalReview/completed":
    case "item/guardianApprovalReview/completed":
      events.push({
        type: "backend_specific",
        backend: "codex",
        data: { method, params },
      })
      break

    // ----- Server request resolved (after approval response) -----

    case "serverRequest/resolved":
      log.debug("Codex approval request resolved", { requestId: params?.requestId })
      break

    // ----- Account/model/skills updates -----

    case "model/rerouted": {
      const newModel = params?.model ?? params?.newModel ?? params?.modelProvider ?? "unknown"
      log.info("Codex model rerouted", { model: newModel })
      events.push({
        type: "model_changed",
        model: typeof newModel === "string" ? newModel : String(newModel),
      })
      break
    }

    case "account/updated":
    case "account/rateLimits/updated":
      events.push(...mapCodexRateLimitEvents(params))
      break

    case "skills/changed":
    case "mcpServer/startupStatus/updated":
      events.push({
        type: "backend_specific",
        backend: "codex",
        data: { method, params },
      })
      break

    // ----- Errors -----

    case "error": {
      let code = params?.code ?? "codex_error"
      let message = params?.message ?? "Unknown Codex error"

      // Codex sometimes sends error bodies as stringified JSON, e.g.:
      //   {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'opus[1m]' model is not supported..."}}
      // Extract the human-readable message so the user sees something actionable.
      if (typeof message === "string" && message.startsWith("{")) {
        try {
          const parsed = JSON.parse(message)
          // Nested error.message (OpenAI API format)
          if (parsed.error?.message) {
            message = parsed.error.message
          } else if (parsed.message) {
            message = parsed.message
          }
          if (typeof parsed.status === "number") {
            code = `http_${parsed.status}`
          }
        } catch {
          // Not valid JSON — use message as-is
        }
      }

      // Default to fatal so errors are VISIBLE in the TUI. Only rate-limit
      // and transient server errors are recoverable (the backend will retry).
      const isTransient = code === "rate_limit" || code === "http_429" || code === "http_503"

      events.push({
        type: "error",
        code,
        message,
        severity: isTransient ? "recoverable" : "fatal",
      })
      break
    }

    default:
      log.warn("Unhandled Codex notification", { method })
      events.push({
        type: "backend_specific",
        backend: "codex",
        data: { method, params },
      })
  }

  return events
}

/**
 * Map Codex window duration to the appropriate rate-limit bucket type.
 *
 * Only maps to Claude-compatible buckets (`five_hour` / `seven_day`) when the
 * actual window duration matches (within 10% tolerance). Otherwise preserves
 * the Codex-native `primary` / `secondary` identity so the statusline can
 * render duration-accurate labels.
 */
function codexWindowToBucket(
  windowDurationMins: number | undefined,
  slot: "primary" | "secondary",
): "five_hour" | "seven_day" | "primary" | "secondary" {
  if (typeof windowDurationMins !== "number") return slot
  // 5 hours = 300 mins (±10%: 270–330)
  if (windowDurationMins >= 270 && windowDurationMins <= 330) return "five_hour"
  // 7 days = 10080 mins (±10%: 9072–11088)
  if (windowDurationMins >= 9072 && windowDurationMins <= 11088) return "seven_day"
  return slot
}

function mapCodexRateLimitEvents(params: any): AgentEvent[] {
  const rateLimits = params?.rateLimits
  if (!rateLimits || typeof rateLimits !== "object") {
    return [{
      type: "backend_specific",
      backend: "codex",
      data: { method: "account/rateLimits/updated", params },
    }]
  }

  const events: AgentEvent[] = []

  const pushRateLimitEvent = (
    bucket: unknown,
    slot: "primary" | "secondary",
  ) => {
    if (!bucket || typeof bucket !== "object") return

    const usedPercent = (bucket as { usedPercent?: unknown }).usedPercent
    const resetsAt = (bucket as { resetsAt?: unknown }).resetsAt
    const windowDurationMins = (bucket as { windowDurationMins?: unknown }).windowDurationMins

    if (typeof usedPercent !== "number") return

    const rateLimitType = codexWindowToBucket(
      typeof windowDurationMins === "number" ? windowDurationMins : undefined,
      slot,
    )

    events.push({
      type: "rate_limit_update",
      rateLimitType,
      utilization: usedPercent / 100,
      resetsAt: typeof resetsAt === "number" ? resetsAt : undefined,
      windowDurationMins: typeof windowDurationMins === "number" ? windowDurationMins : undefined,
      source: "codex",
    })
  }

  pushRateLimitEvent(rateLimits.primary, "primary")
  pushRateLimitEvent(rateLimits.secondary, "secondary")

  if (events.length === 0) {
    events.push({
      type: "backend_specific",
      backend: "codex",
      data: { method: "account/rateLimits/updated", params },
    })
  }

  return events
}

// ---------------------------------------------------------------------------
// Item started → AgentEvent
// ---------------------------------------------------------------------------

function mapItemStarted(item: CodexItem): AgentEvent[] {
  const events: AgentEvent[] = []

  switch (item.type) {
    case "agentMessage":
      // Agent text will stream via item/agentMessage/delta — no start event needed
      log.debug("Codex item streaming started", { type: item.type, id: item.id })
      break

    case "reasoning":
      // Reasoning will stream via delta events — no start event needed
      log.debug("Codex item streaming started", { type: item.type, id: item.id })
      break

    case "plan":
      // Plan will stream via item/plan/delta — no start event needed
      log.debug("Codex item streaming started", { type: item.type, id: item.id })
      break

    case "commandExecution":
      events.push({
        type: "tool_use_start",
        id: item.id,
        tool: "Bash",
        input: {
          command: item.command ?? "",
          cwd: item.cwd ?? "",
        },
      })
      break

    case "fileChange":
      events.push({
        type: "tool_use_start",
        id: item.id,
        tool: "Edit",
        input: {
          changes: item.changes ?? [],
        },
      })
      break

    case "mcpToolCall":
      events.push({
        type: "tool_use_start",
        id: item.id,
        tool: `mcp:${item.server ?? "unknown"}/${item.tool ?? "unknown"}`,
        input: item.arguments ?? {},
      })
      break

    case "webSearch":
      events.push({
        type: "tool_use_start",
        id: item.id,
        tool: "WebSearch",
        input: { query: item.query ?? "" },
      })
      break

    case "userMessage":
      // User's own message echoed back — no event needed
      log.debug("Codex user message echo suppressed", { id: item.id })
      break

    case "todoList":
      // Pass through as backend_specific
      events.push({
        type: "backend_specific",
        backend: "codex",
        data: { type: "todoList", item },
      })
      break

    case "contextCompaction":
      events.push({
        type: "compact",
        summary: (item.summary as string) ?? "Codex compacted conversation context.",
        trigger: "auto",
      })
      break

    default:
      log.warn("Unhandled Codex item type in item/started", { type: item.type, id: item.id, keys: Object.keys(item).join(",") })
  }

  return events
}

// ---------------------------------------------------------------------------
// Item completed → AgentEvent
// ---------------------------------------------------------------------------

function mapItemCompleted(item: CodexItem): AgentEvent[] {
  const events: AgentEvent[] = []

  switch (item.type) {
    case "agentMessage": {
      // Full agent message — emit text_complete with final text
      const text = (item.text as string) ?? ""
      if (text) {
        events.push({ type: "text_complete", text })
      }
      break
    }

    case "commandExecution": {
      const status = item.status as string
      const output = (item.aggregatedOutput as string) ?? ""
      const exitCode = item.exitCode as number | undefined
      const isError =
        status === "failed" || (exitCode !== undefined && exitCode !== 0)

      events.push({
        type: "tool_use_end",
        id: item.id,
        output: output || `Exit code: ${exitCode ?? "unknown"}`,
        error: isError
          ? output || `Command failed (exit ${exitCode ?? "unknown"})`
          : undefined,
      })
      break
    }

    case "fileChange": {
      const status = item.status as string
      const changes = (item.changes as CodexFileChangeEntry[] | undefined) ?? []
      const summary = changes
        .map(
          (c: CodexFileChangeEntry) =>
            `${c.kind ?? "update"}: ${c.path ?? "unknown"}`,
        )
        .join(", ")

      events.push({
        type: "tool_use_end",
        id: item.id,
        output: summary || "File change completed",
        error: status === "failed" ? "File change failed" : undefined,
      })
      break
    }

    case "mcpToolCall": {
      const status = item.status as string
      const result = item.result as CodexMcpToolResult | undefined
      const error = item.error as CodexMcpToolError | undefined
      let output = ""

      if (result?.content) {
        const contentBlocks: CodexMcpContentBlock[] = Array.isArray(result.content)
          ? result.content
          : [result.content]
        output = contentBlocks
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n")
      }

      events.push({
        type: "tool_use_end",
        id: item.id,
        output: output || "MCP tool call completed",
        error:
          status === "failed" ? error?.message ?? "MCP tool call failed" : undefined,
      })
      break
    }

    case "webSearch": {
      // Propagate query from completed item — item/started may arrive with empty query
      const wsQuery = item.query as string | undefined
      if (wsQuery) {
        events.push({
          type: "tool_use_progress",
          id: item.id,
          output: "",
          input: { query: wsQuery },
        })
      }
      events.push({
        type: "tool_use_end",
        id: item.id,
        output: "Web search completed",
      })
      break
    }

    case "reasoning":
    case "plan":
    case "userMessage":
    case "todoList":
    case "contextCompaction":
      // No end event needed — content was streamed via deltas or captured at start
      log.debug("Codex item completed (no end event)", { type: item.type, id: item.id })
      break

    default:
      log.warn("Unhandled Codex item type in item/completed", { type: item.type, id: item.id, keys: Object.keys(item).join(",") })
  }

  return events
}
