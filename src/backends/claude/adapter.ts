/**
 * Claude Agent SDK V1 Adapter
 *
 * Maps the SDK's query() API to our AgentBackend interface.
 *
 * Key patterns:
 * - AsyncIterable prompt mode for multi-turn message queuing
 * - canUseTool callback bridges permission_request <-> approveToolUse/denyToolUse
 * - Single AsyncGenerator for the entire session (not per-turn)
 * - Process lifecycle management (SIGINT/SIGTERM/SIGHUP cleanup)
 */

import {
  query as sdkQuery,
  startup as sdkStartup,
  listSessions as sdkListSessions,
  forkSession as sdkForkSession,
  deleteSession as sdkDeleteSession,
  type Options as SDKOptions,
  type SDKUserMessage as SDKUserMsg,
  type SDKMessage as SDKMsg,
  type ModelInfo as SDKModelInfo,
  type WarmQuery as SDKWarmQuery,
} from "@anthropic-ai/claude-agent-sdk"
import { getDiagnosticsSdkMcpConfig } from "../../mcp/server"
import { getCrossagentSdkMcpConfig } from "../../subagents/mcp-tools"
import { log } from "../../utils/logger"
import type {
  AgentBackend,
  AgentEvent,
  BackendCapabilities,
  EffortLevel,
  ForkOptions,
  ModelInfo,
  PermissionMode,
  SandboxInfo,
  SessionConfig,
  SessionInfo,
  UserMessage,
} from "../../protocol/types"
import { DEFAULT_CAPABILITIES } from "../../protocol/capabilities"
import { EventChannel } from "../../utils/event-channel"
import { AsyncQueue } from "../../utils/async-queue"
import { backendTrace } from "../../utils/backend-trace"

const trace = backendTrace.scoped("claude")

import { mapSDKMessage, ToolStreamState } from "./event-mapper"

// ---------------------------------------------------------------------------
// Debug log payload builder for SDK messages
// ---------------------------------------------------------------------------

/**
 * Build a DEBUG log payload for one SDK message. The raw `{"type":"assistant"}`
 * we used to log was useless for diagnosing hangs (you couldn't tell whether
 * the assistant actually had content, how many tool uses fired, or what the
 * turn cost). This surfaces:
 *   - assistant: content-block count, combined text length, tool-use count,
 *                whether it's a sub-agent message, and the underlying
 *                SDK message id / model / stop_reason when present
 *   - result:    usage (input/output/cache tokens), total_cost_usd, num_turns,
 *                duration_ms, is_error flag
 *   - system:    session_id and model for init; subtype for everything else
 *   - stream_event: eventType (content_block_delta still suppressed upstream)
 *   - user (tool_result): tool_use_id and whether the result is an error
 * Unknown shapes fall back to the original minimal {type, subtype} so we
 * never lose the baseline signal.
 */
function buildSdkMessageLogPayload(
  msg: any,
  msgRecord: Record<string, unknown>,
  streamEventType: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> = { type: msg.type }
  if (msgRecord.subtype !== undefined) base.subtype = msgRecord.subtype

  switch (msg.type) {
    case "stream_event":
      if (streamEventType !== undefined) base.eventType = streamEventType
      return base

    case "assistant": {
      const content = msg.message?.content
      const parentToolUseId = msg.parent_tool_use_id
      if (Array.isArray(content)) {
        base.contentBlocks = content.length
        let textChars = 0
        let thinkingChars = 0
        let toolUses = 0
        for (const block of content) {
          if (!block || typeof block !== "object") continue
          if (block.type === "text" && typeof block.text === "string") textChars += block.text.length
          else if (block.type === "thinking" && typeof block.thinking === "string") thinkingChars += block.thinking.length
          else if (block.type === "tool_use") toolUses++
        }
        base.textChars = textChars
        if (thinkingChars > 0) base.thinkingChars = thinkingChars
        base.toolUses = toolUses
      } else {
        base.contentBlocks = 0
      }
      if (msg.message?.id) base.messageId = msg.message.id
      if (msg.message?.model) base.model = msg.message.model
      if (msg.message?.stop_reason) base.stopReason = msg.message.stop_reason
      if (parentToolUseId) base.parentToolUseId = parentToolUseId
      return base
    }

    case "result": {
      const usage = msg.usage
      if (usage) {
        base.usage = {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        }
      }
      if (typeof msg.total_cost_usd === "number") base.totalCostUsd = msg.total_cost_usd
      if (typeof msg.num_turns === "number") base.numTurns = msg.num_turns
      if (typeof msg.duration_ms === "number") base.durationMs = msg.duration_ms
      if (msg.is_error) base.isError = true
      if (msg.session_id) base.sessionId = msg.session_id
      return base
    }

    case "system":
      if (msg.subtype === "init") {
        if (msg.session_id) base.sessionId = msg.session_id
        if (msg.model) base.model = msg.model
        if (Array.isArray(msg.tools)) base.toolCount = msg.tools.length
      }
      return base

    case "user": {
      const content = msg.message?.content
      if (Array.isArray(content)) {
        let toolResults = 0
        let toolUseId: string | undefined
        let isError = false
        for (const block of content) {
          if (block?.type === "tool_result") {
            toolResults++
            if (!toolUseId && block.tool_use_id) toolUseId = block.tool_use_id
            if (block.is_error) isError = true
          }
        }
        if (toolResults > 0) base.toolResults = toolResults
        if (toolUseId) base.toolUseId = toolUseId
        if (isError) base.isError = true
      }
      if (msg.parent_tool_use_id) base.parentToolUseId = msg.parent_tool_use_id
      return base
    }

    default:
      return base
  }
}

