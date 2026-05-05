/**
 * Backend Registry — single source of truth for the set of backends bantai
 * knows how to instantiate at runtime.
 *
 * One descriptor per backend captures:
 *   - identity         (id, displayName, description)
 *   - instantiation    (acpPreset OR factory, mutually exclusive)
 *   - availability     (isAvailable probe — "is the binary on PATH?")
 *   - surface flags    (exposeAsCliSubcommand, requiresExtraConfig)
 *
 * Adding a new ACP-backed backend is a single registry entry — the rest of
 * the system (CLI subcommands, help text, friendly names, slash-command
 * validators, slack routing, config validation, A/B picker) all derive from
 * this list. Adding a new non-ACP backend is the registry entry plus the
 * adapter file itself.
 *
 * Used by:
 *   - `bantai` CLI: `program.ts` derives subcommands from `listCliSubcommandBackends()`
 *   - `--backend` flag help: `options.ts` derives the comma list from `knownBackendIds()`
 *   - `/backend` slash command: lists everything in BACKEND_REGISTRY
 *   - `/switch <backend>`: validates against `isKnownBackendId()` then calls `instantiateBackend()`
 *   - `/ab` target picker: `isKnownBackendId()` + `knownBackendIds()`
 *   - `friendlyBackendName()` in `protocol/models.ts`: descriptor lookup
 *   - subagent definition parser: `isKnownBackendId()`
 *   - Slack routing + config validators: `isKnownBackendId()`
 *
 * `isAvailable()` is intentionally a fast best-effort check (binary on PATH
 * for ACP-based backends, always-true for everything else). It exists so the
 * `/backend` listing can highlight which backends will actually start, but it
 * never prevents a switch — the user might have the binary on a non-default
 * PATH, in which case they're free to try anyway and read the resulting
 * adapter error.
 */

import { ClaudeAdapter } from "../backends/claude/adapter"
import { CodexAdapter } from "../backends/codex/adapter"
import { AcpAdapter } from "../backends/acp/adapter"
import { MockAdapter } from "../backends/mock/adapter"
import type { AcpPreset } from "../backends/acp/types"
import type { AgentBackend, Block, SessionInfo, SessionResumeSummary } from "./types"
import type { PermissionMode } from "./permission-modes"
import {
  findCodexSessionFile,
  findGeminiSessionFile,
  listClaudeSessionsFromDisk,
  listCodexSessionsFromDisk,
  listGeminiSessionsFromDisk,
  parseCodexSession,
  parseCodexSessionWithSummary,
  parseGeminiSession,
  parseGeminiSessionWithSummary,
} from "../session/cross-backend"
import { readSessionHistory } from "../backends/claude/session-reader"
import { log } from "../utils/logger"

/**
 * Identifier used at the CLI / slash command / config boundary.
 *
 * Kept as a plain string alias because the registry is the runtime source of
 * truth — narrowing this to a closed string-literal union historically led to
 * the same set being duplicated (and silently drifting) in multiple files. If
 * you need to validate, call `isKnownBackendId(id)`.
 */
export type BackendId = string

export interface BackendInstantiateOpts {
  acpCommand?: string
  acpArgs?: string[]
}

/**
 * Per-backend handlers for reading session storage off disk.
 *
 * Backends that own a session file format on the local filesystem populate
 * this; the multi-backend session picker iterates the registry to discover
 * them. Backends that don't (e.g. mock, generic acp, copilot) omit it and
 * the picker silently treats them as having zero on-disk sessions.
 */
export interface SessionFileHandlers {
  /**
   * Enumerate sessions visible from `cwd`. May return an empty array when the
   * backend's session directory is missing (first run, never used). MUST NOT
   * throw — wrap any I/O errors and return [].
   */
  listFromDisk: (cwd: string) => SessionInfo[]
  /**
   * Deep-parse a single session for the resume summary (turn count, tool
   * count, token usage). Returns undefined when the session can't be located
   * or parsed. Powers `enrichSessions` in the multi-backend picker so each
   * backend's parser is registered alongside its lister rather than living
   * in a parallel switch.
   */
  parseSummary: (sessionId: string, cwd: string) => SessionResumeSummary | undefined
  /**
   * Read a session's full conversation history as the universal `Block[]`.
   * Used by cross-backend resume: the foreign backend's history is parsed
   * via this handler, then formatted as a context-injection prompt for the
   * destination backend. Returns [] when the session can't be read; the
   * handler is responsible for `log.warn` on missing-file paths.
   */
  readBlocks: (sessionId: string, cwd: string) => Block[]
}

