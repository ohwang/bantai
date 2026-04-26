/**
 * SubagentManager — orchestrates native cross-backend subagents.
 *
 * Each subagent is an independent AgentBackend instance with its own process
 * and session. The manager consumes each child's event stream and re-emits
 * filtered events into the parent's pipeline via pushEvent().
 *
 * All re-emitted events carry the subagent's subagentId (mapped to taskId
 * at the event boundary), ensuring clean scoping when many subagents run
 * concurrently.
 */

import { instantiateBackend } from "../protocol/registry"
import { log } from "../utils/logger"
import type { AgentEvent, SessionConfig } from "../protocol/types"
import type { SpawnOptions, SubagentStatus, RunningSubagent } from "./types"

const MAX_RECENT_TOOLS = 5
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000
const TEXT_PROGRESS_THROTTLE_MS = 500

export class SubagentManager {
  private subagents = new Map<string, RunningSubagent>()
  private pushEvent: ((event: AgentEvent) => void) | null = null
  private nextId = 1
  private lastTextProgressTime = new Map<string, number>()

  /** Wire up the event relay. Called by SyncProvider on mount. */
  setPushEvent(fn: (event: AgentEvent) => void): void {
    this.pushEvent = fn
  }

  /**
   * Spawn a new subagent. Returns the subagentId immediately.
   * The backend starts asynchronously in the background.
   */
  spawn(opts: SpawnOptions): string {
    const subagentId = `subagent-${this.nextId++}`
    const def = opts.definition
    const backendName = opts.backendOverride ?? def.backend ?? "claude"

    const backend = instantiateBackend(backendName, {
      acpCommand: def.acpCommand,
      acpArgs: def.acpArgs,
    })

    const status: SubagentStatus = {
      subagentId,
      definitionName: def.name,
      backendName,
      state: "running",
      description: def.description ?? def.name,
      output: "",
      startTime: Date.now(),
      turnCount: 0,
      toolUseCount: 0,
      thinkingActive: false,
      activeTurn: false,
      recentTools: [],
    }

    let resolveCompletion!: (status: SubagentStatus) => void
    const completion = new Promise<SubagentStatus>((resolve) => {
      resolveCompletion = resolve
    })

    const running: RunningSubagent = {
      subagentId,
      definition: def,
      status,
      backend,
      messageQueue: [],
      midTurn: false,
      completion,
      resolveCompletion,
    }

    this.subagents.set(subagentId, running)

    this.emit({
      type: "task_start",
      taskId: subagentId,
      description: status.description,
      source: "native",
      backendName,
      model: opts.modelOverride ?? def.model,
    } as AgentEvent)

    // Subagents default to bypassPermissions because multi-requestor
    // permission flows are not supported — permission_request events from
    // children are auto-denied (see switch case below). Setting a stricter
    // mode on a definition is allowed but effectively a no-op since requests
    // would still be auto-denied rather than surfaced to the user.
    const config: SessionConfig = {
      model: opts.modelOverride ?? def.model,
      permissionMode: def.permissionMode ?? "bypassPermissions",
      maxTurns: def.maxTurns,
      cwd: opts.cwd ?? process.cwd(),
      systemPrompt: def.systemPrompt,
      persistSession: true,
      effort: def.effort,
      allowedTools: def.tools,
      disallowedTools: def.disallowedTools,
    }

    const startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.startEventLoop(running, config, opts.prompt, startupTimeoutMs).catch((err) => {
      log.error("Subagent event loop failed", { subagentId, error: String(err) })
      this.completeSubagent(running, "error", String(err))
    })

    log.info("Subagent spawned", { subagentId, name: def.name, backend: backendName })
    return subagentId
  }

  /** Send a follow-up message to a running subagent. */
  sendMessage(subagentId: string, text: string): void {
    const running = this.subagents.get(subagentId)
    if (!running || running.status.state !== "running") return

    if (running.midTurn) {
      running.messageQueue.push(text)
    } else {
      running.backend.sendMessage({ text })
    }
  }

