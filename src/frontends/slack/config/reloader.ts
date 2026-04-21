/**
 * ConfigReloader — watches `slack.json` on disk and hot-swaps the
 * running server's resolved config when it changes.
 *
 * Design doc: team/bantai-slack-dynamic-config.md
 *
 * Invariant: the running server always reflects exactly one
 * `ResolvedSlackConfig` at a time, and that config is always the
 * most-recent config that passed validation. A reload that fails
 * parse / zod keeps the previous config live.
 *
 * Pipeline on every watcher fire (or poll tick, or forceReload):
 *
 *   debounce 300ms  →  readFile  →  parseJsonc  →  zod  →
 *   resolveSlackConfig  →  diff  →  partition(restart-required)  →
 *   swap current config ref  →  notify listeners
 *
 * Restart-required fields (workspace.*, store_path) are detected in the
 * diff and surfaced to listeners without preventing the swap of the
 * hot-swappable parts (channels, defaults, mcp_servers). The consumer
 * decides whether to log a warn — the reloader itself stays quiet so
 * a future in-process token-rotation can opt out of the warning.
 *
 * Watcher quirks covered:
 *   - macOS fires multiple `change` events per write → debounced.
 *   - Editors doing rename-then-swap (vim `:w`, VS Code atomic saves)
 *     fire a `rename` event pointing at a path that then re-exists on
 *     the new inode; we re-install the watcher on re-stat.
 *   - `fs.watch` can silently die (inode reuse, FS remount); a 30s
 *     stat-mtime poll is a belt-and-braces fallback.
 */

import { type FSWatcher, watch as fsWatch } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { log } from "../../../utils/logger"
import { parseSlackConfig } from "./loader"
import {
  type DefaultsConfig,
  type ResolvedSlackConfig,
  resolveSlackConfig,
} from "./schema"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"

// ---------------------------------------------------------------------------
// Diff shape
// ---------------------------------------------------------------------------

export interface ConfigDiff {
  channels: {
    added: string[]
    removed: string[]
    /** ids whose body (excluding `name`) differs from the prior config. */
    changed: string[]
    /** ids where only `name` differs (cosmetic — still "changed" but flagged separately). */
    renamed: string[]
  }
  /** Dotted paths of defaults fields that changed, e.g. "defaults.verbosity". */
  defaultsChanged: string[]
  mcpServers: {
    added: string[]
    removed: string[]
    changed: string[]
  }
  /** Workspace fields that differ (bot_token, port, …). All are restart-required. */
  workspaceChanged: string[]
  /** True when `store_path` differs. Restart-required. */
  storeChanged: boolean
  /** True when nothing actually changed (byte-identical or semantically equivalent). */
  empty: boolean
}

/** Fields that cannot be hot-swapped; changing them logs a warn and leaves the workspace half of the config untouched. */
export type RestartRequiredField =
  | "workspace.mode"
  | "workspace.bot_token"
  | "workspace.app_token"
  | "workspace.signing_secret"
  | "workspace.webhook_path"
  | "workspace.port"
  | "workspace.slack_api_url"
  | "store_path"

// ---------------------------------------------------------------------------
// Reload outcome + listeners
// ---------------------------------------------------------------------------

export type ReloadReason = "watcher" | "mcp-write" | "control-command" | "poll" | "manual"

export type ReloadOutcome =
  | {
      kind: "applied"
      diff: ConfigDiff
      restartRequired: RestartRequiredField[]
      next: ResolvedSlackConfig
    }
  | { kind: "noop"; reason: "byte-identical" | "empty-diff" }
  | { kind: "rejected"; errors: string[] }

export interface AppliedEvent {
  diff: ConfigDiff
  restartRequired: RestartRequiredField[]
  next: ResolvedSlackConfig
  previous: ResolvedSlackConfig
  reason: ReloadReason
}

export interface RejectedEvent {
  errors: string[]
  reason: ReloadReason
}

export type AppliedListener = (event: AppliedEvent) => void
export type RejectedListener = (event: RejectedEvent) => void

// ---------------------------------------------------------------------------
// Reloader interface + factory
// ---------------------------------------------------------------------------

export interface ConfigReloader {
  /** Current applied config. Always reflects the latest successful load. */
  current(): ResolvedSlackConfig

  /** Register an apply-listener; returns unsubscribe. */
  onApplied(fn: AppliedListener): () => void

  /** Register a reject-listener; returns unsubscribe. */
  onRejected(fn: RejectedListener): () => void

