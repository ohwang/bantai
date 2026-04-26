/**
 * Agent Protocol — Type Definitions
 *
 * The load-bearing abstraction. All backends implement AgentBackend,
 * all TUI components consume AgentEvent via ConversationState.
 *
 * This file IS the spec. Types as documentation.
 */

// ---------------------------------------------------------------------------
// Thinking & Effort — controls for Claude's reasoning behavior
// ---------------------------------------------------------------------------

/** Thinking configuration for extended reasoning */
export type ThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens?: number }
  | { type: "disabled" }

/**
 * Effort level for controlling reasoning depth.
 *
 * The closed enumeration lives in `protocol/effort-levels.ts`; this is a
 * re-export so existing `import { EffortLevel } from "../protocol/types"`
 * call sites keep working. New code should import from
 * `protocol/effort-levels` directly when it also needs helpers
 * (`isKnownEffortLevel`, `RUNTIME_EFFORT_LEVELS`, etc.).
 */
export type { EffortLevel } from "./effort-levels"
import type { EffortLevel } from "./effort-levels"

/**
 * Rate-limit bucket id. Closed enumeration lives in `protocol/rate-limits.ts`;
 * this is a re-export so existing `import { RateLimitBucket } from
 * "../protocol/types"` call sites keep working. New code should import from
 * `protocol/rate-limits` directly when it also needs helpers
 * (`isKnownRateLimitBucket`, `BUCKET_SLOT_STRATEGY`, etc.).
 */
export type { RateLimitBucket } from "./rate-limits"
import type { RateLimitBucket } from "./rate-limits"

// ---------------------------------------------------------------------------
// Agent Events — unified stream from all backends
// ---------------------------------------------------------------------------

/** Content streaming */
export type TextDeltaEvent = { type: "text_delta"; text: string }
export type ThinkingDeltaEvent = { type: "thinking_delta"; text: string }
export type TextCompleteEvent = { type: "text_complete"; text: string }

/** Tool lifecycle */
export type ToolUseStartEvent = {
  type: "tool_use_start"
  id: string
  tool: string
  input: unknown
}
export type ToolUseProgressEvent = {
  type: "tool_use_progress"
  id: string
  output: string
  input?: unknown // Set when tool input JSON is fully accumulated from streaming deltas
}
export type ToolUseEndEvent = {
  type: "tool_use_end"
  id: string
  output: string
  error?: string
}

/** Shell command lifecycle (user-initiated ! prefix) */
export type ShellStartEvent = {
  type: "shell_start"
  id: string
  command: string
}
export type ShellEndEvent = {
  type: "shell_end"
  id: string
  output: string
  error?: string
  exitCode: number
}

/** Permission flow */
export type PermissionRequestEvent = {
  type: "permission_request"
  id: string
  tool: string
  input: unknown
  suggestions?: PermissionUpdate[]
  /** Short noun phrase for the tool action (e.g., "Read file") — from SDK */
  displayName?: string
  /** Full permission prompt sentence (e.g., "Claude wants to read foo.txt") — from SDK */
  title?: string
  /** Human-readable subtitle (e.g., "Claude will have read and write access to files in ~/Downloads") */
  description?: string
  /** Why this permission request was triggered */
  decisionReason?: string
  /** File path that triggered the permission request */
  blockedPath?: string
}

/** Permission response (approval/denial from user) */
export type PermissionResponseEvent = {
  type: "permission_response"
  id: string
  behavior: "allow" | "deny"
}

/** Elicitation / AskUserQuestion */
export type ElicitationRequestEvent = {
  type: "elicitation_request"
  id: string
  questions: ElicitationQuestion[]
}
export type ElicitationResponseEvent = {
  type: "elicitation_response"
  id: string
  answers: Record<string, string>
}

/**
 * Provenance of a user-role message — mirrors the SDK's `SDKMessageOrigin`
 * shape exactly (Claude Agent SDK 0.2.112+).
 *
 * In multi-agent / coordinator sessions a "user" turn is not always typed by
 * the user: it can be a peer agent's message, a coordinator instruction, or
 * an incoming channel post. Surfacing the origin lets the UI distinguish
 * "the human typed this" from "another agent sent this", which is otherwise
 * indistinguishable on resume.
 *
 * Mirroring the SDK shape verbatim (rather than collapsing to a subset) is
 * deliberate: any new `kind` the SDK adds becomes a TypeScript error here
 * and forces the event-mapper / renderer to handle it explicitly, rather
 * than silently degrading to "human".
 */
export type SDKMessageOrigin =
  | { kind: "human" }
  | { kind: "channel"; server: string }
  | { kind: "peer"; from: string; name?: string }
  | { kind: "task-notification" }
  | { kind: "coordinator" }

/** User message (synthetic, emitted by TUI when user submits, or extracted
 *  from replayed `SDKUserMessage` / `SDKUserMessageReplay` by the Claude
 *  event-mapper). `origin` is absent for synthetic TUI-side sends (those are
 *  always human), and absent on older SDK transcripts that predate the field
 *  — both cases render identically to `{ kind: "human" }`. */
export type UserMessageEvent = {
  type: "user_message"
  text: string
  images?: ImageContent[]
  origin?: SDKMessageOrigin
}

/** Interrupt (synthetic, emitted by TUI when user presses Ctrl+C) */
export type InterruptEvent = { type: "interrupt" }

/** Shutdown (synthetic, emitted by TUI when user triggers clean exit) */
export type ShutdownEvent = { type: "shutdown" }

/** Turn lifecycle */
export type TurnStartEvent = { type: "turn_start" }
export type TurnCompleteEvent = {
  type: "turn_complete"
  usage?: TokenUsage
  sessionId?: string
  /** Milliseconds from query start to the first streamed token for this turn.
   *  Sourced from SDK 0.2.112+ `SDKPartialAssistantMessage.ttft_ms`. High TTFT
   *  signals backend queueing / cold starts; low TTFT with slow total turn
   *  time points at the model itself. Backends that don't report it omit the
   *  field; the reducer keeps the previous value intact when absent. */
  ttftMs?: number
  /** Total wall-clock duration of this agentic turn, in milliseconds. Sourced
   *  from the Claude SDK `result` message's `duration_ms` — spans the full
   *  multi-step turn (all internal API calls + tool uses), not just the final
   *  API call. Backends that don't report it omit the field. Used by the TUI
   *  to render a "Baked for X" summary line when the turn completes. */
  durationMs?: number
}

