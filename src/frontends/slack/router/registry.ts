/**
 * Session registry — maps Slack (channel, thread) pairs to `SessionHost`
 * instances. Hosts are constructed lazily on first use and idle-evicted
 * after a configurable timeout.
 *
 * The key shape mirrors the plan's §2.2 "Session key": `slack:<workspace>:
 * <channelId>:<threadTs|main>`. Top-level channel messages collapse to
 * "main" so the bot doesn't accumulate one SessionHost per unrelated
 * top-level post.
 *
 * Construction (host-factory):
 *   resolveProjectForChannel → createBackend → createSessionHost → listen to
 *   backend.start() (as an async generator) → forward events to the host
 *   subscriber set.
 *
 * The registry holds per-session state:
 *   - the SessionHost instance,
 *   - the event pump (the async-generator iteration, which must be started
 *     exactly once per host),
 *   - an idle timer,
 *   - a subscriber set (view layer event renderers),
 *   - a started flag so `backend.sendMessage` is only called after the
 *     generator is actually listening (otherwise the first message queues
 *     forever).
 *
 * Nothing in this file knows about Bolt or Slack payload shapes. The
 * launcher wires incoming Slack events to `registry.get(...).send(...)`.
 */

import type { SessionHost } from "../../../session/host"
import type { AgentBackend, AgentEvent, ConversationEvent, PermissionMode, SessionConfig, SessionOrigin, UserMessage } from "../../../protocol/types"
import { SubagentManager } from "../../../subagents/manager"
import { createBackend } from "../../../subagents/backend-factory"
import { createSessionHost } from "../../../session/host"
import { log } from "../../../utils/logger"
import type { ProjectConfig } from "./resolver"
import type { SessionStore } from "../store/sessions"
import { createNoopSessionStore } from "../store/sessions"
import { createPhaseTracker } from "../admin/phase"
import type { SessionPhase, SessionSummary } from "../admin/protocol"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionKeyParts {
  workspace: string
  channelId: string
  threadTs?: string
}

export function sessionKeyFor(parts: SessionKeyParts): string {
  const thread = parts.threadTs ?? "main"
  return `slack:${parts.workspace}:${parts.channelId}:${thread}`
}

export type EventSubscriber = (event: ConversationEvent) => void

export interface SessionEntry {
  key: string
  host: SessionHost
  project: ProjectConfig
  /** Slack-side routing metadata for view layer (channel, parentTs). */
  routing: {
    channel: string
    /** The ts that became the thread anchor for this session's replies. */
    parentTs: string
  }
  /**
   * True when this session was rehydrated from the persistent store (i.e.
   * the launcher survived a prior process death or was restarted). The
   * view layer uses this to post a "session resumed after restart" banner
   * instead of the default "session started" one.
   */
  resumed: boolean
  /** Pre-restart cumulative cost + turns, read from the store. Zeros for fresh sessions. */
  priorUsage: { turns: number; totalCostUsd: number }
  /** Cumulative turn count for this session (prior + in-process). */
  turns: number
  /** Cumulative cost in USD (prior + in-process). */
  totalCostUsd: number
  /** Epoch ms of the last observed AgentEvent, or the open time if none yet. */
  lastEventAt: number
  /** Epoch ms the entry was first constructed in-process. */
  openedAt: number
  /** Current admin-surface phase (`UNKNOWN` until the first classifying event). */
  phase: SessionPhase
  /** Push an inbound user turn into the backend. Safe to call any time. */
  send(message: UserMessage): void
  /** Add a view-layer subscriber that will receive every AgentEvent. */
  subscribe(fn: EventSubscriber): () => void
  /**
   * Close the host + evict from memory. Idempotent. Does NOT touch the
   * persistent store — an idle-evicted session stays resumable; the next
   * inbound message will rehydrate it through the same store lookup that
   * runs on a cold start. Passing `reason` lets the admin hook report
   * WHY we closed (idle timeout vs. explicit reset vs. launcher shutdown).
   */
  close(reason?: SessionCloseReason): void
  /**
   * Tear the session down AND forget it in the persistent store. Called
   * on explicit user action (`!bantai new`), not on idle eviction. After
   * reset(), any subsequent inbound message in this thread starts fresh.
   */
  reset(): void
}