import {
  createCanUseTool,
  type PendingPermission,
  type PendingElicitation,
  type PermissionResult,
  type PermissionBridgeState,
} from "./permission-bridge"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SDKQuery = ReturnType<typeof sdkQuery>
type ClaudeSdkRuntime = {
  query: typeof sdkQuery
  startup: typeof sdkStartup
  listSessions: typeof sdkListSessions
  /** Optional — only required by sideQuery(). Falling back to the live SDK
   *  module export keeps existing call sites that pass a partial runtime
   *  (e.g. older tests) working unchanged. */
  forkSession?: typeof sdkForkSession
  /** Optional — paired with forkSession; teardown unlinks the JSONL. */
  deleteSession?: typeof sdkDeleteSession
}

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000
const defaultClaudeSdkRuntime: ClaudeSdkRuntime = {
  query: sdkQuery,
  startup: sdkStartup,
  listSessions: sdkListSessions,
  forkSession: sdkForkSession,
  deleteSession: sdkDeleteSession,
}

// ---------------------------------------------------------------------------
// Claude V1 Adapter
// ---------------------------------------------------------------------------

export class ClaudeAdapter implements AgentBackend {
  constructor(private readonly sdk: ClaudeSdkRuntime = defaultClaudeSdkRuntime) {}

  private static sdkVersion: string = (() => {
    try { return require("@anthropic-ai/claude-agent-sdk/package.json").version } catch { return "unknown" }
  })()

  private activeQuery: SDKQuery | null = null
  private pendingWarmQuery: SDKWarmQuery | null = null
  private messageQueue = new AsyncQueue<UserMessage>()
  // Pending replay context from /switch — prepended to the next user message
  // as a marked historical section so the model treats it as background
  // rather than a turn to respond to. See SessionConfig.replayContext.
  private pendingReplayContext: string | null = null