/** Session state */
export type SessionInitEvent = {
  type: "session_init"
  tools: ToolInfo[]
  models: ModelInfo[]
  account?: AccountInfo
  sessionId?: string
  /** Which entry in `models[]` is currently active.
   *
   *  Used by the reducer to pick the correct `ModelInfo` for `state.currentModel`
   *  and by `findCurrentModel(...)` to look up the live `contextWindow`.
   *
   *  Critical for ACP backends like Qwen Code, which reports an `availableModels`
   *  array where `[0]` is NOT necessarily the active model — e.g. with three
   *  models configured, `[0]` may be `coder-model` (1M context) while the live
   *  selection is `qwen/qwen3.6-35b-a3b(openai)` (262K). Without this field the
   *  reducer falls back to `models[0]` and the status bar shows the wrong cap.
   *
   *  Backends with a single model per session (Claude, Codex) may omit this —
   *  consumers fall back to `models[0]` when absent. */
  currentModelId?: string
}
export type SessionStateEvent = {
  type: "session_state"
  state: "idle" | "running" | "requires_action"
}
export type CompactEvent = {
  type: "compact"
  summary: string
  /** What triggered the compaction: "user" (/compact command) or "auto" (backend-initiated) */
  trigger?: "user" | "auto"
  /** Token count before compaction (when available from backend) */
  preTokens?: number
  /** Token count after compaction (when available from backend) */
  postTokens?: number
  /** Whether compaction is in progress (true) or completed (false/undefined) */
  inProgress?: boolean
  /** How long compaction took in milliseconds (SDK 0.2.107+) */
  durationMs?: number
}

/** Tasks / subagents */
export type TaskStartEvent = {
  type: "task_start"
  taskId: string
  description: string
  /** Correlates this task to the Agent ToolUseBlock that spawned it */
  toolUseId?: string
  /** Subagent type (e.g., "Explore", "general-purpose") */
  taskType?: string
  /** "native" for crossagent-managed subagents, "backend" for backend's own (Claude SDK, etc.) */
  source?: "native" | "backend"
  /** Which backend the subagent runs on (e.g., "gemini", "claude", "copilot") */
  backendName?: string
  /** Model powering this subagent (when known) */
  model?: string
  /** Subagent's session ID for log cross-referencing */
  sessionId?: string
  /** When true, this is an ambient/housekeeping task — hide from inline transcript */
  skipTranscript?: boolean
}
export type TaskProgressEvent = {
  type: "task_progress"
  taskId: string
  output: string
  /** Name of the most recent tool the subagent used */
  lastToolName?: string
  /** AI-generated progress summary (requires agentProgressSummaries option) */
  summary?: string
  /** Number of conversation turns completed */
  turnCount?: number
  /** Total tool invocations */
  toolUseCount?: number
  /** Token usage (when available) */
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens?: number }
  /** Currently in a thinking block */
  thinkingActive?: boolean
  /** True while a turn is in progress (between turn_start and turn_complete) */
  activeTurn?: boolean
  /** Last N tool names used (rolling window) */
  recentTools?: string[]
}
export type TaskCompleteEvent = {
  type: "task_complete"
  taskId: string
  output: string
  /** Correlates this task completion to the Agent ToolUseBlock that spawned it */
  toolUseId?: string
  /** Final state -- "completed" or "error" */
  state?: "completed" | "error"
  /** Error message if state is "error" */
  errorMessage?: string
  /** When true, this is an ambient/housekeeping task — hide from inline transcript */
  skipTranscript?: boolean
}
/** Granular task state patch (SDK 0.2.107+). Merged into activeTasks map. */
export type TaskUpdatedEvent = {
  type: "task_updated"
  taskId: string
  patch: {
    status?: "pending" | "running" | "completed" | "failed" | "killed"
    description?: string
    endTime?: number
    totalPausedMs?: number
    error?: string
    isBackgrounded?: boolean
  }
}

/** A single todo entry surfaced by the agent's TodoWrite tool.
 *
 *  V1 semantics (matches Claude Code's TodoWrite): in-memory, full-list
 *  replacement on each call, no owner / blocking / file-backed state.
 *  `content` is the imperative form shown when the todo is not in progress
 *  ("Run tests"); `activeForm` is the present-continuous form shown while
 *  the todo is actively being worked on ("Running tests"). */
export interface TodoItem {
  /** Imperative form — e.g. "Run tests" */
  content: string
  /** Present-continuous form — e.g. "Running tests" */
  activeForm: string
  status: "pending" | "in_progress" | "completed"
}

/** Todo list replaced (TodoWrite V1). `todos` is the FULL new list — the
 *  reducer replaces state.todos with this payload. An empty array is a
 *  valid "clear" signal. All-completed lists are stored as-is; the UI layer
 *  handles the short auto-hide delay (matches Claude Code's TaskListV2
 *  5-second hide timer — see team/backlog/done/task-view.md §6.3). */
export type TodosUpdatedEvent = {
  type: "todos_updated"
  /** Full replacement list. Empty array is valid (means "clear"). */
  todos: TodoItem[]
}

/** Errors */
export type ErrorEvent = {
  type: "error"
  code: string
  message: string
  severity?: "fatal" | "recoverable"
}

/** Cost tracking */
export type CostUpdateEvent = {
  type: "cost_update"
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Reasoning tokens used during the turn so far. SUBSET of outputTokens —
   *  see TokenUsage.reasoningTokens for the same subset semantics. */
  reasoningTokens?: number
  cost?: number
  /** Live per-model context-window cap reported by the backend (currently
   *  Codex 0.122+ via thread/tokenUsage/updated.modelContextWindow). When
   *  present, surfaces should prefer this over the static MODEL_CONTEXT_WINDOWS
   *  lookup since the backend may cap below the API-side maximum. */
  contextWindow?: number
  /** Per-API-call context window fill — the total prompt tokens for the
   *  most recent API call. More accurate than turn_complete.usage which
   *  is cumulative across all API calls in a multi-step agentic turn.
   *
   *  Each backend computes this differently because caching models differ:
   *
   *  - **Anthropic**: input_tokens, cache_read, cache_creation are DISJOINT.
   *    contextTokens = input_tokens + cache_read + cache_creation.
   *    Source: message_start stream event usage.
   *
   *  - **OpenAI (Codex)**: inputTokens INCLUDES cachedInputTokens (subset).
   *    contextTokens = inputTokens (from tokenUsage.last, not .total).
   *
   *  - **Gemini**: promptTokenCount INCLUDES cachedContentTokenCount (subset).
   *    contextTokens = promptTokenCount.
   */
  contextTokens?: number
}

/** Model changed (emitted by /model command) */
export type ModelChangedEvent = {
  type: "model_changed"
  model: string
}

/** Effort level changed (emitted by /thinking command) */
export type EffortChangedEvent = {
  type: "effort_changed"
  effort: EffortLevel
}

/** System message (slash command output, notifications) */
export type SystemMessageEvent = {
  type: "system_message"
  text: string
  /** Ephemeral messages are shown in the UI but excluded from API context.
   *  Matches Claude Code's `display: 'system'` behavior for local commands. */
  ephemeral?: boolean
}

