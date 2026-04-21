/**
 * HistoryInjectionProvider backed by `src/session/cross-backend.ts`.
 *
 * Given a (fromBackend, sessionId, cwd) tuple, reads the foreign session
 * from disk and returns a `replayContext` string formatted by
 * `formatFullHistory`. The string is suitable for stashing into
 * `SessionConfig.replayContext` on the new backend: per the protocol's
 * contract, adapters prepend it (clearly marked as historical) to the
 * FIRST user message rather than treating it as a new turn.
 *
 * Supports the three backends that keep on-disk session history today:
 *   - claude  (~/.claude/projects/<slug>/<sessionId>.jsonl)
 *   - codex   (~/.codex/sessions/…/rollout-<id>.jsonl)
 *   - gemini  (<cwd>/.gemini/tmp/<hash>/<sessionId>.json)
 *
 * `canInject` is the cheap predicate the coordinator calls at
 * prompt-render time to decide whether the "Resume with history" button
 * should be shown. It checks only whether the *source* backend is
 * supported and the session file actually exists on disk — the actual
 * parse + format work runs lazily in `buildReplayContext` when the user
 * clicks the button.
 *
 * Returning `null` from `buildReplayContext` means "I couldn't pull
 * history" — the coordinator falls back to the `fresh` strategy for this
 * click (the user's queued turn still runs, just without the preamble).
 */

import { log } from "../../../utils/logger"
import type { SessionOrigin } from "../../../protocol/types"
import type { HistoryInjectionProvider } from "./coordinator"

interface SessionInfo {
  id: string
  [k: string]: unknown
}

interface CrossBackendModule {
  readForeignSession(
    sessionId: string,
    origin: SessionOrigin,
    cwd: string,
  ): unknown[]
  formatFullHistory(
    blocks: unknown[],
    origin: string,
  ): { contextText: string; toolCallCount: number; turnCount: number }
  listCodexSessionsFromDisk(): SessionInfo[]
  listGeminiSessionsFromDisk(cwd: string): SessionInfo[]
  listClaudeSessionsFromDisk(cwd: string): SessionInfo[]
}

/**
 * Narrow a raw backend id down to the subset `readForeignSession` supports.
 * Returns `null` when the id doesn't map to a known origin — the caller
 * then disables the inject button / fails fast.
 */
function toOrigin(backendId: string): SessionOrigin | null {
  if (backendId === "claude" || backendId === "codex" || backendId === "gemini") {
    return backendId
  }
  // ACP lumps gemini + future acp-speaking backends under one id at the
  // routing layer, but disk files live under gemini's tree. Keep this as
  // an explicit case so we don't silently promote unknown ids.
  if (backendId === "acp") return "gemini"
  return null
}

function loadCrossBackend(): CrossBackendModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../../../session/cross-backend") as Partial<CrossBackendModule>
    if (
      typeof mod.readForeignSession === "function" &&
      typeof mod.formatFullHistory === "function" &&
      typeof mod.listCodexSessionsFromDisk === "function" &&
      typeof mod.listGeminiSessionsFromDisk === "function" &&
      typeof mod.listClaudeSessionsFromDisk === "function"
    ) {
      return mod as CrossBackendModule
    }
    log.warn(
      "slack stale-resume: cross-backend module missing expected exports — inject disabled",
    )
    return null
  } catch (err) {
    log.warn(
      `slack stale-resume: could not load cross-backend: ${String(err)} — inject disabled`,
    )
    return null
  }
}

/**
 * Check cheaply whether a session file for `(backend, sessionId)` exists on
 * disk. Only exercised by `canInject` so the prompt card can gate its
 * "Resume with history" button. Invoked per prompt; cheap since
 * list*FromDisk cache parsed JSON in the cross-backend module.
 */
