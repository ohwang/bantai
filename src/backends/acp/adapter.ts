/**
 * ACP Adapter
 *
 * Implements AgentBackend by spawning an ACP-compatible agent as a subprocess
 * and speaking JSON-RPC 2.0 over stdio. Supports any agent that implements the
 * Agent Client Protocol: Gemini CLI, GitHub Copilot CLI, and others.
 *
 * Usage:
 *   --backend gemini          (preset: gemini --acp)
 *   --backend copilot         (preset: gh copilot --acp)
 *   --backend acp              (generic: requires --acp-command)
 *
 * Lifecycle:
 *   1. start() spawns the agent, sends initialize handshake
 *   2. session/new creates a session, discovers modes and models
 *   3. session/prompt sends user input, server streams session/update notifications
 *   4. session/request_permission → permission_request events → user response → JSON-RPC reply
 *   5. interrupt() sends session/cancel notification
 *   6. close() kills the child process
 */

import { log } from "../../utils/logger"
import type {
  AgentEvent,
  BackendCapabilities,
  EffortLevel,
  ElicitationQuestion,
  ElicitationOption,
  ForkOptions,
  ModelInfo,
  PermissionMode,
  SandboxInfo,
  SessionConfig,
  SessionInfo,
  UserMessage,
} from "../../protocol/types"
import { backendTrace } from "../../utils/backend-trace"
import { BaseAdapter } from "../shared/base-adapter"
import { AcpTransport } from "./transport"
import { AcpTerminalManager } from "./terminal-manager"
import { mapAcpUpdate, deriveToolName } from "./event-mapper"
import type {
  AcpInitializeResult,
  AcpAgentCapabilities,
  AcpSessionNewResult,
  AcpSessionUpdateParams,
  AcpPermissionRequestParams,
  AcpElicitationParams,
  AcpTerminalCreateParams,
  AcpTerminalOutputParams,
  AcpTerminalWaitParams,
  AcpTerminalKillParams,
  AcpTerminalReleaseParams,
  AcpFsReadParams,
  AcpFsWriteParams,
  AcpContentBlock,
  AcpModel,
  AcpMode,
  AcpConfigOption,
  AcpConfigOptionUpdateNotification,
} from "./types"
import nodePath from "path"

const trace = backendTrace.scoped("acp")

// ---------------------------------------------------------------------------
// Path validation (exported for testing)
// ---------------------------------------------------------------------------

/** Validate that a path is within the allowed working directory */
export function validatePathWithinCwd(
  filePath: string,
  cwd: string,
): { valid: boolean; resolved: string; error?: string } {
  const resolved = nodePath.resolve(filePath)
  if (!resolved.startsWith(cwd + "/") && resolved !== cwd) {
    return { valid: false, resolved, error: `Path outside working directory: ${filePath}` }
  }
  return { valid: true, resolved }
}

/**
 * Normalize an ACP config option to a consistent shape.
 * Handles Copilot vs Gemini differences:
 *   - Copilot: type="select", currentValue, options[].value
 *   - Gemini: type="enum", value, options[].id
 */
function normalizeConfigOption(raw: AcpConfigOption): AcpConfigOption {
  return {
    ...raw,
    // Normalize type: "select" → "enum"
    type: raw.type === "select" ? "enum" : raw.type,
    // Normalize value: prefer currentValue (Copilot), fall back to value (Gemini)
    value: raw.currentValue ?? raw.value,
    // Normalize choices: ensure each has both id and value
    options: raw.options?.map(c => ({
      ...c,
      id: c.id ?? c.value ?? c.name,
      value: c.value ?? c.id ?? c.name,
    })),
  }
}

// ---------------------------------------------------------------------------
// ACP Adapter
// ---------------------------------------------------------------------------

export class AcpAdapter extends BaseAdapter {
  private transport: AcpTransport | null = null
  private terminalManager = new AcpTerminalManager()

  // Session state
  private sessionId: string | null = null
  private agentCapabilities: AcpAgentCapabilities | null = null
  private currentModel: string | null = null
  private discoveredModels: AcpModel[] = []
  private discoveredModes: AcpMode[] = []
  private discoveredConfigOptions: AcpConfigOption[] = []
  private agentName = "ACP Agent"

  // Config
  private command: string
  private args: string[]
  private presetName: string

  // System prompt state
  private config: SessionConfig | null = null
  private systemPromptApplied = false

  // Pending replay context from /switch — prepended to the next real user
  // message as a marked historical section, never sent as its own turn.
  // See SessionConfig.replayContext for the contract.
  private pendingReplayContext: string | null = null

  /** True between session/load returning and the "replay drained" signal.
   *  While set, session/update notifications that replay historical
   *  conversational content are dropped — we already have the full history
   *  on disk (seeded by the TUI sync layer from the session JSON file) and
   *  don't need the backend to stream it back.
   *
   *  Cleared by finalizeReplay(), which runs as soon as ANY of:
   *    (a) `available_commands_update` fires — Gemini emits this immediately
   *        after `streamHistory`, so it's a reliable end-of-replay signal
   *    (b) a safety-net timer elapses (~1.5s after session/load) in case a
   *        future ACP agent doesn't emit (a)
   *    (c) sendPrompt runs — guaranteed fallback; replay can't still be in
   *        flight if the user is sending a new message
   *  Whichever fires first also emits the `history_loaded` SystemEvent with
   *  the summary stashed in config._pendingResumeSummary. */
  private replayMode = false
  private replayDrainTimer: ReturnType<typeof setTimeout> | null = null

  // Pending permission requests (server-initiated JSON-RPC requests awaiting our response)
  private pendingApprovals = new Map<
    string,
    { rpcId: number | string; params: AcpPermissionRequestParams }
  >()

  // Pending elicitation requests (server-initiated JSON-RPC requests awaiting user input)
  private pendingElicitations = new Map<string, { rpcId: number | string }>()

  // Turn lifecycle
  private turnCompleteResolve: (() => void) | null = null

  constructor(preset?: { command: string; args: string[]; displayName: string; presetName: string }) {
    super()
    this.command = preset?.command ?? ""
    this.args = preset?.args ?? []
    this.presetName = preset?.presetName ?? "acp"
    if (preset?.displayName) this.agentName = preset.displayName
  }