/** Worktree created — synthetic event emitted by the Claude event-mapper when
 *  the agent's `EnterWorktree` tool call succeeds. The reducer folds this into
 *  `ConversationState.worktree`; the header bar reads that to show a
 *  "(worktree: <name>)" badge. We emit this event (rather than writing
 *  directly to the session store) so worktree state is event-sourced like
 *  every other piece of UI state. */
export type WorktreeCreatedEvent = {
  type: "worktree_created"
  /** Worktree name / slug. Derived from the tool's worktreePath when absent. */
  name: string
  /** Absolute path to the worktree directory on disk. */
  path: string
}

/** Worktree removed — synthetic event emitted by the Claude event-mapper when
 *  the agent's `ExitWorktree` tool call succeeds with `action: "remove"`. */
export type WorktreeRemovedEvent = {
  type: "worktree_removed"
  /** Absolute path of the worktree that was torn down. */
  path: string
}

/** Working directory changed — synthetic event emitted whenever the backend
 *  reports a cwd transition. Today this fires from the Claude event-mapper
 *  on EnterWorktree / ExitWorktree completion; future backends can emit it
 *  from an equivalent signal. */
export type CwdChangedEvent = {
  type: "cwd_changed"
  /** Previous working directory. Empty string when unknown. */
  oldCwd: string
  /** New working directory. */
  newCwd: string
}

/** Task backgrounding (synthetic, emitted by TUI on Ctrl+B double-press) */
export type TaskBackgroundEvent = { type: "task_background" }
export type TaskForegroundEvent = { type: "task_foreground" }

/** Plan update (ACP structured plan) */
export type PlanUpdateEvent = {
  type: "plan_update"
  entries: PlanEntry[]
}

export interface PlanEntry {
  content: string
  priority?: "high" | "medium" | "low"
  status?: "pending" | "in_progress" | "completed"
}

/** Config options update (from agent capability negotiation) */
export type ConfigOptionsEvent = {
  type: "config_options"
  options: ConfigOption[]
}

/** Skill sub-agent tool activity — extracted from sub-agent messages with parent_tool_use_id */
export type SkillToolActivityEvent = {
  type: "skill_tool_activity"
  /** The Skill tool_use_id that this activity belongs to */
  parentToolUseId: string
  /** Name of the sub-agent tool (e.g., "Bash", "Read", "Edit"). May be absent on tool_result messages. */
  toolName?: string
  /** The sub-agent's tool_use_id for this specific tool invocation */
  toolId: string
  /** Current status of this tool use */
  status: "running" | "done" | "error"
}

/** Backend escape hatch */
export type BackendSpecificEvent = {
  type: "backend_specific"
  backend: string
  data: unknown
}

/**
 * Rate-limit / subscription-usage update.
 *
 * Emitted whenever a backend reports a new usage snapshot. Claude's SDK
 * emits one `SDKRateLimitEvent` per claude.ai subscription bucket
 * (5hr / 7day / 7day_opus / 7day_sonnet / overage). Codex emits one
 * `account/rateLimits/updated` notification per primary/secondary window.
 *
 * The reducer folds these into `ConversationState.rateLimits`, which the
 * status bar and `/statusline` hook consume. A single event describes
 * *one* window — repeat events update their respective slots.
 *
 * Field shape mirrors Claude SDK's `SDKRateLimitInfo` so the Claude
 * adapter can forward verbatim; Codex adapter normalizes into this shape.
 */
export type RateLimitUpdateEvent = {
  type: "rate_limit_update"
  /**
   * Which window this update describes. The closed enumeration lives in
   * `protocol/rate-limits.ts` (`RATE_LIMIT_BUCKETS`); using `RateLimitBucket`
   * here keeps the wire shape, the validators in event-mappers, and the
   * reducer's slot routing in lock-step (Cluster 9 — anti-drift sprint).
   */
  rateLimitType: RateLimitBucket
  /** Current status for this window. */
  status?: "allowed" | "allowed_warning" | "rejected"
  /** Fractional utilization in [0, 1]. Preferred over `surpassedThreshold`. */
  utilization?: number
  /** Fallback hint (also 0–1) for the threshold most recently crossed, when
   *  `utilization` is unavailable (e.g. some SDK revisions). */
  surpassedThreshold?: number
  /** Unix epoch seconds when this window resets. */
  resetsAt?: number
  /** Window duration in minutes. Only Codex supplies this today — used to
   *  disambiguate which underlying subscription bucket a generic
   *  primary/secondary slot corresponds to. */
  windowDurationMins?: number
  /** True when the user is currently consuming overage credits. */
  isUsingOverage?: boolean
  /** Status for the overage pool, independent of the primary window. */
  overageStatus?: "allowed" | "allowed_warning" | "rejected"
  /** Epoch seconds when the overage pool resets. */
  overageResetsAt?: number
  /** Reason overage is disabled (verbatim from the SDK — surface for debugging). */
  overageDisabledReason?: string
  /** Originating backend (for logging / multi-backend telemetry). */
  source?: "claude" | "codex" | string
}

// ---------------------------------------------------------------------------
// Session resume summary — aggregate metadata derived from a parsed session
// file. Used by the resume banner (SessionResumeSummaryView) and by
// cross-backend resume to communicate what's being loaded.
// ---------------------------------------------------------------------------

export interface SessionResumeUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number
  /** Effective context window occupied by the conversation (input + cache-reads).
   *  Used to compute a "% of context used" indicator. */
  contextTokens: number
}

export interface SessionResumeSummary {
  sessionId: string
  /** Backend that originally created the session (claude | codex | gemini | ...) */
  origin: string
  /** Current backend rendering the resume. When origin !== target, it's cross-backend. */
  target: string
  messageCount: number
  toolCallCount: number
  turnCount: number
  /** Epoch ms of the most recent message in the session, if known */
  lastActiveAt?: number
  usage?: SessionResumeUsage
  /** Context-window size of the model associated with the session, if known */
  contextWindowTokens?: number
  /** Absolute path of the source file (for debugging / error messages) */
  filePath?: string
  /** Cross-backend caveat to display inside the summary (e.g. "Tools from the
   *  original session may not be available here"). Set by sync layer when origin
   *  differs from target. */
  crossBackendCaveat?: string
}

/** Result returned by session file parsers. The `target` inside `summary`
 *  defaults to `origin`; the TUI sync layer overrides it when resuming
 *  cross-backend. */
export interface ParsedSession {
  blocks: Block[]
  summary: SessionResumeSummary
  /** Todo list reconstructed from the last TodoWrite tool_use in the session
   *  history. The reducer's live path replaces `ConversationState.todos`
   *  wholesale on each TodoWrite, so only the LAST call in the transcript
   *  matters — earlier calls are superseded. Backends without a TodoWrite
   *  equivalent (Codex, Gemini) always return `[]`. */
  todos: TodoItem[]
}

