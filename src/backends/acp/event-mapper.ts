/**
 * ACP Event Mapper
 *
 * Maps ACP session/update notifications to the unified AgentEvent type.
 *
 * ACP model:
 *   Session → Prompt turn → Streaming updates (agent_message_chunk, tool_call, etc.)
 *
 * Key mapping:
 *   agent_message_chunk (text)    → text_delta
 *   agent_message_chunk (audio)   → text_delta (placeholder)
 *   agent_message_chunk (resource)→ text_delta (inline or link)
 *   agent_thought_chunk (text)    → thinking_delta
 *   tool_call                     → tool_use_start
 *   tool_call_update (in_progress) → tool_use_progress
 *   tool_call_update (completed)  → tool_use_end
 *   tool_call_update (failed)     → tool_use_end (with error)
 *   plan                          → plan_update
 *   usage_update                  → cost_update
 *   config_option_update          → backend_specific (config data)
 *   current_mode_update           → backend_specific (mode data)
 *   session_info_update           → backend_specific (session metadata)
 *   user_message_chunk            → user_message
 *   available_commands_update     → backend_specific
 *   unknown                       → backend_specific
 */

import { log } from "../../utils/logger"
import { buildUnifiedDiff } from "../../utils/format-diff"
import type { AgentEvent, PlanEntry } from "../../protocol/types"
import type {
  AcpSessionUpdateParams,
  AcpAgentMessageChunk,
  AcpAgentThoughtChunk,
  AcpToolCall,
  AcpToolCallUpdate,
  AcpPlanUpdate,
  AcpAvailableCommandsUpdate,
  AcpToolContent,
} from "./types"

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map an ACP session/update notification to AgentEvents.
 */
export function mapAcpUpdate(params: AcpSessionUpdateParams): AgentEvent[] {
  const update = params.update
  if (!update?.sessionUpdate) {
    log.warn("ACP session/update missing sessionUpdate type", { params })
    return []
  }

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      // Qwen Code piggybacks token usage onto an empty `agent_message_chunk`
      // by attaching `_meta.usage = { inputTokens, outputTokens, ... }` and
      // `_meta.durationMs` (see emitUsageMetadata in qwen-code 0.15.x).
      // Emit a cost_update alongside the text mapping so the reducer's
      // existing `cost_update` path populates `state.lastTurnInputTokens`
      // (Qwen never sends a real `usage_update`).
      return [
        ...mapAgentMessageChunk(update as AcpAgentMessageChunk),
        ...mapEmbeddedUsage(update as { _meta?: unknown }),
      ]
    }

    case "agent_thought_chunk":
      return mapAgentThoughtChunk(update as AcpAgentThoughtChunk)

    case "tool_call":
      return mapToolCall(update as AcpToolCall)

    case "tool_call_update":
      return mapToolCallUpdate(update as AcpToolCallUpdate)

    case "plan":
      return mapPlan(update as AcpPlanUpdate)

    case "available_commands_update":
      return mapAvailableCommands(update as AcpAvailableCommandsUpdate)

    case "usage_update": {
      // ACP spec: `{ used: number, size: number, cost?: { amount, currency } }`.
      // `size` is the live model context window (already-defined by the spec —
      // we just propagate it). Neither Gemini CLI 0.37.0 nor Qwen Code 0.15.x
      // emits this notification today, but it's part of the protocol and the
      // mapping is trivially correct, so we keep it for forward compatibility.
      const u = update as {
        sessionUpdate: string
        used?: number
        size?: number
        cost?: { amount: number; currency: string }
      }
      const events: AgentEvent[] = []
      if (u.used != null || u.cost || u.size != null) {
        events.push({
          type: "cost_update",
          inputTokens: u.used ?? 0,
          outputTokens: 0,
          contextTokens: u.used,
          contextWindow: u.size,
          cost: u.cost?.amount,
        })
      }
      return events
    }

    case "config_option_update": {
      const configUpdate = update as { sessionUpdate: string; configOptions?: unknown[] }
      return [{
        type: "backend_specific",
        backend: "acp",
        data: { type: "config_option_session_update", configOptions: configUpdate.configOptions },
      }]
    }

    case "current_mode_update": {
      const modeUpdate = update as { sessionUpdate: string; currentModeId?: string }
      log.info("ACP mode updated by agent", { currentModeId: modeUpdate.currentModeId })
      return [{
        type: "backend_specific",
        backend: "acp",
        data: { type: "current_mode_update", currentModeId: modeUpdate.currentModeId },
      }]
    }

    case "session_info_update": {
      const infoUpdate = update as { sessionUpdate: string; title?: string; updatedAt?: string }
      log.debug("ACP session info update", { title: infoUpdate.title })
      return [{
        type: "backend_specific",
        backend: "acp",
        data: { type: "session_info_update", title: infoUpdate.title, updatedAt: infoUpdate.updatedAt },
      }]
    }

    case "user_message_chunk": {
      const userChunk = update as unknown as AcpAgentMessageChunk  // same content shape
      if (!userChunk.content) return []
      if (userChunk.content.type === "text" && userChunk.content.text != null) {
        if (userChunk.content.text === "") return []
        return [{ type: "user_message", text: userChunk.content.text }]
      }
      // Non-text user content — log and drop
      log.debug("ACP user_message_chunk with non-text content", { type: userChunk.content.type })
      return []
    }

    default:
      log.warn("Unhandled ACP update type", { sessionUpdate: update.sessionUpdate })
      return [{
        type: "backend_specific",
        backend: "acp",
        data: { method: "session/update", update },
      }]
  }
}