  /** Map ACP config options to protocol ConfigOption[] and emit a config_options event */
  private emitConfigOptions(): void {
    if (this.discoveredConfigOptions.length === 0) return
    this.eventChannel?.push({
      type: "config_options",
      options: this.discoveredConfigOptions.map(o => ({
        id: o.id,
        name: o.name,
        description: o.description,
        type: o.type,
        value: o.value,
        choices: o.options?.map(c => ({ id: c.id ?? c.value ?? c.name, name: c.name, description: c.description })),
      })),
    })
  }

  private deriveSupportedPermissionModes(): PermissionMode[] {
    // Reverse-map ACP mode IDs to our internal PermissionMode names.
    // Supports both short IDs (Gemini: "default", "yolo") and
    // URI-based IDs (Copilot: "https://...#agent", "https://...#plan").
    const reverseMap: Record<string, PermissionMode> = {
      default: "default",
      autoEdit: "acceptEdits",
      yolo: "bypassPermissions",
      plan: "plan",
    }
    // URI fragment mappings for Copilot-style mode IDs
    const fragmentMap: Record<string, PermissionMode> = {
      agent: "default",
      plan: "plan",
      autopilot: "bypassPermissions",
    }

    if (this.discoveredModes.length > 0) {
      const modes = this.discoveredModes
        .map(m => {
          // Try direct ID match first (Gemini)
          if (reverseMap[m.id]) return reverseMap[m.id]!
          // Try URI fragment match (Copilot)
          const fragment = m.id.split("#").pop()
          if (fragment && fragmentMap[fragment]) return fragmentMap[fragment]!
          // Try name-based matching as fallback
          const name = m.name.toLowerCase()
          if (name.includes("plan")) return "plan" as PermissionMode
          if (name.includes("auto")) return "bypassPermissions" as PermissionMode
          return undefined
        })
        .filter((m): m is PermissionMode => !!m)
      // Always include "default" as a fallback
      if (!modes.includes("default")) modes.unshift("default")
      // Deduplicate
      return [...new Set(modes)]
    }

    // Fallback if no modes discovered yet
    return ["default", "bypassPermissions"]
  }

  /**
   * ACP sandbox/approval model:
   *
   * The ACP protocol defines modes and permission_request callbacks, but
   * sandbox enforcement is entirely agent-specific and not introspectable
   * from the client side. Different ACP agents have different models:
   *
   * - Gemini CLI: Uses modes ("default", "autoEdit", "yolo") that map to
   *   our permission modes. Sandbox behavior is agent-internal. The client
   *   only sees permission_request callbacks when the agent decides to ask.
   *
   * - GitHub Copilot CLI: Uses URI-based modes (e.g., "#agent", "#plan",
   *   "#autopilot"). Mode selection is done via config options. Sandbox
   *   details are opaque to the client.
   *
   * Key limitation: We cannot determine from the ACP protocol alone what
   * filesystem restrictions, network policies, or protected paths an agent
   * enforces. The sandboxInfo we provide is necessarily approximate.
   */
  capabilities(): BackendCapabilities {
    // Derive thinking support from discovered config options
    const hasThinkingOption = this.discoveredConfigOptions.some(
      o => o.category === "thought_level" || o.id === "thinking" || o.name.toLowerCase().includes("thinking") || o.name.toLowerCase().includes("effort"),
    )

    const sandboxInfo: SandboxInfo = {
      statusHint: "agent-managed permissions",
      modeDetails: {
        default: {
          writableScope: "agent-determined",
          protectedPaths: "agent-determined",
          commandApproval: "always",
          editApproval: "always",
          networkAccess: "unknown",
          separateSandbox: false,
          caveats: "Sandbox enforcement is agent-specific and not visible to the client.",
        },
        bypassPermissions: {
          writableScope: "agent-determined",
          protectedPaths: "agent-determined",
          commandApproval: "never",
          editApproval: "never",
          networkAccess: "unknown",
          separateSandbox: false,
          caveats: "Agent may still enforce its own restrictions regardless of mode.",
        },
      },
    }

    return {
      name: this.presetName,
      supportsThinking: hasThinkingOption,
      supportsToolApproval: true,
      supportsResume: !!this.agentCapabilities?.loadSession,
      supportsContinue: !!this.agentCapabilities?.loadSession,
      supportsFork: false,
      supportsStreaming: true,
      supportsSubagents: false,
      supportsCompact: false,
      supportedPermissionModes: this.deriveSupportedPermissionModes(),
      sandboxInfo,
    }
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
    if (!this.transport?.isAlive || !this.sessionId) return

    trace.write({
      dir: "out",
      stage: "adapter_event",
      type: "interrupt",
      payload: { sessionId: this.sessionId, pendingApprovals: this.pendingApprovals.size },
    })

    log.info("Interrupting ACP turn", { sessionId: this.sessionId })

    // Auto-deny pending permission requests
    for (const [toolCallId, approval] of this.pendingApprovals) {
      this.transport?.respond(approval.rpcId, {
        outcome: { outcome: "cancelled" },
      })
      this.eventChannel?.push({
        type: "permission_response",
        id: toolCallId,
        behavior: "deny",
      })
    }
    this.pendingApprovals.clear()

    // Auto-cancel pending elicitations
    for (const [elicId, elic] of this.pendingElicitations) {
      this.transport.respond(elic.rpcId, { action: "cancel" })
      this.eventChannel?.push({
        type: "elicitation_response",
        id: elicId,
        answers: {},
      })
    }
    this.pendingElicitations.clear()

    // session/cancel is a notification per ACP spec (no id, no response)
    this.transport.notify("session/cancel", { sessionId: this.sessionId })

    // Resolve turn completion to unblock the message loop
    if (this.turnCompleteResolve) {
      this.eventChannel?.push({ type: "turn_complete" } as AgentEvent)
      const resolve = this.turnCompleteResolve
      this.turnCompleteResolve = null
      resolve()
    }
  }

