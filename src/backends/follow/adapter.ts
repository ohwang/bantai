/**
 * FollowBackend — read-only adapter that tails a live Claude JSONL session.
 *
 * Scope marker: this is an EXPERIMENT. Claude-backend only, same-host only,
 * read-only. See `team/bantai-follow-tui.md` for the full design.
 *
 * Wiring (this is the item-1 skeleton — tailer and translator are landed in
 * subsequent commits; until then `resume()` emits a session_init + an error
 * event so the TUI surfaces a clear "not implemented" message instead of
 * hanging):
 *
 * - `start(config)` / `resume(id)` open the JSONL at `~/.claude/projects/.../<id>.jsonl`,
 *   replay existing entries through the translator, then tail via fs.watch.
 * - Write-side methods (sendMessage, interrupt, approveToolUse, …) all no-op
 *   with a `system_message` warning so the user cannot accidentally mutate
 *   the source session. `setModel` / `setPermissionMode` / `setEffort` reject.
 *
 * The adapter deliberately does NOT extend `BaseAdapter`:
 * - BaseAdapter's message loop pulls from a queue; follow has no queue.
 * - BaseAdapter's readiness promise expects the adapter to accept messages;
 *   follow is read-only.
 * Rolling our own tiny lifecycle keeps the read-only intent obvious at the
 * class level.
 */

import type {
  AgentBackend,
  BackendCapabilities,
  ConversationEvent,
  EffortLevel,
  ForkOptions,
  ModelInfo,
  PermissionMode,
  SessionConfig,
  SessionInfo,
  UserMessage,
} from "../../protocol/types"
import { EventChannel } from "../../utils/event-channel"
import { log } from "../../utils/logger"

export interface FollowBackendOptions {
  /** Claude session ID to follow (UUID). */
  sessionId: string
  /** Caller's cwd — used as the first hint for locating the JSONL. The
   *  adapter falls back to scanning every project directory if the file is
   *  not present under this cwd's encoded key. */
  cwd?: string
}

export class FollowBackend implements AgentBackend {
  private readonly sessionId: string
  private readonly cwd: string
  private eventChannel: EventChannel<ConversationEvent> | null = null
  private closed = false

  constructor(opts: FollowBackendOptions) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd ?? process.cwd()
  }

  capabilities(): BackendCapabilities {
    return {
      name: "follow",
      supportsThinking: false,
      supportsToolApproval: false,
      supportsResume: true,
      supportsContinue: false,
      supportsFork: false,
      // No streaming deltas: Claude's JSONL is only written at whole-message
      // granularity, so the translator emits `text_complete` instead of
      // `text_delta`. Users will not see typing-in-progress.
      supportsStreaming: false,
      supportsSubagents: false,
      supportsCompact: true,
      supportedPermissionModes: ["default"],
    }
  }

  // ---------------------------------------------------------------------------
  // start / resume — both funnel into the same read-only tail loop. FollowBackend
  // has no concept of "fresh session"; every invocation resumes the named JSONL.
  // ---------------------------------------------------------------------------

  async *start(_config: SessionConfig): AsyncGenerator<ConversationEvent> {
    yield* this.resume(this.sessionId)
  }

  async *resume(sessionId: string): AsyncGenerator<ConversationEvent> {
    this.eventChannel = new EventChannel<ConversationEvent>()
    this.runSession(sessionId).finally(() => {
      this.eventChannel?.close()
    })
    yield* this.eventChannel[Symbol.asyncIterator]()
  }

  private async runSession(sessionId: string): Promise<void> {
    // Skeleton: emit session_init with an empty toolset so the TUI transitions
    // to IDLE, then surface a clear error. The real replay+tail loop lands in
    // items 3-5; this keeps the adapter resolvable for item 1 (CLI wiring).
    this.eventChannel?.push({
      type: "session_init",
      sessionId,
      tools: [],
      models: [],
    })
    log.warn("FollowBackend.runSession — tail loop not implemented yet", {
      sessionId,
      cwd: this.cwd,
    })
    this.eventChannel?.push({
      type: "error",
      code: "follow_not_implemented",
      message:
        "Follow mode is still being built — the JSONL tailer has not yet been wired up.",
      severity: "fatal",
    })
  }

  // ---------------------------------------------------------------------------
  // Write-side methods — all no-op with a visible banner. The TUI's read-only
  // gating should prevent most of these from firing in the first place, but
  // keeping them defensive means a stray send never corrupts the source
  // session.
  // ---------------------------------------------------------------------------

  sendMessage(_message: UserMessage): void {
    this.warnReadOnly("sendMessage")
  }

  interrupt(): void {
    this.warnReadOnly("interrupt")
  }

  approveToolUse(_id: string): void {
    this.warnReadOnly("approveToolUse")
  }

  denyToolUse(_id: string): void {
    this.warnReadOnly("denyToolUse")
  }

  respondToElicitation(_id: string, _answers: Record<string, string>): void {
    this.warnReadOnly("respondToElicitation")
  }

  cancelElicitation(_id: string): void {
    this.warnReadOnly("cancelElicitation")
  }

  async setModel(_model: string): Promise<void> {
    throw new Error("Follow mode is read-only — setModel is not supported.")
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    throw new Error(
      "Follow mode is read-only — setPermissionMode is not supported.",
    )
  }

  async setEffort(_level: EffortLevel): Promise<void> {
    throw new Error("Follow mode is read-only — setEffort is not supported.")
  }

  async availableModels(): Promise<ModelInfo[]> {
    return []
  }

  async listSessions(): Promise<SessionInfo[]> {
    return []
  }

  async forkSession(
    _sessionId: string,
    _options?: ForkOptions,
  ): Promise<string> {
    throw new Error("Follow mode is read-only — forkSession is not supported.")
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.eventChannel?.close()
    this.eventChannel = null
  }

  private warnReadOnly(method: string): void {
    log.warn("Ignoring write-side call on FollowBackend", { method })
    this.eventChannel?.push({
      type: "system_message",
      text: "Read-only follow session — use the originating frontend (Slack) to interact.",
      ephemeral: true,
    })
  }
}

/** Convenience factory so call sites don't need to know the class name. */
export function createFollowBackend(opts: FollowBackendOptions): FollowBackend {
  return new FollowBackend(opts)
}
