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
  `)

  const upsertStmt = db.prepare(
    `INSERT INTO sessions (key, workspace, channel_id, thread_ts, backend_id, last_active_at, created_at)
     VALUES ($key, $workspace, $channel, $thread, $backend, $now, $now)
     ON CONFLICT(key) DO UPDATE SET
       workspace = excluded.workspace,
       channel_id = excluded.channel_id,
       thread_ts = excluded.thread_ts,
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
 * or operators who explicitly opt out via `slack.toml`). Keeps the registry's
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
    close() {},
  }
}
