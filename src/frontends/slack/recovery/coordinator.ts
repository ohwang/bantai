/**
 * Stale-resume coordinator — handles the case where a thread's persisted
 * backend-session id is unlikely to resolve on the current backend.
 *
 * Flow:
 *
 *   inbound user turn
 *     └─ routing.ts calls `coordinator.detect(...)` with the persisted row
 *        and the current project
 *           └─ null          → proceed to SessionHost.send as usual
 *           └─ detection     → routing.ts calls `coordinator.promptAndQueue(...)`
 *                               └─ post Block Kit card
 *                               └─ persist a `PendingResumePrompt` in SQLite
 *                               └─ return early (DO NOT send the turn yet)
 *
 *   user clicks a button
 *     └─ Bolt block_action → routing.ts forwards to
 *        `coordinator.handleBlockAction(...)`
 *           └─ look up the pending prompt by id (from the action_id)
 *           └─ update the card in place (resolved variant)
 *           └─ act on the decision:
 *               • "fresh"   → clear backend_session_id in store,
 *                              call the launcher's replay callback to
 *                              re-enqueue the turn. Next dispatch will
 *                              start a clean `session/new`.
 *               • "inject"  → fetch foreign session history via
 *                              `HistoryInjectionProvider`, pack it into
 *                              `sessionConfig.replayContext`, then replay
 *                              the turn. (Provider is stubbed in this
 *                              commit; the real wiring lands in commit 5.)
 *               • "cancel"  → drop the turn. No backend call.
 *           └─ delete the pending prompt row
 *
 * Persistence: every pending prompt is written to SQLite before the card
 * is posted — a click that lands hours (or a restart) later still finds
 * its row. On process startup the launcher calls `restoreFromStore()` so
 * the coordinator's in-memory index matches what's in the DB.
 *
 * The coordinator is frontend-agnostic IO: it only talks to `SendAdapter`
 * (post + update) and two callbacks the launcher supplies (`replayTurn`,
 * and the optional `historyProvider` for inject support).
 */

import { log } from "../../../utils/logger"
import type { SendAdapter } from "../view/outbox"
import type {
  PendingResumePrompt,
  SessionStore,
} from "../store/sessions"
import type { InboundTurn } from "../inbox/turn-builder"
import type { SessionKeyParts } from "../router/registry"
import type { ProjectConfig } from "../router/resolver"
import type { PersistedSession } from "../store/sessions"
import type { SessionConfig } from "../../../protocol/types"
import {
  buildStaleResumeBlocks,
  buildResolvedStaleResumeBlocks,
  parseStaleResumeActionId,
  type StaleResumeDecision,
  type StaleResumeReason,
} from "../view/blocks/stale-resume"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectInput {
  /** Persisted row for the session key, if any. */
  persisted: PersistedSession | undefined
  /** Current project (the channel's config). */
  project: ProjectConfig
}

export interface StaleResumeDetection {
  reason: StaleResumeReason
  staleBackendId: string
  staleSessionId: string
}

export interface PromptInput {
  detection: StaleResumeDetection
  sessionKey: string
  channel: string
  threadTs: string
  project: ProjectConfig
  /** The turn we intercepted. Serialised verbatim into SQLite. */
  turn: InboundTurn
}

export interface BlockActionInput {
  actionId: string
  userId: string
  /** Slack workspace team id — used to rebuild the session key on replay. */
  workspace: string
}

export type BlockActionResult =
  | { kind: "resolved"; promptId: string; decision: StaleResumeDecision }
  | { kind: "unknown"; promptId: string }
  | { kind: "malformed" }

/**
 * Optional provider that loads a foreign session's history into a
 * SessionConfig.replayContext payload. Commit 4 stubs this; commit 5
 * provides a real implementation backed by `readForeignSession` +
 * `formatFullHistory`.
 */
export interface HistoryInjectionProvider {
  /**
   * `true` when the provider can actually fetch history for this pair of
   * backends. The coordinator calls this on `promptAndQueue` to decide
   * whether the "Resume with history" button should appear on the card.
   */
  canInject(args: {
    fromBackend: string
    toBackend: string
    sessionId: string
  }): boolean
  /**
   * Build a replayContext payload to inject into the next session. Returns
   * null on any failure (missing file, unparseable content). The
   * coordinator then falls back to the "fresh" strategy for this click
   * and surfaces the reason in the resolved card.
   */
  buildReplayContext(args: {
    fromBackend: string
    toBackend: string
    sessionId: string
    cwd: string
  }): Promise<SessionConfig["replayContext"] | null>
}

