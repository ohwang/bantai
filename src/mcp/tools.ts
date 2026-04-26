/**
 * MCP Tool Handlers — pure functions that read from the state bridge.
 *
 * Each handler returns an MCP CallToolResult. Separated from server
 * lifecycle for testability.
 */

import { getSnapshot, getSubagentManagerBridge } from "./state-bridge"
import { log } from "../utils/logger"
import { friendlyModelName, modelContextWindow } from "../protocol/models"
import type { Block } from "../protocol/types"

interface CallToolResult {
  [key: string]: unknown
  content: Array<{ type: "text"; text: string }>
}

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] }
}

// ---------------------------------------------------------------------------
// get_state
// ---------------------------------------------------------------------------

export function getState(): CallToolResult {
  const snap = getSnapshot()
  const s = snap.conversationState
  if (!s) return textResult("No session state available yet.")

  const caps = snap.backend?.capabilities()
  const rawModel = s.currentModel ?? ""
  const ctxWindow = modelContextWindow(rawModel)
  const ctxFill = s.lastTurnInputTokens

  return jsonResult({
    session: {
      state: s.sessionState,
      sessionId: s.session?.sessionId ?? null,
      turnNumber: s.turnNumber,
      backgrounded: s.backgrounded,
    },
    model: {
      id: rawModel,
      display_name: friendlyModelName(rawModel),
    },
    thinking: {
      effort: s.currentEffort || "high",
      config: snap.config?.thinking ?? { type: "adaptive" },
    },
    cost: {
      total_cost_usd: s.cost.totalCostUsd,
      input_tokens: s.cost.inputTokens,
      output_tokens: s.cost.outputTokens,
      cache_read_tokens: s.cost.cacheReadTokens,
      cache_write_tokens: s.cost.cacheWriteTokens,
    },
    context_window: {
      total_input_tokens: ctxFill,
      context_window_size: ctxWindow,
      used_percentage: ctxWindow > 0 && ctxFill > 0 ? Math.round(ctxFill / ctxWindow * 1000) / 10 : null,
    },
    rate_limits: s.rateLimits,
    error: s.lastError ? { code: s.lastError.code, message: s.lastError.message } : null,
    streaming: {
      text_length: s.streamingText.length,
      thinking_length: s.streamingThinking.length,
      output_tokens: s.streamingOutputTokens,
    },
    backend: caps ? {
      name: caps.name,
      capabilities: {
        thinking: caps.supportsThinking,
        tool_approval: caps.supportsToolApproval,
        resume: caps.supportsResume,
        streaming: caps.supportsStreaming,
        subagents: caps.supportsSubagents,
      },
    } : null,
    workspace: {
      cwd: snap.config?.cwd ?? process.cwd(),
      permission_mode: snap.config?.permissionMode ?? "default",
    },
  })
}

// ---------------------------------------------------------------------------
// get_conversation
// ---------------------------------------------------------------------------

export function getConversation(args: { last_n?: number; type_filter?: string }): CallToolResult {
  const snap = getSnapshot()
  const s = snap.conversationState
  if (!s) return textResult("No conversation available.")

  let blocks: Block[] = s.blocks
  if (args.type_filter) {
    blocks = blocks.filter(b => b.type === args.type_filter)
  }
  if (args.last_n !== undefined && args.last_n > 0) {
    blocks = blocks.slice(-args.last_n)
  }

  return jsonResult({
    blocks,
    streaming: {
      text: s.streamingText || undefined,
      thinking: s.streamingThinking || undefined,
    },
    total_block_count: s.blocks.length,
  })
}

// ---------------------------------------------------------------------------
// get_logs
// ---------------------------------------------------------------------------