  approveToolUse(
    id: string,
    options?: { alwaysAllow?: boolean },
  ): void {
    const approval = this.pendingApprovals.get(id)
    if (!approval) return

    // Find the appropriate option
    const opts = approval.params.options || []
    const option = options?.alwaysAllow
      ? opts.find(o => o.kind === "allow_always") ?? opts.find(o => o.kind === "allow_once")
      : opts.find(o => o.kind === "allow_once")

    log.info("ACP approval: approve", { id, optionId: option?.optionId })
    this.transport?.respond(approval.rpcId, {
      outcome: {
        outcome: "selected",
        optionId: option?.optionId ?? opts[0]?.optionId ?? "allow",
      },
    })
    this.pendingApprovals.delete(id)
    this.eventChannel?.push({
      type: "permission_response",
      id,
      behavior: "allow",
    })
  }

  denyToolUse(id: string, _reason?: string, options?: { denyForSession?: boolean }): void {
    const approval = this.pendingApprovals.get(id)
    if (!approval) return

    const opts = approval.params.options || []
    const rejectOption = options?.denyForSession
      ? opts.find(o => o.kind === "reject_always") ?? opts.find(o => o.kind === "reject_once")
      : opts.find(o => o.kind === "reject_once") ?? opts.find(o => o.kind === "reject_always")

    log.info("ACP approval: deny", { id, optionId: rejectOption?.optionId })
    this.transport?.respond(approval.rpcId, {
      outcome: {
        outcome: "selected",
        optionId: rejectOption?.optionId ?? "reject",
      },
    })
    this.pendingApprovals.delete(id)
    this.eventChannel?.push({
      type: "permission_response",
      id,
      behavior: "deny",
    })
  }

  respondToElicitation(id: string, answers: Record<string, string>): void {
    const pending = this.pendingElicitations.get(id)
    if (!pending) return

    this.transport?.respond(pending.rpcId, {
      action: "submit",
      data: answers,
    })
    this.pendingElicitations.delete(id)
    this.eventChannel?.push({
      type: "elicitation_response",
      id,
      answers,
    })
  }

  cancelElicitation(id: string): void {
    const pending = this.pendingElicitations.get(id)
    if (!pending) return

    this.transport?.respond(pending.rpcId, {
      action: "cancel",
    })
    this.pendingElicitations.delete(id)
    this.eventChannel?.push({
      type: "elicitation_response",
      id,
      answers: {},
    })
  }

  async setModel(model: string): Promise<void> {
    if (!this.transport?.isAlive || !this.sessionId) {
      throw new Error("No active ACP session")
    }

    // Strategy 1: Try config option if a model config option exists
    const modelOption = this.discoveredConfigOptions.find(
      o => o.category === "model" || o.id === "model" || o.name.toLowerCase().includes("model"),
    )
    if (modelOption) {
      try {
        await this.transport.request("session/set_config_option", {
          sessionId: this.sessionId,
          configOptionId: modelOption.id,
          value: model,
        })
        this.currentModel = model
        this.eventChannel?.push({ type: "model_changed", model })
        log.info("ACP model set via config option", { model })
        return
      } catch (err) {
        log.warn("session/set_config_option failed for model", { error: String(err) })
      }
    }

    // Strategy 2: Try session/set_model if agent exposes it
    // (Some agents support this as a direct method)
    try {
      await this.transport.request("session/set_model", {
        sessionId: this.sessionId,
        modelId: model,
      })
      this.currentModel = model
      this.eventChannel?.push({ type: "model_changed", model })
      log.info("ACP model set via session/set_model", { model })
    } catch (err) {
      log.warn("Model switching not supported by this ACP agent", { error: String(err), model })
      throw new Error("Model switching not supported by this ACP agent")
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.transport?.isAlive || !this.sessionId) return

    // Strategy 1: Try config option (Copilot supports mode as a config option)
    const modeOption = this.discoveredConfigOptions.find(
      o => o.id === "mode" || o.category === "mode",
    )
    if (modeOption) {
      // Find the matching choice value
      const targetName = mode === "default" ? "agent" : mode === "bypassPermissions" ? "autopilot" : mode
      const choice = modeOption.options?.find(c => {
        const cid = (c.id ?? c.value ?? "").toLowerCase()
        const cname = c.name.toLowerCase()
        return cid.includes(targetName) || cname.includes(targetName)
      })
      if (choice) {
        try {
          await this.transport.request("session/set_config_option", {
            sessionId: this.sessionId,
            configOptionId: modeOption.id,
            value: choice.id ?? choice.value,
          })
          log.info("ACP mode set via config option", { mode, value: choice.id ?? choice.value })
          return
        } catch (err) {
          log.warn("session/set_config_option failed for mode", { error: String(err) })
        }
      }
    }

    // Strategy 2: Try session/set_mode with direct ID mapping (Gemini)
    const modeMap: Record<string, string> = {
      default: "default",
      acceptEdits: "autoEdit",
      bypassPermissions: "yolo",
      plan: "plan",
    }
    const modeId = modeMap[mode]
    if (!modeId) return

    try {
      await this.transport.request("session/set_mode", {
        sessionId: this.sessionId,
        modeId,
      })
      log.info("ACP mode set via session/set_mode", { mode, modeId })
    } catch (err) {
      log.warn("session/set_mode failed", { error: String(err) })
    }
  }

  async setConfigOption(id: string, value: unknown): Promise<void> {
    if (!this.transport?.isAlive || !this.sessionId) return

    await this.transport.request("session/set_config_option", {
      sessionId: this.sessionId,
      configOptionId: id,
      value,
    })

    // Update local state
    const idx = this.discoveredConfigOptions.findIndex(o => o.id === id)
    const existing = this.discoveredConfigOptions[idx]
    if (idx >= 0 && existing) {
      this.discoveredConfigOptions[idx] = { ...existing, value }
    }

    // Emit updated options
    this.emitConfigOptions()

    log.info("ACP config option set", { id, value })
  }