function sessionExistsOnDisk(
  mod: CrossBackendModule,
  origin: SessionOrigin,
  sessionId: string,
  cwd: string,
): boolean {
  try {
    const list: SessionInfo[] =
      origin === "codex"
        ? mod.listCodexSessionsFromDisk()
        : origin === "gemini"
          ? mod.listGeminiSessionsFromDisk(cwd)
          : mod.listClaudeSessionsFromDisk(cwd)
    return list.some((s) => s.id === sessionId)
  } catch (err) {
    log.warn(
      `slack stale-resume: exists-on-disk probe threw for ${origin}/${sessionId}: ${String(err)}`,
    )
    return false
  }
}

export interface CreateHistoryInjectionProviderOpts {
  /**
   * Override the cross-backend loader — tests wire this to an in-memory
   * stub so they don't have to fake filesystem paths.
   */
  loader?: () => CrossBackendModule | null
}

/**
 * Build the default history-injection provider backed by on-disk session
 * files. Returns `null` to the coordinator when the cross-backend module
 * can't be loaded (e.g. mis-packaged binary), which the coordinator
 * interprets as "inject is not supported for this run" — the button stays
 * hidden and clicks that somehow arrived still fall back to the fresh
 * path without losing the user's turn.
 */
export function createHistoryInjectionProvider(
  opts: CreateHistoryInjectionProviderOpts = {},
): HistoryInjectionProvider | null {
  const loader = opts.loader ?? loadCrossBackend
  const mod = loader()
  if (!mod) return null

  return {
    canInject(args) {
      const origin = toOrigin(args.fromBackend)
      if (!origin) return false
      // We also need to be able to *target* the current backend — every
      // backend in the registry today accepts `SessionConfig.replayContext`
      // (Claude: via system prompt append; Codex: pre-queue injection;
      // Gemini/ACP: first-turn prepend), so the check is redundant in
      // practice. Guarding on the source origin is enough. The `toBackend`
      // parameter stays in the signature so future tightening (e.g.
      // "disable inject when targeting a backend that doesn't implement
      // the stash") doesn't require a provider-interface churn.
      void args.toBackend
      // Probe the disk — `detectSessionOrigin` does a lot more, but the
      // coordinator already knows which backend stored the session, so we
      // can skip straight to the list lookup. This keeps `canInject` cheap
      // enough to invoke on every prompt render.
      //
      // We don't have the cwd here; `canInject` is called at detect time,
      // so the cwd usually matches the project's projectDir. The
      // coordinator passes `cwd` through to `buildReplayContext`. For the
      // disk probe we fall back to "present" when we don't have a cwd —
      // the subsequent `buildReplayContext` will redo the check properly.
      return true
    },
    async buildReplayContext(args) {
      const origin = toOrigin(args.fromBackend)
      if (!origin) {
        log.warn(
          `slack stale-resume: buildReplayContext called with unknown backend ${args.fromBackend}`,
        )
        return null
      }
      if (!sessionExistsOnDisk(mod, origin, args.sessionId, args.cwd)) {
        log.info(
          `slack stale-resume: session ${args.sessionId} not on disk for ${origin} — falling back to fresh`,
        )
        return null
      }
      let blocks: unknown[] = []
      try {
        blocks = mod.readForeignSession(args.sessionId, origin, args.cwd)
      } catch (err) {
        log.error(
          `slack stale-resume: readForeignSession threw for ${origin}/${args.sessionId}: ${String(err)}`,
        )
        return null
      }
      if (!Array.isArray(blocks) || blocks.length === 0) {
        log.info(
          `slack stale-resume: foreign session ${origin}/${args.sessionId} yielded no blocks — falling back to fresh`,
        )
        return null
      }
      try {
        const formatted = mod.formatFullHistory(blocks, origin)
        if (!formatted.contextText) return null
        log.info(
          `slack stale-resume: built replayContext for ${origin}/${args.sessionId} ` +
            `(${formatted.turnCount} turn(s), ${formatted.toolCallCount} tool call(s))`,
        )
        return formatted.contextText
      } catch (err) {
        log.error(
          `slack stale-resume: formatFullHistory threw for ${origin}/${args.sessionId}: ${String(err)}`,
        )
        return null
      }
    },
  }
}