// ---------------------------------------------------------------------------
// Embedded usage (Qwen Code piggybacks per-turn token usage on
// `agent_message_chunk._meta.usage` — see qwen-code 0.15.x emitUsageMetadata).
// Returns a `cost_update` event when the shape matches; otherwise empty.
// ---------------------------------------------------------------------------

function mapEmbeddedUsage(update: { _meta?: unknown }): AgentEvent[] {
  const meta = update._meta as
    | {
        usage?: {
          inputTokens?: number
          outputTokens?: number
          totalTokens?: number
          thoughtTokens?: number
          cachedReadTokens?: number
        }
      }
    | undefined
  const usage = meta?.usage
  if (!usage) return []
  if (usage.inputTokens == null && usage.outputTokens == null) return []
  return [{
    type: "cost_update",
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    contextTokens: usage.inputTokens,
  }]
}

// ---------------------------------------------------------------------------
// Agent message chunk
// ---------------------------------------------------------------------------

function mapAgentMessageChunk(update: AcpAgentMessageChunk): AgentEvent[] {
  const content = update.content
  if (!content) return []

  switch (content.type) {
    case "text": {
      if (content.text == null) return []
      if (content.text === "") {
        log.debug("ACP agent_message_chunk with empty text (keep-alive), skipping")
        return []
      }
      return [{ type: "text_delta", text: content.text }]
    }

    case "resource_link": {
      // Render resource links as markdown-style links
      // Terminal emulators with OSC 8 support will make these clickable
      const link = content as { type: "resource_link"; uri: string; name: string; mimeType?: string }
      const label = link.name || link.uri
      const text = `[${label}](${link.uri})`
      return [{ type: "text_delta", text }]
    }

    case "image": {
      // Render images as descriptive placeholder text
      // Full image rendering needs TUI infrastructure that doesn't exist yet
      const img = content as { type: "image"; mimeType: string; data: string; uri?: string }
      const desc = img.uri
        ? `\n[Image: ${img.uri.split("/").pop() ?? "image"}](${img.uri})\n`
        : `\n[Image: ${img.mimeType}]\n`
      return [{ type: "text_delta", text: desc }]
    }

    default: {
      // Handle content types not yet in AcpContentBlock union (audio, resource, etc.)
      const generic = content as unknown as { type: string; [key: string]: unknown }

      if (generic.type === "audio") {
        const audio = content as unknown as { type: "audio"; mimeType: string; data: string }
        return [{ type: "text_delta", text: `\n[Audio: ${audio.mimeType}]\n` }]
      }

      if (generic.type === "resource") {
        const res = content as unknown as { type: "resource"; resource: { uri?: string; text?: string; mimeType?: string } }
        if (res.resource?.text) {
          // Inline text resources directly
          return [{ type: "text_delta", text: res.resource.text }]
        }
        const label = res.resource?.uri ?? "resource"
        return [{ type: "text_delta", text: `[Resource: ${label}]` }]
      }

      // Truly unknown content type — pass through
      log.debug("ACP agent_message_chunk with unhandled content type", { type: generic.type })
      return [{
        type: "backend_specific",
        backend: "acp",
        data: { method: "session/update", update },
      }]
    }
  }
}