export interface CreateRegistryOpts {
  workspace: string
  /**
   * Idle timeout in ms — no inbound user turn within this window evicts
   * the session from memory (the on-disk store is untouched, so the
   * next message rehydrates it). Default: 60 min. 0 disables eviction.
   */
  idleTimeoutMs?: number
  /** For tests — override the host-factory. */
  buildHost?: (opts: BuildHostOpts) => HostPair
  /**
   * Persistent session store for crash recovery (plan §S8). On `getOrCreate`
   * for a new in-memory entry, the registry consults the store for a
   * previously-persisted backend session id and forwards it to the new
   * SessionConfig as `resume`. When omitted we substitute a no-op store so
   * the rest of the registry code path stays uniform.
   */
  store?: SessionStore
  /**
   * Metrics hook. The registry increments lifecycle counters through this
   * interface so the launcher's Prometheus `/metrics` endpoint reflects
   * real session activity. Omitted in tests that don't care about metrics.
   */
  metrics?: RegistryMetricsHook
  /**
   * Admin-surface hook. When present, the registry publishes lifecycle
   * events (opened/closed/phase/event) through this interface so the
   * launcher's admin server (item 7) can fan them out to connected
   * monitors. Default is a no-op, so nothing downstream has to branch on
   * whether admin is enabled.
   */
  admin?: RegistryAdminHook
  /**
   * Clock override for tests. Used to stamp `lastEventAt` /
   * `openedAt` on the summary deterministically.
   */
  now?: () => number
}

export interface RegistryMetricsHook {
  onSessionOpened(activeCount: number): void
  onSessionClosed(activeCount: number): void
  onTurnStarted(): void
  onTurnCompleted(addCostUsd: number): void
  onTurnErrored(): void
}

/**
 * Admin-surface hook wired to an `AdminBus` by the launcher. The registry
 * is the only thing that sees every session's event stream plus the open /
 * close lifecycle, so it's also the only place that can build an accurate
 * `SessionSummary` + `session_phase` projection without duplicating state
 * across modules.
 */
export interface RegistryAdminHook {
  /** Emitted once when a new entry is constructed (or rehydrated). */
  onSessionOpened(summary: SessionSummary): void
  /**
   * Emitted for every AgentEvent that flows through the pump — same stream
   * the view layer subscribes to. The admin server persists these in its
   * per-session ring buffer + forwards them to keyed WebSocket clients.
   * SystemEvents (history replay markers) are filtered out upstream — the
   * admin surface only cares about the agent's own event stream.
   */
  onSessionEvent(key: string, event: AgentEvent): void
  /**
   * Emitted whenever the derived phase changes (see `admin/phase.ts`). Only
   * fires on transitions — streaming deltas do NOT flap the label.
   */
  onSessionPhase(key: string, phase: SessionPhase): void
  /** Emitted once when the entry is evicted (idle / reset / shutdown / error). */
  onSessionClosed(key: string, reason: SessionCloseReason): void
}

export type SessionCloseReason = "idle" | "reset" | "shutdown" | "error"

export interface BuildHostOpts {
  project: ProjectConfig
  sessionConfig: SessionConfig
}

export interface HostPair {
  host: SessionHost
  backend: AgentBackend
}

export interface SessionRegistry {
  /**
   * Return the entry for the given key, lazy-constructing if absent.
   * `routing.parentTs` is the `threadTs` passed by the caller — already the
   * anchor ts for downstream replies.
   */
  getOrCreate(
    parts: SessionKeyParts,
    project: ProjectConfig,
    parentTs: string,
    sessionConfigOverlay?: Partial<SessionConfig>,
  ): SessionEntry

  /** Return an existing entry if present, undefined otherwise. */
  peek(parts: SessionKeyParts): SessionEntry | undefined

  /** Close a specific session. No-op when absent. */
  close(parts: SessionKeyParts): void

  /** Close everything. Called on launcher shutdown. */
  closeAll(): void

  /** Expose open session count for diagnostics. */
  size(): number

