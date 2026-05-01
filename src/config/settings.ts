/**
 * Bantai Settings Loader
 *
 * Resolves persistent user settings from multiple sources with explicit
 * precedence:
 *
 *   1. CLI flags                    (highest priority — in-memory only)
 *   2. .bantai/settings.json        (project root)
 *   3. ~/.bantai/settings.json      (global)
 *   4. ~/.claude/settings.json      (read-only Claude Code fallback)
 *   5. Built-in defaults            (lowest priority)
 *
 * Each resolved key tracks its provenance so `/settings` can explain where
 * every value came from. Array-valued keys (permissions, MCP servers) are
 * concatenated across scopes and deduplicated rather than overridden.
 *
 * Malformed files are never fatal — they produce a `log.warn` and the loader
 * falls through to the next scope.
 */

import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { log } from "../utils/logger"
import type { PermissionMode } from "../protocol/types"
import {
  isKnownPermissionMode,
  listPermissionModesForCli,
} from "../protocol/permission-modes"
import { isKnownBackendId, knownBackendIds, type BackendId } from "../protocol/registry"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-export for downstream callers that imported BackendId from here.
export type { BackendId }

export interface StatusLineSetting {
  type: "command"
  command: string
  padding?: number
}

/**
 * The minimum viable persisted settings schema. All keys are optional —
 * unset keys fall through to the next scope or a built-in default.
 *
 * Extend this interface (and `DEFAULTS` below) when adding a new setting.
 * `SCALAR_KEYS` and `ARRAY_KEYS` drive the merge strategy automatically,
 * so adding a key means updating one of those lists too.
 */
export interface BantaiConfig {
  theme?: string
  model?: string
  backend?: BackendId
  permissionMode?: PermissionMode
  statusLine?: StatusLineSetting
  /** Native status bar preset id (e.g. "default", "minimal", "detailed"). */
  statusBar?: string
  vimMode?: boolean
  showCost?: boolean
  showTokens?: boolean
  debug?: boolean
  /**
   * Provider config for the bantai-internal LLM service (summaries, titles,
   * recaps, compaction). Validated lazily by `src/services/llm/config.ts` —
   * we keep the type loose here so a malformed/forward-compatible block in
   * the settings file never crashes startup.
   */
  llm?: Record<string, unknown>
  /** Array settings — merged + deduplicated across scopes. */
  permissions?: string[]
  mcpServers?: Record<string, unknown>
}

/** Where a resolved setting came from. */
export type SettingSource =
  | "cli"
  | "project"
  | "global"
  | "claude-fallback"
  | "default"

export interface ResolvedSetting<T> {
  value: T
  source: SettingSource
}

/** Full resolved config with per-key source provenance. */
export interface ResolvedConfig {
  /** Flat config values — what the rest of the app consumes. */
  values: Required<Pick<BantaiConfig, "theme" | "statusBar" | "vimMode" | "showCost" | "showTokens" | "debug">>
    & Omit<BantaiConfig, "theme" | "statusBar" | "vimMode" | "showCost" | "showTokens" | "debug">
  /** Per-key source — tells `/settings` where each value came from. */
  sources: Partial<Record<keyof BantaiConfig, SettingSource>>
  /** Paths of every scope we considered, whether they existed, and whether parsing succeeded. */
  scopes: {
    project: ScopeInfo
    global: ScopeInfo
    claude: ScopeInfo
  }
}

export interface ScopeInfo {
  path: string
  exists: boolean
  parsed: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Built-in defaults
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  theme: "default-dark",
  statusBar: "claude-compat",
  vimMode: false,
  showCost: true,
  showTokens: true,
  debug: false,
} as const

/**
 * Scalar keys — walk scopes top-down, first-hit wins.
 * Array keys (`permissions`, `mcpServers`) are handled separately below.
 */
const SCALAR_KEYS = [
  "theme",
  "model",
  "backend",
  "permissionMode",
  "statusLine",
  "statusBar",
  "vimMode",
  "showCost",
  "showTokens",
  "debug",
  "llm",
] as const

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve the home directory, preferring $HOME so tests can override. */
function resolveHome(): string {
  return process.env.HOME || os.homedir()
}

/** Canonical paths used by the loader. Exposed for tests / the /settings UI. */
export function getConfigPaths(opts?: { cwd?: string; home?: string }) {
  const home = opts?.home ?? resolveHome()
  const cwd = opts?.cwd ?? process.cwd()
  return {
    project: path.join(cwd, ".bantai", "settings.json"),
    global: path.join(home, ".bantai", "settings.json"),
    claude: path.join(home, ".claude", "settings.json"),
  }
}