const LOG_LEVEL_RANKS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function getLogs(args: { level?: string; last_n?: number }): CallToolResult {
  let lines = log.getLines()

  if (args.level && LOG_LEVEL_RANKS[args.level] !== undefined) {
    const minRank = LOG_LEVEL_RANKS[args.level]!
    lines = lines.filter(line => {
      const match = line.match(/\[([A-Z]+)\s*\]/)
      if (!match) return true
      const lineLevel = match[1]!.toLowerCase().trim()
      return (LOG_LEVEL_RANKS[lineLevel] ?? 0) >= minRank
    })
  }

  const n = args.last_n ?? 50
  if (n > 0) lines = lines.slice(-n)

  return textResult(lines.join("\n"))
}

// ---------------------------------------------------------------------------
// get_screenshot
// ---------------------------------------------------------------------------

export function getScreenshot(): CallToolResult {
  const snap = getSnapshot()
  if (!snap.renderer) {
    return textResult("Renderer not available.")
  }

  const buffer = snap.renderer.currentRenderBuffer
  const lines = buffer.getSpanLines()
  const text = lines.map(line => line.spans.map(s => s.text).join("")).join("\n")
  return textResult(text)
}

// ---------------------------------------------------------------------------
// get_diagnostics
// ---------------------------------------------------------------------------

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

function countBlockTypes(blocks: Block[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const b of blocks) {
    counts[b.type] = (counts[b.type] ?? 0) + 1
  }
  return counts
}

export function getDiagnostics(): CallToolResult {
  const snap = getSnapshot()
  const s = snap.conversationState
  const caps = snap.backend?.capabilities()
  const mem = process.memoryUsage()

  const rawModel = s?.currentModel ?? ""
  const ctxWindow = modelContextWindow(rawModel)
  const ctxFill = s?.lastTurnInputTokens ?? 0

  const gitBranch = getGitBranch()

  return jsonResult({
    system: {
      version: "0.0.1",
      runtime: `Bun ${Bun.version}`,
      platform: `${process.platform}/${process.arch}`,
      heap_used_bytes: mem.heapUsed,
      rss_bytes: mem.rss,
    },
    session: s ? {
      session_id: s.session?.sessionId,
      state: s.sessionState,
      turn_number: s.turnNumber,
      model: s.currentModel,
      cost: s.cost,
      rate_limits: s.rateLimits,
      last_error: s.lastError,
    } : null,
    context_window: {
      current_tokens: ctxFill,
      max_tokens: ctxWindow,
      utilization_percent: ctxWindow > 0 && ctxFill > 0 ? Math.round(ctxFill / ctxWindow * 1000) / 10 : 0,
    },
    conversation: s ? {
      total_blocks: s.blocks.length,
      block_counts: countBlockTypes(s.blocks),
      is_streaming: !!(s.streamingText || s.streamingThinking),
      active_tasks: s.activeTasks.size,
    } : null,
    subagents: (() => {
      const mgr = getSubagentManagerBridge()
      if (!mgr) return null
      const all = mgr.listAll()
      if (all.length === 0) return { total: 0, running: 0, completed: 0, errored: 0 }
      const running = all.filter(s => s.state === "running")
      const completed = all.filter(s => s.state === "completed")
      const errored = all.filter(s => s.state === "error")
      return {
        total: all.length,
        running: running.length,
        completed: completed.length,
        errored: errored.length,
        agents: all.map(s => ({
          id: s.subagentId,
          name: s.definitionName,
          backend: s.backendName,
          state: s.state,
          elapsed_ms: (s.endTime ?? Date.now()) - s.startTime,
          turns: s.turnCount,
          tools_used: s.toolUseCount,
          last_tool: s.lastToolName ?? null,
          session_id: s.sessionId ?? null,
          error: s.errorMessage ?? null,
        })),
      }
    })(),
    git: gitBranch ? { branch: gitBranch, dirty_files: getGitDirtyCount() } : null,
    backend: caps ?? null,
    config: {
      cwd: snap.config?.cwd ?? process.cwd(),
      log_file: log.getLogFile(),
      permission_mode: snap.config?.permissionMode ?? "default",
    },
  })
}
