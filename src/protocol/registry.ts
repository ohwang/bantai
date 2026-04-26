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
import type { AgentBackend } from "./types"

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
  },
  {
    id: "codex",
    displayName: "Codex",
    description: "OpenAI Codex CLI",
    factory: () => new CodexAdapter(),
    exposeAsCliSubcommand: true,
    isAvailable: () => binaryOnPath("codex"),
  },
  {
    id: "gemini",
    displayName: "Gemini",
    description: "Google Gemini via the gemini ACP adapter",
    acpPreset: { command: "gemini", args: ["--acp"], displayName: "Gemini CLI" },
    exposeAsCliSubcommand: true,
    isAvailable: () => binaryOnPath("gemini"),
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