  async setEffort(level: EffortLevel): Promise<void> {
    if (!this.transport?.isAlive || !this.sessionId) return

    // Try config option if a thinking/effort config option exists
    const effortOption = this.discoveredConfigOptions.find(
      o => o.category === "thought_level" || o.id === "thinking" || o.name.toLowerCase().includes("thinking") || o.name.toLowerCase().includes("effort"),
    )
    if (effortOption) {
      try {
        await this.transport.request("session/set_config_option", {
          sessionId: this.sessionId,
          configOptionId: effortOption.id,
          value: level,
        })
        this.eventChannel?.push({ type: "effort_changed", effort: level })
        log.info("ACP effort set via config option", { level })
        return
      } catch (err) {
        log.warn("session/set_config_option failed for effort", { error: String(err) })
      }
    }

    log.debug("Effort control not supported by this ACP agent", { level })
  }

  /** Extract a normalized model ID from an AcpModel, preferring modelId > value > name */
  private normalizeModelId(m: AcpModel): string {
    return m.modelId ?? m.value ?? m.name ?? ""
  }

  /** Extract a display name from an AcpModel */
  private normalizeModelName(m: AcpModel): string {
    return m.name ?? m.modelId ?? m.value ?? ""
  }

  /** Normalize a list of AcpModel into ModelInfo[], skipping entries with no ID */
  private normalizeModelList(models: AcpModel[]): ModelInfo[] {
    const result: ModelInfo[] = []
    for (const m of models) {
      const id = this.normalizeModelId(m)
      if (!id) continue
      result.push({
        id,
        name: this.normalizeModelName(m) || id,
        provider: this.presetName,
      })
    }
    return result
  }

  /** Get the ID of the first model in a list, or null */
  private firstModelId(models: AcpModel[]): string | null {
    const id = models[0] ? this.normalizeModelId(models[0]) : ""
    return id || null
  }

  async availableModels(): Promise<ModelInfo[]> {
    // Merge models from two sources:
    // 1. models.availableModels from session/new
    // 2. config option with category="model" (Copilot pattern)
    const modelSet = new Map<string, ModelInfo>()

    // Source 1: Direct model list
    for (const m of this.discoveredModels) {
      const id = m.modelId ?? m.value ?? m.name ?? ""
      if (!id) continue
      modelSet.set(id, {
        id,
        name: m.name ?? m.modelId ?? m.value ?? id,
        provider: this.presetName,
      })
    }

    // Source 2: Config option models (Copilot pattern)
    const modelOption = this.discoveredConfigOptions.find(
      o => o.category === "model" || o.id === "model",
    )
    if (modelOption?.options) {
      for (const choice of modelOption.options) {
        const id = choice.id ?? choice.value ?? choice.name
        if (!id || modelSet.has(id)) continue
        modelSet.set(id, {
          id,
          name: choice.name ?? id,
          provider: this.presetName,
        })
      }
    }

    return Array.from(modelSet.values())
  }

  async listSessions(): Promise<SessionInfo[]> {
    // Check if the agent supports session listing
    const sessionCaps = (this.agentCapabilities as any)?.sessionCapabilities
    if (!sessionCaps?.list || !this.transport?.isAlive) {
      // Fall back to reading Gemini session files from disk when transport
      // is not alive. This enables the session picker to show sessions
      // before the ACP subprocess is spawned.
      // Scope to the current cwd's project dir so every listed session can
      // actually be loaded — Gemini's session/load only searches the project
      // dir for the active cwd and rejects sessions from other projects
      // with JSON-RPC -32603 "Invalid session identifier".
      if (!this.transport?.isAlive && (this.presetName === "gemini" || this.presetName === "acp")) {
        const { listGeminiSessionsFromDisk } = await import("../../session/cross-backend")
        return listGeminiSessionsFromDisk(this.config?.cwd ?? process.cwd())
      }
      return []
    }

    try {
      const result = (await this.transport.request("session/list", {})) as {
        sessions?: { sessionId: string; title?: string; cwd?: string; updatedAt?: string }[]
      }
      return (result.sessions ?? []).map(s => ({
        id: s.sessionId,
        title: s.title ?? s.sessionId.slice(0, 8),
        updatedAt: s.updatedAt ? new Date(s.updatedAt).getTime() : Date.now(),
        cwd: s.cwd,
      }))
    } catch (err) {
      log.debug("session/list not supported by this agent", { error: String(err) })
      return []
    }
  }

  async forkSession(_sessionId: string, _options?: ForkOptions): Promise<string> {
    throw new Error("Session forking not supported for ACP backend")
  }