  /**
   * Iterate every live entry. Used by the admin server's `/admin/sessions`
   * snapshot so a monitor that connects mid-flight sees what's running.
   */
  entries(): SessionEntry[]
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionRegistry(opts: CreateRegistryOpts): SessionRegistry {
  const entries = new Map<string, SessionEntry>()
  const idleMs = opts.idleTimeoutMs ?? 60 * 60 * 1000
  const buildHost = opts.buildHost ?? defaultBuildHost
  const store: SessionStore = opts.store ?? createNoopSessionStore()
  const metrics: RegistryMetricsHook = opts.metrics ?? noopMetricsHook()
  const admin: RegistryAdminHook = opts.admin ?? noopAdminHook()
  const now = opts.now ?? (() => Date.now())

  function touchIdle(entry: SessionEntry & { _idleTimer?: ReturnType<typeof setTimeout> }) {
    if (entry._idleTimer) clearTimeout(entry._idleTimer)
    // 0 (or negative) disables idle eviction — sessions live forever in-process.
    if (idleMs <= 0) return
    entry._idleTimer = setTimeout(() => {
      log.info(`slack: idle-closing session ${entry.key} after ${idleMs}ms`)
      entry.close()
    }, idleMs)
    // Keep `ref()` behaviour so Bun doesn't exit solely because the idle
    // timer is the last live handle. Bun's `setTimeout` returns a Timer,
    // which may or may not have `.unref()` — we leave it on so the timer
    // behaves like a normal Node timer in tests.
  }

  function buildEntry(
    key: string,
    project: ProjectConfig,
    parentTs: string,
    parts: SessionKeyParts,
    sessionConfigOverlay: Partial<SessionConfig> | undefined,
  ): SessionEntry {
    // Consult the persistent store before constructing the backend. If a
    // prior run persisted a backend session id for this key, pass it via
    // `resume` so the backend rehydrates instead of starting fresh.
    const persisted = store.get(key)
    const resumed = !!(persisted && persisted.backendSessionId)
    const priorUsage = persisted
      ? { turns: persisted.turns, totalCostUsd: persisted.totalCostUsd }
      : { turns: 0, totalCostUsd: 0 }
    const mergedOverlay: Partial<SessionConfig> = {
      ...(persisted?.backendSessionId
        ? { resume: persisted.backendSessionId }
        : {}),
      ...(sessionConfigOverlay ?? {}),
    }
    const sessionConfig: SessionConfig = buildSessionConfigFromProject(project, mergedOverlay)
    const { host, backend } = buildHost({ project, sessionConfig })

    // Persist (or re-assert) the row NOW so a crash before the first turn
    // still leaves a resumable record. setBackendSessionId() + recordTurn()
    // below mutate the same row as more data arrives.
    store.upsert({
      key,
      workspace: parts.workspace,
      channelId: parts.channelId,
      threadTs: parts.threadTs ?? "main",
      backendId: project.backend,
    })

    const subscribers = new Set<EventSubscriber>()
    let started = false
    let closed = false

    // Rehydrated sessions can skip UNKNOWN → IDLE: the persistent store
    // already knows they're past their first session_init. Fresh ones stay
    // UNKNOWN until the first classifying event lands, so the admin view
    // doesn't flash a false IDLE label while the backend is still booting.
    const phaseTracker = createPhaseTracker(resumed ? "IDLE" : "UNKNOWN")
    const openedAt = now()

    function pump(): void {
      started = true
      const gen = backend.start(sessionConfig)
      void (async () => {
        try {
          for await (const event of gen) {
            if (closed) break
            // Persist the backend session id the first time it lands so a
            // post-crash restart can resume; accumulate cost + turn count
            // on turn_complete so `!bantai cost` survives restarts.
            try {
              if (event.type === "session_init" && event.sessionId) {
                store.setBackendSessionId(key, event.sessionId)
              } else if (event.type === "turn_complete") {
                const addUsd = event.usage?.totalCostUsd ?? 0
                store.recordTurn(key, addUsd)
                metrics.onTurnCompleted(addUsd)
                entry.turns += 1
                entry.totalCostUsd += addUsd
              } else if (event.type === "turn_start") {
                metrics.onTurnStarted()
              } else if (event.type === "error" && event.severity === "fatal") {
                metrics.onTurnErrored()
              }
            } catch (err) {
              log.warn(`slack: session store update failed for ${key}: ${String(err)}`)
            }
            entry.lastEventAt = now()
            // AgentEvents drive the admin surface; SystemEvents (history
            // replay markers) are TUI-only and never leave this process.
            if (isAgentEvent(event)) {
              // Observe phase BEFORE fan-out so admin subscribers can see the
              // session_phase frame interleaved with the session_event frame.
              const obs = phaseTracker.observe(event)
              entry.phase = obs.next
              try {
                admin.onSessionEvent(key, event)
              } catch (err) {
                log.error(`slack: admin.onSessionEvent threw for ${event.type}: ${String(err)}`)
              }
              if (obs.changed) {
                try {
                  admin.onSessionPhase(key, obs.next)
                } catch (err) {
                  log.error(`slack: admin.onSessionPhase threw for ${event.type}: ${String(err)}`)
                }
              }
            }
            // Fan out to subscribers. We snapshot the set so a subscriber
            // that unsubscribes mid-fan-out doesn't skew the iteration.
            for (const sub of Array.from(subscribers)) {
              try {
                sub(event)
              } catch (err) {
                log.error(`slack: subscriber threw for ${event.type}: ${String(err)}`)
              }
            }
            // Fatal errors terminate the pump; the backend will close its
            // channel shortly after, which ends the for-await cleanly.
            if (event.type === "error" && event.severity === "fatal") {
              log.warn(`slack: fatal error from backend (${event.code}): ${event.message}`)
            }
          }
        } catch (err) {
          log.error(`slack: event pump threw for ${key}: ${String(err)}`)
        }
      })()
    }

    const entry: SessionEntry & { _idleTimer?: ReturnType<typeof setTimeout> } = {
      key,
      host,
      project,
      routing: { channel: project.channelId, parentTs },
      resumed,
      priorUsage,
      turns: priorUsage.turns,
      totalCostUsd: priorUsage.totalCostUsd,
      lastEventAt: openedAt,
      openedAt,
      phase: phaseTracker.current(),
      send(message) {
        if (closed) {
          log.warn(`slack: dropped message to closed session ${key}`)
          return
        }
        if (!started) pump()
        backend.sendMessage(message)
        store.touch(key)
        touchIdle(entry)
      },
      subscribe(fn) {
        subscribers.add(fn)
        return () => subscribers.delete(fn)
      },
      close(reason: SessionCloseReason = "idle") {
        if (closed) return
        closed = true
        if (entry._idleTimer) clearTimeout(entry._idleTimer)
        entry._idleTimer = undefined
        subscribers.clear()
        try {
          host.close()
        } catch (err) {
          log.error(`slack: host.close threw for ${key}: ${String(err)}`)
        }
        entries.delete(key)
        metrics.onSessionClosed(entries.size)
        try {
          admin.onSessionClosed(key, reason)
        } catch (err) {
          log.error(`slack: admin.onSessionClosed threw: ${String(err)}`)
        }
      },
      reset() {
        try {
          store.delete(key)
        } catch (err) {
          log.warn(`slack: session store delete failed for ${key}: ${String(err)}`)
        }
        entry.close("reset")
      },
    }
    return entry
  }

  const registry: SessionRegistry = {
    getOrCreate(parts, project, parentTs, sessionConfigOverlay) {
      const key = sessionKeyFor(parts)
      const existing = entries.get(key)
      if (existing) {
        touchIdle(existing as SessionEntry & { _idleTimer?: ReturnType<typeof setTimeout> })
        return existing
      }
      const entry = buildEntry(key, project, parentTs, parts, sessionConfigOverlay)
      entries.set(key, entry)
      touchIdle(entry as SessionEntry & { _idleTimer?: ReturnType<typeof setTimeout> })
      metrics.onSessionOpened(entries.size)
      try {
        admin.onSessionOpened(buildSummary(entry))
      } catch (err) {
        log.error(`slack: admin.onSessionOpened threw: ${String(err)}`)
      }
      log.info(
        `slack: opened session ${key} (backend=${project.backend}, cwd=${project.projectDir}${entry.resumed ? ", resumed" : ""})`,
      )
      return entry
    },
    peek(parts) {
      return entries.get(sessionKeyFor(parts))
    },
    close(parts) {
      entries.get(sessionKeyFor(parts))?.close()
    },
    closeAll() {
      for (const entry of Array.from(entries.values())) entry.close("shutdown")
    },
    size() {
      return entries.size
    },
    entries() {
      return Array.from(entries.values())
    },
  }
  return registry
}

/**
 * Build the admin `SessionSummary` projection from an in-memory entry.
 * Exported so the admin server's `/admin/sessions` snapshot can reuse the
 * same shape instead of reinventing it.
 */
export function buildSummary(entry: SessionEntry): SessionSummary {
  const channelLabel = entry.project.channelName ?? entry.project.channelId
  return {
    key: entry.key,
    channelId: entry.project.channelId,
    threadTs: entry.key.split(":").pop() ?? "main",
    backend: entry.project.backend,
    projectName: channelLabel,
    phase: entry.phase,
    turns: entry.turns,
    totalCostUsd: entry.totalCostUsd,
    lastEventAt: entry.lastEventAt,
    resumed: entry.resumed,
  }
}

/**
 * Type guard: drop TUI-only SystemEvents (history replay markers) before
 * the admin hook / phase reducer see them. AgentEvents are what the admin
 * surface serialises over the wire.
 */
function isAgentEvent(event: ConversationEvent): event is AgentEvent {
  return (
    event.type !== "history_load_started" &&
    event.type !== "history_loaded" &&
    event.type !== "history_load_failed"
  )
}

/** Default no-op metrics hook — keeps the pump code path uniform. */
function noopMetricsHook(): RegistryMetricsHook {
  return {
    onSessionOpened() {},
    onSessionClosed() {},
    onTurnStarted() {},
    onTurnCompleted() {},
    onTurnErrored() {},
  }
}

/** Default no-op admin hook — lets the registry call `admin.*` unconditionally. */
function noopAdminHook(): RegistryAdminHook {
  return {
    onSessionOpened() {},
    onSessionEvent() {},
    onSessionPhase() {},
    onSessionClosed() {},
  }
}

// ---------------------------------------------------------------------------
// SessionConfig builder — maps ProjectConfig into the protocol-level config.
// Exported for unit tests + for the banner/dispatch layers to reflect what
// the backend will actually see without duplicating the precedence rules.
// ---------------------------------------------------------------------------

/**
 * Build a SessionConfig that reflects the per-channel ProjectConfig:
 *
 *   - project.projectDir          → sessionConfig.cwd
 *   - project.model               → sessionConfig.model
 *   - project.systemPrompt        → sessionConfig.systemPrompt
 *   - project.allowedTools        → sessionConfig.allowedTools
 *   - project.mcpServers (subset) → sessionConfig.mcpServers
 *   - project.claudeConfigDir     → sessionConfig.env.CLAUDE_CONFIG_DIR
 *   - project.env (freeform)      → merged into sessionConfig.env
 *   - overlay                     → shallow-merged on top of everything
 *
 * The overlay wins so callers (e.g. /switch, future session resume) can
 * override specific fields without having to rebuild the full map.
 */
export function buildSessionConfigFromProject(
  project: ProjectConfig,
  overlay?: Partial<SessionConfig>,
): SessionConfig {
  const env: Record<string, string> = { ...project.env }
  if (project.claudeConfigDir) {
    // Claude SDK reads CLAUDE_CONFIG_DIR at invocation time. Non-claude
    // backends ignore it, so setting it unconditionally does no harm and
    // keeps the mapping uniform across backends that might one day learn
    // to honour it.
    env.CLAUDE_CONFIG_DIR = project.claudeConfigDir
  }
  const base: SessionConfig = {
    cwd: project.projectDir,
    permissionMode: project.permissionMode as PermissionMode,
    ...(project.model ? { model: project.model } : {}),
    ...(project.systemPrompt ? { systemPrompt: project.systemPrompt } : {}),
    ...(project.allowedTools ? { allowedTools: project.allowedTools } : {}),
    ...(project.resolvedMcpServers
      ? { mcpServers: project.resolvedMcpServers }
      : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  }
  return { ...base, ...overlay }
}

// ---------------------------------------------------------------------------
// Default host-factory — production wiring
// ---------------------------------------------------------------------------

function defaultBuildHost(opts: BuildHostOpts): HostPair {
  const backend = createBackend({ backend: opts.project.backend })
  const subagentManager = new SubagentManager()
  const host = createSessionHost({
    backend,
    config: opts.sessionConfig,
    subagentManager,
    currentBackend: opts.project.backend as SessionOrigin,
    close: () => {
      try {
        backend.close()
      } catch {
        // already closed
      }
    },
  })
  return { host, backend }
}
