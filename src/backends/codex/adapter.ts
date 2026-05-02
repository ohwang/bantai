/**
 * Codex App-Server Adapter
 *
 * Implements AgentBackend by spawning `codex app-server` as a child process
 * and speaking JSON-RPC 2.0 over stdio. Full bidirectional protocol with
 * approval callbacks, streaming, interrupt, and thread fork.
 *
 * Usage: --backend codex
 *
 * Lifecycle:
 *   1. start() spawns the process, sends initialize/initialized handshake
 *   2. thread/start creates a thread, turn/start sends user input
 *   3. Server streams notifications → event mapper → AgentEvent channel
 *   4. Server-initiated approval requests → permission_request events → user response → JSON-RPC reply
 *   5. interrupt() calls turn/interrupt
 *   6. close() kills the child process
 */

import { log } from "../../utils/logger"
import type {
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
import { backendTrace } from "../../utils/backend-trace"
import { BaseAdapter } from "../shared/base-adapter"

const trace = backendTrace.scoped("codex")

import { JsonRpcTransport } from "./jsonrpc-transport"
import { buildCodexMcpConfigArgs } from "./mcp-config"
import { mapCodexNotification } from "./event-mapper"
import type {
  CodexSandboxPolicy,
  CodexThreadResponse,
  CodexThreadListResponse,
  CodexThreadInfo,
  CodexThreadForkResponse,
  CodexTurnStartResponse,
  CodexTurnStartParams,
  CodexTurnInput,
  CodexTokenUsageParams,
} from "./codex-types"

// ---------------------------------------------------------------------------
// Permission mode → Codex approval policy mapping
//
// IMPORTANT: Codex separates approval policy from sandbox policy.
// These are two independent controls sent per-turn via turn/start params.
//
// Approval policy controls WHETHER the user is prompted:
//   - "on-request" → Codex asks for approval before shell commands & file changes
//   - "never"      → Codex never asks (all actions auto-approved)
//
// Sandbox policy controls WHAT the process can actually do:
//   - undefined (default) → workspace-write sandbox: repo is writable but
//     .git directory is READ-ONLY. This means `git commit`, `git push`,
//     `git checkout`, etc. will fail even if the user approves the command.
//     This is the key semantic gap vs Claude, where approving a command
//     grants full access to execute it.
//   - { type: "dangerFullAccess" } → No sandbox restrictions at all.
//
// Semantic gaps vs Claude's unified model:
//   1. "acceptEdits" in Claude auto-approves edits. In Codex, approval policy
//      is "on-request" (still asks), but the SANDBOX allows edits. The user
//      experience is different: Codex still prompts for file changes.
//   2. "default" in Claude blocks commands without approval. In Codex,
//      "default" uses workspace-write sandbox which blocks .git writes
//      REGARDLESS of approval. A user who approves `git commit` in Codex
//      will see it fail — unlike Claude where approval = execution.
//   3. "plan" has no native Codex equivalent. We map it to "on-request"
//      approval (closest approximation) but there's no read-only sandbox.
// ---------------------------------------------------------------------------

/**
 * Map our PermissionMode to Codex's approval policy.
 *
 * Approval policy only controls prompting behavior, not filesystem access.
 * See toCodexSandboxPolicy() for the filesystem enforcement side.
 */
/**
 * Map our `PermissionMode` to Codex's approval-policy string.
 *
 * Typed as `Record<PermissionMode, string>` (after the `mode ?? "default"`
 * normalisation) so adding a new permission mode is a compile-time error
 * here unless we explicitly decide whether Codex prompts for it (Cluster 5
 * / L6 — `auto` and `plan` used to be silently inconsistent between this
 * function and `capabilities().supportedPermissionModes`).
 *
 * - "never"      — never prompt (auto-approve everything)
 * - "on-request" — Codex's default: prompt before destructive ops
 */
const CODEX_APPROVAL_POLICY: Record<PermissionMode, string> = {
  default: "on-request",
  acceptEdits: "on-request",
  plan: "on-request",
  // `auto` would let Codex's classifier route requests — Codex doesn't
  // expose that toggle, so map it to the default prompting behaviour.
  auto: "on-request",
  bypassPermissions: "never",
  dontAsk: "never",
}

export function toCodexApprovalPolicy(mode?: PermissionMode): string {
  return CODEX_APPROVAL_POLICY[mode ?? "default"]
}

/**
 * Map our PermissionMode to Codex's sandbox policy.
 *
 * When undefined is returned, Codex uses its default "workspace-write" sandbox:
 *   - Repo files are writable
 *   - .git directory is READ-ONLY (git operations that write will fail)
 *   - Network access may be restricted depending on Codex configuration
 *
 * Only bypassPermissions/dontAsk disables the sandbox entirely via
 * "dangerFullAccess", which removes all filesystem restrictions.
 */
export function toCodexSandboxPolicy(
  mode?: PermissionMode,
): CodexSandboxPolicy | undefined {
  switch (mode) {
    case "bypassPermissions":
    case "dontAsk":
      return { type: "dangerFullAccess" }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Default model — GPT-5.5 (released 2026-04-23). Codex CLI itself can fall
// back to whatever model the binary considers default, but bantai pins this
// explicitly so the choice is visible in trace logs and stable across CLI
// upgrades.
// ---------------------------------------------------------------------------
export const CODEX_DEFAULT_MODEL = "gpt-5.5"

// ---------------------------------------------------------------------------
// Codex Adapter
// ---------------------------------------------------------------------------

export class CodexAdapter extends BaseAdapter {
  private transport: JsonRpcTransport | null = null

  // Thread/turn state
  private threadId: string | null = null
  private activeTurnId: string | null = null
  private modelName: string | null = null

  // Guard against turn/completed arriving before waitForTurnComplete() is called.
  // When both the turn/start response and turn/completed notification arrive in the
  // same stdout chunk, handleLine() processes them synchronously — the response
  // resolves the request promise (queuing a microtask), then turn/completed fires
  // BEFORE the microtask resumes startTurn(). At that point turnCompleteResolve is
  // still null, so the completion is silently lost. This flag captures it.
  private turnCompletedEarly = false

  // Cached token usage from thread/tokenUsage/updated (arrives before turn/completed).
  // reasoningTokens is a SUBSET of outputTokens (OpenAI billing) — see
  // codex-types.ts:CodexTokenUsageEntry for subset semantics.
  private lastTokenUsage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    reasoningTokens?: number
  } | null = null

  // Pending approval requests (server-initiated JSON-RPC requests awaiting our response)
  private pendingApprovals = new Map<
    string,
    { rpcId: number | string; method: string; params: any }
  >()

  // Whether the system prompt has been prepended to the first turn
  private systemPromptApplied = false

  // Session config for reference
  private config: SessionConfig | null = null

  // Pending replay context: formatted conversation history from a previous
  // backend (populated via /switch). When set, it is prepended as a marked
  // historical section to the NEXT real user message — it must NOT be sent
  // as its own turn. Cleared once consumed.
  private pendingReplayContext: string | null = null

  // Client-side max turns enforcement
  private turnCount = 0

  /**
   * Codex sandbox/approval model:
   *
   * Approvals and sandboxing are SEPARATE controls (unlike Claude).
   * See toCodexApprovalPolicy() and toCodexSandboxPolicy() for mapping details.
   *
   * Default sandbox ("workspace-write"):
   *   - Repo files: writable
   *   - .git directory: READ-ONLY (git commit/push/checkout fail)
   *   - Network: may be restricted by Codex config
   *
   * "dangerFullAccess" sandbox (bypassPermissions/dontAsk):
   *   - Everything writable, no restrictions
   *
   * Key difference from Claude: approving a tool use does NOT override sandbox
   * restrictions. If the sandbox blocks .git writes, approval is irrelevant.
   */
  capabilities(): BackendCapabilities {
    // Cluster 8: build modeDetails from a per-backend default + per-mode
    // overrides. Two of Codex's four modes ("bypassPermissions" /
    // "dontAsk") were character-for-character identical except for the
    // key — that copy/paste is what the sprint's "spread + override"
    // pattern eliminates. The default sandboxed shape (workspace-write)
    // applies to "default" and "acceptEdits" verbatim except for the
    // caveat string.
    const SANDBOXED_DEFAULT = {
      writableScope: "repo working tree (excludes .git)",
      protectedPaths: ".git (read-only in workspace-write sandbox)",
      commandApproval: "always",
      editApproval: "always",
      networkAccess: "restricted",
      separateSandbox: true,
    } as const
    const FULL_ACCESS = {
      writableScope: "everything (dangerFullAccess)",
      protectedPaths: "none",
      commandApproval: "never",
      editApproval: "never",
      networkAccess: "unrestricted",
      separateSandbox: false,
      caveats: "Disables both approval prompts AND the sandbox entirely.",
    } as const

    const sandboxInfo: SandboxInfo = {
      statusHint: "sandbox: .git read-only",
      modeDetails: {
        default: {
          ...SANDBOXED_DEFAULT,
          caveats:
            "Approving a command does not override sandbox restrictions. git commit/push will fail.",
        },
        acceptEdits: {
          ...SANDBOXED_DEFAULT,
          caveats:
            "Codex still prompts for file changes (no native acceptEdits). Sandbox blocks .git writes.",
        },
        bypassPermissions: { ...FULL_ACCESS },
        dontAsk: { ...FULL_ACCESS },
      },
    }

    return {
      ...DEFAULT_CAPABILITIES,
      name: "codex",
      supportsThinking: true,
      supportsToolApproval: true,
      supportsResume: true,
      supportsContinue: true,
      supportsFork: true,
      // Codex auto-compacts but doesn't support user-initiated /compact.
      supportsCompact: false,
      // Derived from the CODEX_APPROVAL_POLICY record so this list cannot
      // drift from the actual mapping (Cluster 5 / L6 — `auto` and `plan`
      // were silently missing here even though the policy switch
      // recognised them). Since every PermissionMode now has an entry in
      // the policy record, every PermissionMode is supported.
      supportedPermissionModes: Object.keys(CODEX_APPROVAL_POLICY) as PermissionMode[],
      sandboxInfo,
    } satisfies BackendCapabilities
  }

  sendMessage(message: UserMessage): void {
    trace.write({
      dir: "out",
      stage: "adapter_event",
      type: "sendMessage",
      payload: message,
    })
    super.sendMessage(message)
  }

  interrupt(): void {
    if (!this.transport?.isAlive || !this.threadId || !this.activeTurnId) return

    trace.write({
      dir: "out",
      stage: "adapter_event",
      type: "interrupt",
      payload: { threadId: this.threadId, turnId: this.activeTurnId, pendingApprovals: this.pendingApprovals.size },
    })

    log.info("Interrupting Codex turn", {
      threadId: this.threadId,
      turnId: this.activeTurnId,
    })

    // Auto-deny pending approval requests
    for (const [itemId, approval] of this.pendingApprovals) {
      this.transport.respond(approval.rpcId, { decision: "cancel" })
      this.eventChannel?.push({
        type: "permission_response",
        id: itemId,
        behavior: "deny",
      })
    }
    this.pendingApprovals.clear()

    // Send turn/interrupt — fire and forget (response comes as turn/completed with status "interrupted")
    this.transport
      .request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      })
      .catch((err) => {
        log.warn("turn/interrupt failed", { error: String(err) })
      })
  }

  approveToolUse(
    id: string,
    options?: { updatedInput?: unknown; alwaysAllow?: boolean },
  ): void {
    const approval = this.pendingApprovals.get(id)
    if (!approval) return

    const decision = options?.alwaysAllow ? "acceptForSession" : "accept"
    log.info("Codex approval: approve", { id, decision, method: approval.method, rpcId: approval.rpcId })
    this.transport?.respond(approval.rpcId, { decision })
    this.pendingApprovals.delete(id)
    this.eventChannel?.push({
      type: "permission_response",
      id,
      behavior: "allow",
    })
  }

  denyToolUse(id: string, _reason?: string, _options?: { denyForSession?: boolean }): void {
    const approval = this.pendingApprovals.get(id)
    if (!approval) return

    log.info("Codex approval: deny", { id, method: approval.method, rpcId: approval.rpcId })
    this.transport?.respond(approval.rpcId, { decision: "decline" })
    this.pendingApprovals.delete(id)
    this.eventChannel?.push({
      type: "permission_response",
      id,
      behavior: "deny",
    })
  }

  respondToElicitation(id: string, answers: Record<string, string>): void {
    const approval = this.pendingApprovals.get(id)
    if (!approval) return

    log.info("Codex elicitation: respond", { id, method: approval.method, answerKeys: Object.keys(answers).join(",") })
    // MCP elicitation response
    this.transport?.respond(approval.rpcId, {
      action: "accept",
      content: answers,
    })
    this.pendingApprovals.delete(id)
    this.eventChannel?.push({
      type: "elicitation_response",
      id,
      answers,
    })
  }

  cancelElicitation(id: string): void {
    const approval = this.pendingApprovals.get(id)
    if (!approval) return

    log.info("Codex elicitation: cancel", { id, method: approval.method })
    this.transport?.respond(approval.rpcId, {
      action: "decline",
      content: null,
    })
    this.pendingApprovals.delete(id)
    this.eventChannel?.push({
      type: "elicitation_response",
      id,
      answers: {},
    })
  }

  async setModel(model: string): Promise<void> {
    if (!this.config) return
    log.info("Codex setModel()", { from: this.config.model, to: model })
    this.config.model = model
    // Model is sent per-turn via turn/start params, so the next turn
    // will automatically use the new model. No RPC call needed.
  }

  async setEffort(_level: EffortLevel): Promise<void> {
    log.debug("setEffort called on Codex adapter — not supported")
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.config) return
    log.info("Codex setPermissionMode()", { from: this.config.permissionMode, to: mode })
    this.config.permissionMode = mode
    // Approval policy is derived from config.permissionMode per-turn
    // via toCodexApprovalPolicy(), so the next turn will use the new mode.
  }

  async availableModels(): Promise<ModelInfo[]> {
    // Codex doesn't expose a model list via the app-server protocol, so we
    // ship a curated catalogue here. GPT-5.5 (released 2026-04-23) is listed
    // first so it surfaces as the canonical recommendation.
    return [
      { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      { id: "gpt-5.5-pro", name: "GPT-5.5 Pro", provider: "openai" },
      { id: "gpt-5-codex", name: "GPT-5 Codex", provider: "openai" },
      { id: "gpt-5", name: "GPT-5", provider: "openai" },
      { id: "o3", name: "o3", provider: "openai" },
      { id: "o4-mini", name: "o4-mini", provider: "openai" },
      { id: "codex-mini-latest", name: "Codex Mini", provider: "openai" },
    ]
  }

  /**
   * Find the most recent thread ID using thread/list.
   * Returns null if no threads exist or the request fails.
   */
  private async findMostRecentThread(): Promise<string | null> {
    if (!this.transport?.isAlive) return null
    try {
      const result = (await this.transport.request("thread/list")) as CodexThreadListResponse
      const threads = result?.threads ?? []
      if (threads.length === 0) return null
      // Sort by createdAt descending, pick the first
      const sorted = [...threads].sort((a: CodexThreadInfo, b: CodexThreadInfo) =>
        (b.createdAt ?? 0) - (a.createdAt ?? 0)
      )
      return sorted[0]?.id ?? null
    } catch (err) {
      log.warn("Failed to list Codex threads for --continue", { error: String(err) })
      return null
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    // When transport is not alive (before runSession), fall back to reading
    // Codex session files directly from disk. This enables the session picker
    // to show sessions even before the codex app-server subprocess is spawned.
    if (!this.transport?.isAlive) {
      const { listCodexSessionsFromDisk } = await import("../../session/cross-backend")
      return listCodexSessionsFromDisk()
    }

    try {
      const result = (await this.transport.request("thread/list")) as CodexThreadListResponse
      const threads = result?.threads ?? []
      return threads.map((t: CodexThreadInfo) => ({
        id: t.id,
        title: t.preview ?? t.name ?? "Untitled",
        createdAt: t.createdAt ?? 0,
        updatedAt: t.createdAt ?? 0,
        messageCount: 0,
      }))
    } catch (err) {
      log.warn("Failed to list Codex sessions", { error: String(err) })
      return []
    }
  }

  async forkSession(
    sessionId: string,
    _options?: ForkOptions,
  ): Promise<string> {
    if (!this.transport?.isAlive) {
      throw new Error("Transport not connected")
    }

    const result = (await this.transport.request("thread/fork", {
      threadId: sessionId,
    })) as CodexThreadForkResponse

    const forkedId = result?.thread?.id ?? result?.threadId
    if (!forkedId) throw new Error("Codex fork did not return a thread ID")
    return forkedId
  }

  protected onClose(): void {
    trace.write({
      dir: "out",
      stage: "adapter_event",
      type: "close",
      payload: { threadId: this.threadId, hadTransport: !!this.transport },
    })

    // Reject pending approvals
    for (const [, approval] of this.pendingApprovals) {
      this.transport?.respond(approval.rpcId, { decision: "cancel" })
    }
    this.pendingApprovals.clear()

    if (this.transport) {
      this.transport.close()
      this.transport = null
    }
  }

  // -----------------------------------------------------------------------
  // Protected: Session lifecycle
  // -----------------------------------------------------------------------

  protected async runSession(
    config: SessionConfig,
    resumeSessionId?: string,
  ): Promise<void> {
    this.config = config

    try {
      // 1. Spawn transport.
      //    Build `codex app-server --config …` argv with any stdio + HTTP MCP
      //    servers from SessionConfig. The Codex SDK's Codex class does
      //    this flattening for us when you go through startThread(), but
      //    we spawn app-server directly for the JSON-RPC session protocol,
      //    so we roll it out here.
      const mcpConfigArgs = buildCodexMcpConfigArgs(
        config.stdioMcpServers,
        config.httpMcpServers,
      )
      if (mcpConfigArgs.length > 0) {
        log.info("Codex: injecting MCP servers via --config", {
          stdioServers: Object.keys(config.stdioMcpServers ?? {}),
          httpServers: Object.keys(config.httpMcpServers ?? {}),
          argCount: mcpConfigArgs.length,
        })
      }
      if (config.appendSystemPrompt) {
        // Codex SDK has no `appendSystemPrompt`; the most faithful
        // fallback is to log that we couldn't forward it. Operators that
        // need session-scoped prompts on Codex should set `systemPrompt`
        // directly; Slack's launcher concatenates when building the
        // SessionConfig for Codex (see routing overlay).
        log.debug(
          "Codex: appendSystemPrompt observed; relying on caller to pre-merge into systemPrompt",
          { chars: config.appendSystemPrompt.length },
        )
      }
      this.transport = new JsonRpcTransport()
      await this.transport.start("codex", [
        "app-server",
        ...mcpConfigArgs,
        "--listen",
        "stdio://",
      ])

      // 2. Wire up event handlers
      this.transport.onNotification((method, params) => {
        this.handleNotification(method, params)
      })
      this.transport.onRequest((id, method, params) => {
        this.handleServerRequest(id, method, params)
      })

      // 3. Initialize handshake
      log.info("Sending initialize request")
      await this.transport.request("initialize", {
        clientInfo: {
          name: "bantai",
          title: "Claude OpenTUI",
          version: "0.0.1",
        },
        capabilities: {},
      })
      this.transport.notify("initialized")
      log.info("Codex app-server initialized")

      // 4. Start or resume thread
      if (resumeSessionId) {
        // Explicit resume by session ID
        const result = (await this.transport.request("thread/resume", {
          threadId: resumeSessionId,
        })) as CodexThreadResponse
        this.threadId = result?.thread?.id ?? resumeSessionId
        this.modelName = result?.model ?? result?.modelProvider ?? null
        log.info("Resumed Codex thread", { threadId: this.threadId, model: this.modelName })
      } else if (config.continue) {
        // Continue most recent thread — list threads and pick the latest
        const latestId = await this.findMostRecentThread()
        if (latestId) {
          log.info("Continuing most recent Codex thread", { threadId: latestId })
          const result = (await this.transport.request("thread/resume", {
            threadId: latestId,
          })) as CodexThreadResponse
          this.threadId = result?.thread?.id ?? latestId
          this.modelName = result?.model ?? result?.modelProvider ?? null
          log.info("Resumed Codex thread for --continue", { threadId: this.threadId, model: this.modelName })
        } else {
          // No threads found — inform the user and start a new thread
          log.info("No existing Codex threads found for --continue, starting new thread")
          this.eventChannel?.push({
            type: "system_message",
            text: "No previous Codex sessions found. Starting a new session.",
          })
          const result = (await this.transport.request("thread/start", {})) as CodexThreadResponse
          this.threadId = result?.thread?.id ?? null
          this.modelName = result?.model ?? result?.modelProvider ?? null
          log.info("Started new Codex thread", { threadId: this.threadId, model: this.modelName })
        }
      } else {
        const result = (await this.transport.request("thread/start", {})) as CodexThreadResponse
        this.threadId = result?.thread?.id ?? null
        this.modelName = result?.model ?? result?.modelProvider ?? null
        log.info("Started Codex thread", { threadId: this.threadId, model: this.modelName })
      }

      if (!this.threadId) {
        throw new Error("Failed to obtain thread ID from Codex")
      }

      // 5. If there's replay context from a prior backend, stash it so the
      //    next real user message can carry it as prepended historical
      //    context rather than generating a phantom response turn.
      if (config.replayContext) {
        this.pendingReplayContext = config.replayContext
        log.info("Codex: replay context staged for next user turn", {
          chars: config.replayContext.length,
        })
      }

      // 6. If there's an initial prompt (CLI --prompt), send the first turn.
      //    replayContext is NOT delivered here — it rides along with the next
      //    real user message so the model only produces one response.
      if (config.initialPrompt) {
        await this.startTurn(config.initialPrompt)
      }

      // 7. Signal readiness — subprocess alive, handshake complete, thread
      //    started, replay stashed. /switch awaits this before returning so
      //    the user cannot type into a backend that's still spinning up.
      this.markReady()

      // 8. Main message loop
      await this.runMessageLoop(async (message) => {
        await this.startTurn(message.text, message.images)
      })
    } catch (err) {
      if (!this.closed && this.eventChannel) {
        this.eventChannel.push({
          type: "error",
          code: "adapter_error",
          message: err instanceof Error ? err.message : String(err),
          severity: "fatal",
        })
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private: Turn management
  // -----------------------------------------------------------------------

  private async startTurn(
    text: string,
    images?: { data: string; mediaType: string }[],
  ): Promise<void> {
    if (!this.transport?.isAlive || !this.threadId) return

    this.turnCount++

    if (this.config?.maxTurns && this.turnCount > this.config.maxTurns) {
      log.info("Max turns reached", { turnCount: this.turnCount, maxTurns: this.config.maxTurns })
      this.eventChannel?.push({
        type: "system_message",
        text: `Maximum turns (${this.config.maxTurns}) reached. No further turns will be processed.`,
      })
      this.eventChannel?.push({
        type: "error",
        code: "max_turns",
        message: `Maximum turns (${this.config.maxTurns}) reached`,
        severity: "fatal",
      })
      return
    }

    // Build user input, prepending (a) system prompt on the first turn, and
    // (b) any pending replay context from a /switch. Replay context is marked
    // as historical so the model treats it as context — not a new user turn
    // — and only responds to the actual user text that follows.
    const applySystemPrompt = !this.systemPromptApplied && !!this.config?.systemPrompt
    const replayPrefix = this.pendingReplayContext
    this.pendingReplayContext = null
    const sections: string[] = []
    if (applySystemPrompt) {
      sections.push(`[System Prompt]\n${this.config!.systemPrompt}`)
      this.systemPromptApplied = true
    }
    if (replayPrefix) {
      sections.push(
        `[Historical context — do not respond to this section; it is a replay of the prior conversation for your reference]\n${replayPrefix}\n[End of historical context]`,
      )
    }
    sections.push(applySystemPrompt || replayPrefix ? `[User Message]\n${text}` : text)
    const input: CodexTurnInput[] = []
    input.push({ type: "text", text: sections.join("\n\n") })
    if (images) {
      for (const img of images) {
        input.push({
          type: "image",
          url: `data:${img.mediaType};base64,${img.data}`,
        })
      }
    }

    const sandboxPolicy = toCodexSandboxPolicy(this.config?.permissionMode)
    const model = this.config?.model ?? CODEX_DEFAULT_MODEL

    const turnParams: CodexTurnStartParams = {
      threadId: this.threadId,
      input,
      approvalPolicy: toCodexApprovalPolicy(this.config?.permissionMode),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
      ...(applySystemPrompt ? { instructions: this.config!.systemPrompt } : {}),
      model,
      ...(this.config?.cwd ? { cwd: this.config.cwd } : {}),
    }

    log.info("Starting Codex turn", { threadId: this.threadId })

    try {
      // Reset the early-completion flag before sending the request.
      // If turn/completed arrives in the same stdout chunk as the turn/start
      // response, it will set this flag so waitForTurnComplete() can resolve
      // immediately instead of hanging.
      this.turnCompletedEarly = false

      const result = (await this.transport.request(
        "turn/start",
        turnParams,
      )) as CodexTurnStartResponse
      this.activeTurnId = result?.turn?.id ?? null
      log.info("Codex turn started", {
        turnId: this.activeTurnId,
        turnStatus: result?.turn?.status,
      })

      // Wait for turn to complete (signaled by turn/completed notification)
      await this.waitForTurnComplete()
    } catch (err) {
      log.error("turn/start failed", { error: String(err) })
      this.eventChannel?.push({
        type: "error",
        code: "turn_error",
        message: err instanceof Error ? err.message : String(err),
        severity: "fatal",
      })
    }
  }

  /**
   * Block until the active turn completes.
   * The turn loop is driven by notifications — turn/completed signals the end.
   * Includes an exit guard: if the transport dies mid-turn, we emit an error
   * and resolve rather than hanging forever.
   */
  private waitForTurnComplete(): Promise<void> {
    // If turn/completed already arrived (race: response + notification in same
    // stdout chunk), resolve immediately instead of hanging forever.
    if (this.turnCompletedEarly) {
      log.info("Turn already completed (early signal), skipping wait")
      this.turnCompletedEarly = false
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      this.turnCompleteResolve = resolve

      // Guard: if transport dies while waiting, don't hang forever
      const exitGuard = setInterval(() => {
        if (!this.transport?.isAlive && this.turnCompleteResolve) {
          clearInterval(exitGuard)
          this.activeTurnId = null
          this.eventChannel?.push({
            type: "error",
            code: "transport_died",
            message: "Codex process exited unexpectedly during turn",
            severity: "fatal",
          })
          this.eventChannel?.push({ type: "turn_complete" } as AgentEvent)
          const r = this.turnCompleteResolve
          this.turnCompleteResolve = null
          r()
        }
      }, 500)

      // Clean up the guard when turn completes normally
      const origResolve = this.turnCompleteResolve
      this.turnCompleteResolve = () => {
        clearInterval(exitGuard)
        origResolve()
      }
    })
  }

  private turnCompleteResolve: (() => void) | null = null

  // -----------------------------------------------------------------------
  // Private: Handle server notifications
  // -----------------------------------------------------------------------

  private handleNotification(method: string, params: unknown): void {
    log.debug("Codex notification", { method })

    // Capture token usage from thread/tokenUsage/updated (fires before turn/completed)
    if (method === "thread/tokenUsage/updated") {
      const p = params as CodexTokenUsageParams
      const usage = p?.tokenUsage?.last ?? p?.tokenUsage?.total
      if (usage) {
        this.lastTokenUsage = {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.cachedInputTokens ?? 0,
          reasoningTokens: usage.reasoningOutputTokens ?? undefined,
        }
        log.debug("Cached token usage from tokenUsage/updated", this.lastTokenUsage)
      }
    }

    const events = mapCodexNotification(method, params)
    if (events.length === 0) {
      log.debug("Codex notification produced no events", { method })
    }

    for (const event of events) {
      // Augment session_init with actual model name from thread/start response
      if (event.type === "session_init" && this.modelName) {
        event.models = [{ id: this.modelName, name: this.modelName, provider: "openai" }]
      }
      // Safety net: if the notification arrived without a thread.id (the
      // mapper intentionally leaves sessionId undefined rather than forging
      // a random UUID — see event-mapper.ts "thread/started") but the
      // thread/start RESPONSE has since resolved `this.threadId`, use it.
      // This keeps session ids stable across the race between Codex firing
      // `thread/started` and the `thread/start` request returning.
      if (event.type === "session_init" && !event.sessionId && this.threadId) {
        event.sessionId = this.threadId
      }
      // Inject cached token usage into turn_complete events if usage is undefined
      if (event.type === "turn_complete" && !event.usage && this.lastTokenUsage) {
        event.usage = { ...this.lastTokenUsage }
        this.lastTokenUsage = null
      }
      trace.write({
        dir: "internal",
        stage: "mapped_event",
        type: event.type,
        payload: event,
        meta: { sourceType: method },
      })
      this.eventChannel?.push(event)
    }

    // Detect turn completion to unblock the message loop
    if (method === "turn/completed") {
      this.activeTurnId = null
      if (this.turnCompleteResolve) {
        const resolve = this.turnCompleteResolve
        this.turnCompleteResolve = null
        resolve()
      } else {
        // turn/completed arrived before waitForTurnComplete() was called.
        // This happens when the turn/start response and turn/completed
        // notification arrive in the same stdout chunk — handleLine()
        // processes both synchronously before the microtask from the
        // request() resolution can run. Set the flag so
        // waitForTurnComplete() resolves immediately.
        this.turnCompletedEarly = true
        log.info("turn/completed arrived before waitForTurnComplete (early signal set)")
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private: Handle server-initiated requests (approvals)
  // -----------------------------------------------------------------------

  private handleServerRequest(
    rpcId: number | string,
    method: string,
    params: any,
  ): void {
    log.info("Codex server request", { method, rpcId })
    trace.write({
      dir: "internal",
      stage: "adapter_event",
      type: "server_request",
      payload: { rpcId, method, params },
    })

    switch (method) {
      case "item/commandExecution/requestApproval": {
        const itemId = params?.itemId ?? String(rpcId)
        this.pendingApprovals.set(itemId, { rpcId, method, params })

        this.eventChannel?.push({
          type: "permission_request",
          id: itemId,
          tool: "Bash",
          input: {
            command: params?.command ?? "",
            cwd: params?.cwd ?? "",
          },
          title: `Codex wants to run a command`,
          description: params?.reason,
        })
        break
      }

      case "item/fileChange/requestApproval": {
        const itemId = params?.itemId ?? String(rpcId)
        this.pendingApprovals.set(itemId, { rpcId, method, params })

        this.eventChannel?.push({
          type: "permission_request",
          id: itemId,
          tool: "Edit",
          input: {
            reason: params?.reason,
          },
          title: `Codex wants to modify files`,
          description: params?.reason,
        })
        break
      }

      case "item/permissions/requestApproval": {
        const itemId = params?.itemId ?? String(rpcId)
        this.pendingApprovals.set(itemId, { rpcId, method, params })

        const perms = params?.permissions ?? {}
        const desc = [
          perms.fileSystem?.read ? `Read: ${perms.fileSystem.read.join(", ")}` : null,
          perms.fileSystem?.write ? `Write: ${perms.fileSystem.write.join(", ")}` : null,
          perms.network?.enabled ? "Network access" : null,
        ]
          .filter(Boolean)
          .join("; ")

        this.eventChannel?.push({
          type: "permission_request",
          id: itemId,
          tool: "Permissions",
          input: perms,
          title: "Codex requests additional permissions",
          description: desc || params?.reason,
        })
        break
      }

      case "mcpServer/elicitation/request": {
        const elicId = params?.elicitationId ?? String(rpcId)
        this.pendingApprovals.set(elicId, { rpcId, method, params })

        this.eventChannel?.push({
          type: "elicitation_request",
          id: elicId,
          questions: [
            {
              question: params?.message ?? "MCP server requires input",
              options: [],
              allowFreeText: true,
            },
          ],
        })
        break
      }

      case "item/tool/requestUserInput": {
        const inputId = params?.itemId ?? String(rpcId)
        this.pendingApprovals.set(inputId, { rpcId, method, params })

        this.eventChannel?.push({
          type: "elicitation_request",
          id: inputId,
          questions: [
            {
              question: params?.message ?? params?.prompt ?? "Codex needs input",
              options: [],
              allowFreeText: true,
            },
          ],
        })
        break
      }

      case "item/tool/call": {
        // MCP tool call that needs client-side execution (rare)
        // Auto-respond since we don't execute tools client-side
        this.transport?.respondError(
          rpcId,
          -32601,
          "Client-side tool execution not supported",
        )
        break
      }

      default:
        log.warn("Unhandled server request", { method })
        this.transport?.respondError(rpcId, -32601, "Method not handled")
    }
  }
}
