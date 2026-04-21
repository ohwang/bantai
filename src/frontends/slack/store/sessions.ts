/**
 * Session persistence for the Slack frontend (plan §S8 crash recovery).
 *
 * On process restart we want the bot to pick up live threads where it left
 * off — the user's next message lands in a session resumed from the backend's
 * stored state (Claude SDK `resume: <sessionId>`), not a brand-new one.
 *
 * Scope for v0 persistence:
 *   - One `sessions` row per (workspace, channel, threadTs) key.
 *   - Records the backend id + backend-returned sessionId (for `resume`).
 *   - Tracks cumulative cost + turn count so `!bantai cost` survives a
 *     restart.
 *   - `lastActiveAt` for future idle-GC / observability.
 *
 * Not persisted (out of scope — belongs with the S10 web viewer):
 *   - Per-turn message history (the backend already persists its own).
 *   - Block Kit / approval / elicitation state. On restart, outstanding
 *     approvals are lost; the backend's canUseTool will re-issue them on
 *     the next turn, which is the correct behaviour.
 *
 * Uses `bun:sqlite` (zero-dep, WAL mode, SQLite-standard). An in-memory
 * store is available for unit tests (`path: ":memory:"`). Operations are
 * synchronous per SQLite semantics; callers can treat them as cheap.
 */

import { Database } from "bun:sqlite"
import { log } from "../../../utils/logger"

export interface PersistedSession {
  /** `slack:<workspace>:<channelId>:<threadTs|main>` */
  key: string
  workspace: string
  channelId: string
  /** The anchor thread_ts (or "main" for top-level main channel). */
  threadTs: string
  /** Backend id chosen for this session (claude / codex / …). */
  backendId: string
  /** Backend-issued session identifier — passed as `resume` on rehydration. */
  backendSessionId: string | null
  /** Accumulated turn count. */
  turns: number
  /** Accumulated USD cost across all turns. */
  totalCostUsd: number
  /** Milliseconds since unix epoch of the most-recent activity. */
  lastActiveAt: number
  /** Milliseconds since unix epoch when the session was first created. */
  createdAt: number
}

/**
 * A user turn that's been intercepted by the stale-resume coordinator and is
 * waiting for the user to pick a recovery strategy. Serialised to SQLite so
 * a crash/restart doesn't lose it — the click that resolves the card might
 * land hours later, and we can't store it in process memory.
 */
export interface PendingResumePrompt {
  /** Stable id — used as the suffix in the Block Kit action id. */
  id: string
  /** Slack session key this turn was routed to. */
  sessionKey: string
  channelId: string
  /** The actual thread we posted the card into. */
  threadTs: string
  /** The Block Kit card's ts (for `chat.update`). */
  messageTs: string
  /** Current project backend (what the turn will run on if approved). */
  backendId: string
  /**
   * The backend id of the *persisted* (stale) session — used to drive
   * cross-backend history injection. May equal `backendId` when the reason
   * is `session_file_missing`.
   */
  staleBackendId: string
  /** The persisted session id we would have blindly resumed. */
  staleSessionId: string
  reason: "backend_mismatch" | "session_file_missing"
  /** JSON-serialised `InboundTurn` replay payload. */
  queuedTurnJson: string
  createdAt: number
}

export interface SessionStore {
  /** Upsert the session row at creation time (before the first turn). */
  upsert(opts: {
    key: string
    workspace: string
    channelId: string
    threadTs: string
    backendId: string
  }): void
  /** Persist the backend-returned session id (from `session_init`). */
  setBackendSessionId(key: string, backendSessionId: string): void
  /** Bump `lastActiveAt` to now. */
  touch(key: string): void
  /** Increment turns + add usd to the running total, bump lastActiveAt. */
  recordTurn(key: string, addCostUsd: number): void
  /** Read the row for `key`, or undefined when absent. */
  get(key: string): PersistedSession | undefined
  /** Delete the row (session terminated cleanly). */
  delete(key: string): void
  /** Snapshot of every row — diagnostic / admin. */
  list(): PersistedSession[]
  /**
   * Clear the backend-issued session id without dropping the row. Used by
   * the stale-resume coordinator's "Start fresh" path — the next turn will
   * run `session/new` instead of `session/load`.
   */
  clearBackendSessionId(key: string): void

