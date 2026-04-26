/**
 * Backend Registry — single source of truth for the set of backends bantai
 * knows how to instantiate at runtime.
 *
 * Used by:
 *   - `/backend` (list available backends)
 *   - `/switch <backend>` (hot-swap the active backend mid-conversation)
 *   - the multi-backend session picker for friendly labels
 *
 * Construction itself is delegated to `subagents/backend-factory.ts` so we
 * don't have two parallel switches that can drift; the registry just adds
 * a name -> { displayName, isAvailable } map on top.
 *
 * `isAvailable()` is intentionally a fast best-effort check (binary on PATH
 * for ACP-based backends, always-true for everything else). It exists so the
 * `/backend` listing can highlight which backends will actually start, but it
 * never prevents a switch — the user might have the binary on a non-default
 * PATH, in which case they're free to try anyway and read the resulting
 * adapter error.
 */

import { createBackend } from "../subagents/backend-factory"
import type { AgentBackend } from "./types"

/** Identifier used at the CLI / slash command boundary. */
export type BackendId =
  | "claude"
  | "codex"
  | "gemini"
  | "copilot"
  | "qwen"
  | "acp"
  | "mock"

export interface BackendDescriptor {
  id: BackendId
  /** User-facing brand name (matches friendlyBackendName for the ones it covers). */
  displayName: string
  /** One-line summary shown in `/backend`. */
  description: string
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
    isAvailable: () => true,
  },
  {
    id: "codex",
    displayName: "Codex",
    description: "OpenAI Codex CLI",
    isAvailable: () => binaryOnPath("codex"),
  },
  {
    id: "gemini",
    displayName: "Gemini",
    description: "Google Gemini via the gemini ACP adapter",
    isAvailable: () => binaryOnPath("gemini"),
  },
  {
    id: "copilot",
    displayName: "GitHub Copilot",
    description: "GitHub Copilot via `gh copilot --acp`",
    isAvailable: () => binaryOnPath("gh"),
  },
  {
    id: "qwen",
    displayName: "Qwen Code",
    description: "Qwen Code via the qwen ACP adapter (local Qwen3-Coder via ~/.qwen/settings.json)",
    isAvailable: () => binaryOnPath("qwen"),
  },
  {
    id: "acp",
    displayName: "Generic ACP",
    description: "Custom ACP agent (requires --acp-command at launch)",
    isAvailable: () => true,
    requiresExtraConfig: true,
  },
  {
    id: "mock",
    displayName: "Mock",
    description: "In-memory test backend (development only)",
    isAvailable: () => true,
  },
]

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

/**
 * Construct an AgentBackend by registry id. Thin wrapper around
 * `createBackend()` so callers don't have to know the underlying factory
 * shape — they pass an id and get a fresh adapter back.
 *
 * Throws on unknown id or missing required options (e.g., `acp` without
 * `acpCommand`).
 */
export function instantiateBackend(
  id: BackendId,
  opts: { acpCommand?: string; acpArgs?: string[] } = {},
): AgentBackend {
  return createBackend({ backend: id, acpCommand: opts.acpCommand, acpArgs: opts.acpArgs })
}