  /**
   * Force a reload now, bypassing the debouncer. Returns the outcome.
   * Used by `bantai slack doctor --check-reload` and by any future
   * `/bantai reload` escape hatch.
   */
  reloadNow(reason: ReloadReason): Promise<ReloadOutcome>

  /** Stop watching + polling. Idempotent. */
  close(): void
}

export interface CreateConfigReloaderOpts {
  /** Path to the file being watched. "<inline>" disables watching entirely. */
  path: string
  /** Initial config, already loaded by the caller on boot. */
  initial: ResolvedSlackConfig
  /** Environment for SecretRef + storePath resolution. */
  env?: NodeJS.ProcessEnv
  /** Debounce window; 300ms by default. Bypassed by `reloadNow`. */
  debounceMs?: number
  /** Stat-poll interval for watcher-died fallback; 30s by default. 0 disables. */
  pollIntervalMs?: number
  /**
   * When true, do not install any filesystem watcher or poller. Used by the
   * `<inline>` config path (tests, minislack harnesses) where there's no
   * file on disk.
   */
  disableWatcher?: boolean
}

const DEFAULT_DEBOUNCE_MS = 300
const DEFAULT_POLL_MS = 30_000

export function createConfigReloader(opts: CreateConfigReloaderOpts): ConfigReloader {
  const env = opts.env ?? process.env
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS
  const path = opts.path
  const watchEnabled =
    !opts.disableWatcher && path !== "<inline>" && path.length > 0

  let current: ResolvedSlackConfig = opts.initial
  let lastHash: string | null = null
  let lastMtimeMs: number | null = null
  let watcher: FSWatcher | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let reloadInFlight = false
  const queued: ReloadReason[] = []
  const appliedListeners = new Set<AppliedListener>()
  const rejectedListeners = new Set<RejectedListener>()

  function scheduleDebouncedReload(reason: ReloadReason): void {
    if (closed) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void runReload(reason)
    }, debounceMs)
  }

  async function runReload(reason: ReloadReason): Promise<ReloadOutcome> {
    if (closed) return { kind: "noop", reason: "empty-diff" }
    if (reloadInFlight) {
      queued.push(reason)
      return { kind: "noop", reason: "empty-diff" }
    }
    reloadInFlight = true
    try {
      const outcome = await readAndApply(reason)
      return outcome
    } finally {
      reloadInFlight = false
      if (queued.length > 0) {
        // Collapse queued reasons — run one follow-up that represents any
        // fires that landed mid-reload. Preserve the first queued reason.
        const next = queued.shift()!
        queued.length = 0
        setImmediate(() => void runReload(next))
      }
    }
  }

  async function readAndApply(reason: ReloadReason): Promise<ReloadOutcome> {
    if (!watchEnabled && reason !== "manual" && reason !== "mcp-write") {
      // Inline/no-path reloaders only act on explicit manual / mcp writes
      // that hand the new config in via `setCurrent`. The reader path is
      // a no-op in that case.
      return { kind: "noop", reason: "empty-diff" }
    }
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch (err) {
      const msg = `failed to read ${path}: ${String(err)}`
      log.error(`slack reload: ${msg}`)
      notifyRejected({ errors: [msg], reason })
      return { kind: "rejected", errors: [msg] }
    }

    const hash = hashString(raw)
    if (hash === lastHash) {
      return { kind: "noop", reason: "byte-identical" }
    }

    const parseErrors: ParseError[] = []
    const parsedJson: unknown = parseJsonc(raw, parseErrors, {
      allowTrailingComma: true,
      disallowComments: false,
    })
    if (parseErrors.length > 0) {
      const errs = parseErrors.map(
        (e) => `JSONC parse error code ${e.error} at offset ${e.offset}`,
      )
      log.error(`slack reload: invalid JSONC in ${path}: ${errs.join("; ")}`)
      notifyRejected({ errors: errs, reason })
      return { kind: "rejected", errors: errs }
    }

    let next: ResolvedSlackConfig
    try {
      const parsed = parseSlackConfig(parsedJson, path)
      next = resolveSlackConfig(parsed, path, env)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errs = msg.split("\n").map((s) => s.trim()).filter(Boolean)
      log.error(`slack reload: validation failed for ${path}: ${msg}`)
      notifyRejected({ errors: errs, reason })
      return { kind: "rejected", errors: errs }
    }

    // Parse succeeded: record hash so subsequent byte-identical
    // re-fires short-circuit. Do this BEFORE apply so a listener that
    // throws doesn't trap us in a re-parse loop.
    lastHash = hash

    const previous = current
    const diff = diffConfigs(previous, next)
    if (diff.empty) {
      return { kind: "noop", reason: "empty-diff" }
    }
    const restartRequired = restartRequiredFieldsFromDiff(diff)

    current = next
    for (const fn of Array.from(appliedListeners)) {
      try {
        fn({ diff, restartRequired, next, previous, reason })
      } catch (err) {
        log.error(`slack reload: applied-listener threw: ${String(err)}`)
      }
    }
    return { kind: "applied", diff, restartRequired, next }
  }

  function notifyRejected(event: RejectedEvent): void {
    for (const fn of Array.from(rejectedListeners)) {
      try {
        fn(event)
      } catch (err) {
        log.error(`slack reload: rejected-listener threw: ${String(err)}`)
      }
    }
  }

  function installWatcher(): void {
    if (!watchEnabled || closed) return
    try {
      watcher = fsWatch(path, { persistent: false }, (eventType) => {
        if (closed) return
        if (eventType === "rename") {
          // Editor atomic-save (vim `:w`, VS Code): the old inode is gone,
          // the path points at a new file. Tear down + re-install.
          log.debug(`slack reload: watcher saw rename on ${path}, re-installing`)
          if (watcher) {
            try {
              watcher.close()
            } catch {
              /* ignore */
            }
            watcher = null
          }
          scheduleDebouncedReload("watcher")
          setTimeout(() => installWatcher(), debounceMs + 50)
          return
        }
        scheduleDebouncedReload("watcher")
      })
      watcher.on("error", (err) => {
        log.warn(`slack reload: watcher errored: ${String(err)}`)
        if (watcher) {
          try {
            watcher.close()
          } catch {
            /* ignore */
          }
          watcher = null
        }
        // Retry install after a short backoff. The poll fallback still
        // catches changes while we're down.
        setTimeout(() => installWatcher(), 2000)
      })
    } catch (err) {
      log.warn(
        `slack reload: failed to install watcher on ${path}: ${String(err)}. Polling only.`,
      )
      watcher = null
    }
  }

  async function pollTick(): Promise<void> {
    if (closed || !watchEnabled) return
    try {
      const st = await stat(path)
      const mtime = st.mtimeMs
      if (lastMtimeMs === null) {
        lastMtimeMs = mtime
      } else if (mtime !== lastMtimeMs) {
        lastMtimeMs = mtime
        scheduleDebouncedReload("poll")
      }
    } catch (err) {
      log.debug(`slack reload: poll stat failed for ${path}: ${String(err)}`)
    } finally {
      if (!closed && pollMs > 0) {
        pollTimer = setTimeout(() => void pollTick(), pollMs)
      }
    }
  }

  // Initial hash of the file (if we can read it) so the first watcher
  // fire doesn't trigger a spurious apply. If the read fails, leave
  // lastHash null — the first real reload will fill it in.
  if (watchEnabled) {
    void readFile(path, "utf8")
      .then((raw) => {
        lastHash = hashString(raw)
      })
      .catch((err) => {
        log.debug(
          `slack reload: initial hash read failed for ${path}: ${String(err)}`,
        )
      })
    void stat(path)
      .then((st) => {
        lastMtimeMs = st.mtimeMs
      })
      .catch(() => {
        /* non-fatal */
      })
    installWatcher()
    if (pollMs > 0) {
      pollTimer = setTimeout(() => void pollTick(), pollMs)
    }
  }

  return {
    current: () => current,
    onApplied(fn) {
      appliedListeners.add(fn)
      return () => appliedListeners.delete(fn)
    },
    onRejected(fn) {
      rejectedListeners.add(fn)
      return () => rejectedListeners.delete(fn)
    },
    reloadNow: (reason) => runReload(reason),
    close() {
      if (closed) return
      closed = true
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = null
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = null
      if (watcher) {
        try {
          watcher.close()
        } catch {
          /* ignore */
        }
        watcher = null
      }
      appliedListeners.clear()
      rejectedListeners.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Diff logic — pure, exported for unit tests.
// ---------------------------------------------------------------------------

export function diffConfigs(
  prev: ResolvedSlackConfig,
  next: ResolvedSlackConfig,
): ConfigDiff {
  const diff: ConfigDiff = {
    channels: { added: [], removed: [], changed: [], renamed: [] },
    defaultsChanged: [],
    mcpServers: { added: [], removed: [], changed: [] },
    workspaceChanged: [],
    storeChanged: false,
    empty: true,
  }

  // Workspace fields — flat compare. We only look at resolved fields we
  // actually consume; the `source` field is implicit.
  const wsKeys: (keyof ResolvedSlackConfig["workspace"])[] = [
    "mode",
    "botToken",
    "appToken",
    "signingSecret",
    "webhookPath",
    "port",
    "slackApiUrl",
  ]
  for (const k of wsKeys) {
    if (prev.workspace[k] !== next.workspace[k]) {
      diff.workspaceChanged.push(k)
    }
  }

  // Defaults — compare every key on the Defaults schema. Uses a shallow
  // equality that works for scalars + arrays of scalars (approvers) by
  // JSON-serialising. Deep-equal dependency pulled out — the defaults
  // schema is shallow enough that this is cheap and correct.
  const prevDefaults = prev.defaults as unknown as Record<string, unknown>
  const nextDefaults = next.defaults as unknown as Record<string, unknown>
  const allDefaultsKeys = new Set([
    ...Object.keys(prevDefaults),
    ...Object.keys(nextDefaults),
  ])
  for (const k of allDefaultsKeys) {
    if (!shallowJsonEqual(prevDefaults[k], nextDefaults[k])) {
      diff.defaultsChanged.push(`defaults.${k}`)
    }
  }

  // Channels — match by id. Renames count as "changed" but also land in
  // `renamed` so listeners can surface them specifically.
  const prevById = new Map(prev.channels.map((c) => [c.id, c]))
  const nextById = new Map(next.channels.map((c) => [c.id, c]))
  for (const id of prevById.keys()) {
    if (!nextById.has(id)) diff.channels.removed.push(id)
  }
  for (const [id, nextCh] of nextById) {
    const prevCh = prevById.get(id)
    if (!prevCh) {
      diff.channels.added.push(id)
      continue
    }
    const bodyChanged = !shallowJsonEqual(
      stripField(prevCh, "name"),
      stripField(nextCh, "name"),
    )
    const nameChanged = prevCh.name !== nextCh.name
    if (bodyChanged) diff.channels.changed.push(id)
    else if (nameChanged) diff.channels.renamed.push(id)
  }

  // mcp_servers registry.
  const allMcpKeys = new Set([
    ...Object.keys(prev.mcpServers),
    ...Object.keys(next.mcpServers),
  ])
  for (const name of allMcpKeys) {
    const p = prev.mcpServers[name]
    const n = next.mcpServers[name]
    if (p === undefined && n !== undefined) diff.mcpServers.added.push(name)
    else if (p !== undefined && n === undefined) diff.mcpServers.removed.push(name)
    else if (!shallowJsonEqual(p, n)) diff.mcpServers.changed.push(name)
  }

  diff.storeChanged = prev.storePath !== next.storePath

  diff.empty =
    diff.workspaceChanged.length === 0 &&
    diff.defaultsChanged.length === 0 &&
    diff.channels.added.length === 0 &&
    diff.channels.removed.length === 0 &&
    diff.channels.changed.length === 0 &&
    diff.channels.renamed.length === 0 &&
    diff.mcpServers.added.length === 0 &&
    diff.mcpServers.removed.length === 0 &&
    diff.mcpServers.changed.length === 0 &&
    !diff.storeChanged

  return diff
}

/** Map a `ConfigDiff` to its restart-required subset. */
export function restartRequiredFieldsFromDiff(
  diff: ConfigDiff,
): RestartRequiredField[] {
  const out: RestartRequiredField[] = []
  for (const k of diff.workspaceChanged) {
    // Map resolved camelCase key back to the dotted snake_case field name
    // used in the doc + user-facing logs.
    switch (k) {
      case "mode":
        out.push("workspace.mode")
        break
      case "botToken":
        out.push("workspace.bot_token")
        break
      case "appToken":
        out.push("workspace.app_token")
        break
      case "signingSecret":
        out.push("workspace.signing_secret")
        break
      case "webhookPath":
        out.push("workspace.webhook_path")
        break
      case "port":
        out.push("workspace.port")
        break
      case "slackApiUrl":
        out.push("workspace.slack_api_url")
        break
    }
  }
  if (diff.storeChanged) out.push("store_path")
  return out
}

// ---------------------------------------------------------------------------
// Summary rendering — used by the notify-channel + log summarizer.
// ---------------------------------------------------------------------------

export interface FormatDiffOpts {
  /** Source path for the header line. */
  source: string
  /** When true, render Slack-mrkdwn bullets; when false, plain log-friendly text. */
  mrkdwn?: boolean
  /** next config — needed to render friendly channel-add bullets. */
  next: ResolvedSlackConfig
  /** prev config — needed to render friendly channel-remove bullets (we show old project_dir). */
  previous: ResolvedSlackConfig
  restartRequired: RestartRequiredField[]
}

export function formatDiffSummary(diff: ConfigDiff, opts: FormatDiffOpts): string {
  const bullets: string[] = []
  const code = opts.mrkdwn ? (s: string) => `\`${s}\`` : (s: string) => `\`${s}\``

  for (const id of diff.channels.added) {
    const ch = opts.next.channels.find((c) => c.id === id)
    const label = ch?.name ? `#${ch.name}` : id
    const dir = ch?.project_dir ?? "<default cwd>"
    const backend = ch?.backend ?? opts.next.defaults.backend
    bullets.push(`+1 channel: ${label} → ${code(dir)} (${backend})`)
  }
  for (const id of diff.channels.removed) {
    const ch = opts.previous.channels.find((c) => c.id === id)
    const label = ch?.name ? `#${ch.name} (${id})` : id
    bullets.push(`-1 channel: ${label}`)
  }
  for (const id of diff.channels.changed) {
    const ch = opts.next.channels.find((c) => c.id === id)
    const label = ch?.name ? `#${ch.name}` : id
    bullets.push(`~ channel: ${label} config updated`)
  }
  for (const id of diff.channels.renamed) {
    const prevCh = opts.previous.channels.find((c) => c.id === id)
    const nextCh = opts.next.channels.find((c) => c.id === id)
    bullets.push(
      `~ channel renamed: ${prevCh?.name ?? id} → ${nextCh?.name ?? id}`,
    )
  }
  for (const path of diff.defaultsChanged) {
    const key = path.replace(/^defaults\./, "") as keyof DefaultsConfig
    const from = (opts.previous.defaults as Record<string, unknown>)[key]
    const to = (opts.next.defaults as Record<string, unknown>)[key]
    bullets.push(`${path}: ${redactValue(from)} → ${redactValue(to)}`)
  }
  for (const name of diff.mcpServers.added) bullets.push(`+ mcp_servers.${name}`)
  for (const name of diff.mcpServers.removed) bullets.push(`- mcp_servers.${name}`)
  for (const name of diff.mcpServers.changed) bullets.push(`~ mcp_servers.${name}`)

  if (opts.restartRequired.length > 0) {
    bullets.push(
      `:warning: restart required for: ${opts.restartRequired.join(", ")}`,
    )
  }

  const header = opts.mrkdwn
    ? `:arrows_counterclockwise: config reloaded from ${code(opts.source)}`
    : `config reloaded from ${opts.source}`
  if (bullets.length === 0) return header
  return [header, ...bullets.map((b) => `• ${b}`)].join("\n")
}

export function formatRejectionSummary(
  errors: string[],
  opts: { source: string; mrkdwn?: boolean },
): string {
  const header = opts.mrkdwn
    ? `:warning: config reload rejected — file unchanged in memory (${opts.source})`
    : `config reload rejected for ${opts.source}`
  if (errors.length === 0) return header
  return [header, ...errors.map((e) => `• ${e}`)].join("\n")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashString(s: string): string {
  return createHash("sha1").update(s).digest("hex")
}

/**
 * JSON.stringify-based structural equality. Correct for the shapes we hold
 * in `ResolvedSlackConfig`: scalars, arrays of scalars, and plain objects
 * with no class instances. Order-sensitive — which is fine because the
 * resolver always preserves declaration order.
 */
function shallowJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function stripField<T extends Record<string, unknown>>(
  obj: T,
  field: keyof T,
): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...obj }
  delete clone[field as string]
  return clone
}

/**
 * Redact values that look like credentials before rendering into a log or
 * Slack message. Currently limited to `env` blocks — secrets should never
 * hit `defaults.*` anyway, but we belt-and-brace so a future schema
 * addition can't accidentally leak.
 */
function redactValue(v: unknown): string {
  if (v === undefined) return "<unset>"
  if (v === null) return "null"
  if (typeof v === "string") return JSON.stringify(v)
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return "<unserialisable>"
  }
}