  // Readiness gate — resolves when start() has finished all synchronous setup
  // (replayContext stashed, SDK query kicked off, message iterable listening).
  // See AgentBackend.whenReady() and base-adapter.ts for the contract.
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: unknown) => void) | null = null
  private readyPromise: Promise<void> = (() => {
    const p = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // No-op handler so close()-triggered rejection doesn't bubble as
    // unhandled when callers never awaited whenReady().
    p.catch(() => {})
    return p
  })()

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  private markReady(): void {
    if (this.readyResolve) {
      this.readyResolve()
      this.readyResolve = null
      this.readyReject = null
    }
  }

  private rejectReady(err: unknown): void {
    if (this.readyReject) {
      this.readyReject(err)
      this.readyResolve = null
      this.readyReject = null
    }
  }
  private pendingPermissions = new Map<string, PendingPermission>()
  private pendingElicitations = new Map<string, PendingElicitation>()
  private pendingElicitationInputs = new Map<string, Record<string, unknown>>()
  private eventChannel: EventChannel<AgentEvent> | null = null
  private closed = false

  // Tool input JSON accumulation from streaming deltas
  private streamState = new ToolStreamState()

  // Tools denied for the duration of this session (via "deny for session" option)
  private sessionDeniedTools = new Set<string>()

  // Most-recent session ID observed from SDK system/init or result messages.
  // Used by sideQuery() to pick the fork source. Updated by the background
  // event loop in iterateQuery().
  private liveSessionId: string | null = null

  // Working dir of the active session — used as the `dir` hint for forkSession()
  // so we don't have to scan every Claude project directory looking for the
  // source file.
  private sessionCwd: string | null = null

  // Permission bridge state (passed to extracted functions)
  private get bridgeState(): PermissionBridgeState {
    return {
      pendingPermissions: this.pendingPermissions,
      pendingElicitations: this.pendingElicitations,
      pendingElicitationInputs: this.pendingElicitationInputs,
      sessionDeniedTools: this.sessionDeniedTools,
      getEventChannel: () => this.eventChannel,
    }
  }

  /**
   * Claude SDK sandbox/approval model:
   *
   * Approvals and sandboxing are the SAME control — the SDK's permissionMode
   * governs both what actions get prompted and what gets blocked. There is no
   * separate sandbox process; the CLI itself enforces file/command restrictions.
   *
   * Mode mapping (passed directly to SDK):
   *   - "default"           → Ask before file edits AND shell commands
   *   - "acceptEdits"       → Auto-approve file edits, ask before shell commands
   *   - "bypassPermissions" → Auto-approve everything (no prompts at all)
   *   - "plan"              → Read-only: no edits, no commands allowed
   *   - "dontAsk"           → Never prompt; deny anything not pre-approved
   *                           (SDK denies if not in the pre-approval rule set)
   *   - "auto"              → Classifier model decides approve/deny per request;
   *                           only falls back to a prompt on low confidence
   *
   * Filesystem scope: cwd + any --add-dir directories. Paths outside are blocked.
   * Protected paths: None explicitly — all paths within scope are equally accessible.
   * Network: Unrestricted (no network sandbox).
   */
  capabilities(): BackendCapabilities {
    // Cluster 8: derive modeDetails from a backend-default shape + per-
    // mode overrides. Six near-identical blocks here used to repeat the
    // same `writableScope` / `protectedPaths` / `networkAccess` /
    // `separateSandbox` strings; the only fields that actually vary are
    // `commandApproval`, `editApproval`, and (sometimes) `caveats`.
    const DEFAULT_MODE_DETAIL = {
      writableScope: "cwd + allowed directories",
      protectedPaths: "none (all in-scope paths equal)",
      commandApproval: "always",
      editApproval: "always",
      networkAccess: "unrestricted",
      separateSandbox: false,
    } as const
    const sandboxInfo: SandboxInfo = {
      statusHint: "approvals only, no sandbox",
      modeDetails: {
        default: { ...DEFAULT_MODE_DETAIL },
        acceptEdits: { ...DEFAULT_MODE_DETAIL, editApproval: "never" },
        bypassPermissions: {
          ...DEFAULT_MODE_DETAIL,
          commandApproval: "never",
          editApproval: "never",
        },
        plan: {
          ...DEFAULT_MODE_DETAIL,
          writableScope: "none (read-only)",
          protectedPaths: "all (no writes allowed)",
          commandApproval: "never",
          editApproval: "never",
          caveats: "Read-only mode: no file edits or shell commands",
        },
        dontAsk: {
          ...DEFAULT_MODE_DETAIL,
          commandApproval: "per-tool-rules",
          editApproval: "per-tool-rules",
          caveats:
            "No prompts ever — tools not covered by an allowlist rule are denied.",
        },
        auto: {
          ...DEFAULT_MODE_DETAIL,
          commandApproval: "per-tool-rules",
          editApproval: "per-tool-rules",
          caveats:
            "Model classifier judges each request; low-confidence calls still surface a prompt.",
        },
      },
    }

    return {
      ...DEFAULT_CAPABILITIES,
      name: "claude",
      sdkVersion: ClaudeAdapter.sdkVersion,
      supportsThinking: true,
      supportsToolApproval: true,
      supportsResume: true,
      supportsContinue: true,
      supportsFork: true,
      supportsSubagents: true,
      supportsCompact: true,
      sandboxInfo,
    } satisfies BackendCapabilities
  }

  async *start(config: SessionConfig): AsyncGenerator<AgentEvent> {
    try {
      // Stash session cwd for sideQuery() forkSession() lookups. The SDK
      // resolves session files via the encoded-cwd project key, so passing the
      // wrong dir makes forkSession scan all projects (slower, more error-prone).
      this.sessionCwd = config.cwd ?? process.cwd()

      // Stash replay context from /switch so the next real user message picks
      // it up as prepended history. Must NOT be sent as its own turn.
      if (config.replayContext) {
        this.pendingReplayContext = config.replayContext
        log.info("Claude: replay context staged for next user turn", {
          chars: config.replayContext.length,
        })
      }

      // If a CLI initial prompt was supplied (e.g. `bantai run "<msg>"`), queue
      // it so the message iterable picks it up immediately. Mock/codex/acp do
      // the equivalent inside their own start(); without this, headless mode
      // hangs forever waiting for a user message that never arrives. Queue
      // before sdkQuery so the message is visible the moment the SDK starts
      // pulling — and so a query construction error doesn't leave the prompt
      // un-queued either.
      if (config.initialPrompt) {
        this.messageQueue.push({ text: config.initialPrompt })
      }

      // Build SDK options
      const options = this.buildOptions(config)

      // Create the message iterable for multi-turn
      const messageIterable = this.createMessageIterable(config)

      // Start the query via a pre-warmed SDK subprocess when possible.
      this.activeQuery = await this.createQuery(messageIterable, options)
      log.info("ClaudeAdapter: SDK query created", { hasQuery: !!this.activeQuery })

      // Signal readiness — replay stashed, SDK query kicked off, message
      // iterable listening. /switch awaits this before returning.
      this.markReady()

      // Out-of-band: ask the SDK for the authenticated account snapshot
      // (email / organization / subscription tier / token source). The
      // SDK's stream `system/init` message does NOT include `account` —
      // the data lives in the `accountInfo()` control response and the
      // `initializationResult()` response. We fire-and-forget so the
      // request can't block first paint of the conversation.
      //
      // Nice-to-have, not load-bearing — failures land in the log at
      // warn level and the TUI banner falls back to the bare model line.
      void this.fetchAndEmitAccountInfo()
    } catch (err) {
      this.rejectReady(err)
      throw err
    }

    // Iterate SDK messages — let the underlying claude binary handle auth/errors
    yield* this.iterateQuery()
  }

  async *resume(sessionId: string, baseConfig?: SessionConfig): AsyncGenerator<AgentEvent> {
    const config: SessionConfig = { ...baseConfig, resume: sessionId }
    yield* this.start(config)
  }

  sendMessage(message: UserMessage): void {
    trace.write({
      dir: "out",
      stage: "adapter_event",
      type: "sendMessage",
      payload: message,
    })
    this.messageQueue.push(message)
  }

  interrupt(): void {
    trace.write({
      dir: "out",
      stage: "adapter_event",
      type: "interrupt",
      payload: { pendingPermissions: this.pendingPermissions.size, pendingElicitations: this.pendingElicitations.size },
    })

    if (this.activeQuery) {
      // Auto-deny any pending permissions (prevent SDK deadlock)
      for (const [, pending] of this.pendingPermissions) {
        pending.resolve({
          behavior: "deny",
          message: "Interrupted by user",
          interrupt: true,
        })
      }
      this.pendingPermissions.clear()

      // Auto-respond to pending elicitations
      for (const [, pending] of this.pendingElicitations) {
        pending.resolve({
          behavior: "deny",
          message: "Interrupted by user",
          interrupt: true,
        })
      }
      this.pendingElicitations.clear()
      this.pendingElicitationInputs.clear()

      this.activeQuery.interrupt()
    }
  }

  approveToolUse(
    id: string,
    options?: { updatedInput?: unknown; alwaysAllow?: boolean; updatedPermissions?: any[] },
  ): void {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return

    const result: PermissionResult = {
      behavior: "allow",
      updatedInput: (options?.updatedInput as Record<string, unknown>) ?? pending.input,
      updatedPermissions: options?.updatedPermissions,
      toolUseID: id,
      decisionClassification: options?.alwaysAllow ? "user_permanent" : "user_temporary",
    }
    pending.resolve(result)
    this.pendingPermissions.delete(id)

    // Emit event to transition state machine WAITING_FOR_PERM -> RUNNING
    this.eventChannel?.push({ type: "permission_response", id, behavior: "allow" })
  }

  denyToolUse(id: string, reason?: string, options?: { denyForSession?: boolean }): void {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return

    // Track session-level denials so future canUseTool calls are auto-denied
    if (options?.denyForSession) {
      this.sessionDeniedTools.add(pending.toolName)
      log.info("Tool denied for session", { tool: pending.toolName })
    }

    pending.resolve({
      behavior: "deny",
      message: reason ?? "User denied",
      toolUseID: id,
      decisionClassification: "user_reject",
    })
    this.pendingPermissions.delete(id)

    // Emit event to transition state machine WAITING_FOR_PERM -> RUNNING
    this.eventChannel?.push({ type: "permission_response", id, behavior: "deny" })
  }

  respondToElicitation(id: string, answers: Record<string, string>): void {
    const pending = this.pendingElicitations.get(id)
    if (!pending) return

    // Build updatedInput: copy original AskUserQuestion input and add answers map.
    // This matches how the SDK expects the response — the original input (with its
    // questions array) is preserved, and an "answers" map keyed by question text is added.
    const originalInput = this.pendingElicitationInputs.get(id) ?? {}
    const updatedInput: Record<string, unknown> = { ...originalInput, answers }

    pending.resolve({
      behavior: "allow",
      updatedInput,
    })
    this.pendingElicitations.delete(id)
    this.pendingElicitationInputs.delete(id)

    // Emit event to transition state machine WAITING_FOR_ELIC -> RUNNING
    this.eventChannel?.push({ type: "elicitation_response", id, answers })
  }

  cancelElicitation(id: string): void {
    const pending = this.pendingElicitations.get(id)
    if (!pending) return

    pending.resolve({
      behavior: "deny",
      message: "User declined to answer",
    })
    this.pendingElicitations.delete(id)
    this.pendingElicitationInputs.delete(id)

    // Emit event to transition state machine WAITING_FOR_ELIC -> RUNNING
    this.eventChannel?.push({ type: "elicitation_response", id, answers: {} })
  }

  async setModel(model: string): Promise<void> {
    if (this.activeQuery) {
      await this.activeQuery.setModel(model)
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.activeQuery) {
      await this.activeQuery.setPermissionMode(mode)
    }
  }

  async setEffort(level: EffortLevel): Promise<void> {
    if (!this.activeQuery) return
    // applyFlagSettings only supports low/medium/high — reject 'max'/'xhigh' at runtime
    if (level === "max" || level === "xhigh") {
      this.eventChannel?.push({
        type: "system_message",
        text: `Cannot set effort to '${level}' at runtime. Use --effort ${level} at startup.`,
        ephemeral: true,
      })
      return
    }
    try {
      await this.activeQuery.applyFlagSettings({ effortLevel: level })
      log.info("setEffort()", { level })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error("setEffort() failed", { error: message })
      this.eventChannel?.push({
        type: "system_message",
        text: `Failed to set effort level: ${message}`,
        ephemeral: true,
      })
    }
  }

  async availableModels(): Promise<ModelInfo[]> {
    if (!this.activeQuery) return []
    const models: SDKModelInfo[] = await this.activeQuery.supportedModels()
    return models
      .map((m) => ({
        id: m.value ?? m.displayName,
        name: m.displayName ?? m.value,
        provider: "anthropic" as const,
      }))
      .filter((m) => m.id != null && m.id !== "undefined" && m.id !== "")
  }

  async listSessions(): Promise<SessionInfo[]> {
    try {
      const sessions = await this.sdk.listSessions({ dir: process.cwd() })
      return sessions.map((s) => ({
        id: s.sessionId,
        title: s.summary ?? s.firstPrompt ?? "Untitled",
        createdAt: s.createdAt ?? s.lastModified,
        updatedAt: s.lastModified,
        messageCount: 0, // Not available from SDK metadata
      }))
    } catch (err) {
      log.warn("Failed to list sessions", { error: String(err) })
      return []
    }
  }

  async forkSession(
    _sessionId: string,
    _options?: ForkOptions,
  ): Promise<string> {
    // Forking creates a new session with copied history
    // Handled via the SDK's forkSession option
    throw new Error("Fork via start() with config.forkSession = true")
  }

  /**
   * Side query — fork the live session, send a single tool-less prompt into the
   * fork, stream the answer, then discard the fork.
   *
   * The cost story rests on prompt-cache reuse: the fork inherits the parent
   * session's exact prompt prefix (handled by the SDK's `forkSession`), so the
   * side turn's input tokens hit the server-side cache. We deliberately do
   * NOT inject any system prompt or "you are answering a side question" prefix
   * — that would invalidate the cache key.
   *
   * Tool-disabling is achieved via three independent levers, all on the
   * forked query's options: `mcpServers: {}`, `allowedTools: []`, and
   * `permissionMode: "deny"`. If any tool_use_* events leak through despite
   * this, we drop them with a warn-level log (per AGENTS.md "never silently
   * drop external data").
   *
   * Lifecycle: on completion, error, or signal abort, the fork is closed and
   * the forked JSONL file is unlinked via `deleteSession()` so we don't leak
   * disk under `~/.claude/projects/<cwd-key>/`. This MUST run on every exit
   * path; the `try/finally` is load-bearing.
   */
  async *sideQuery(
    prompt: string,
    opts: { signal: AbortSignal },
  ): AsyncIterable<AgentEvent> {
    const sourceSessionId = this.liveSessionId
    if (!sourceSessionId) {
      yield {
        type: "error",
        code: "side_chat_no_session",
        message:
          "Side chat requires a live Claude session — wait for the main session to initialize and try again.",
        severity: "recoverable",
      }
      return
    }

    const dir = this.sessionCwd ?? process.cwd()
    let forkedSessionId: string | null = null
    let forkQuery: SDKQuery | null = null

    // Abort plumbing — when the caller signals abort, close the fork query;
    // the SDK iterator will end and finally-block teardown unlinks the JSONL.
    const onAbort = () => {
      try {
        forkQuery?.close()
      } catch (err) {
        log.warn("side chat: forkQuery.close() failed during abort", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (opts.signal.aborted) {
      yield {
        type: "error",
        code: "side_chat_aborted",
        message: "Side chat aborted before it started.",
        severity: "recoverable",
      }
      return
    }
    opts.signal.addEventListener("abort", onAbort, { once: true })

    try {
      const forkFn = this.sdk.forkSession ?? sdkForkSession
      const forkResult = await forkFn(sourceSessionId, {
        dir,
        title: "side chat (bantai)",
      })
      forkedSessionId = forkResult.sessionId
      log.debug("side chat: fork created", {
        sourceSessionId,
        forkedSessionId,
        dir,
      })

      // Tool-less options. Cache-key integrity: don't inject systemPrompt,
      // appendSystemPrompt, or any other prefix — let the fork inherit the
      // parent's prompt prefix verbatim. The SDK has no "deny" mode; the
      // closest equivalent is `dontAsk`, which denies anything not pre-
      // approved. Combined with an empty `allowedTools` allowlist, this
      // means every tool_use is denied without the user being prompted.
      const sideOptions: SDKOptions = {
        resume: forkedSessionId,
        cwd: dir,
        mcpServers: {},
        allowedTools: [],
        permissionMode: "dontAsk",
        // Don't persist this fork to a separate JSONL — we delete it anyway,
        // but minimising on-disk churn means a dropped close() doesn't leak.
        persistSession: true, // SDK requires this for resume; teardown unlinks
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
      }

      forkQuery = this.sdk.query({ prompt, options: sideOptions })

      // Stream events. Side chat emits a deliberate SUBSET of AgentEvent —
      // turn_start / text_delta / thinking_delta / turn_complete / error.
      // Anything else (permission_request, tool_use_*, session_init repeats)
      // is dropped with a warn so a model that misbehaves under "deny" mode
      // is visible in logs rather than silently surfacing an unanswerable
      // permission prompt to the user.
      const sideStreamState = new ToolStreamState()
      for await (const msg of forkQuery as AsyncIterable<SDKMsg>) {
        if (opts.signal.aborted) break
        const events = mapSDKMessage(msg, sideStreamState)
        for (const event of events) {
          switch (event.type) {
            case "turn_start":
            case "text_delta":
            case "thinking_delta":
            case "turn_complete":
            case "error":
              yield event
              break
            case "session_init":
              // Side query inherits the parent session's prompt cache; the
              // synthetic init event from the fork carries no info the
              // overlay needs. Suppress at debug-level (per AGENTS.md
              // "never silently drop").
              log.debug("side chat: suppressing session_init from fork", {
                forkedSessionId,
              })
              break
            case "permission_request":
            case "tool_use_start":
            case "tool_use_progress":
            case "tool_use_end":
              log.warn(
                "side chat: tool/permission event leaked despite tool-less fork — dropping",
                { eventType: event.type, forkedSessionId },
              )
              break
            default:
              log.debug("side chat: ignoring non-side event", {
                eventType: event.type,
              })
              break
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn("side chat: query failed", { error: message, forkedSessionId })
      yield {
        type: "error",
        code: "side_chat_error",
        message: `Side chat failed: ${message}`,
        severity: "recoverable",
      }
    } finally {
      opts.signal.removeEventListener("abort", onAbort)
      try {
        forkQuery?.close()
      } catch (err) {
        log.debug("side chat: forkQuery.close() during teardown threw", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      // Unlink the fork's JSONL so we don't leak files under
      // ~/.claude/projects/<cwd-key>/. Tolerate failure — the main session is
      // unaffected either way.
      if (forkedSessionId) {
        try {
          const deleteFn = this.sdk.deleteSession ?? sdkDeleteSession
          await deleteFn(forkedSessionId, { dir })
          log.debug("side chat: fork deleted", { forkedSessionId })
        } catch (err) {
          log.warn("side chat: failed to delete fork JSONL", {
            forkedSessionId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
  }

  close(): void {
    trace.write({
      dir: "out",
      stage: "adapter_event",
      type: "close",
      payload: { hadActiveQuery: !!this.activeQuery },
    })

    this.closed = true
    // Reject any pending whenReady() waiters so /switch can't hang on a
    // backend closed before it ever became ready.
    this.rejectReady(new Error("claude closed before ready"))
    this.messageQueue.close()

    // Close the event channel (unblocks iterateQuery consumer)
    if (this.eventChannel) {
      this.eventChannel.close()
      this.eventChannel = null
    }

    // Close any pre-warmed subprocess that has not yet been consumed by
    // WarmQuery.query(). Once consumed, activeQuery owns the underlying process.
    if (this.pendingWarmQuery) {
      this.pendingWarmQuery.close()
      this.pendingWarmQuery = null
    }

    // Close the active query
    if (this.activeQuery) {
      this.activeQuery.close()
      this.activeQuery = null
    }

    // Clean up any pending permission promises
    for (const [, pending] of this.pendingPermissions) {
      pending.reject(new Error("Adapter closed"))
    }
    this.pendingPermissions.clear()

    for (const [, pending] of this.pendingElicitations) {
      pending.reject(new Error("Adapter closed"))
    }
    this.pendingElicitations.clear()
    this.pendingElicitationInputs.clear()
  }


  private async createQuery(
    prompt: string | AsyncIterable<SDKUserMsg>,
    options: SDKOptions,
  ): Promise<SDKQuery> {
    log.info("ClaudeAdapter: prewarming SDK query", {
      model: options.model,
      permissionMode: options.permissionMode,
      initializeTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      hasMcpServers: !!(options.mcpServers && Object.keys(options.mcpServers).length),
    })
    trace.write({
      dir: "out",
      stage: "sdk_call",
      type: "startup",
      payload: { options, initializeTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS },
    })

    try {
      const warmQuery = await this.sdk.startup({
        options,
        initializeTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      })

      if (this.closed) {
        warmQuery.close()
        throw new Error("claude closed during startup")
      }

      this.pendingWarmQuery = warmQuery
      let query: SDKQuery
      try {
        query = warmQuery.query(prompt)
      } catch (err) {
        this.pendingWarmQuery = null
        warmQuery.close()
        throw err
      }
      this.pendingWarmQuery = null
      log.info("ClaudeAdapter: using pre-warmed SDK query")
      trace.write({
        dir: "out",
        stage: "sdk_call",
        type: "warm_query",
        payload: { options },
      })
      return query
    } catch (err) {
      if (this.closed) throw err
      const message = err instanceof Error ? err.message : String(err)
      log.warn("ClaudeAdapter: SDK startup prewarm failed; falling back to cold query", {
        error: message,
      })
      trace.write({
        dir: "out",
        stage: "sdk_call",
        type: "query",
        payload: { options, warmFallbackReason: message },
      })
      return this.sdk.query({ prompt, options })
    }
  }

  // -----------------------------------------------------------------------
  // Private: out-of-band account snapshot
  // -----------------------------------------------------------------------

  /**
   * Fetch the authenticated account snapshot via the SDK's `accountInfo()`
   * control request and push it onto the active event channel as an
   * `account_update` event.
   *
   * Why call it explicitly: the SDK's stream `system/init` message does not
   * include account info — that lives only on the control-response side
   * (`SDKControlInitializeResponse.account` / `Query.accountInfo()`). Without
   * this call, `state.session.account` stays `undefined` for the entire
   * session and the header banner can't render `email · subscription`.
   *
   * Race with `iterateQuery`: this method races against the background SDK
   * loop that creates the channel. If the channel hasn't been instantiated
   * by the time the response lands, we briefly poll (up to ~2s) before
   * giving up. Failure is non-fatal — header just falls back to the bare
   * model line.
   */
  private async fetchAndEmitAccountInfo(): Promise<void> {
    const query = this.activeQuery
    if (!query) return
    try {
      const sdkAccount = await query.accountInfo()
      if (this.closed || !sdkAccount) return

      // Wait briefly for iterateQuery to instantiate the event channel —
      // accountInfo() races startup, and emitting before the consumer is
      // wired up would drop the event silently.
      const deadline = Date.now() + 2_000
      while (!this.eventChannel && !this.closed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (this.closed || !this.eventChannel) {
        log.warn("ClaudeAdapter: account_update dropped — no event channel", {
          haveAccount: !!sdkAccount,
        })
        return
      }

      log.info("ClaudeAdapter: account info captured", {
        email: sdkAccount.email,
        organization: sdkAccount.organization,
        subscriptionType: sdkAccount.subscriptionType,
        tokenSource: sdkAccount.tokenSource,
        apiKeySource: sdkAccount.apiKeySource,
      })
      this.eventChannel.push({
        type: "account_update",
        account: {
          email: sdkAccount.email,
          organization: sdkAccount.organization,
          subscriptionType: sdkAccount.subscriptionType,
          tokenSource: sdkAccount.tokenSource,
          apiKeySource: sdkAccount.apiKeySource,
          // Backwards-compatibility alias: a few callsites still read
          // `account.plan`. Mirror `subscriptionType` into it so legacy
          // code keeps rendering until the migration completes.
          plan: sdkAccount.subscriptionType,
        },
      })
    } catch (err) {
      log.warn("ClaudeAdapter: accountInfo() failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // -----------------------------------------------------------------------
  // Private: SDK message -> AgentEvent mapping
  // -----------------------------------------------------------------------

  private async *iterateQuery(): AsyncGenerator<AgentEvent> {
    if (!this.activeQuery) return

    this.eventChannel = new EventChannel<AgentEvent>()

    // Run SDK iteration in background — pushes events to channel.
    // This decouples the SDK's async iterable from the consumer, so
    // canUseTool callbacks can push permission_request events to the
    // same channel without waiting for the SDK to yield next.
    // fire-and-forget
    void (async () => {
      log.info("ClaudeAdapter: background event loop starting")
      let firstMsgLogged = false
      try {
        for await (const msg of this.activeQuery!) {
          if (!firstMsgLogged) {
            firstMsgLogged = true
            log.info("ClaudeAdapter: first SDK message received", { type: msg.type })
          }
          if (this.closed || !this.eventChannel) break
          // SDK messages are a wide union — extract optional fields for logging
          const msgRecord = msg as Record<string, unknown>
          const streamEventType =
            msg.type === "stream_event"
              ? (msgRecord.event as Record<string, unknown> | undefined)?.type
              : undefined
          // Skip per-delta debug spam — `content_block_delta` fires once per
          // character during text/thinking streaming (dozens per second). The
          // underlying text/thinking content is still captured via the mapped
          // `text_delta` / `thinking_delta` AgentEvents and the raw `sdk_event`
          // trace entry below, so suppressing the log line here loses nothing.
          if (streamEventType !== "content_block_delta") {
            log.debug("V1 SDK message", buildSdkMessageLogPayload(msg, msgRecord, streamEventType))
          }
          trace.write({
            dir: "in",
            stage: "sdk_event",
            type: msg.type,
            payload: msg,
          })
          const events = mapSDKMessage(msg, this.streamState)
          for (const event of events) {
            // Track the live session id so sideQuery() can fork from the
            // correct source — both `session_init` (start of session) and
            // `turn_complete` (carries SDK result.session_id) refresh it.
            if (event.type === "session_init" && event.sessionId) {
              this.liveSessionId = event.sessionId
            } else if (event.type === "turn_complete" && event.sessionId) {
              this.liveSessionId = event.sessionId
            }
            trace.write({
              dir: "internal",
              stage: "mapped_event",
              type: event.type,
              payload: event,
              meta: { sourceType: msg.type },
            })
            this.eventChannel?.push(event)
          }
        }
      } catch (err) {
        log.error("ClaudeAdapter: background event loop error", { error: err instanceof Error ? err.message : String(err) })
        if (!this.closed && this.eventChannel) {
          this.eventChannel.push({
            type: "error" as const,
            code: "adapter_error",
            message: err instanceof Error ? err.message : String(err),
            severity: "fatal" as const,
          })
        }
      }
      log.info("ClaudeAdapter: background event loop ended", { closed: this.closed, firstMsgReceived: firstMsgLogged })
      this.eventChannel?.close()
    })().catch((err) => {
      log.error("ClaudeAdapter: unhandled error in background loop", { error: String(err) })
      if (!this.closed && this.eventChannel) {
        this.eventChannel.push({
          type: "error" as const,
          code: "adapter_error" as const,
          message: `SDK loop crashed: ${err instanceof Error ? err.message : String(err)}`,
          severity: "fatal" as const,
        })
        this.eventChannel.close()
      }
    })

    // Yield from channel — receives both SDK events AND canUseTool callback events
    yield* this.eventChannel[Symbol.asyncIterator]()
  }

  // -----------------------------------------------------------------------
  // Private: Build SDK options from SessionConfig
  // -----------------------------------------------------------------------

  private buildOptions(config: SessionConfig): SDKOptions {
    log.info("Building V1 SDK options", {
      model: config.model,
      permissionMode: config.permissionMode,
      resume: !!config.resume,
      continue: !!config.continue,
      forkSession: !!config.forkSession,
      cwd: config.cwd,
    })
    // Translate (systemPrompt, appendSystemPrompt) into the SDK's layered
    // `systemPrompt` shape. The SDK accepts three forms: a string (fully
    // override), a preset object with `append` (keep Claude Code prompt +
    // add extra), or `undefined` (SDK default). The Slack frontend uses
    // `appendSystemPrompt` to inject per-session context without clobbering
    // the built-in coding prompt.
    const systemPromptOpt: SDKOptions["systemPrompt"] =
      config.systemPrompt !== undefined
        ? config.appendSystemPrompt
          ? `${config.systemPrompt}\n\n${config.appendSystemPrompt}`
          : config.systemPrompt
        : config.appendSystemPrompt
          ? {
              type: "preset" as const,
              preset: "claude_code" as const,
              append: config.appendSystemPrompt,
            }
          : undefined

    const opts: SDKOptions = {
      model: config.model,
      systemPrompt: systemPromptOpt,
      permissionMode: config.permissionMode,
      // Always opt the session into being ALLOWED to switch to
      // `bypassPermissions` at runtime (via Shift+Tab / setPermissionMode).
      // Without this, the SDK rejects the mode change with "Cannot set
      // permission mode to bypassPermissions because the session was not
      // launched with --dangerously-skip-permissions" — which, combined with
      // our non-optimistic cycler, manifests as the status-bar hanging for
      // ~880ms per press and the cycle appearing stuck. Setting this flag
      // only UNLOCKS the mode — it doesn't enter it; the initial mode is
      // still `config.permissionMode` (which defaults to "default").
      allowDangerouslySkipPermissions: true,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      cwd: config.cwd,
      continue: config.continue,
      resume: config.resume,
      forkSession: config.forkSession,
      mcpServers: (() => {
        const servers: Record<string, unknown> = { ...config.mcpServers }
        // Translate backend-agnostic stdioMcpServers into the Claude SDK's
        // native stdio-MCP shape. A name-collision with `mcpServers` wins
        // for the in-process entry (operators / upstream frontends set
        // `mcpServers` deliberately for in-process tools).
        if (config.stdioMcpServers) {
          for (const [name, spec] of Object.entries(config.stdioMcpServers)) {
            if (name in servers) continue
            servers[name] = {
              type: "stdio" as const,
              command: spec.command,
              ...(spec.args ? { args: spec.args } : {}),
              ...(spec.env ? { env: spec.env } : {}),
            }
          }
        }
        // Translate backend-agnostic httpMcpServers into the Claude SDK's
        // native http-MCP shape. The SDK takes literal headers (no env-var
        // indirection), so we resolve `bearerTokenEnvVar` to a literal
        // Authorization header at session-build time. Missing env vars are
        // logged + skipped — silently sending an unauthenticated request to a
        // server that requires auth would surface as a confusing tool-call
        // error inside the agent (per AGENTS.md "never silently drop"). Same
        // collision rule as stdioMcpServers: in-process entries already in
        // `mcpServers` win.
        if (config.httpMcpServers) {
          for (const [name, spec] of Object.entries(config.httpMcpServers)) {
            if (name in servers) continue
            const headers: Record<string, string> = { ...(spec.httpHeaders ?? {}) }
            if (spec.bearerTokenEnvVar !== undefined) {
              const token = process.env[spec.bearerTokenEnvVar]
              if (token === undefined || token.length === 0) {
                log.warn(
                  `Claude: skipping http MCP server "${name}" — env var ` +
                    `${spec.bearerTokenEnvVar} is unset or empty`,
                )
                continue
              }
              headers["Authorization"] = `Bearer ${token}`
            }
            servers[name] = {
              type: "http" as const,
              url: spec.url,
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
            }
          }
        }
        const diag = getDiagnosticsSdkMcpConfig()
        if (diag) servers["bantai-diagnostics"] = diag
        const crossagent = getCrossagentSdkMcpConfig()
        if (crossagent) servers["bantai-crossagent"] = crossagent
        // Cast: mcpServers values come from user config and our MCP server —
        // both conform to McpServerConfig at runtime but the spread loses type info
        return servers as SDKOptions["mcpServers"]
      })(),
      allowedTools: config.allowedTools,
      disallowedTools: config.disallowedTools,
      additionalDirectories: config.additionalDirectories,
      persistSession: config.persistSession ?? true,
      settingSources: ["user", "project", "local"],
      // Cast: our PermissionResult is structurally identical to the SDK's but
      // updatedPermissions is typed as unknown[] (we pass through SDK values
      // without importing PermissionUpdate from the SDK in the bridge module)
      canUseTool: createCanUseTool(this.bridgeState) as SDKOptions["canUseTool"],
      includePartialMessages: true,
      ...(config.thinking ? { thinking: config.thinking } : {}),
      ...(config.effort ? { effort: config.effort } : {}),
      // Operator escape hatch for the SDK's broken native-binary resolver.
      // The SDK ships per-libc native packages and tries `-musl` before
      // `-x64` via require.resolve(); on a glibc host with bun (which
      // installs both optional deps because both match `cpu=x64,os=linux`)
      // the resolve succeeds for -musl and spawn() fails at first query
      // with "Claude Code native binary not found at .../-x64-musl/claude".
      // The cringle.ai infra Dockerfile installs a known-good binary at
      // /usr/local/bin/claude (symlinked to /opt/bantai's SDK-bundled
      // glibc copy); the launcher.sh exports BANTAI_CLAUDE_CODE_EXECUTABLE
      // pointing at it so this branch wins over the SDK's resolver.
      // Honors a caller-set value first (config.pathToClaudeCodeExecutable
      // would route through here too if we ever surface it on
      // SessionConfig), env var second, undefined (SDK default) last.
      ...(process.env.BANTAI_CLAUDE_CODE_EXECUTABLE
        ? { pathToClaudeCodeExecutable: process.env.BANTAI_CLAUDE_CODE_EXECUTABLE }
        : {}),
      // Per-session env for per-channel isolation (Slack frontend S7):
      // the SDK merges this on top of process.env, so we only need to
      // forward the delta here.
      ...(config.env && Object.keys(config.env).length > 0
        ? { env: { ...process.env, ...config.env } }
        : {}),
    }
    log.info("ClaudeAdapter: options built", {
      model: opts.model,
      permissionMode: opts.permissionMode,
      maxTurns: opts.maxTurns,
      mcpServerCount: opts.mcpServers ? Object.keys(opts.mcpServers).length : 0,
      hasCanUseTool: !!opts.canUseTool,
      hasSystemPrompt: !!opts.systemPrompt,
      persistSession: opts.persistSession,
    })
    return opts
  }

  // -----------------------------------------------------------------------
  // Private: Message iterable for multi-turn
  // -----------------------------------------------------------------------

  private async *createMessageIterable(
    config: SessionConfig,
  ): AsyncGenerator<SDKUserMsg> {
    log.info("ClaudeAdapter: message iterable started", { resume: !!config.resume, continue: !!config.continue })
    // First message from config or wait for user
    if (config.resume || config.continue) {
      // Resuming: don't send an initial message, wait for user
    }

    // Yield messages as the user sends them
    while (!this.closed) {
      try {
        const message = await this.messageQueue.pull()
        // Prepend any pending /switch replay context as marked historical
        // context so the model responds to the new user message while having
        // the prior conversation available.
        if (this.pendingReplayContext) {
          const replay = this.pendingReplayContext
          this.pendingReplayContext = null
          message.text = `[Historical context — do not respond to this section; it is a replay of the prior conversation for your reference]\n${replay}\n[End of historical context]\n\n[User Message]\n${message.text}`
        }
        const sdkMessage = this.toSDKUserMessage(message)
        trace.write({
          dir: "out",
          stage: "sdk_call",
          type: "prompt",
          payload: sdkMessage,
        })
        yield sdkMessage
      } catch {
        break
      }
    }
  }

  private toSDKUserMessage(message: UserMessage): SDKUserMsg {
    const content: SDKUserMsg["message"]["content"] = [{ type: "text", text: message.text }]

    if (message.images) {
      for (const img of message.images) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mediaType,
            data: img.data,
          },
        })
      }
    }

    return {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "", // SDK fills this in
    }
  }
}
