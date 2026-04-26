/**
 * FollowBackend — read-only adapter that tails a live Claude JSONL session.
 *
 * Scope marker: this is an EXPERIMENT. Claude-backend only, same-host only,
 * read-only. See `team/bantai-follow-tui.md` for the full design.
 *
 * Pipeline:
 *   1. `resume(id)` (or `start(config)`) resolves the session's JSONL
 *      location via findClaudeSessionFileAnywhere — the caller's cwd is a
 *      hint, but the scan covers every project directory.
 *   2. Emits a synthetic `session_init` as the first event (contract
 *      requirement) and a `history_load_started` SystemEvent so the TUI
 *      can render a "loading…" state.
 *   3. Hands the JSONL to JsonlTailer. Every line that arrives — both
 *      initial replay and live tail — is JSON.parsed and passed through
 *      `eventsFromJsonlEntry` via a shared TranslatorState.
 *   4. After the initial replay drains, emits `history_loaded` so the TUI
 *      stops showing the spinner and drops the session-resume summary.
 *   5. Live appends flow through the same translator, so the follower's
 *      rendering is byte-identical to what the resume path produces.
 *
 * Write-side methods are no-ops with a visible `system_message` so a stray
 * call can never mutate the source session. `setModel`, `setPermissionMode`,
 * and `setEffort` reject outright — the follow UI should never surface
 * controls for them, but belt-and-braces.
 *
 * The adapter deliberately does NOT extend `BaseAdapter`:
 *   - BaseAdapter owns a message queue and a "ready for user input" promise,
 *     both of which are meaningless for a read-only follower.
 *   - Rolling our own tiny lifecycle keeps the read-only intent obvious at
 *     the class level and avoids having to plumb around pieces that don't
 *     apply.
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
  SessionResumeSummary,
  UserMessage,
} from "../../protocol/types"
import { DEFAULT_CAPABILITIES } from "../../protocol/capabilities"
import { EventChannel } from "../../utils/event-channel"
import { log } from "../../utils/logger"
import { readSessionHistory } from "../claude/session-reader"
import { findClaudeSessionFileAnywhere } from "./find-session"
import { JsonlTailer } from "./jsonl-tailer"
import {
  createTranslatorState,
  eventsFromJsonlEntry,
  type TranslatorState,
} from "./event-from-jsonl"

export interface FollowBackendOptions {
  /** Claude session ID to follow (UUID). */
  sessionId: string
  /** Caller's cwd — used as a hint for locating the JSONL. The adapter
   *  falls back to scanning every project directory if the file is not
   *  present under this cwd's encoded key. */
  cwd?: string
}

export class FollowBackend implements AgentBackend {
  private readonly sessionId: string
  private readonly cwd: string
  private eventChannel: EventChannel<ConversationEvent> | null = null
  private tailer: JsonlTailer | null = null
  private translatorState: TranslatorState = createTranslatorState()
  private closed = false