  async resetSession?(): Promise<void> {
    if (!this.transport?.isAlive) return

    // Create a new session on the existing transport
    try {
      const result = (await this.transport.request("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      })) as AcpSessionNewResult

      this.sessionId = result.sessionId
      if (result.models) {
        this.discoveredModels = result.models.availableModels
        this.currentModel = result.models.currentModelId ??
          this.firstModelId(this.discoveredModels)
      }
      if (result.modes) {
        this.discoveredModes = result.modes.availableModes
      }
      if (result.configOptions) {
        this.discoveredConfigOptions = result.configOptions.map(normalizeConfigOption)
      }

      this.eventChannel?.push({
        type: "session_init",
        sessionId: this.sessionId,
        tools: [],
        models: this.normalizeModelList(this.discoveredModels),
      })

      this.emitConfigOptions()

      log.info("ACP session reset", { sessionId: this.sessionId })
    } catch (err) {
      log.error("Failed to reset ACP session", { error: String(err) })
    }
  }

  protected onClose(): void {
    trace.write({
      dir: "out",
      stage: "adapter_event",
      type: "close",
      payload: { sessionId: this.sessionId, hadTransport: !!this.transport },
    })

    // Reject pending approvals
    for (const [, approval] of this.pendingApprovals) {
      this.transport?.respond(approval.rpcId, {
        outcome: { outcome: "cancelled" },
      })
    }
    this.pendingApprovals.clear()

    // Cancel pending elicitations
    for (const [, elic] of this.pendingElicitations) {
      this.transport?.respond(elic.rpcId, { action: "cancel" })
    }
    this.pendingElicitations.clear()

    // Send session/close notification for graceful shutdown
    if (this.transport?.isAlive && this.sessionId) {
      this.transport.notify("session/close", { sessionId: this.sessionId })
    }

    // Kill all managed terminals
    this.terminalManager.destroyAll()

    if (this.transport) {
      this.transport.close()
      this.transport = null
    }
  }

  // -----------------------------------------------------------------------
  // Protected: Session lifecycle
  // -----------------------------------------------------------------------

  protected async runSession(config: SessionConfig): Promise<void> {
    if (!this.command) {
      throw new Error(
        "ACP backend requires a command. Use --backend gemini, --backend copilot, " +
        "or --backend acp with --acp-command <cmd>",
      )
    }

    this.config = config

    try {
      // 1. Spawn transport
      this.transport = new AcpTransport()
      await this.transport.start(this.command, this.args)

      // 2. Wire up event handlers
      this.transport.onNotification((method, params) => {
        this.handleNotification(method, params)
      })
      this.transport.onRequest((id, method, params) => {
        this.handleServerRequest(id, method, params)
      })

      // 3. Initialize handshake
      log.info("Sending ACP initialize request")
      const initResult = (await this.transport.request("initialize", {
        protocolVersion: 1,
        clientInfo: {
          name: "bantai",
          version: "0.0.1",
        },
        clientCapabilities: {
          terminal: true,
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      })) as AcpInitializeResult

      this.agentName = initResult.agentInfo?.title ?? initResult.agentInfo?.name ?? this.agentName
      this.agentCapabilities = initResult.agentCapabilities ?? null
      log.info("ACP agent initialized", {
        agent: this.agentName,
        version: initResult.agentInfo?.version,
        protocolVersion: initResult.protocolVersion,
        loadSession: !!this.agentCapabilities?.loadSession,
      })

      // Send initialized notification (harmless if agent doesn't recognize it)
      this.transport.notify("initialized")

      // 4. Create or load session
      const cwd = config.cwd ?? process.cwd()
      let sessionResult: AcpSessionNewResult

      // Track the session ID we used when loading an existing session.
      // session/load's response omits `sessionId` (only session/new returns it),
      // so we need to remember the ID we asked to resume.
      let loadedSessionId: string | null = null

      // Enter replay suppression BEFORE session/load is awaited. Gemini may
      // start streaming historical turns back as session/update notifications
      // concurrently with the load response — if we flipped replayMode after
      // the await, those early notifications would slip through and render
      // as duplicates above the resume marker.
      if (config.resume || config.continue) {
        this.replayMode = true
      }

      if (config.resume) {
        // --resume: load a specific session by ID.
        // Per ACP spec, session/load requires { sessionId, cwd, mcpServers } —
        // Gemini rejects the request with JSON-RPC -32603 if cwd/mcpServers
        // are missing.
        if (!this.agentCapabilities?.loadSession) {
          this.replayMode = false
          this.eventChannel?.push({
            type: "error",
            code: "unsupported_resume",
            message: `The ${this.agentName} agent does not support session resume. Start a new session instead.`,
            severity: "fatal",
          })
          return
        }
        sessionResult = (await this.transport.request("session/load", {
          sessionId: config.resume,
          cwd,
          mcpServers: [],
        })) as AcpSessionNewResult
        loadedSessionId = config.resume
        log.info("ACP session loaded", { sessionId: config.resume })
      } else if (config.continue) {
        // --continue: find and load the most recent session
        if (!this.agentCapabilities?.loadSession) {
          this.replayMode = false
          this.eventChannel?.push({
            type: "error",
            code: "unsupported_continue",
            message: `The ${this.agentName} agent does not support session resume. Cannot use --continue.`,
            severity: "fatal",
          })
          return
        }
        const sessions = await this.listSessions()
        if (sessions.length === 0) {
          // No session to load → no replay to suppress.
          this.replayMode = false
          log.info("No existing ACP sessions found for --continue, starting new session")
          this.eventChannel?.push({
            type: "system_message",
            text: `No previous ${this.agentName} sessions found. Starting a new session.`,
          })
          sessionResult = (await this.transport.request("session/new", {
            cwd,
            mcpServers: [],
          })) as AcpSessionNewResult
        } else {
          // Pick the most recent session by updatedAt
          const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
          const mostRecent = sorted[0]!
          log.info("Continuing most recent ACP session", { sessionId: mostRecent.id })
          sessionResult = (await this.transport.request("session/load", {
            sessionId: mostRecent.id,
            cwd,
            mcpServers: [],
          })) as AcpSessionNewResult
          loadedSessionId = mostRecent.id
          log.info("ACP session loaded for --continue", { sessionId: mostRecent.id })
        }
      } else {
        sessionResult = (await this.transport.request("session/new", {
          cwd,
          mcpServers: [],
        })) as AcpSessionNewResult
      }

      // session/load's response omits `sessionId` (only session/new returns it),
      // so fall back to the ID we passed in. Without this, sendPrompt() silently
      // bails out because its sessionId guard fails and the user's message stays
      // queued forever.
      this.sessionId = sessionResult.sessionId ?? loadedSessionId

      // If we loaded an existing session, the backend is streaming historical
      // turns back as session/update notifications (Gemini does this via
      // streamHistory). replayMode was set earlier — right before the await
      // on session/load — to catch notifications that arrive concurrently
      // with the load response. Now arm the safety-net drain timer in case
      // `available_commands_update` (the preferred end-of-replay signal)
      // never arrives for a particular agent.
      if (loadedSessionId) {
        this.replayDrainTimer = setTimeout(() => {
          this.replayDrainTimer = null
          this.finalizeReplay("timer")
        }, 1500)
      } else {
        // Fresh session/new path: nothing to suppress.
        this.replayMode = false
      }
      if (sessionResult.models) {
        this.discoveredModels = sessionResult.models.availableModels
        this.currentModel = sessionResult.models.currentModelId ??
          this.firstModelId(this.discoveredModels)
      }
      if (sessionResult.modes) {
        this.discoveredModes = sessionResult.modes.availableModes
      }
      if (sessionResult.configOptions) {
        this.discoveredConfigOptions = sessionResult.configOptions
      }

      log.info("ACP session created", {
        sessionId: this.sessionId,
        models: this.discoveredModels.length,
        modes: this.discoveredModes.length,
        currentModel: this.currentModel,
      })

      // 5. Emit session_init
      this.eventChannel?.push({
        type: "session_init",
        sessionId: this.sessionId,
        tools: [],
        models: this.normalizeModelList(this.discoveredModels),
      })

      // 5b. Emit config options if the agent exposed any
      this.emitConfigOptions()

      // 5c. Apply system prompt via config option if the agent exposes one
      await this.applySystemPromptViaConfigOption()

      // 5d. Apply the caller-requested permission mode. Without this the
      //     agent sits in its default "ask before every tool" state even
      //     when the operator explicitly configured bypassPermissions in
      //     slack.json. `setPermissionMode` is best-effort: agents that
      //     don't advertise a matching mode just log.warn and move on.
      if (config.permissionMode && config.permissionMode !== "default") {
        await this.setPermissionMode(config.permissionMode)
      }

      // 6a. Replay context from /switch is stashed, not sent as a turn —
      //     it'll prepend to the next real user message inside sendPrompt().
      if (config.replayContext) {
        this.pendingReplayContext = config.replayContext
        log.info("ACP: replay context staged for next user turn", {
          chars: config.replayContext.length,
        })
      }

      // 6b. If there's a CLI initial prompt, send the first turn normally.
      if (config.initialPrompt) {
        await this.sendPrompt(config.initialPrompt)
      }

      // 6c. Signal readiness — subprocess alive, ACP session created,
      //     capabilities discovered, replay stashed. /switch awaits this.
      this.markReady()

      // 7. Main message loop
      await this.runMessageLoop(async (message) => {
        await this.sendPrompt(message.text, message.images)
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
  // Private: System prompt support
  // -----------------------------------------------------------------------

  /**
   * Try to apply the system prompt via a discovered config option.
   * Looks for config options with id/category matching "system_prompt",
   * "system_instruction", or category "system".
   */
  private async applySystemPromptViaConfigOption(): Promise<void> {
    if (!this.config?.systemPrompt || !this.transport?.isAlive || !this.sessionId) return

    const systemOption = this.discoveredConfigOptions.find(
      o =>
        o.id === "system_prompt" ||
        o.id === "system_instruction" ||
        o.category === "system" ||
        o.name.toLowerCase().includes("system prompt") ||
        o.name.toLowerCase().includes("system instruction"),
    )
    if (!systemOption) return

    try {
      await this.transport.request("session/set_config_option", {
        sessionId: this.sessionId,
        configOptionId: systemOption.id,
        value: this.config.systemPrompt,
      })
      this.systemPromptApplied = true
      log.info("ACP system prompt set via config option", { configOptionId: systemOption.id })
    } catch (err) {
      log.warn("session/set_config_option failed for system prompt, will use fallback injection", {
        error: String(err),
      })
    }
  }

  // -----------------------------------------------------------------------
  // Private: Finalize the replay-suppression window
  // -----------------------------------------------------------------------

  /**
   * Close the replay-suppression window and emit history_loaded. Idempotent
   * and safe to call from multiple signal sites (available_commands_update,
   * the safety timer, and sendPrompt). First caller wins; subsequent callers
   * are no-ops.
   */
  private finalizeReplay(source: "available_commands_update" | "timer" | "send_prompt"): void {
    if (!this.replayMode) return
    this.replayMode = false
    if (this.replayDrainTimer) {
      clearTimeout(this.replayDrainTimer)
      this.replayDrainTimer = null
    }

    const pending = this.config?._pendingResumeSummary
    log.info("ACP replay mode closed", { source, hasSummary: !!pending })

    if (pending) {
      this.eventChannel?.push({
        type: "history_loaded",
        sessionId: pending.sessionId,
        origin: pending.origin,
        target: pending.target,
        summary: pending,
      })
      // Consume so subsequent sessions (e.g. after /new) don't re-emit it.
      if (this.config) {
        this.config._pendingResumeSummary = undefined
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private: Prompt turn
  // -----------------------------------------------------------------------

  private async sendPrompt(
    text: string,
    images?: { data: string; mediaType: string }[],
  ): Promise<void> {
    if (!this.transport?.isAlive || !this.sessionId) return

    // Build prompt content blocks, prepending (a) system prompt on first turn,
    // and (b) any pending replay context from a /switch. The replay context
    // is clearly marked as historical so the model treats it as background
    // rather than a turn to respond to.
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
    const promptText = sections.join("\n\n")
    const prompt: AcpContentBlock[] = [{ type: "text", text: promptText }]
    if (images) {
      for (const img of images) {
        prompt.push({
          type: "image",
          mimeType: img.mediaType,
          data: img.data,
        })
      }
    }

    // Guarantee replay mode is closed before the first real turn goes out,
    // even if neither available_commands_update nor the safety timer fired.
    this.finalizeReplay("send_prompt")

    // Emit turn_start
    this.eventChannel?.push({ type: "turn_start" })

    try {
      // Send prompt — this blocks until the turn completes
      // but streaming updates arrive as notifications
      const resultPromise = this.transport.request("session/prompt", {
        sessionId: this.sessionId,
        prompt,
      })

      // Wait for the prompt result (which signals turn completion)
      const result = (await resultPromise) as { stopReason: string } | undefined

      // Emit turn_complete with stop reason
      this.eventChannel?.push({
        type: "turn_complete",
        sessionId: this.sessionId ?? undefined,
      })

      // Warn on non-normal stop reasons
      if (result?.stopReason && result.stopReason !== "end_turn" && result.stopReason !== "stop") {
        const reasonMessages: Record<string, string> = {
          max_tokens: "Response truncated (token limit reached)",
          max_turn_requests: "Turn ended (maximum tool calls reached)",
          refusal: "Agent refused to continue",
          cancelled: "Turn was cancelled",
        }
        const msg = reasonMessages[result.stopReason] ?? `Turn ended: ${result.stopReason}`
        this.eventChannel?.push({
          type: "system_message",
          text: msg,
          ephemeral: true,
        })
      }

      log.info("ACP prompt completed", { stopReason: result?.stopReason })
    } catch (err) {
      // If we were interrupted, the cancel notification resolves the prompt
      // with an error — that's expected behavior
      if (this.closed) return

      log.error("ACP prompt failed", { error: String(err) })
      this.eventChannel?.push({
        type: "turn_complete",
        sessionId: this.sessionId ?? undefined,
      })
      this.eventChannel?.push({
        type: "error",
        code: "turn_error",
        message: err instanceof Error ? err.message : String(err),
        severity: "recoverable",
      })
    }
  }

  // -----------------------------------------------------------------------
  // Private: Handle server notifications
  // -----------------------------------------------------------------------

  private handleNotification(method: string, params: unknown): void {
    if (this.closed) return
    log.debug("ACP notification", { method })

    if (method === "session/update") {
      // Replay suppression: during the window between session/load returning
      // and the first real sendPrompt, Gemini emits every historical turn
      // back as session/update notifications. We already seeded the full
      // conversation from the on-disk session file, so these replayed events
      // are duplicates that would render as if the agent were typing live.
      // Drop only the subtypes that carry conversational payload — keep
      // stateful ones (available_commands_update, current_mode_update,
      // session_info_update) because they describe current agent state
      // and shouldn't be lost just because we happened to resume.
      if (this.replayMode) {
        const update = (params as AcpSessionUpdateParams | undefined)?.update as
          | { sessionUpdate?: string }
          | undefined
        const kind = update?.sessionUpdate
        const isConversational =
          kind === "agent_message_chunk" ||
          kind === "agent_thought_chunk" ||
          kind === "tool_call" ||
          kind === "tool_call_update" ||
          kind === "plan" ||
          kind === "user_message_chunk"
        if (isConversational) {
          log.debug("ACP session/update suppressed during replay", { kind })
          return
        }
      }

      const events = mapAcpUpdate(params as AcpSessionUpdateParams)
      for (const event of events) {
        trace.write({
          dir: "internal",
          stage: "mapped_event",
          type: event.type,
          payload: event,
          meta: { sourceType: method },
        })
        this.eventChannel?.push(event)
      }

      // Gemini reliably emits `available_commands_update` right after
      // `streamHistory` finishes (see the Gemini CLI loadSession handler).
      // Use it as the end-of-replay signal instead of waiting for the
      // safety-net timer.
      if (this.replayMode) {
        const update = (params as AcpSessionUpdateParams | undefined)?.update as
          | { sessionUpdate?: string }
          | undefined
        if (update?.sessionUpdate === "available_commands_update") {
          this.finalizeReplay("available_commands_update")
        }
      }
      return
    }

    if (method === "config_option_update") {
      this.handleConfigOptionUpdate(params)
      return
    }

    // Unknown notification — pass through
    log.warn("Unhandled ACP notification", { method })
    this.eventChannel?.push({
      type: "backend_specific",
      backend: "acp",
      data: { method, params },
    })
  }

  // -----------------------------------------------------------------------
  // Private: Handle config option updates from agent
  // -----------------------------------------------------------------------

  private handleConfigOptionUpdate(params: unknown): void {
    const update = params as AcpConfigOptionUpdateNotification | undefined
    if (!update?.configOption) return

    const option = update.configOption
    log.info("ACP config option updated by agent", { id: option.id, value: option.value })

    // Update our stored config options
    const idx = this.discoveredConfigOptions.findIndex(o => o.id === option.id)
    if (idx >= 0) {
      this.discoveredConfigOptions[idx] = option
    } else {
      this.discoveredConfigOptions.push(option)
    }

    // Emit refreshed config options list to update TUI state
    this.emitConfigOptions()

    // Map to AgentEvents based on the option type — check category first
    if (option.category === "model" || option.id === "model" || option.name.toLowerCase().includes("model")) {
      const model = String(option.value)
      this.currentModel = model
      this.eventChannel?.push({ type: "model_changed", model })
    } else if (
      option.category === "thought_level" ||
      option.id === "thinking" ||
      option.name.toLowerCase().includes("thinking") ||
      option.name.toLowerCase().includes("effort")
    ) {
      const effort = String(option.value)
      if (["low", "medium", "high", "max"].includes(effort)) {
        this.eventChannel?.push({
          type: "effort_changed",
          effort: effort as EffortLevel,
        })
      }
    } else {
      // Unknown config option — pass through as backend_specific
      this.eventChannel?.push({
        type: "backend_specific",
        backend: "acp",
        data: { type: "config_option_update", option },
      })
    }
  }

  // -----------------------------------------------------------------------
  // Private: Handle server-initiated requests
  // -----------------------------------------------------------------------

  private handleServerRequest(
    rpcId: number | string,
    method: string,
    params: any,
  ): void {
    if (this.closed) return
    log.info("ACP server request", { method, rpcId })
    trace.write({
      dir: "internal",
      stage: "adapter_event",
      type: "server_request",
      payload: { rpcId, method, params },
    })

    switch (method) {
      case "session/request_permission": {
        const permParams = params as AcpPermissionRequestParams
        const toolCallId = permParams.toolCall?.toolCallId ?? String(rpcId)
        const toolCall = permParams.toolCall as Record<string, unknown> | undefined
        const kind = typeof toolCall?.kind === "string" ? toolCall.kind : undefined
        const title = typeof toolCall?.title === "string" ? toolCall.title : undefined
        const toolName = deriveToolName(kind, title)
        const locations = Array.isArray(toolCall?.locations) ? toolCall.locations : []
        const blockedPath = typeof locations[0]?.path === "string" ? locations[0].path : undefined

        this.pendingApprovals.set(toolCallId, { rpcId, params: permParams })

        this.eventChannel?.push({
          type: "permission_request",
          id: toolCallId,
          tool: toolName,
          input: permParams.toolCall,
          title: `${this.agentName}: ${title ?? toolName}`,
          description: permParams.options?.map(o => o.name).join(" / "),
          blockedPath,
        })
        break
      }

      case "terminal/create": {
        const p = params as AcpTerminalCreateParams
        try {
          const terminalId = this.terminalManager.create(
            p.command, p.args, p.cwd, p.env, p.timeout,
          )
          this.transport?.respond(rpcId, { terminalId })

          // Build display command string
          const displayCommand = p.args?.length
            ? `${p.command} ${p.args.join(" ")}`
            : p.command

          // Emit shell_start so the TUI shows a shell block
          this.eventChannel?.push({
            type: "shell_start",
            id: terminalId,
            command: displayCommand,
          })
        } catch (err) {
          this.transport?.respondError(rpcId, -32603, `Failed to create terminal: ${String(err)}`)
        }
        break
      }

      case "terminal/output": {
        const p = params as AcpTerminalOutputParams
        const result = this.terminalManager.getOutput(p.terminalId)
        this.transport?.respond(rpcId, result)
        break
      }

      case "terminal/wait_for_exit": {
        const p = params as AcpTerminalWaitParams
        ;(async () => {
          try {
            const exitCode = await this.terminalManager.waitForExit(p.terminalId)
            this.transport?.respond(rpcId, { exitCode })

            // Emit shell_end with accumulated output
            const { output } = this.terminalManager.getOutput(p.terminalId)
            if (!this.closed) {
              this.eventChannel?.push({
                type: "shell_end",
                id: p.terminalId,
                output,
                exitCode,
                error: exitCode !== 0 ? `Process exited with code ${exitCode}` : undefined,
              })
            }
          } catch (err) {
            this.transport?.respondError(rpcId, -32603, `Wait failed: ${String(err)}`)
          }
        })()
        break
      }

      case "terminal/kill": {
        const p = params as AcpTerminalKillParams
        this.terminalManager.kill(p.terminalId, p.signal)
        this.transport?.respond(rpcId, {})
        break
      }

      case "terminal/release": {
        const p = params as AcpTerminalReleaseParams
        this.terminalManager.release(p.terminalId)
        this.transport?.respond(rpcId, {})
        break
      }

      case "session/elicitation": {
        const elicParams = params as AcpElicitationParams
        const elicId = String(rpcId)

        // Store the pending elicitation for response matching
        this.pendingElicitations.set(elicId, { rpcId })

        // Map ACP schema to ElicitationQuestion[] format
        const questions = this.mapElicitationQuestions(elicParams)

        this.eventChannel?.push({
          type: "elicitation_request",
          id: elicId,
          questions,
        })
        break
      }

      case "fs/read_text_file": {
        const p = params as AcpFsReadParams
        this.handleFsRead(rpcId, p)
        break
      }

      case "fs/write_text_file": {
        const p = params as AcpFsWriteParams
        this.handleFsWrite(rpcId, p)
        break
      }

      default:
        log.warn("Unhandled ACP server request", { method })
        this.transport?.respondError(rpcId, -32601, `Method not supported: ${method}`)
    }
  }

  // -----------------------------------------------------------------------
  // Private: Elicitation helpers
  // -----------------------------------------------------------------------

  private mapElicitationQuestions(params: AcpElicitationParams): ElicitationQuestion[] {
    const questions: ElicitationQuestion[] = []

    // The message itself is always a question
    if (params.message) {
      questions.push({
        question: params.message,
        options: [],
        allowFreeText: true,
      })
    }

    // Map schema properties to additional questions
    if (params.schema?.properties) {
      for (const [key, prop] of Object.entries(params.schema.properties)) {
        const options: ElicitationOption[] = []
        if (prop.enum) {
          for (const value of prop.enum) {
            options.push({ label: value })
          }
        } else if (prop.type === "boolean") {
          options.push({ label: "true" }, { label: "false" })
        }

        questions.push({
          question: prop.description ?? key,
          header: key.length <= 12 ? key : undefined,
          options,
          allowFreeText: prop.type === "string" || prop.type === "number",
          multiSelect: false,
        })
      }
    }

    return questions
  }

  // -----------------------------------------------------------------------
  // Private: Filesystem handlers
  // -----------------------------------------------------------------------

  private async handleFsRead(rpcId: number | string, params: AcpFsReadParams): Promise<void> {
    const { path: filePath, line, limit } = params

    // Security: validate path is within the session's working directory.
    // Fall back to process.cwd() only when the adapter was constructed
    // without a SessionConfig (older tests); production callers always
    // supply `config.cwd`.
    const cwd = this.config?.cwd ?? process.cwd()
    const check = validatePathWithinCwd(filePath, cwd)
    if (!check.valid) {
      log.warn("ACP fs/read_text_file blocked: path outside cwd", { path: filePath, cwd })
      this.transport?.respondError(rpcId, -32602, check.error!)
      return
    }

    try {
      const fs = await import("fs/promises")
      const content = await fs.readFile(check.resolved, "utf-8")

      // Apply line/limit filtering if specified
      if (line !== undefined || limit !== undefined) {
        const lines = content.split("\n")
        const startLine = (line ?? 1) - 1  // 1-indexed
        const endLine = limit ? startLine + limit : lines.length
        const sliced = lines.slice(Math.max(0, startLine), endLine).join("\n")
        this.transport?.respond(rpcId, { content: sliced })
      } else {
        this.transport?.respond(rpcId, { content })
      }

      log.info("ACP fs/read_text_file", { path: filePath })
    } catch (err: any) {
      if (err.code === "ENOENT") {
        this.transport?.respondError(rpcId, -32602, `File not found: ${filePath}`)
      } else if (err.code === "EACCES") {
        this.transport?.respondError(rpcId, -32602, `Permission denied: ${filePath}`)
      } else {
        this.transport?.respondError(rpcId, -32603, `Read failed: ${String(err)}`)
      }
    }
  }

  private async handleFsWrite(rpcId: number | string, params: AcpFsWriteParams): Promise<void> {
    const { path: filePath, content } = params

    // Security: validate path is within the session's working directory.
    // Fall back to process.cwd() only when the adapter was constructed
    // without a SessionConfig (older tests); production callers always
    // supply `config.cwd`.
    const cwd = this.config?.cwd ?? process.cwd()
    const check = validatePathWithinCwd(filePath, cwd)
    if (!check.valid) {
      log.warn("ACP fs/write_text_file blocked: path outside cwd", { path: filePath, cwd })
      this.transport?.respondError(rpcId, -32602, check.error!)
      return
    }

    try {
      const fs = await import("fs/promises")
      // Ensure parent directory exists
      await fs.mkdir(nodePath.dirname(check.resolved), { recursive: true })
      await fs.writeFile(check.resolved, content, "utf-8")
      this.transport?.respond(rpcId, {})
      log.info("ACP fs/write_text_file", { path: filePath })
    } catch (err: any) {
      this.transport?.respondError(rpcId, -32603, `Write failed: ${String(err)}`)
    }
  }
}