export interface BackendDescriptor {
  id: string
  /** User-facing brand name (matches what `friendlyBackendName()` returns). */
  displayName: string
  /** One-line summary shown in `/backend`. */
  description: string
  /**
   * ACP preset — when present, this backend is constructed by spawning the
   * given command in ACP mode. The factory is automatic; no `factory`
   * function needed. Mutually exclusive with `factory`.
   */
  acpPreset?: AcpPreset
  /**
   * Factory for non-ACP backends (Claude SDK, Codex SDK, mock, generic ACP
   * with a runtime-supplied command). Mutually exclusive with `acpPreset`.
   */
  factory?: (opts: BackendInstantiateOpts) => AgentBackend
  /**
   * True if `bantai <id>` should expose this backend as a Commander
   * subcommand (e.g., `bantai claude`, `bantai qwen`). Off by default —
   * generic-ACP and mock are not first-class CLI verbs.
   */
  exposeAsCliSubcommand?: boolean
  /**
   * Best-effort availability probe. Returns true when the backend's
   * dependencies are satisfied (binary on PATH, etc.). Never blocks on the
   * network. Never throws — wrap probes that might.
   */
  isAvailable: () => boolean
  /** True if this backend requires extra arguments (`--acp-command ...`). */
  requiresExtraConfig?: boolean
  /**
   * Optional on-disk session storage handlers. When present, the backend
   * participates in the multi-backend session picker (Sprint 1 / Cluster 1).
   * Backends that don't store sessions on the local filesystem (mock,
   * generic acp, copilot) omit this.
   */
  sessionFile?: SessionFileHandlers
  /**
   * Backend-level fallback for `SessionConfig.permissionMode` applied at the
   * CLI entry points (TUI launcher, headless `run`) when the user has NOT
   * provided a value via either:
   *   - the `--permission-mode` flag, or
   *   - the `permissionMode` setting in any config scope (project / global /
   *     claude-fallback).
   *
   * Precedence (highest first):
   *   1. CLI `--permission-mode`
   *   2. Settings file (project → global → claude-fallback)
   *   3. `BackendDescriptor.defaultPermissionMode`  ← this field
   *   4. SDK / adapter default (typically "default" — i.e. always prompt)
   *
   * Backends that want the SDK's own default (no opinion at the bantai layer)
   * leave this `undefined`. Today only the Claude backend opts in, defaulting
   * to "auto" so first-time users get the model-classifier permission flow
   * without having to discover it themselves.
   *
   * NOTE: This default is applied at the user-facing CLI entry points only.
   * Programmatic callers (subagents, side-chats) construct their own
   * SessionConfig with an explicit `permissionMode` and bypass this field
   * entirely.
   */
  defaultPermissionMode?: PermissionMode
  /**
   * If true, `setPermissionMode()` is a no-op for the running turn — the
   * adapter only consults `config.permissionMode` when the NEXT turn starts.
   * The TUI cycler (Shift-Tab) gates on this flag during RUNNING so the user
   * isn't tricked into thinking a mid-turn cycle changed the policy of the
   * in-flight turn.
   *
   * Default false: the backend honours mode changes for the running turn.
   *
   * Codex sets this true because approval/sandbox policy is sent per-turn
   * via `turn/start` params; mid-turn `setPermissionMode()` updates
   * `this.config.permissionMode` but the in-flight turn keeps the policy it
   * was started with. Without this flag the status bar swaps instantly while
   * the actual enforcement lags by a turn — Audit §F-23.
   */
  permissionModeAppliesOnNextTurn?: boolean
}

function binaryOnPath(name: string): boolean {
  try {
    return Bun.which(name) !== null
  } catch {
    return false
  }
}