/** Union of all agent events */
export type AgentEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | TextCompleteEvent
  | ToolUseStartEvent
  | ToolUseProgressEvent
  | ToolUseEndEvent
  | PermissionRequestEvent
  | PermissionResponseEvent
  | ElicitationRequestEvent
  | ElicitationResponseEvent
  | UserMessageEvent
  | InterruptEvent
  | ShutdownEvent
  | TurnStartEvent
  | TurnCompleteEvent
  | SessionInitEvent
  | SessionStateEvent
  | CompactEvent
  | TaskStartEvent
  | TaskProgressEvent
  | TaskCompleteEvent
  | TaskUpdatedEvent
  | TodosUpdatedEvent
  | ErrorEvent
  | CostUpdateEvent
  | ModelChangedEvent
  | EffortChangedEvent
  | SystemMessageEvent
  | TaskBackgroundEvent
  | TaskForegroundEvent
  | BackendSpecificEvent
  | ShellStartEvent
  | ShellEndEvent
  | PlanUpdateEvent
  | ConfigOptionsEvent
  | SkillToolActivityEvent
  | RateLimitUpdateEvent
  | WorktreeCreatedEvent
  | WorktreeRemovedEvent
  | CwdChangedEvent

// ---------------------------------------------------------------------------
// System Events — TUI lifecycle, not from any agent backend
//
// These are emitted by the TUI (sync layer) or by adapters for *local*
// lifecycle concerns that have no equivalent in any backend protocol.
// Kept in a separate union from AgentEvent so the type system makes it
// obvious whether an event originated from a remote agent or from
// bantai itself.
// ---------------------------------------------------------------------------

/** Resume: parsing has started. UI should show a loading spinner and block input. */
export type HistoryLoadStartedEvent = {
  type: "history_load_started"
  sessionId: string
  /** Absolute path of the session file being parsed (for debug/error surfacing) */
  filePath: string
  /** Backend that originally created the session (may differ from current target) */
  origin: string
}

/** Resume: history was successfully parsed and seeded. UI should stop the spinner,
 *  append a SessionResumeSummaryView block, and scroll the conversation to the bottom.
 *  For native-replay backends (Gemini/ACP) this fires when the adapter is about to
 *  send the first real user prompt — signaling that the initial replay window has
 *  fully drained. */
export type HistoryLoadedEvent = {
  type: "history_loaded"
  sessionId: string
  /** Backend that originally created the session */
  origin: string
  /** Current (target) backend rendering the resume */
  target: string
  /** Aggregate metadata used by the resume summary component */
  summary: SessionResumeSummary
}

/** Resume: parsing failed (missing file, malformed JSON, etc). UI should clear
 *  the spinner, show a detailed error block, and fall back to a fresh session. */
export type HistoryLoadFailedEvent = {
  type: "history_load_failed"
  sessionId: string
  /** File path we attempted to read, if known */
  filePath?: string
  /** Origin backend, if we got far enough to detect it */
  origin?: string
  /** User-facing error summary */
  error: string
  /** Full details (stack, inner message) for debug output */
  details?: string
}

/** Union of system/lifecycle events — emitted locally, never by an agent. */
export type SystemEvent =
  | HistoryLoadStartedEvent
  | HistoryLoadedEvent
  | HistoryLoadFailedEvent

/** Everything the reducer / event channel / event batcher actually handles.
 *  Adapters produce AgentEvent. The TUI sync layer (and AcpAdapter, for its
 *  replay-done signal) can also emit SystemEvent. */
export type ConversationEvent = AgentEvent | SystemEvent

// ---------------------------------------------------------------------------
// Agent Backend — the unified adapter interface
// ---------------------------------------------------------------------------

export interface AgentBackend {
  /** Start a new session. Returns the event stream for the entire session.
   *  Adapters produce AgentEvent, but may also emit local lifecycle
   *  SystemEvents (e.g. history_loaded for native-replay backends) — so
   *  the stream is typed as ConversationEvent. */
  start(config: SessionConfig): AsyncGenerator<ConversationEvent>

  /** Send a message. Queued if a turn is already running. */
  sendMessage(message: UserMessage): void

  /** Interrupt the current turn. */
  interrupt(): void

  /** Resume a previous session. */
  resume(sessionId: string): AsyncGenerator<ConversationEvent>

  /** List available sessions. */
  listSessions(): Promise<SessionInfo[]>

  /** Fork a session at a specific point. */
  forkSession(sessionId: string, options?: ForkOptions): Promise<string>

  /** Approve a pending tool use request. */
  approveToolUse(
    id: string,
    options?: { updatedInput?: unknown; alwaysAllow?: boolean; updatedPermissions?: PermissionUpdate[] },
  ): void

  /** Deny a pending tool use request. */
  denyToolUse(id: string, reason?: string, options?: { denyForSession?: boolean }): void

  /** Respond to an elicitation request with answers keyed by question text. */
  respondToElicitation(id: string, answers: Record<string, string>): void

  /** Cancel/decline a pending elicitation request. */
  cancelElicitation(id: string): void

  /** Change the model at runtime. Only valid in IDLE state. */
  setModel(model: string): Promise<void>

  /** Change permission mode. */
  setPermissionMode(mode: PermissionMode): Promise<void>

  /** Change thinking effort level at runtime. Only valid in IDLE state. */
  setEffort(level: EffortLevel): Promise<void>

  /** Query backend capabilities. */
  capabilities(): BackendCapabilities

  /** List available models. */
  availableModels(): Promise<ModelInfo[]>

  /** Set a backend config option. Only valid for backends that expose config options. */
  setConfigOption?(id: string, value: unknown): Promise<void>

  /** Reset the backend session (create a fresh session without restarting).
   *  Used by /new to clear server-side conversation history.
   *  Backends that don't support this can leave it unimplemented. */
  resetSession?(): Promise<void>

  /** Resolves once the backend is truly ready to accept user messages:
   *  subprocess alive, handshake complete, any replayContext stashed, and
   *  the message loop listening. Used by /switch as the definitive readiness
   *  gate, replacing the looser `session_init` edge — which can race ahead of
   *  the adapter's own stash sequence on backends that emit session_init from
   *  a notification path (Codex).
   *
   *  Rejects with the underlying error if the adapter fails during startup
   *  (e.g. subprocess crash, handshake error). The rejection reason should
   *  carry enough context for the user to act on (see Codex transport's
   *  stderr-capturing error path, shipped in commit ae7c53b).
   *
   *  Optional for backward compatibility. Callers that require it (switch)
   *  should fall back to awaiting session_init when this is undefined.
   */
  whenReady?(): Promise<void>