  // --- Thread participation ----------------------------------------------
  /**
   * Upsert a "the bot has posted in this (channel, thread)" marker with
   * `last_post_at = now`. Called from the send-adapter's `onPostSucceeded`
   * hook after every successful `chat.postMessage`. Idempotent — re-posting
   * in the same thread bumps the timestamp via ON CONFLICT.
   *
   * This row is what lets the inbox gate accept follow-up messages in the
   * thread without `@bantai` across process restarts and idle-close. See
   * `inbox/gate.ts → threadHasPriorBotPost`.
   */
  recordThreadPost(channelId: string, threadTs: string): void
  /**
   * True when a thread-participation row exists for `(channel, thread)` AND
   * its `last_post_at >= cutoffMs`. The caller decides the cutoff (TTL
   * policy lives at the cache layer so the store stays unopinionated).
   */
  hasThreadPost(channelId: string, threadTs: string, cutoffMs: number): boolean
  /**
   * Delete thread-participation rows whose `last_post_at < cutoffMs`.
   * Returns the deleted row count. Called lazily at launcher boot to keep
   * the table bounded over time.
   */
  pruneThreadPosts(cutoffMs: number): number

  // --- Pending stale-resume prompts --------------------------------------
  /**
   * Insert a pending prompt. Fails silently if the id already exists (the
   * caller should generate fresh uuids per prompt).
   */
  putPendingResumePrompt(prompt: PendingResumePrompt): void
  /** Read a pending prompt by id, or undefined. */
  getPendingResumePrompt(id: string): PendingResumePrompt | undefined
  /** Delete a resolved prompt. */
  deletePendingResumePrompt(id: string): void
  /** Diagnostic: every outstanding prompt, oldest first. */
  listPendingResumePrompts(): PendingResumePrompt[]

  /** Release the underlying database handle. Safe to call multiple times. */
  close(): void
}

export interface CreateSessionStoreOpts {
  /**
   * SQLite path. Use `:memory:` for tests. Any other string names an
   * on-disk file; the enclosing directory must already exist.
   */
  path: string
}

