/** Subagent System — Type Definitions */

import type { AgentBackend, EffortLevel, PermissionMode } from "../protocol/types"

// ---------------------------------------------------------------------------
// Agent Definition — parsed from .md frontmatter (Claude Code compatible + extensions)
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  name: string
  description?: string
  systemPrompt: string // markdown body
  backend?: string // any id registered in BACKEND_REGISTRY (see protocol/registry.ts)
  model?: string
  permissionMode?: PermissionMode // defaults to "bypassPermissions" for subagents
  maxTurns?: number
  effort?: EffortLevel
  tools?: string[]
  disallowedTools?: string[]
  color?: string // TUI accent color for this agent
  acpCommand?: string // for generic ACP backend
  acpArgs?: string[]
  filePath: string // source file path
}

// ---------------------------------------------------------------------------
// Spawn Options — what you pass to SubagentManager.spawn()
// ---------------------------------------------------------------------------

export interface SpawnOptions {
  definition: AgentDefinition
  prompt: string
  backendOverride?: string
  modelOverride?: string
  cwd?: string
  /** Timeout in ms for the backend to emit session_init. Defaults to 60_000. */
  startupTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Subagent Status — returned by getStatus() and listAll()
// ---------------------------------------------------------------------------

export interface SubagentStatus {
  subagentId: string
  definitionName: string
  backendName: string
  sessionId?: string // tracked for log inspection
  state: "running" | "completed" | "error"
  description: string
  output: string
  lastToolName?: string
  startTime: number
  endTime?: number
  errorMessage?: string
  // Rich progress metadata — streamed to TUI for at-a-glance visibility
  turnCount: number // how many conversation turns so far
  toolUseCount: number // total tool invocations
  tokenUsage?: {
    // accumulated token usage (when available)
    inputTokens: number
    outputTokens: number
  }
  thinkingActive: boolean // currently in a thinking block
  activeTurn: boolean // true while a turn is in progress (between turn_start and turn_complete)
  recentTools: string[] // last N tool names (rolling window, e.g. last 5)
}

// ---------------------------------------------------------------------------
// Running Subagent — internal bookkeeping for SubagentManager
// ---------------------------------------------------------------------------

export interface RunningSubagent {
  subagentId: string
  definition: AgentDefinition
  status: SubagentStatus
  backend: AgentBackend
  /** Queued messages to send on next turn_complete */
  messageQueue: string[]
  /** True while a turn is in progress (between turn_start and turn_complete) */
  midTurn: boolean
  /** Resolves when the subagent reaches a terminal state (completed/error). */
  completion: Promise<SubagentStatus>
  /** Call to resolve the completion promise. Set at spawn time. */
  resolveCompletion: (status: SubagentStatus) => void
}