export interface LoadOptions {
  /** Override the working directory (defaults to `process.cwd()`). */
  cwd?: string
  /** Override the home directory (used by tests). */
  home?: string
  /** Values sourced from CLI flags — they always win. */
  cliOverrides?: Partial<BantaiConfig>
}

/**
 * Load + merge all settings scopes into a single resolved config.
 * Never throws — malformed files are logged and skipped.
 */
export async function loadConfig(opts: LoadOptions = {}): Promise<ResolvedConfig> {
  const paths = getConfigPaths(opts)

  const project = await readScope(paths.project)
  const global = await readScope(paths.global)
  const claude = await readScope(paths.claude)

  return mergeScopes(project, global, claude, opts)
}

/**
 * Synchronous variant used by hot-path callers (status line, diagnostics)
 * that must return a config value immediately. Same precedence + graceful
 * failure semantics as `loadConfig`.
 */
export function loadConfigSync(opts: LoadOptions = {}): ResolvedConfig {
  const paths = getConfigPaths(opts)

  const project = readScopeSync(paths.project)
  const global = readScopeSync(paths.global)
  const claude = readScopeSync(paths.claude)

  return mergeScopes(project, global, claude, opts)
}

function mergeScopes(
  project: ScopeInfo & { data?: BantaiConfig },
  global: ScopeInfo & { data?: BantaiConfig },
  claude: ScopeInfo & { data?: BantaiConfig },
  opts: LoadOptions,
): ResolvedConfig {
  // Compose layered view (lowest to highest priority) for merging.
  // Arrays concatenate across all scopes (claude -> global -> project -> cli).
  // Scalars use first-hit from top (cli -> project -> global -> claude -> default).
  const sources: Partial<Record<keyof BantaiConfig, SettingSource>> = {}
  const out: BantaiConfig = {}

  // Scalar resolution: walk top-down, first non-undefined wins.
  const scalarLayers: Array<{ source: SettingSource; data: BantaiConfig }> = [
    { source: "cli", data: (opts.cliOverrides ?? {}) as BantaiConfig },
    { source: "project", data: project.data ?? {} },
    { source: "global", data: global.data ?? {} },
    { source: "claude-fallback", data: claude.data ?? {} },
  ]

  for (const key of SCALAR_KEYS) {
    for (const layer of scalarLayers) {
      const v = (layer.data as Record<string, unknown>)[key]
      if (v !== undefined) {
        ;(out as Record<string, unknown>)[key] = v
        sources[key] = layer.source
        break
      }
    }
  }

  // Array merge: concatenate + dedupe (keep first-seen).
  // Permissions are strings; mcpServers is an object keyed by server name.
  {
    const merged: string[] = []
    const seen = new Set<string>()
    let anySource: SettingSource | undefined
    // Merge in priority order so earlier entries win on conflict.
    for (const layer of scalarLayers) {
      const arr = (layer.data as Record<string, unknown>)["permissions"]
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === "string" && !seen.has(item)) {
            merged.push(item)
            seen.add(item)
          }
        }
        if (arr.length > 0) anySource = anySource ?? layer.source
      }
    }
    if (merged.length > 0) {
      out.permissions = merged
      sources.permissions = anySource
    }
  }

  {
    const merged: Record<string, unknown> = {}
    let anySource: SettingSource | undefined
    // Walk lowest-priority first so higher layers overwrite on key conflict.
    for (const layer of [...scalarLayers].reverse()) {
      const rec = (layer.data as Record<string, unknown>)["mcpServers"]
      if (rec && typeof rec === "object" && !Array.isArray(rec)) {
        for (const [name, cfg] of Object.entries(rec as Record<string, unknown>)) {
          merged[name] = cfg
          anySource = layer.source
        }
      }
    }
    if (Object.keys(merged).length > 0) {
      out.mcpServers = merged
      sources.mcpServers = anySource
    }
  }

  // Apply defaults for required scalar keys that nothing supplied.
  if (out.theme === undefined) { out.theme = DEFAULTS.theme; sources.theme = "default" }
  if (out.statusBar === undefined) { out.statusBar = DEFAULTS.statusBar; sources.statusBar = "default" }
  if (out.vimMode === undefined) { out.vimMode = DEFAULTS.vimMode; sources.vimMode = "default" }
  if (out.showCost === undefined) { out.showCost = DEFAULTS.showCost; sources.showCost = "default" }
  if (out.showTokens === undefined) { out.showTokens = DEFAULTS.showTokens; sources.showTokens = "default" }
  if (out.debug === undefined) { out.debug = DEFAULTS.debug; sources.debug = "default" }

  return {
    values: out as ResolvedConfig["values"],
    sources,
    scopes: { project, global, claude },
  }
}