  /** Get status of a specific subagent. */
  getStatus(subagentId: string): SubagentStatus | undefined {
    return this.subagents.get(subagentId)?.status
  }

  /** List all subagent statuses. */
  listAll(): SubagentStatus[] {
    return Array.from(this.subagents.values()).map((r) => r.status)
  }

  /** Stop a running subagent. */
  stop(subagentId: string): void {
    const running = this.subagents.get(subagentId)
    if (!running || running.status.state !== "running") return
    this.completeSubagent(running, "completed")
    log.info("Subagent stopped", { subagentId })
  }

  /** Wait for a subagent to finish. Returns null if unknown, or the final status. */
  waitForCompletion(subagentId: string, timeoutMs?: number): Promise<SubagentStatus | null> {
    const running = this.subagents.get(subagentId)
    if (!running) return Promise.resolve(null)
    if (running.status.state !== "running") return Promise.resolve(running.status)

    if (timeoutMs == null) return running.completion

    return Promise.race([
      running.completion,
      new Promise<SubagentStatus>((resolve) =>
        setTimeout(() => resolve(running.status), timeoutMs),
      ),
    ])
  }

  /** Shut down all subagents. Called during app cleanup. */
  closeAll(): void {
    for (const running of this.subagents.values()) {
      if (running.status.state === "running") {
        this.completeSubagent(running, "error", "Session ended")
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Single completion path for all terminal transitions. Sets status,
   * closes the backend, emits task_complete, and resolves waiters.
   */
  private completeSubagent(
    running: RunningSubagent,
    state: "completed" | "error",
    errorMessage?: string,
  ): void {
    if (running.status.state !== "running") return

    // Surface silent message loss: if the local follow-up queue still has
    // items when the subagent terminates, those messages will never be
    // delivered. Warn loudly so it's visible in session logs instead of
    // silently dropped (per project's "never silently drop" convention).
    if (running.messageQueue.length > 0) {
      log.warn("Subagent terminated with queued messages dropped", {
        subagentId: running.subagentId,
        state,
        droppedCount: running.messageQueue.length,
        droppedPreview: running.messageQueue.map((m) => m.slice(0, 80)),
      })
    }

    running.status.state = state
    running.status.endTime = Date.now()
    if (errorMessage) running.status.errorMessage = errorMessage
    running.backend.close()
    this.lastTextProgressTime.delete(running.subagentId)

    this.emit({
      type: "task_complete",
      taskId: running.subagentId,
      output: running.status.output,
      state,
      errorMessage,
    } as AgentEvent)

    running.resolveCompletion(running.status)

    if (state === "error") {
      log.error("Subagent error", { subagentId: running.subagentId, error: errorMessage })
    }
  }

  private async startEventLoop(
    running: RunningSubagent,
    config: SessionConfig,
    initialPrompt: string,
    startupTimeoutMs: number,
  ): Promise<void> {
    const { subagentId, backend } = running
    log.info("Subagent starting backend", { subagentId, backend: running.status.backendName, model: config.model, cwd: config.cwd })
    const gen = backend.start(config)
    log.info("Subagent backend generator created", { subagentId })

    // Send prompt before waiting for session_init — Claude SDK's query() is
    // lazy and won't emit session_init until the message iterable yields.
    backend.sendMessage({ text: initialPrompt })
    log.info("Subagent initial prompt sent", { subagentId })

    let sessionInitReceived = false
    const startupTimeout = setTimeout(() => {
      if (!sessionInitReceived && running.status.state === "running") {
        log.error("Subagent startup timeout", { subagentId })
        this.completeSubagent(
          running,
          "error",
          `Subagent failed to initialize within ${startupTimeoutMs / 1000}s. The backend may require a TTY or have authentication issues.`,
        )
      }
    }, startupTimeoutMs)

    let firstEventReceived = false
    try {
      for await (const event of gen) {
        if (!firstEventReceived) {
          firstEventReceived = true
          log.info("Subagent received first event", { subagentId, type: event.type })
        }
        if (running.status.state !== "running") break

        switch (event.type) {
          case "session_init":
            sessionInitReceived = true
            clearTimeout(startupTimeout)
            running.status.sessionId = event.sessionId
            log.info("Subagent session initialized", { subagentId, sessionId: event.sessionId })
            break

          case "turn_start":
            running.midTurn = true
            running.status.activeTurn = true
            this.emitProgress(running)
            log.debug("Subagent turn started", { subagentId })
            break

          case "text_delta": {
            running.status.output += event.text
            const now = Date.now()
            const lastEmit = this.lastTextProgressTime.get(subagentId) ?? 0
            if (now - lastEmit >= TEXT_PROGRESS_THROTTLE_MS) {
              this.lastTextProgressTime.set(subagentId, now)
              this.emitProgress(running)
            }
            break
          }

          case "text_complete":
            running.status.output = event.text
            this.emitProgress(running)
            break

          case "thinking_delta":
            running.status.thinkingActive = true
            this.emitProgress(running)
            break

          case "tool_use_start":
            running.status.toolUseCount++
            running.status.lastToolName = event.tool
            running.status.recentTools = [
              ...running.status.recentTools.slice(-(MAX_RECENT_TOOLS - 1)),
              event.tool,
            ]
            this.emitProgress(running)
            break

          case "tool_use_end":
            log.debug("Subagent tool use ended", { subagentId, id: event.id })
            break

          case "turn_complete":
            running.status.turnCount++
            running.status.thinkingActive = false
            running.status.activeTurn = false
            running.midTurn = false
            if (running.messageQueue.length > 0) {
              const msg = running.messageQueue.shift()!
              backend.sendMessage({ text: msg })
            } else {
              log.info("Subagent turn complete with no follow-ups, completing", { subagentId, turnCount: running.status.turnCount })
              this.completeSubagent(running, "completed")
            }
            this.emitProgress(running)
            break

          case "cost_update":
            running.status.tokenUsage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
            }
            break

          case "permission_request":
            log.warn("Subagent permission request auto-denied (multi-requestor not supported)", {
              subagentId,
              tool: event.tool,
            })
            backend.denyToolUse(event.id, "Subagent permissions not supported")
            break

          case "elicitation_request":
            log.warn("Subagent elicitation request auto-dismissed (multi-requestor not supported)", {
              subagentId,
            })
            backend.cancelElicitation(event.id)
            break

          case "error":
            clearTimeout(startupTimeout)
            this.completeSubagent(running, "error", event.message)
            return

          default:
            log.debug("Subagent event ignored", { subagentId, type: event.type })
            break
        }
      }
    } catch (err) {
      clearTimeout(startupTimeout)
      if (running.status.state === "running") {
        this.completeSubagent(running, "error", String(err))
      }
      return
    }

    clearTimeout(startupTimeout)
    log.info("Subagent event loop exited", { subagentId, eventsReceived: firstEventReceived, state: running.status.state })

    if (running.status.state === "running") {
      this.completeSubagent(running, "completed")
      log.info("Subagent completed", { subagentId })
    }
  }

  private emitProgress(running: RunningSubagent): void {
    this.emit({
      type: "task_progress",
      taskId: running.subagentId,
      output: running.status.output,
      lastToolName: running.status.lastToolName,
      turnCount: running.status.turnCount,
      toolUseCount: running.status.toolUseCount,
      tokenUsage: running.status.tokenUsage,
      thinkingActive: running.status.thinkingActive,
      activeTurn: running.status.activeTurn,
      recentTools: running.status.recentTools,
    } as AgentEvent)
  }

  private emit(event: AgentEvent): void {
    if (this.pushEvent) {
      this.pushEvent(event)
    }
  }
}