  /** Gracefully close the backend and clean up child processes. */
  close(): void
}

// ---------------------------------------------------------------------------
// Session lifecycle state machine
// ---------------------------------------------------------------------------

// SessionState is re-exported from `protocol/session-state.ts` so existing
// `import { SessionState } from "../protocol/types"` call sites keep working.
// New code should import from `protocol/session-state` directly when it also
// needs helpers (`STATE_LABELS`, `STATE_GLYPHS`, `isKnownSessionState`).
export type { SessionState } from "./session-state"
import type { SessionState } from "./session-state"

// ---------------------------------------------------------------------------
// Block types — flat, append-only conversation model
// ---------------------------------------------------------------------------

export type ToolStatus = "running" | "done" | "error" | "canceled"

/** A single tool invocation by a Skill's sub-agent */
export interface SkillToolUse {
  toolId: string
  toolName: string
  status: "running" | "done" | "error"
}

export type Block =
  | { type: "user"; text: string; queued?: boolean; images?: ImageContent[]; error?: { code: string; message: string }; origin?: SDKMessageOrigin }
  | { type: "assistant"; text: string; timestamp?: number; model?: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; tool: string; input: unknown; status: ToolStatus; output?: string; error?: string; startTime: number; duration?: number; skillActivity?: SkillToolUse[] }
  | { type: "system"; text: string; ephemeral?: boolean }
  | { type: "compact"; summary: string; trigger?: "user" | "auto"; preTokens?: number; postTokens?: number; inProgress?: boolean; durationMs?: number }
  | { type: "shell"; id: string; command: string; output: string; error?: string; exitCode?: number; status: "running" | "done" | "error"; startTime: number; duration?: number }
  | { type: "error"; code: string; message: string }
  | { type: "plan"; entries: PlanEntry[] }
  | SessionResumeSummaryBlock

/** Marker block inserted at the boundary between loaded-from-disk history and
 *  new turns produced in this session. Rendered by SessionResumeSummaryView —
 *  gives the user token usage, context %, cost, last-active time, and any
 *  cross-backend caveats, so they can judge whether resuming is worthwhile. */
export interface SessionResumeSummaryBlock extends SessionResumeSummary {
  type: "session_resume_summary"
}

// ---------------------------------------------------------------------------
// Conversation State — event-sourced, derived via reducer
// ---------------------------------------------------------------------------

export interface ConversationState {
  /** Current session lifecycle state */
  sessionState: SessionState

  /** Flat, append-only block list */
  blocks: Block[]

  /** Currently streaming text (accumulated text_deltas) */
  streamingText: string

  /** Currently streaming thinking (accumulated thinking_deltas) */
  streamingThinking: string

  /** Pending permission request (at most one at a time) */
  pendingPermission: PermissionRequestEvent | null

  /** Pending elicitation request */
  pendingElicitation: ElicitationRequestEvent | null

  /** Active background tasks */
  activeTasks: Map<string, TaskInfo>

  /** Agent's current todo list (V1 TodoWrite — in-memory, full replacement
   *  on each update). All-completed lists stay in state; the TUI layer
   *  hides them after a short delay to match Claude Code's V2 behavior.
   *  Persists across turns by design; reset on session_init and backend
   *  switch. */
  todos: TodoItem[]

  /** Current model name (updated by /model command, overrides session default) */
  currentModel: string | null

  /** Current effort level (updated by /thinking command, null = default/high) */
  currentEffort: EffortLevel | null

  /** Session metadata from session_init */
  session: SessionMetadata | null

  /** Running cost totals */
  cost: CostTotals

  /** Ordered event log (source of truth) */
  eventLog: AgentEvent[]

  /** Error info when in ERROR state */
  lastError: ErrorEvent | null

  /** Current turn number (incremented on turn_start) */
  turnNumber: number

  /** Input tokens from the last completed turn — approximates context window fill */
  lastTurnInputTokens: number

  /** Milliseconds from query start to first streamed token for the most
   *  recent completed turn (SDK 0.2.112+ `ttft_ms`). `null` when unknown
   *  (backend doesn't report it, or no turn has completed yet). Reset to
   *  `null` on `turn_start` so stale values don't leak across turns. */
  lastTurnTtftMs: number | null
  /** True when lastTurnInputTokens was set from per-API-call data (message_start)
   *  during the current turn, so turn_complete should not overwrite it with
   *  cumulative usage. Reset on turn_start. */
  _contextFromStream: boolean

  /** Output tokens accumulated during streaming (reset on turn boundaries, separate from authoritative cost) */
  streamingOutputTokens: number

  /** Whether the current turn is backgrounded (UI collapsed, input re-enabled) */
  backgrounded: boolean

  /** Rate limit utilization, keyed by window bucket. Fed by
   *  `rate_limit_update` events (Claude SDK rate_limit_event + Codex
   *  account/rateLimits/updated). */
  rateLimits: RateLimits | null

  /**
   * True after user_message transitions to RUNNING (before the SDK's turn_start arrives).
   * Allows turn_start to process when already in RUNNING from a user_message,
   * while still ignoring genuine duplicate turn_start events mid-stream.
   */
  awaitingTurnStart: boolean

  /** Files modified in the last completed turn */
  lastTurnFiles?: TurnFileChange[]

  /** Summary of the most recent completed turn — drives the TUI "Baked for X"
   *  line shown in IDLE state. All fields are optional per-backend: Claude
   *  reports full data (duration/cost/tokens); Codex reports usage only; ACP
   *  and mock report usage with no duration. Reset to `null` on `turn_start`
   *  so stale values don't leak across turns. */
  lastTurnSummary: TurnSummaryInfo | null

  /** Agent-advertised slash commands (from ACP available_commands_update) */
  agentCommands: AgentSlashCommand[]

  /** Config options exposed by the backend agent */
  configOptions: ConfigOption[]

  /** True while a resume is in progress: session file is being parsed, or
   *  (for Gemini) the initial replay stream is being drained. The TUI uses
   *  this to show a loading spinner and disable message input.
   *  Set by `history_load_started`, cleared by `history_loaded` / `history_load_failed`. */
  resuming: boolean

  /** Current working directory as reported by the backend. Updated by
   *  `cwd_changed` events. Null until the first change is observed — the
   *  header bar falls back to `agent.config.cwd` in that case. */
  currentCwd: string | null