// ---------------------------------------------------------------------------
// Agent thought chunk (thinking/reasoning)
// ---------------------------------------------------------------------------

function mapAgentThoughtChunk(update: AcpAgentThoughtChunk): AgentEvent[] {
  const content = update.content
  if (!content) return []

  // Thinking content is typically text — extract and emit as thinking_delta
  if (content.type === "text") {
    if (content.text == null || content.text === "") return []
    return [{ type: "thinking_delta", text: content.text }]
  }

  // Non-text thinking content (unlikely but handle gracefully)
  log.debug("ACP agent_thought_chunk with non-text content", { type: (content as { type: string }).type })
  return [{
    type: "backend_specific",
    backend: "acp",
    data: { method: "session/update", update },
  }]
}

// ---------------------------------------------------------------------------
// Tool call (initial)
// ---------------------------------------------------------------------------

function mapToolCall(update: AcpToolCall): AgentEvent[] {
  const toolName = deriveToolName(update.kind, update.title)

  // Normalize input to include fields tool-view.tsx expects
  const input: Record<string, unknown> = {
    // Preserve ACP metadata
    title: update.title,
    kind: update.kind,
    locations: update.locations,
    rawInput: update.rawInput,
  }

  // Extract standard fields from rawInput (may be string or object)
  const raw = update.rawInput
  if (raw && typeof raw === "object") {
    const rawObj = raw as Record<string, unknown>
    // Pass through any standard fields from rawInput
    if (rawObj.file_path) input.file_path = rawObj.file_path
    if (rawObj.command) input.command = rawObj.command
    if (rawObj.pattern) input.pattern = rawObj.pattern
    if (rawObj.query) input.query = rawObj.query
    if (rawObj.path) input.file_path = input.file_path ?? rawObj.path
  } else if (raw && typeof raw === "string") {
    // rawInput is a string — likely a command or file path
    if (toolName === "Bash") input.command = raw
    else if (toolName === "Read" || toolName === "Edit" || toolName === "Delete" || toolName === "Move") input.file_path = raw
    else if (toolName === "Search") input.pattern = raw
  }

  // Extract file_path from locations if not already set
  if (!input.file_path && update.locations && update.locations.length > 0) {
    const loc = update.locations[0]
    if (loc?.path) input.file_path = loc.path
  }

  // Note: we used to emit tool_use_end here when the initial tool_call came
  // with status `completed` or `failed` — that happened during Gemini's
  // session/load replay, leaving every historical tool stuck in "running"
  // otherwise. That workaround is no longer needed: AcpAdapter now suppresses
  // the entire replay stream (see `replayMode` in src/backends/acp/adapter.ts)
  // because the TUI seeds history from the on-disk session file directly.
  // Live tool calls always arrive as tool_call (status=pending/in_progress)
  // → tool_call_update (terminal status), which mapToolCallUpdate handles.
  return [{
    type: "tool_use_start",
    id: update.toolCallId,
    tool: toolName,
    input,
  }]
}

// ---------------------------------------------------------------------------
// Tool call update (progress / completion)
// ---------------------------------------------------------------------------