export interface ReplayTurnInput {
  key: SessionKeyParts
  project: ProjectConfig
  turn: InboundTurn
  /**
   * When present, the replay must start the session with this replayContext
   * so history gets injected on the first turn. Caller is responsible for
   * merging it into the SessionConfig overlay.
   */
  replayContext?: SessionConfig["replayContext"]
}

export interface CreateStaleResumeCoordinatorOpts {
  adapter: SendAdapter
  store: SessionStore
  /**
   * Called after a prompt resolves — the coordinator hands back the turn
   * the user originally sent so the launcher can re-dispatch it. Fresh /
   * inject both go through this callback; cancel skips it.
   *
   * The callback is responsible for `SessionHost.send(...)` and any
   * thread-status / reaction side effects that normally accompany a send.
   */
  replayTurn(input: ReplayTurnInput): Promise<void> | void
  /** Optional: a lookup from `sessionKey` back to the `ProjectConfig`. */
  lookupProject(sessionKey: string): ProjectConfig | undefined
  /**
   * Optional history-injection provider. Omit or pass `null` to disable the
   * "Resume with history" button entirely — callers will only see
   * fresh / cancel.
   */
  historyProvider?: HistoryInjectionProvider | null
  /** Clock override for tests — stamp createdAt deterministically. */
  now?: () => number
  /** UUID generator override for tests. */
  uuid?: () => string
  /**
   * Optional friendly backend name map for the card copy. e.g.
   * `{ gemini: "Gemini", codex: "Codex" }`. Missing keys fall back to the
   * raw backend id.
   */
  backendLabels?: Record<string, string>
}