  /** Active worktree metadata. Set by `worktree_created`, cleared by
   *  `worktree_removed`. Only populated when the agent is inside a git
   *  worktree created via the Claude SDK's built-in `EnterWorktree` tool. */
  worktree: { path: string; name?: string } | null
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface UserMessage {
  text: string
  images?: ImageContent[]
}

export interface ImageContent {
  data: string // base64
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
}

export interface SessionConfig {
  model?: string
  permissionMode?: PermissionMode
  maxTurns?: number
  maxBudgetUsd?: number
  cwd?: string
  systemPrompt?: string
  resume?: string
  /** When true, --resume was invoked without a session ID — show interactive picker */
  resumeInteractive?: boolean
  continue?: boolean
  forkSession?: boolean
  mcpServers?: Record<string, unknown>
  /**
   * Backend-agnostic stdio MCP servers to expose to the agent. Each entry
   * names a subprocess that speaks MCP over stdio; the adapter translates
   * into the runtime's native spec:
   *
   *   - Claude: merged into `mcpServers` with `type: "stdio"` (the Claude
   *     SDK accepts this natively, alongside in-process `mcpServers` entries).
   *   - Codex: injected into `CodexOptions.config.mcp_servers.*` which the
   *     Codex CLI flattens into TOML-level MCP config.
   *   - ACP / mock: logged and ignored (the transports don't carry MCP).
   *
   * Used by the Slack frontend to expose `slack_upload` to every backend
   * (Claude's in-process variant was Claude-only). Keep entries self-
   * contained — the subprocess only sees `env` + the command line.
   */
  stdioMcpServers?: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string> }
  >
  /**
   * Extra text appended to the backend's system prompt without replacing it.
   *
   * Populated by the Slack frontend with per-session context (channel id,
   * thread ts, available Slack-specific tools) so the agent knows it's
   * responding in Slack and can use `slack_upload` proactively. The TUI
   * doesn't set this; project/user `systemPrompt` is the single source of
   * truth there.
   *
   * Contract:
   *   - Claude: forwarded as the SDK's `appendSystemPrompt` option.
   *   - Codex: concatenated onto `systemPrompt` with a blank line separator
   *     (Codex SDK has no append primitive — we fall back to joining).
   *   - ACP / mock: ignored.
   */
  appendSystemPrompt?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  additionalDirectories?: string[]
  /** Initial prompt from CLI (--prompt or positional arg) */
  initialPrompt?: string
  /**
   * Prior-session context to inject into the NEXT real user turn without
   * creating a phantom turn of its own. Populated by `/switch` when swapping
   * backends mid-session — the formatted conversation history goes here so
   * the model has prior turns in its context window, but does NOT get a
   * "new user message" that it then has to respond to.
   *
   * Adapter contract: on startup, if `replayContext` is set, the adapter
   * MUST NOT start a turn with it. Instead it stashes the context and
   * prepends it (clearly marked as historical) to the first user message
   * that arrives via the message queue. Adapters that cannot support
   * deferred context injection may fall back to a clear UX ("starts
   * fresh — prior conversation not replayed") — but must never send it
   * as a user turn.
   */
  replayContext?: string
  /** Original backend that created the session being resumed (cross-backend resume) */
  sessionOrigin?: string
  /** Internal: when set, the adapter is expected to emit a `history_loaded`
   *  SystemEvent with this summary once the backend's initial replay stream
   *  has been drained. Populated by the TUI sync layer for native-replay
   *  backends (Gemini/ACP). Ignored by silent-load backends (Claude/Codex),
   *  which emit `history_loaded` directly from sync.tsx. */
  _pendingResumeSummary?: SessionResumeSummary
  /** Persist session to disk so it can be resumed later (default: true) */
  persistSession?: boolean
  /** Thinking/reasoning configuration */
  thinking?: ThinkingConfig
  /** Effort level for controlling reasoning depth */
  effort?: EffortLevel
  /**
   * Extra environment variables to inject into the backend spawn. Used by
   * the Slack frontend to isolate per-channel settings — notably
   * `CLAUDE_CONFIG_DIR`, `NPM_CONFIG_CACHE`, and auth tokens — so two
   * channels can run different skills/MCP auth without colliding.
   *
   * Claude adapter: passes this verbatim into the SDK's `env` option, which
   * is merged on top of `process.env`. Backends that don't support a
   * per-query env (e.g. mock, ACP presets) ignore the field.
   */
  env?: Record<string, string>

  /**
   * Experimental — when true, the TUI should render in read-only follow mode.
   * Set by `bantai follow <id>` (see `src/backends/follow/`). Consumers:
   *   - input area: disables the textarea and shows a "following" banner.
   *   - slash dispatcher: no-ops all commands (system_message instead).
   *   - status bar: shows a "FOLLOW" pill.
   *
   * MUST be read via the session/agent reactive stores in the TUI, never
   * snapshot into a const (per AGENTS.md runtime-mutable-values rule).
   */
  readOnly?: boolean
}

/**
 * Backend that owns a session.
 *
 * Mirrors `BackendId` from the registry — kept as a separate alias so that
 * existing imports (`import { SessionOrigin } from "../protocol/types"`) keep
 * working. New code should prefer `BackendId` from `protocol/registry` plus
 * `isKnownBackendId()` for validation.
 *
 * Historically this was a closed `"claude" | "codex" | "gemini"` union, which
 * silently rejected qwen sessions when the qwen backend landed (live bug L1).
 * Widening to `string` is intentional: the registry is the runtime source of
 * truth, and any backend that registers `sessionFile.listFromDisk` gets to
 * tag its sessions with its own id.
 */
export type SessionOrigin = string

/**
 * Sessions grouped by backend id for the multi-backend session picker.
 *
 * Keys are `BackendId`s from the registry — the picker iterates
 * `listSessionFileBackends()` (one descriptor per backend that owns disk
 * storage) and indexes the record by id. Every backend that registers a
 * `sessionFile.listFromDisk` handler contributes a key here.
 */
export type MultiBackendSessions = Record<string, SessionInfo[]>

export interface SessionInfo {
  id: string
  title: string
  createdAt?: number
  updatedAt: number
  messageCount?: number
  gitBranch?: string
  cwd?: string
  fileSize?: number
  // --- V2 picker fields ---
  /** Which backend owns this session */
  origin?: SessionOrigin
  /** Number of user turns */
  turnCount?: number
  /** Total tool invocations */
  toolCallCount?: number
  /** Rough total tokens (input + output + cache) */
  totalTokens?: number
  /** Cumulative cost in USD (Claude only for now) */
  totalCostUsd?: number
  /** Context window usage percentage (0-100) */
  contextPercent?: number
  /** Model name if detectable */
  model?: string
  /** True if session cwd matches current cwd */
  isCurrentProject?: boolean
  /** fuzzysort match positions (transient, set by search pipeline) */
  _matchIndexes?: number[]
  /** fuzzysort score (transient, set by search pipeline) */
  _score?: number
}

export interface ForkOptions {
  atTurn?: number
}