function mapToolCallUpdate(update: AcpToolCallUpdate): AgentEvent[] {
  const events: AgentEvent[] = []

  // Extract text + diff content
  const textOutput = extractToolContentText(update.content)
  const diffOutput = extractDiffContent(update.content)
  const combinedOutput = [textOutput, diffOutput].filter(Boolean).join("\n")

  // Completed or failed → tool_use_end
  if (update.status === "completed" || update.status === "failed") {
    events.push({
      type: "tool_use_end",
      id: update.toolCallId,
      output: combinedOutput || `Tool ${update.status}`,
      error: update.status === "failed" ? (combinedOutput || "Tool call failed") : undefined,
    })
    return events
  }

  // In-progress → tool_use_progress
  if (combinedOutput) {
    events.push({
      type: "tool_use_progress",
      id: update.toolCallId,
      output: combinedOutput,
    })
  }

  // Terminal content still passes through as backend_specific
  if (update.content?.some(c => c.type === "terminal")) {
    events.push({
      type: "backend_specific",
      backend: "acp",
      data: {
        type: "tool_call_rich_content",
        toolCallId: update.toolCallId,
        content: update.content?.filter(c => c.type === "terminal"),
      },
    })
  }

  return events
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function mapPlan(update: AcpPlanUpdate): AgentEvent[] {
  if (!update.entries || update.entries.length === 0) return []

  const entries: PlanEntry[] = update.entries.map((e) => ({
    content: e.content ?? e.text ?? e.title ?? JSON.stringify(e),
    priority: e.priority,
    status: e.status,
  }))

  return [{ type: "plan_update", entries }]
}

// ---------------------------------------------------------------------------
// Available commands (slash commands advertised by the agent)
// ---------------------------------------------------------------------------

function mapAvailableCommands(update: AcpAvailableCommandsUpdate): AgentEvent[] {
  return [{
    type: "backend_specific",
    backend: "acp",
    data: {
      type: "available_commands",
      commands: update.availableCommands,
    },
  }]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable tool name from ACP kind + title.
 */
export function deriveToolName(kind?: string, title?: string): string {
  // Map ACP kind to a tool name similar to Claude/Codex naming
  switch (kind) {
    case "read":
      return "Read"
    case "edit":
      return "Edit"
    case "execute":
      return "Bash"
    case "search":
      return "Search"
    case "fetch":
      return "WebFetch"
    case "think":
      return "Think"
    case "delete":
      return "Delete"
    case "move":
      return "Move"
    default:
      return title ?? kind ?? "Tool"
  }
}

/**
 * Extract plain text from ACP tool content array.
 */
function extractToolContentText(content?: AcpToolContent[]): string {
  if (!content || content.length === 0) return ""

  return content
    .filter((c): c is { type: "content"; content: { type: "text"; text: string } } =>
      c.type === "content" && c.content?.type === "text",
    )
    .map(c => c.content.text)
    .join("\n")
}

/**
 * Extract diff content from ACP tool content array and format as unified diff.
 * The unified diff format is recognized by tool-view.tsx for color-coded rendering.
 */
function extractDiffContent(content?: AcpToolContent[]): string {
  if (!content || content.length === 0) return ""

  return content
    .filter((c): c is { type: "diff"; path: string; oldText: string; newText: string } =>
      c.type === "diff",
    )
    .map(c => formatDiffContent(c))
    .join("\n\n")
}

/**
 * Convert an ACP diff content block to unified diff text format.
 *
 * Thin wrapper over {@link buildUnifiedDiff} — the shared helper in
 * `src/utils/format-diff.ts` handles edge cases (empty oldText / newText)
 * and produces the `--- a/path` + `+++ b/path` + `@@ ` hunk headers that
 * `isDiffOutput()` detects and `<diff>` renders.
 */
function formatDiffContent(diff: { path: string; oldText: string; newText: string }): string {
  return buildUnifiedDiff(diff)
}
