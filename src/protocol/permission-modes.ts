/**
 * Permission Mode Registry — single source of truth for the closed
 * enumeration of permission modes bantai exposes across CLI, settings,
 * subagents, the TUI cycler, and per-backend `supportedPermissionModes`.
 *
 * Follows the drift-contract recipe documented in CLAUDE.md:
 *
 *   1. Source of truth = a typed array of descriptors (this file).
 *   2. The `PermissionMode` type is derived from the array.
 *   3. Helpers (`isKnownPermissionMode`, `knownPermissionModeIds`,
 *      `getPermissionModeDescriptor`, `listPermissionModesForCli`) replace
 *      every hand-rolled `Set` / `[]` / `||` chain across the codebase.
 *   4. CLI help text and validator error messages are built from the array.
 *   5. Switches that need exhaustiveness become `Record<PermissionMode, V>`.
 *
 * IMPORTANT: These names provide a common UI language, but the actual
 * enforcement varies by backend. See `SandboxInfo` in `types.ts` for
 * per-backend details.
 */

export interface PermissionModeDescriptor {
  /** Stable id used at CLI / settings / config / API boundaries. */
  id: string
  /** One-line summary suitable for `--help` text. */
  description: string
  /**
   * Whether this mode is part of the default Shift-Tab cycle in the TUI
   * status bar. `dontAsk` is intentionally excluded from the cycle today
   * because it requires an allowlist; users opt in via `/permission-mode`
   * or settings, never by accidentally tabbing through.
   *
   * NOTE: Keep this comment honest with the array below — if you flip this
   * for `dontAsk`, update the cycler docs and tests in
   * `tests/tui/components/status-bar-cycler.test.ts`.
   */
  inCycler: boolean
}

/**
 * Canonical list of permission modes. Order matters for the TUI cycler
 * (`inCycler: true` entries cycle in this order).
 */
export const PERMISSION_MODES = [
  {
    id: "default",
    description: "Ask before destructive actions (edits, commands)",
    inCycler: true,
  },
  {
    id: "acceptEdits",
    description: "Auto-approve file edits, still ask for commands",
    inCycler: true,
  },
  {
    id: "auto",
    description: "Model classifier decides approve/deny per request",
    inCycler: true,
  },
  {
    id: "bypassPermissions",
    description: "Auto-approve everything (no prompts)",
    inCycler: true,
  },
  {
    id: "plan",
    description: "Read-only analysis, no edits or commands",
    inCycler: true,
  },
  {
    id: "dontAsk",
    description: "Never prompt; deny anything not pre-approved via allowlist",
    inCycler: true,
  },
] as const satisfies readonly PermissionModeDescriptor[]

/** Closed string-literal type derived from the registry above. */
export type PermissionMode = typeof PERMISSION_MODES[number]["id"]

/** All registered permission mode ids, in registration order. */
export function knownPermissionModeIds(): PermissionMode[] {
  return PERMISSION_MODES.map((m) => m.id)
}

/** True if `id` matches a registered permission mode. */
export function isKnownPermissionMode(id: string): id is PermissionMode {
  return PERMISSION_MODES.some((m) => m.id === id)
}

/** Lookup by id. Returns undefined for unknown modes. */
export function getPermissionModeDescriptor(
  id: string,
): PermissionModeDescriptor | undefined {
  return PERMISSION_MODES.find((m) => m.id === id)
}

/**
 * Comma-separated list for CLI `--help` and zod-style validator errors.
 *
 * Built at call-site rather than maintained as a string constant so that
 * adding a permission mode automatically updates every help message.
 */
export function listPermissionModesForCli(): string {
  return knownPermissionModeIds().join(", ")
}

/** Permission modes that participate in the Shift-Tab cycler. */
export function cyclerPermissionModeIds(): PermissionMode[] {
  return PERMISSION_MODES.filter((m) => m.inCycler).map((m) => m.id)
}