export function createSessionStore(opts: CreateSessionStoreOpts): SessionStore {
  const db = new Database(opts.path)
  // WAL lets readers proceed while a writer is active — important when the
  // future web viewer (plan §S10) reads from the same DB. No-op on
  // `:memory:` (SQLite silently ignores WAL pragma there).
  try {
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA synchronous = NORMAL")
    db.exec("PRAGMA foreign_keys = ON")
  } catch (err) {
    log.warn(`slack store: pragma setup failed for ${opts.path}: ${String(err)}`)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      key                TEXT PRIMARY KEY,
      workspace          TEXT NOT NULL,
      channel_id         TEXT NOT NULL,
      thread_ts          TEXT NOT NULL,
      backend_id         TEXT NOT NULL,
      backend_session_id TEXT,
      turns              INTEGER NOT NULL DEFAULT 0,
      total_cost_usd     REAL NOT NULL DEFAULT 0,
      last_active_at     INTEGER NOT NULL,
      created_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_last_active_idx ON sessions(last_active_at);

    CREATE TABLE IF NOT EXISTS pending_resume_prompts (
      id                 TEXT PRIMARY KEY,
      session_key        TEXT NOT NULL,
      channel_id         TEXT NOT NULL,
      thread_ts          TEXT NOT NULL,
      message_ts         TEXT NOT NULL,
      backend_id         TEXT NOT NULL,
      stale_backend_id   TEXT NOT NULL,
      stale_session_id   TEXT NOT NULL,
      reason             TEXT NOT NULL,
      queued_turn_json   TEXT NOT NULL,
      created_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pending_resume_prompts_created_at_idx
      ON pending_resume_prompts(created_at);

    CREATE TABLE IF NOT EXISTS thread_participation (
      channel_id    TEXT NOT NULL,
      thread_ts     TEXT NOT NULL,
      last_post_at  INTEGER NOT NULL,
      PRIMARY KEY (channel_id, thread_ts)
    );
    CREATE INDEX IF NOT EXISTS thread_participation_last_post_idx
      ON thread_participation(last_post_at);
  `)

  // NOTE: the `backend_session_id = CASE …` clause is load-bearing. Without
  // it, flipping a channel's backend in slack.json (e.g. codex → gemini) and
  // restarting the server leaves the DB row with the NEW backend_id but the
  // OLD backend's sessionId. The next turn blindly passes that foreign id to
  // `session/load` / SDK resume, which hard-errors (Gemini returns JSON-RPC
  // -32603 "Invalid session identifier"). Clearing the sessionId whenever
  // backend_id changes forces a clean session/new on the new backend. The
  // stale-resume coordinator can still detect the mismatch BEFORE we get
  // here (via the persisted row's prior backend_id) and prompt the user
  // for cross-backend history injection; this clause is the defense-in-depth
  // for legacy rows that predate the coordinator.
  //
  // SQLite UPSERT semantics: `sessions.backend_id` in the CASE expression
  // references the OLD row value regardless of its position in the SET
  // list (https://sqlite.org/lang_upsert.html §4.2). So evaluating it in
  // the same SET list that also updates `backend_id` is well-defined.
  const upsertStmt = db.prepare(
    `INSERT INTO sessions (key, workspace, channel_id, thread_ts, backend_id, last_active_at, created_at)
     VALUES ($key, $workspace, $channel, $thread, $backend, $now, $now)
     ON CONFLICT(key) DO UPDATE SET
       workspace = excluded.workspace,
       channel_id = excluded.channel_id,
       thread_ts = excluded.thread_ts,
       backend_session_id = CASE
         WHEN sessions.backend_id = excluded.backend_id THEN sessions.backend_session_id
         ELSE NULL
       END,
       backend_id = excluded.backend_id,
       last_active_at = excluded.last_active_at`,
  )
  const setBackendIdStmt = db.prepare(
    `UPDATE sessions SET backend_session_id = $id, last_active_at = $now WHERE key = $key`,
  )
  const touchStmt = db.prepare(
    `UPDATE sessions SET last_active_at = $now WHERE key = $key`,
  )
  const recordTurnStmt = db.prepare(
    `UPDATE sessions
       SET turns = turns + 1,
           total_cost_usd = total_cost_usd + $cost,
           last_active_at = $now
       WHERE key = $key`,
  )
  const getStmt = db.prepare(`SELECT * FROM sessions WHERE key = $key`)
  const deleteStmt = db.prepare(`DELETE FROM sessions WHERE key = $key`)
  const listStmt = db.prepare(`SELECT * FROM sessions ORDER BY last_active_at DESC`)
  const clearBackendIdStmt = db.prepare(
    `UPDATE sessions SET backend_session_id = NULL, last_active_at = $now WHERE key = $key`,
  )

  const recordThreadPostStmt = db.prepare(
    `INSERT INTO thread_participation (channel_id, thread_ts, last_post_at)
     VALUES ($channel, $thread, $now)
     ON CONFLICT(channel_id, thread_ts) DO UPDATE SET last_post_at = excluded.last_post_at`,
  )
  const hasThreadPostStmt = db.prepare(
    `SELECT 1 FROM thread_participation
      WHERE channel_id = $channel AND thread_ts = $thread AND last_post_at >= $cutoff
      LIMIT 1`,
  )
  const pruneThreadPostsStmt = db.prepare(
    `DELETE FROM thread_participation WHERE last_post_at < $cutoff`,
  )

  const putPendingStmt = db.prepare(
    `INSERT OR REPLACE INTO pending_resume_prompts
       (id, session_key, channel_id, thread_ts, message_ts,
        backend_id, stale_backend_id, stale_session_id,
        reason, queued_turn_json, created_at)
     VALUES ($id, $sessionKey, $channel, $thread, $messageTs,
             $backend, $staleBackend, $staleSession,
             $reason, $turnJson, $createdAt)`,
  )
  const getPendingStmt = db.prepare(
    `SELECT * FROM pending_resume_prompts WHERE id = $id`,
  )
  const deletePendingStmt = db.prepare(
    `DELETE FROM pending_resume_prompts WHERE id = $id`,
  )
  const listPendingStmt = db.prepare(
    `SELECT * FROM pending_resume_prompts ORDER BY created_at ASC`,
  )

  function rowToPending(
    row: Record<string, unknown> | null | undefined,
  ): PendingResumePrompt | undefined {
    if (!row) return undefined
    const reason = String(row.reason)
    if (reason !== "backend_mismatch" && reason !== "session_file_missing") {
      log.warn(
        `slack store: pending_resume_prompts row ${String(row.id)} has unknown reason=${reason}; skipping`,
      )
      return undefined
    }
    return {
      id: String(row.id),
      sessionKey: String(row.session_key),
      channelId: String(row.channel_id),
      threadTs: String(row.thread_ts),
      messageTs: String(row.message_ts),
      backendId: String(row.backend_id),
      staleBackendId: String(row.stale_backend_id),
      staleSessionId: String(row.stale_session_id),
      reason,
      queuedTurnJson: String(row.queued_turn_json),
      createdAt: Number(row.created_at ?? 0),
    }
  }

  function rowToSession(row: Record<string, unknown> | null | undefined): PersistedSession | undefined {
    if (!row) return undefined
    return {
      key: String(row.key),
      workspace: String(row.workspace),
      channelId: String(row.channel_id),
      threadTs: String(row.thread_ts),
      backendId: String(row.backend_id),
      backendSessionId: row.backend_session_id === null || row.backend_session_id === undefined
        ? null
        : String(row.backend_session_id),
      turns: Number(row.turns ?? 0),
      totalCostUsd: Number(row.total_cost_usd ?? 0),
      lastActiveAt: Number(row.last_active_at ?? 0),
      createdAt: Number(row.created_at ?? 0),
    }
  }

  let closed = false
  return {
    upsert(o) {
      if (closed) return
      const now = Date.now()
      upsertStmt.run({
        $key: o.key,
        $workspace: o.workspace,
        $channel: o.channelId,
        $thread: o.threadTs,
        $backend: o.backendId,
        $now: now,
      })
    },
    setBackendSessionId(key, backendSessionId) {
      if (closed) return
      setBackendIdStmt.run({
        $key: key,
        $id: backendSessionId,
        $now: Date.now(),
      })
    },
    touch(key) {
      if (closed) return
      touchStmt.run({ $key: key, $now: Date.now() })
    },
    recordTurn(key, addCostUsd) {
      if (closed) return
      recordTurnStmt.run({
        $key: key,
        $cost: addCostUsd,
        $now: Date.now(),
      })
    },
    get(key) {
      if (closed) return undefined
      const row = getStmt.get({ $key: key }) as Record<string, unknown> | null
      return rowToSession(row)
    },
    delete(key) {
      if (closed) return
      deleteStmt.run({ $key: key })
    },
    list() {
      if (closed) return []
      const rows = listStmt.all() as Array<Record<string, unknown>>
      const out: PersistedSession[] = []
      for (const r of rows) {
        const s = rowToSession(r)
        if (s) out.push(s)
      }
      return out
    },
    clearBackendSessionId(key) {
      if (closed) return
      clearBackendIdStmt.run({ $key: key, $now: Date.now() })
    },
    recordThreadPost(channelId, threadTs) {
      if (closed) return
      if (!channelId || !threadTs) return
      recordThreadPostStmt.run({
        $channel: channelId,
        $thread: threadTs,
        $now: Date.now(),
      })
    },
    hasThreadPost(channelId, threadTs, cutoffMs) {
      if (closed) return false
      if (!channelId || !threadTs) return false
      const row = hasThreadPostStmt.get({
        $channel: channelId,
        $thread: threadTs,
        $cutoff: cutoffMs,
      })
      return row !== null && row !== undefined
    },
    pruneThreadPosts(cutoffMs) {
      if (closed) return 0
      const res = pruneThreadPostsStmt.run({ $cutoff: cutoffMs })
      return Number(res.changes ?? 0)
    },
    putPendingResumePrompt(prompt) {
      if (closed) return
      putPendingStmt.run({
        $id: prompt.id,
        $sessionKey: prompt.sessionKey,
        $channel: prompt.channelId,
        $thread: prompt.threadTs,
        $messageTs: prompt.messageTs,
        $backend: prompt.backendId,
        $staleBackend: prompt.staleBackendId,
        $staleSession: prompt.staleSessionId,
        $reason: prompt.reason,
        $turnJson: prompt.queuedTurnJson,
        $createdAt: prompt.createdAt,
      })
    },
    getPendingResumePrompt(id) {
      if (closed) return undefined
      const row = getPendingStmt.get({ $id: id }) as Record<string, unknown> | null
      return rowToPending(row)
    },
    deletePendingResumePrompt(id) {
      if (closed) return
      deletePendingStmt.run({ $id: id })
    },
    listPendingResumePrompts() {
      if (closed) return []
      const rows = listPendingStmt.all() as Array<Record<string, unknown>>
      const out: PendingResumePrompt[] = []
      for (const r of rows) {
        const p = rowToPending(r)
        if (p) out.push(p)
      }
      return out
    },
    close() {
      if (closed) return
      closed = true
      try {
        db.close()
      } catch (err) {
        log.debug(`slack store: close threw: ${String(err)}`)
      }
    },
  }
}

/**
 * No-op store for the paths that disable persistence (tests that don't care,
 * or operators who explicitly opt out via `slack.json`). Keeps the registry's
 * plumbing uniform — every code path that consults the store can do so without
 * a `store ? …` guard.
 */
export function createNoopSessionStore(): SessionStore {
  return {
    upsert() {},
    setBackendSessionId() {},
    touch() {},
    recordTurn() {},
    get() { return undefined },
    delete() {},
    list() { return [] },
    clearBackendSessionId() {},
    recordThreadPost() {},
    hasThreadPost() { return false },
    pruneThreadPosts() { return 0 },
    putPendingResumePrompt() {},
    getPendingResumePrompt() { return undefined },
    deletePendingResumePrompt() {},
    listPendingResumePrompts() { return [] },
    close() {},
  }
}