export interface BackendCapabilities {
  name: string
  sdkVersion?: string
  supportsThinking: boolean
  supportsToolApproval: boolean
  supportsResume: boolean
  supportsContinue: boolean
  supportsFork: boolean
  supportsStreaming: boolean
  supportsSubagents: boolean
  supportsCompact: boolean
  supportedPermissionModes: PermissionMode[]
  /** Describes what the backend's sandbox and approval system actually enforces.
   *  Used by the status bar to show honest, backend-specific caveats. */
  sandboxInfo?: SandboxInfo
}

// ---------------------------------------------------------------------------
// Sandbox & Approval Model — per-backend reality
// ---------------------------------------------------------------------------

/**
 * Describes the actual sandbox and approval semantics for a backend in a
 * given permission mode. Backends have fundamentally different security
 * models — this type makes those differences visible to the UI layer.
 *
 * Semantic gaps between backends:
 *
 * - **Claude**: Approvals and sandboxing are the SAME control. The SDK's
 *   permissionMode governs both what gets asked and what gets blocked.
 *   There is no separate sandbox process — the CLI itself enforces
 *   file/command restrictions.
 *
 * - **Codex**: Approvals and sandboxing are SEPARATE controls. The approval
 *   policy ("on-request" / "never") decides whether the user is asked.
 *   The sandbox policy (workspace-write / dangerFullAccess) runs in a
 *   separate environment that restricts filesystem access regardless of
 *   approval decisions. In workspace-write mode, .git is read-only even
 *   if the user approves a write — the sandbox blocks it.
 *
 * - **ACP (Gemini/Copilot)**: Varies by agent implementation. The ACP
 *   protocol defines modes and permission_request callbacks, but sandbox
 *   enforcement is agent-specific and not introspectable from the client.
 */
export interface SandboxInfo {
  /** Short summary shown as a subtitle in the status bar.
   *  e.g., "sandbox: .git read-only" or "no sandbox" */
  statusHint: string

  /** Per-permission-mode descriptions of what the backend actually enforces */
  modeDetails: Partial<Record<PermissionMode, PermissionModeDetail>>
}

/**
 * Describes what a specific permission mode actually means for a given backend.
 * Each field is a human-readable description, not a machine-enforceable policy.
 */
export interface PermissionModeDetail {
  /** What filesystem paths are writable (e.g., "cwd + allowed dirs", "everything") */
  writableScope: string
  /** What paths are explicitly protected/read-only (e.g., ".git", "none") */
  protectedPaths: string
  /** Whether shell command execution requires approval */
  commandApproval: "always" | "never" | "per-tool-rules"
  /** Whether file edits require approval */
  editApproval: "always" | "never" | "per-tool-rules"
  /** Network access policy */
  networkAccess: "unrestricted" | "restricted" | "blocked" | "unknown"
  /** Whether approvals and sandboxing are separate controls */
  separateSandbox: boolean
  /** Any additional caveats specific to this mode+backend combination */
  caveats?: string
}

/**
 * Permission mode — shared vocabulary across backends.
 *
 * The closed enumeration lives in `protocol/permission-modes.ts`; this is
 * a re-export so existing `import { PermissionMode } from "../protocol/types"`
 * call sites keep working. New code should import from
 * `protocol/permission-modes` directly when it also needs helpers
 * (`isKnownPermissionMode`, `knownPermissionModeIds`, etc.).
 *
 * IMPORTANT: These names provide a common UI language, but the actual
 * enforcement varies by backend. See SandboxInfo for per-backend details.
 *
 * - "default"           — Ask before destructive actions (edits, commands)
 * - "acceptEdits"       — Auto-approve file edits, still ask for commands
 * - "bypassPermissions" — Auto-approve everything (no prompts)
 * - "plan"              — Read-only analysis, no edits or commands
 * - "dontAsk"           — Never prompt; deny anything not pre-approved via allowlist
 * - "auto"              — Model classifier decides approve/deny per request
 *                         (no prompt surfaced when the classifier is confident)
 */
export type { PermissionMode } from "./permission-modes"
import type { PermissionMode } from "./permission-modes"

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalCostUsd?: number
  /** Reasoning tokens used by the model. SUBSET of outputTokens — billing
   *  already counts them as output, so adding them again would double-count.
   *  Provided so surfaces can render a thinking/output split when desired
   *  (gpt-5.5, o-series). */
  reasoningTokens?: number
}

export interface ToolInfo {
  name: string
  description?: string
}

export interface ModelInfo {
  id: string
  name: string
  provider?: string
  contextWindow?: number
}

export interface AccountInfo {
  email?: string
  plan?: string
}

export interface SessionMetadata {
  tools: ToolInfo[]
  models: ModelInfo[]
  account?: AccountInfo
  sessionId?: string
}

export interface TaskInfo {
  taskId: string
  description: string
  output: string
  status: "running" | "completed" | "error"
  startTime: number
  /** Correlates this task to the Agent ToolUseBlock that spawned it */
  toolUseId?: string
  /** Subagent type (e.g., "Explore", "general-purpose") */
  taskType?: string
  /** Name of the most recent tool the subagent used */
  lastToolName?: string
  /** AI-generated progress summary */
  summary?: string
  /** "native" for crossagent-managed subagents, "backend" for backend's own (Claude SDK, etc.) */
  source?: "native" | "backend"
  /** Which backend the subagent runs on (e.g., "gemini", "claude", "copilot") */
  backendName?: string
  /** Subagent's session ID for log cross-referencing */
  sessionId?: string
  /** Number of conversation turns completed */
  turnCount?: number
  /** Total tool invocations */
  toolUseCount?: number
  /** Token usage (when available) */
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens?: number }
  /** Currently in a thinking block */
  thinkingActive?: boolean
  /** True while a turn is in progress (between turn_start and turn_complete) */
  activeTurn?: boolean
  /** Last N tool names used (rolling window) */
  recentTools?: string[]
  /** Model powering this subagent (when known) */
  model?: string
  /** Timestamp when the task completed or errored */
  endTime?: number
  /** Error message if task ended with error */
  errorMessage?: string
  /** Total time paused in milliseconds (SDK 0.2.107+) */
  totalPausedMs?: number
  /** Whether the task is currently backgrounded (SDK 0.2.107+) */
  isBackgrounded?: boolean
  /** When true, this is an ambient/housekeeping task — hide from inline transcript */
  skipTranscript?: boolean
}

export interface CostTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalCostUsd: number
}

export interface RateLimitEntry {
  usedPercentage: number // 0-100
  resetsAt?: number      // Unix epoch seconds
  windowDurationMins?: number // Actual window duration (from Codex)
}