export const BACKEND_REGISTRY: BackendDescriptor[] = [
  {
    id: "claude",
    displayName: "Claude",
    description: "Anthropic Claude via @anthropic-ai/claude-agent-sdk (default)",
    factory: () => new ClaudeAdapter(),
    exposeAsCliSubcommand: true,
    isAvailable: () => true,
    sessionFile: {
      listFromDisk: (cwd) => listClaudeSessionsFromDisk(cwd),
      parseSummary: (id, cwd) => readSessionHistory(id, cwd).summary,
      readBlocks: (id, cwd) => readSessionHistory(id, cwd).blocks,
    },
    // Default to the model-classifier permission flow so first-time users
    // (no `~/.bantai/settings.json`, no `--permission-mode`) get auto
    // approve/deny on routine actions instead of being prompted on every
    // edit/command. Settings file + CLI flag still override.
    defaultPermissionMode: "auto",
  },
  {
    id: "codex",
    displayName: "Codex",
    description: "OpenAI Codex CLI",
    factory: () => new CodexAdapter(),
    exposeAsCliSubcommand: true,
    isAvailable: () => binaryOnPath("codex"),
    // Codex sends approval + sandbox policy per-turn via `turn/start`. A
    // mid-turn `setPermissionMode()` only updates the next turn's params —
    // see CodexAdapter.setPermissionMode() and Audit §F-23.
    permissionModeAppliesOnNextTurn: true,
    sessionFile: {
      listFromDisk: () => listCodexSessionsFromDisk(),
      parseSummary: (id) => {
        const file = findCodexSessionFile(id)
        return file ? parseCodexSessionWithSummary(file).summary : undefined
      },
      readBlocks: (id) => {
        const file = findCodexSessionFile(id)
        if (!file) {
          log.warn("Codex session file not found", { sessionId: id })
          return []
        }
        return parseCodexSession(file)
      },
    },
  },
  {
    id: "gemini",
    displayName: "Gemini",
    description: "Google Gemini via the gemini ACP adapter",
    acpPreset: { command: "gemini", args: ["--acp"], displayName: "Gemini CLI" },
    exposeAsCliSubcommand: true,
    isAvailable: () => binaryOnPath("gemini"),
    sessionFile: {
      listFromDisk: (cwd) => listGeminiSessionsFromDisk(cwd),
      parseSummary: (id) => {
        const file = findGeminiSessionFile(id)
        return file ? parseGeminiSessionWithSummary(file).summary : undefined
      },
      readBlocks: (id) => {
        const file = findGeminiSessionFile(id)
        if (!file) {
          log.warn("Gemini session file not found", { sessionId: id })
          return []
        }
        return parseGeminiSession(file)
      },
    },
  },
  {
    id: "copilot",
    displayName: "GitHub Copilot",
    description: "GitHub Copilot via `gh copilot --acp`",
    acpPreset: { command: "gh", args: ["copilot", "--acp"], displayName: "GitHub Copilot" },
    isAvailable: () => binaryOnPath("gh"),
  },
  {
    id: "qwen",
    displayName: "Qwen Code",
    description:
      "Qwen Code via the qwen ACP adapter (local Qwen3-Coder via ~/.qwen/settings.json)",
    // Gemini CLI fork tuned for Qwen3-Coder. ACP mode and provider selection
    // are orthogonal — `qwen --acp` uses whatever provider is configured in
    // ~/.qwen/settings.json (LM Studio / Ollama / vLLM / DashScope / etc.).
    acpPreset: { command: "qwen", args: ["--acp"], displayName: "Qwen Code" },
    exposeAsCliSubcommand: true,
    isAvailable: () => binaryOnPath("qwen"),
  },
  {
    id: "acp",
    displayName: "Generic ACP",
    description: "Custom ACP agent (requires --acp-command at launch)",
    factory: (opts) => {
      if (!opts.acpCommand) {
        throw new Error("Backend 'acp' requires acpCommand option")
      }
      return new AcpAdapter({
        command: opts.acpCommand,
        args: opts.acpArgs ?? [],
        displayName: `ACP (${opts.acpCommand})`,
        presetName: "acp",
      })
    },
    requiresExtraConfig: true,
    isAvailable: () => true,
  },
  {
    id: "mock",
    displayName: "Mock",
    description: "In-memory test backend (development only)",
    factory: () => new MockAdapter(),
    isAvailable: () => true,
  },
]

// ---------------------------------------------------------------------------
// Lookup + iteration helpers — every cross-cutting concern (CLI, slash
// commands, config validators, slack routing, A/B picker) goes through these
// rather than rehydrating its own copy of the backend list.
// ---------------------------------------------------------------------------

/** Lookup by id. Returns undefined for unknown backends. */
export function getBackendDescriptor(id: string): BackendDescriptor | undefined {
  return BACKEND_REGISTRY.find((b) => b.id === id)
}

/** All registered backends. */
export function listBackends(): BackendDescriptor[] {
  return [...BACKEND_REGISTRY]
}

/** Backends whose dependencies appear to be satisfied. */
export function listAvailableBackends(): BackendDescriptor[] {
  return BACKEND_REGISTRY.filter((b) => b.isAvailable())
}

/** Backends exposed as `bantai <id>` CLI subcommands. */
export function listCliSubcommandBackends(): BackendDescriptor[] {
  return BACKEND_REGISTRY.filter((b) => b.exposeAsCliSubcommand)
}

/** True if `id` matches a registered backend. */
export function isKnownBackendId(id: string): boolean {
  return BACKEND_REGISTRY.some((b) => b.id === id)
}

/** All registered backend ids, in registration order. */
export function knownBackendIds(): string[] {
  return BACKEND_REGISTRY.map((b) => b.id)
}

/**
 * Backends that own session storage on disk — i.e. the ones that contribute
 * to the multi-backend session picker. Today: claude, codex, gemini. Adding
 * a backend with `sessionFile.listFromDisk` automatically pulls it into the
 * picker — no hand-rolled trio of imports required.
 */
export function listSessionFileBackends(): BackendDescriptor[] {
  return BACKEND_REGISTRY.filter((b) => b.sessionFile !== undefined)
}

/**
 * Construct an AgentBackend by registry id.
 *
 * Dispatches automatically based on the descriptor:
 *   - `acpPreset` set  → spawn ACP subprocess via AcpAdapter
 *   - `factory` set    → call factory(opts)
 *
 * Throws on unknown id, on a descriptor missing both `acpPreset` and
 * `factory`, or on a factory that itself throws (e.g., generic `acp` without
 * `acpCommand`).
 */
export function instantiateBackend(
  id: string,
  opts: BackendInstantiateOpts = {},
): AgentBackend {
  const desc = getBackendDescriptor(id)
  if (!desc) {
    throw new Error(`Unknown backend: ${id}`)
  }
  if (desc.acpPreset) {
    return new AcpAdapter({ ...desc.acpPreset, presetName: id })
  }
  if (desc.factory) {
    return desc.factory(opts)
  }
  throw new Error(
    `Backend '${id}' is misconfigured: descriptor has neither acpPreset nor factory`,
  )
}