/**
 * Write a single scalar setting to `~/.bantai/settings.json`, creating the
 * file and directory if needed. Other keys in the file are preserved.
 *
 * Returns the path written to so the caller can report it.
 */
export async function writeGlobalSetting(
  key: keyof BantaiConfig,
  value: unknown,
  opts?: { home?: string },
): Promise<string> {
  const home = opts?.home ?? resolveHome()
  const dir = path.join(home, ".bantai")
  const file = path.join(dir, "settings.json")

  // Load existing content (if any) so we don't clobber unrelated keys.
  let existing: Record<string, unknown> = {}
  const current = await readScope(file)
  if (current.data) existing = { ...current.data }

  if (value === undefined || value === null) {
    delete existing[key]
  } else {
    existing[key] = value
  }

  // Ensure directory exists, then write atomically via Bun.write.
  await Bun.write(file, JSON.stringify(existing, null, 2) + "\n")
  return file
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

/**
 * Parse a raw string (as typed into `/settings set <key> <value>`) into
 * the right JSON type for `key`. Throws on obviously-wrong values so the
 * command surface can show a friendly error without corrupting the file.
 */
export function coerceSettingValue(key: keyof BantaiConfig, raw: string): unknown {
  const trimmed = raw.trim()
  switch (key) {
    case "vimMode":
    case "showCost":
    case "showTokens":
    case "debug": {
      if (trimmed === "true" || trimmed === "1" || trimmed === "yes") return true
      if (trimmed === "false" || trimmed === "0" || trimmed === "no") return false
      throw new Error(`expected boolean for ${key}, got "${raw}"`)
    }
    case "theme":
    case "statusBar":
    case "model":
      return trimmed
    case "backend": {
      if (!isKnownBackendId(trimmed)) {
        throw new Error(`expected one of ${knownBackendIds().join("|")} for backend, got "${raw}"`)
      }
      return trimmed
    }
    case "permissionMode": {
      if (!isKnownPermissionMode(trimmed)) {
        throw new Error(
          `expected one of ${listPermissionModesForCli()} for permissionMode, got "${raw}"`,
        )
      }
      return trimmed
    }
    case "llm":
    case "statusLine":
    case "permissions":
    case "mcpServers": {
      // These take JSON. Parse and validate shape best-effort.
      try {
        return JSON.parse(trimmed)
      } catch {
        throw new Error(`expected valid JSON for ${key}`)
      }
    }
    default:
      // Unknown key — return raw string; caller decides what to do.
      return trimmed
  }
}

/** Pretty-print a value for inline display in `/settings`. */
export function formatSettingValue(value: unknown): string {
  if (value === undefined) return "(unset)"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function readScope(filePath: string): Promise<ScopeInfo & { data?: BantaiConfig }> {
  const file = Bun.file(filePath)
  const exists = await file.exists()
  if (!exists) {
    return { path: filePath, exists: false, parsed: false }
  }
  try {
    const raw = await file.text()
    return parseScope(filePath, raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn("Failed to parse settings file, using defaults", { path: filePath, error: msg })
    return { path: filePath, exists: true, parsed: false, error: msg }
  }
}

function readScopeSync(filePath: string): ScopeInfo & { data?: BantaiConfig } {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, exists: false, parsed: false }
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    return parseScope(filePath, raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn("Failed to parse settings file, using defaults", { path: filePath, error: msg })
    return { path: filePath, exists: true, parsed: false, error: msg }
  }
}

function parseScope(filePath: string, raw: string): ScopeInfo & { data?: BantaiConfig } {
  if (!raw.trim()) {
    // Empty file: treat as present but no data.
    return { path: filePath, exists: true, parsed: true, data: {} }
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      log.warn("Settings file is not a JSON object, ignoring", { path: filePath })
      return { path: filePath, exists: true, parsed: false, error: "not an object" }
    }
    return { path: filePath, exists: true, parsed: true, data: parsed as BantaiConfig }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn("Failed to parse settings file, using defaults", { path: filePath, error: msg })
    return { path: filePath, exists: true, parsed: false, error: msg }
  }
}