export interface RateLimits {
  fiveHour?: RateLimitEntry
  sevenDay?: RateLimitEntry
  /** Generic primary window (Codex backends where duration ≠ 5h or 7d) */
  primary?: RateLimitEntry
  /** Generic secondary window (Codex backends where duration ≠ 5h or 7d) */
  secondary?: RateLimitEntry
}

export interface ElicitationQuestion {
  question: string
  /** Short label displayed as a chip/tag (max 12 chars) */
  header?: string
  options: ElicitationOption[]
  allowFreeText?: boolean
  multiSelect?: boolean
}

export interface ElicitationOption {
  label: string
  description?: string
  preview?: string
}

/** Matches SDK PermissionRuleValue */
export interface PermissionRuleValue {
  toolName: string
  ruleContent?: string
}

/** Matches SDK PermissionUpdateDestination */
export type PermissionUpdateDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session"
  | "cliArg"

/** Matches SDK PermissionUpdate — used in canUseTool results */
export type PermissionUpdate =
  | {
      type: "addRules"
      rules: PermissionRuleValue[]
      behavior: "allow" | "deny"
      destination: PermissionUpdateDestination
    }
  | {
      type: "replaceRules"
      rules: PermissionRuleValue[]
      behavior: "allow" | "deny"
      destination: PermissionUpdateDestination
    }
  | {
      type: "removeRules"
      rules: PermissionRuleValue[]
      behavior: "allow" | "deny"
      destination: PermissionUpdateDestination
    }
  | {
      type: "setMode"
      mode: PermissionMode
      destination: PermissionUpdateDestination
    }
  | {
      type: "addDirectories"
      directories: string[]
      destination: PermissionUpdateDestination
    }
  | {
      type: "removeDirectories"
      directories: string[]
      destination: PermissionUpdateDestination
    }

// ---------------------------------------------------------------------------
// Turn file change tracking
// ---------------------------------------------------------------------------

export interface TurnFileChange {
  path: string
  action: "read" | "write" | "edit" | "create"
  tool: string
}

/** Per-turn summary info, captured at `turn_complete`. Drives the TUI
 *  "Baked for X" line shown in IDLE. All fields are optional per-backend:
 *
 *  - **Claude**: full data — `durationMs`, `costUsd`, and `usage`.
 *  - **Codex**: `usage` only (`turn/completed` has no duration).
 *  - **ACP / mock / follow**: usage-only or nothing.
 *
 *  The TUI hides fields it doesn't have rather than synthesising them. */
export interface TurnSummaryInfo {
  /** Wall-clock duration of the turn in milliseconds (Claude SDK `duration_ms`). */
  durationMs?: number
  /** Per-turn cost in USD (Claude SDK `total_cost_usd`). */
  costUsd?: number
  /** Per-turn token usage breakdown. Absent for backends that don't report it. */
  usage?: TokenUsage
}

/** Agent-advertised slash command (from ACP backends) */
export interface AgentSlashCommand {
  name: string
  description?: string
}

/**
 * Type tag for a `ConfigOption`. The same union also lives in the ACP
 * boundary type; both consumers import this alias so the strings can't
 * drift (Cluster 11). "select" is Copilot's alias for "enum"; the ACP
 * boundary normalises it to "enum" on the way in.
 */
export type ConfigOptionType = "string" | "boolean" | "enum" | "select"

/** Backend-agnostic config option — exposed by ACP agents, potentially other backends in the future */
export interface ConfigOption {
  id: string
  name: string
  description?: string
  type: ConfigOptionType
  value: unknown
  choices?: { id: string; name: string; description?: string }[]
}

// ---------------------------------------------------------------------------
// Initial state factory
// ---------------------------------------------------------------------------

export function createInitialState(): ConversationState {
  return {
    sessionState: "INITIALIZING",
    blocks: [],
    streamingText: "",
    streamingThinking: "",
    pendingPermission: null,
    pendingElicitation: null,
    activeTasks: new Map(),
    todos: [],
    currentModel: null,
    currentEffort: null,
    session: null,
    cost: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0,
    },
    eventLog: [],
    lastError: null,
    turnNumber: 0,
    lastTurnInputTokens: 0,
    lastTurnTtftMs: null,
    _contextFromStream: false,
    streamingOutputTokens: 0,
    backgrounded: false,
    awaitingTurnStart: false,
    lastTurnFiles: undefined,
    lastTurnSummary: null,
    rateLimits: null,
    agentCommands: [],
    configOptions: [],
    resuming: false,
    currentCwd: null,
    worktree: null,
  }
}

/**
 * Reset the per-backend volatile slice of ConversationState to the defaults
 * from `createInitialState()`, while preserving `blocks` (conversation history
 * is deliberately kept across a `/switch`) and other cross-backend state.
 *
 * Use this from `switchBackend()` so the status bar doesn't bleed the old
 * backend's cost / rate-limits / context / turn counters into the new
 * session. Reading the defaults from `createInitialState()` (instead of
 * hand-rolling them here) means that when a new volatile field is added to
 * `ConversationState`, it's enough to add it to the list below — the values
 * can't drift out of sync with the initial-state factory.
 *
 * Preserved (not reset): `blocks`, `eventLog`, `streamingText`,
 * `streamingThinking`, `pendingPermission`, `pendingElicitation`,
 * `activeTasks`, `backgrounded`, `awaitingTurnStart`, `resuming`,
 * `lastError`, `currentCwd`, `worktree`. In practice the switch path gates
 * on IDLE so the mid-turn fields are already at defaults, and
 * `currentCwd`/`worktree` are observable facts about the working
 * environment rather than per-backend state.
 */
export function resetVolatileSessionState(
  current: ConversationState,
): ConversationState {
  const fresh = createInitialState()
  return {
    ...current,
    // Session identity / lifecycle — reset so header + status bar re-render
    // cleanly while the new backend initializes.
    sessionState: fresh.sessionState,
    session: fresh.session,
    currentModel: fresh.currentModel,
    currentEffort: fresh.currentEffort,
    agentCommands: fresh.agentCommands,
    configOptions: fresh.configOptions,
    // Cost + usage accounting — stale values here are actively misleading
    // (users have reported believing Codex charged them for Claude usage).
    cost: fresh.cost,
    rateLimits: fresh.rateLimits,
    lastTurnInputTokens: fresh.lastTurnInputTokens,
    lastTurnTtftMs: fresh.lastTurnTtftMs,
    _contextFromStream: fresh._contextFromStream,
    streamingOutputTokens: fresh.streamingOutputTokens,
    turnNumber: fresh.turnNumber,
    lastTurnFiles: fresh.lastTurnFiles,
    lastTurnSummary: fresh.lastTurnSummary,
    // Todos are the current backend's working state, not a cross-backend
    // observable — clear on switch so the new backend starts fresh rather
    // than inheriting the old agent's in-flight task list.
    todos: fresh.todos,
  }
}