  constructor(opts: FollowBackendOptions) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd ?? process.cwd()
  }

  capabilities(): BackendCapabilities {
    // Follow is read-only — it tails an existing JSONL, never spawns the
    // SDK. Most flags are false; permission modes stay locked to "default"
    // because switching modes during a passive tail is a no-op.
    return {
      ...DEFAULT_CAPABILITIES,
      name: "follow",
      supportsResume: true,
      // No streaming deltas: Claude's JSONL is only written at whole-
      // message granularity, so the translator emits `text_complete`
      // instead of `text_delta`. Users will not see typing-in-progress.
      supportsStreaming: false,
      supportsCompact: true,
      // Override the registry default — follow can't enforce or change
      // modes mid-tail, so locking to "default" is honest.
      supportedPermissionModes: ["default"],
    } satisfies BackendCapabilities
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
    this.runSession(sessionId).catch((err) => {
      log.error("FollowBackend runSession rejected unexpectedly", {
        error: err instanceof Error ? err.message : String(err),
      })
      this.eventChannel?.push({
        type: "error",
        code: "follow_fatal",
        message: `follow backend failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        severity: "fatal",
      })
      this.eventChannel?.close()
    })
    yield* this.eventChannel[Symbol.asyncIterator]()
  }

  private async runSession(sessionId: string): Promise<void> {
    // Step 1: find the JSONL. If we can't, surface a clear error and stop.
    const found = findClaudeSessionFileAnywhere(sessionId, this.cwd)
    if (!found) {
      this.emitSessionInit(sessionId)
      this.eventChannel?.push({
        type: "error",
        code: "follow_not_found",
        message:
          `No Claude session file for ID ${sessionId}. ` +
          `Checked ~/.claude/projects/* — run 'bantai resume' inside the originating repo if you're not sure which cwd it was created under.`,
        severity: "fatal",
      })
      this.eventChannel?.close()
      return
    }
    log.info("FollowBackend located session JSONL", {
      sessionId,
      path: found.path,
      cwd: found.cwd,
    })

    // Step 2: mandatory session_init first, so the contract holds.
    this.emitSessionInit(sessionId)

    // Step 3: history_load_started so the TUI shows a spinner while we
    // replay. The matching history_loaded is emitted once the initial
    // JSONL read drains (the tailer transitions to live-watch mode
    // synchronously inside start()).
    this.eventChannel?.push({
      type: "history_load_started",
      sessionId,
      filePath: found.path,
      origin: "claude",
    })

    // Step 4: parse the session once to build the SessionResumeSummary —
    // token usage, turn counts, etc. readSessionHistory knows the rules
    // for that aggregate; we only want its `summary` here. The blocks it
    // produces are discarded because the translator will rebuild them via
    // events (reducer is the single source of truth).
    const { summary } = safeReadSessionSummary(sessionId, found.cwd)

    // Step 5: install the tailer. Every line — replay and live — funnels
    // through the same translator so the follower's rendering matches a
    // live session.
    this.tailer = new JsonlTailer({
      path: found.path,
      onLine: (line) => this.handleLine(line),
      onEnd: (reason, err) => this.handleTailerEnd(reason, err),
    })

    let replayCount = 0
    try {
      replayCount = this.tailer.start().replayedLines
    } catch (err) {
      log.error("FollowBackend tailer.start() threw", {
        error: err instanceof Error ? err.message : String(err),
      })
      this.eventChannel?.push({
        type: "history_load_failed",
        sessionId,
        filePath: found.path,
        origin: "claude",
        error: "Failed to start JSONL tailer",
        details: err instanceof Error ? err.stack : String(err),
      })
      this.eventChannel?.close()
      return
    }

    // Step 6: close out the replay. If the last entry left a turn open
    // (e.g. a synthetic user prompt whose assistant half hasn't arrived
    // yet), the reducer will continue treating subsequent events as
    // mid-turn — that's exactly what we want for live tail, so don't
    // force-close here.
    this.eventChannel?.push({
      type: "history_loaded",
      sessionId,
      origin: "claude",
      target: "follow",
      summary,
    })
    log.info("FollowBackend replay complete", {
      sessionId,
      replayedLines: replayCount,
    })

    // Generator parks here — new events arrive via handleLine. close()
    // closes the channel which ends the outer for-await-of in sync.tsx.
  }

  private emitSessionInit(sessionId: string): void {
    this.eventChannel?.push({
      type: "session_init",
      sessionId,
      tools: [],
      models: [],
    })
  }

  private handleLine(line: string): void {
    if (this.closed) return
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch (err) {
      log.warn("FollowBackend could not parse JSONL line — skipping", {
        snippet: line.slice(0, 80),
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    const events = eventsFromJsonlEntry(entry, this.translatorState)
    for (const event of events) {
      if (this.closed) break
      this.eventChannel?.push(event)
    }
  }

  private handleTailerEnd(reason: "rename" | "error", err?: unknown): void {
    if (this.closed) return
    log.info("FollowBackend tailer ended", { reason })
    if (reason === "error") {
      this.eventChannel?.push({
        type: "error",
        code: "follow_tailer_error",
        message: `JSONL tailer failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        severity: "fatal",
      })
    } else {
      this.eventChannel?.push({
        type: "system_message",
        text: "Source session file was moved or deleted — follow ended.",
        ephemeral: false,
      })
    }
    this.eventChannel?.close()
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
    if (this.tailer) {
      try {
        this.tailer.close()
      } catch {
        /* best-effort */
      }
      this.tailer = null
    }
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

/**
 * Read the session summary once for the history_loaded payload. If the
 * reader throws (rare; it already catches file-not-found), fall back to
 * a zeroed summary rather than aborting — the follower can still render
 * incoming events, the summary block will just be empty.
 */
function safeReadSessionSummary(
  sessionId: string,
  cwd: string,
): { summary: SessionResumeSummary } {
  try {
    const parsed = readSessionHistory(sessionId, cwd)
    return { summary: { ...parsed.summary, target: "follow" } }
  } catch (err) {
    log.warn("FollowBackend summary read failed — using empty summary", {
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      summary: {
        sessionId,
        origin: "claude",
        target: "follow",
        messageCount: 0,
        toolCallCount: 0,
        turnCount: 0,
      },
    }
  }
}