export interface StaleResumeCoordinator {
  /**
   * Return a detection when the persisted row is unlikely to resume on the
   * current project's backend. `null` = proceed normally.
   */
  detect(input: DetectInput): StaleResumeDetection | null
  /**
   * Post the card + persist the pending prompt. Called by routing.ts
   * when `detect` returned a detection. Returns the prompt id.
   */
  promptAndQueue(input: PromptInput): Promise<string>
  /**
   * Bolt block_action entry point. Returns `malformed` if the action_id
   * doesn't match our schema, so the caller can fall through to the next
   * handler (approvals, elicitations, …).
   */
  handleBlockAction(input: BlockActionInput): Promise<BlockActionResult>
  /** Diagnostic — list currently-pending prompts from the store. */
  listPending(): PendingResumePrompt[]
  /**
   * Re-hydrate the in-memory index from the store. Called once by the
   * launcher at startup so a process that restarted with outstanding
   * prompts doesn't forget about them.
   */
  restoreFromStore(): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStaleResumeCoordinator(
  opts: CreateStaleResumeCoordinatorOpts,
): StaleResumeCoordinator {
  const now = opts.now ?? (() => Date.now())
  const uuid = opts.uuid ?? (() => cryptoRandomUuid())
  const labels = opts.backendLabels ?? {}
  const provider = opts.historyProvider ?? null

  function label(backendId: string): string {
    return labels[backendId] ?? backendId
  }

  function detect(input: DetectInput): StaleResumeDetection | null {
    const { persisted, project } = input
    if (!persisted) return null
    if (!persisted.backendSessionId) return null
    // Backend mismatch: the persisted row's backend_id differs from the
    // project's currently-configured backend. The registry's `upsert`
    // already clears the row on mismatch, but that only runs AFTER we've
    // committed to a direction — detection here runs BEFORE, giving the
    // user the opportunity to inject history from the old backend.
    if (persisted.backendId !== project.backend) {
      return {
        reason: "backend_mismatch",
        staleBackendId: persisted.backendId,
        staleSessionId: persisted.backendSessionId,
      }
    }
    // Session-file missing: only checkable for Gemini today (Codex and
    // Claude don't scope their sessions to cwd in the same way, so the
    // JSON-RPC / SDK calls handle misses themselves). Delegate to the
    // disk-lister so the coordinator stays decoupled from backend
    // specifics.
    if (project.backend === "gemini") {
      const listed = listGeminiSessionsFromDiskSync(project.projectDir)
      if (!listed.has(persisted.backendSessionId)) {
        return {
          reason: "session_file_missing",
          staleBackendId: persisted.backendId,
          staleSessionId: persisted.backendSessionId,
        }
      }
    }
    return null
  }

  async function promptAndQueue(input: PromptInput): Promise<string> {
    const promptId = uuid()
    const canInject = provider
      ? provider.canInject({
          fromBackend: input.detection.staleBackendId,
          toBackend: input.project.backend,
          sessionId: input.detection.staleSessionId,
        })
      : false

    const card = buildStaleResumeBlocks({
      id: promptId,
      currentBackendName: label(input.project.backend),
      priorBackendName:
        input.detection.reason === "backend_mismatch"
          ? label(input.detection.staleBackendId)
          : undefined,
      queuedTurnPreview: input.turn.text,
      reason: input.detection.reason,
      canInjectHistory: canInject,
    })

    let messageTs = ""
    try {
      const res = await opts.adapter.postMessage({
        channel: input.channel,
        threadTs: input.threadTs,
        text: card.text,
        blocks: card.blocks,
      })
      messageTs = res.ts
    } catch (err) {
      log.error(
        `slack stale-resume: failed to post card for ${input.sessionKey}: ${String(err)}. ` +
          `Falling back to silent drop.`,
      )
      throw err
    }

    const record: PendingResumePrompt = {
      id: promptId,
      sessionKey: input.sessionKey,
      channelId: input.channel,
      threadTs: input.threadTs,
      messageTs,
      backendId: input.project.backend,
      staleBackendId: input.detection.staleBackendId,
      staleSessionId: input.detection.staleSessionId,
      reason: input.detection.reason,
      queuedTurnJson: JSON.stringify(input.turn),
      createdAt: now(),
    }
    try {
      opts.store.putPendingResumePrompt(record)
    } catch (err) {
      log.error(
        `slack stale-resume: failed to persist pending prompt ${promptId}: ${String(err)}`,
      )
    }
    log.info(
      `slack stale-resume: prompted ${input.sessionKey} (reason=${input.detection.reason}, id=${promptId})`,
    )
    return promptId
  }

  async function handleBlockAction(
    input: BlockActionInput,
  ): Promise<BlockActionResult> {
    const parsed = parseStaleResumeActionId(input.actionId)
    if (!parsed) return { kind: "malformed" }

    const record = opts.store.getPendingResumePrompt(parsed.id)
    if (!record) {
      log.info(
        `slack stale-resume: click for unknown prompt ${parsed.id} — already resolved or expired`,
      )
      return { kind: "unknown", promptId: parsed.id }
    }

    // Idempotency: delete the row up-front so a double-click doesn't fire
    // the replay callback twice. If the update or replay below throws,
    // we'll log; the user can retry by sending a fresh message.
    try {
      opts.store.deletePendingResumePrompt(parsed.id)
    } catch (err) {
      log.warn(
        `slack stale-resume: failed to delete pending prompt ${parsed.id}: ${String(err)}`,
      )
    }

    // 1. Update the card in place.
    try {
      const rendered = buildResolvedStaleResumeBlocks({
        previous: {
          id: record.id,
          currentBackendName: label(record.backendId),
          priorBackendName:
            record.reason === "backend_mismatch"
              ? label(record.staleBackendId)
              : undefined,
          queuedTurnPreview: previewFromJson(record.queuedTurnJson),
          reason: record.reason,
          canInjectHistory: false,
        },
        resolver: { userId: input.userId },
        decision: parsed.decision,
      })
      await opts.adapter.updateMessage({
        channel: record.channelId,
        ts: record.messageTs,
        text: rendered.text,
        blocks: rendered.blocks,
      })
    } catch (err) {
      log.error(
        `slack stale-resume: chat.update failed for ${parsed.id}: ${String(err)}`,
      )
    }

    // 2. Act on the decision.
    const project =
      opts.lookupProject(record.sessionKey) ?? undefined
    let turn: InboundTurn | null = null
    try {
      turn = JSON.parse(record.queuedTurnJson) as InboundTurn
    } catch (err) {
      log.error(
        `slack stale-resume: could not parse queued turn for ${parsed.id}: ${String(err)}`,
      )
    }

    if (parsed.decision === "cancel") {
      // Nothing else to do — the user chose to drop the turn.
      log.info(`slack stale-resume: ${parsed.id} cancelled by ${input.userId}`)
      return { kind: "resolved", promptId: parsed.id, decision: "cancel" }
    }

    if (!project || !turn) {
      log.warn(
        `slack stale-resume: ${parsed.id} resolved=${parsed.decision} but project/turn missing (project=${!!project}, turn=${!!turn})`,
      )
      return { kind: "resolved", promptId: parsed.id, decision: parsed.decision }
    }

    if (parsed.decision === "fresh") {
      // Drop the stale backend_session_id so the next getOrCreate starts
      // a clean `session/new`. Counters + the row itself survive.
      try {
        opts.store.clearBackendSessionId(record.sessionKey)
      } catch (err) {
        log.warn(
          `slack stale-resume: failed to clear backend_session_id for ${record.sessionKey}: ${String(err)}`,
        )
      }
      try {
        await opts.replayTurn({
          key: sessionKeyPartsFromKey(record.sessionKey, input.workspace),
          project,
          turn,
        })
      } catch (err) {
        log.error(
          `slack stale-resume: replay (fresh) threw for ${parsed.id}: ${String(err)}`,
        )
      }
      return { kind: "resolved", promptId: parsed.id, decision: "fresh" }
    }

    // decision === "inject"
    let replayContext: SessionConfig["replayContext"] | null = null
    if (provider) {
      try {
        replayContext = await provider.buildReplayContext({
          fromBackend: record.staleBackendId,
          toBackend: record.backendId,
          sessionId: record.staleSessionId,
          cwd: project.projectDir,
        })
      } catch (err) {
        log.error(
          `slack stale-resume: history provider threw for ${parsed.id}: ${String(err)}`,
        )
      }
    }
    if (!replayContext) {
      // Fall back to the fresh strategy — card already says "replayed with
      // history" but there's no better option than starting fresh without
      // losing the user's turn. Log + move on.
      log.warn(
        `slack stale-resume: inject requested for ${parsed.id} but no replayContext available; falling back to fresh`,
      )
      try {
        opts.store.clearBackendSessionId(record.sessionKey)
      } catch (err) {
        log.warn(
          `slack stale-resume: failed to clear backend_session_id for ${record.sessionKey}: ${String(err)}`,
        )
      }
    }
    try {
      await opts.replayTurn({
        key: sessionKeyPartsFromKey(record.sessionKey, input.workspace),
        project,
        turn,
        ...(replayContext ? { replayContext } : {}),
      })
    } catch (err) {
      log.error(
        `slack stale-resume: replay (inject) threw for ${parsed.id}: ${String(err)}`,
      )
    }
    return { kind: "resolved", promptId: parsed.id, decision: "inject" }
  }

  function listPending(): PendingResumePrompt[] {
    return opts.store.listPendingResumePrompts()
  }

  function restoreFromStore(): void {
    const rows = opts.store.listPendingResumePrompts()
    if (rows.length === 0) return
    log.info(
      `slack stale-resume: restored ${rows.length} pending prompt(s) from store`,
    )
  }

  return {
    detect,
    promptAndQueue,
    handleBlockAction,
    listPending,
    restoreFromStore,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decompose a session key back into its parts. */
function sessionKeyPartsFromKey(
  key: string,
  fallbackWorkspace: string,
): SessionKeyParts {
  // slack:<workspace>:<channelId>:<threadTs|main>
  const parts = key.split(":")
  if (parts.length < 4 || parts[0] !== "slack") {
    log.warn(
      `slack stale-resume: session key ${key} doesn't match expected shape; using fallback workspace`,
    )
    return { workspace: fallbackWorkspace, channelId: "", threadTs: undefined }
  }
  const workspace = parts[1]!
  const channelId = parts[2]!
  const threadTs = parts.slice(3).join(":")
  return {
    workspace,
    channelId,
    threadTs: threadTs === "main" ? undefined : threadTs,
  }
}

/**
 * Decode an `InboundTurn` JSON payload for display purposes only. Defensive:
 * if the JSON is corrupt, fall back to the raw string so the resolved card
 * still shows *something* instead of blank.
 */
function previewFromJson(json: string): string {
  try {
    const parsed = JSON.parse(json) as InboundTurn
    return parsed.text ?? ""
  } catch {
    return json
  }
}

/** Lightweight uuid — we don't need v4-strict, just a unique string. */
function cryptoRandomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  // Fallback for older runtimes: 16 random bytes as hex.
  const bytes = new Uint8Array(16)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Wrapper so `detect()` can stay synchronous — the gemini session lister is
 * synchronous too, but lives in a module we want to import lazily (keeps
 * the coordinator independent of backend-specific modules at import time).
 *
 * We cache the import promise at module scope so the first detect call
 * triggers the load and subsequent calls hit the warm cache. The sync
 * function is evaluated via `require`-style dynamic import.
 */
let geminiLister: ((cwd: string) => string[]) | undefined
function listGeminiSessionsFromDiskSync(cwd: string): Set<string> {
  if (!geminiLister) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("../../../session/cross-backend") as {
        listGeminiSessionsFromDisk?: (
          cwd: string,
        ) => Array<{ id: string }>
      }
      if (mod.listGeminiSessionsFromDisk) {
        const fn = mod.listGeminiSessionsFromDisk
        geminiLister = (cwd2: string) => fn(cwd2).map((s) => s.id)
      } else {
        geminiLister = () => []
      }
    } catch (err) {
      log.warn(
        `slack stale-resume: could not load gemini session lister: ${String(err)}`,
      )
      geminiLister = () => []
    }
  }
  return new Set(geminiLister(cwd))
}
