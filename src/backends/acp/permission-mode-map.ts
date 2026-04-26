/**
 * ACP Permission Mode Map — single source of truth for translating between
 * bantai's `PermissionMode` (the unified UI vocabulary) and the per-agent
 * IDs that ACP-speaking subprocesses understand.
 *
 * Different ACP agents disagree on shape:
 *
 *   - Gemini CLI uses short string ids        ("default", "autoEdit", "yolo", "plan")
 *     and accepts them directly via session/set_mode.
 *   - GitHub Copilot CLI uses URI-style ids   ("https://…#agent", "#plan",
 *     "#autopilot") AND a separate `mode` config option whose choices are
 *     named "agent" / "plan" / "autopilot". Switching mode is done by setting
 *     that config option.
 *
 * Cluster 7 (anti-drift sprint): the mapping used to live in three places
 * inside `acp/adapter.ts`, each pointing one direction:
 *
 *   1. `deriveSupportedPermissionModes` → `reverseMap` (ACP id → bantai)
 *   2. `deriveSupportedPermissionModes` → `fragmentMap` (URI fragment → bantai)
 *   3. `setPermissionMode` → strategy 1 `targetName` (bantai → fragment / config name)
 *   4. `setPermissionMode` → strategy 2 `modeMap` (bantai → Gemini id)
 *
 * Drift was already visible: `auto`, `dontAsk` and `bypassPermissions` were
 * each present in some tables and missing from others, and the names
 * "agent" / "autopilot" appeared inline as string literals. Centralising the
 * full bidirectional table here means every reverse lookup, forward lookup,
 * and supportedModes derivation goes through the same table — adding a new
 * mode is a single registry edit.
 *
 * The table is intentionally explicit (not "name.includes(target)" string
 * search): if a future agent uses a non-overlapping vocabulary, add an
 * extra ACP-side id for the affected mode rather than introducing a new
 * fuzzy matcher.
 */

import type { PermissionMode } from "../../protocol/permission-modes"

export interface AcpPermissionModeMapping {
  /** Direct ACP mode ids accepted by `session/set_mode` (Gemini-style). */
  acpIds: string[]
  /**
   * URI fragments seen on Copilot-style mode IDs (`https://…#fragment`).
   * Same string also appears as the option name on Copilot's `mode` config
   * option, which is why the two sources of truth used to drift apart.
   */
  uriFragments: string[]
}

/**
 * Bidirectional mapping table. The bantai PermissionMode is the key.
 * `acpIds` and `uriFragments` are searched in declaration order, so the
 * "preferred" form for a forward translation should come first.
 */
export const ACP_PERMISSION_MODE_MAP: Record<PermissionMode, AcpPermissionModeMapping> = {
  default: {
    acpIds: ["default"],
    uriFragments: ["agent"],
  },
  acceptEdits: {
    acpIds: ["autoEdit"],
    uriFragments: [],
  },
  bypassPermissions: {
    acpIds: ["yolo"],
    uriFragments: ["autopilot"],
  },
  plan: {
    acpIds: ["plan"],
    uriFragments: ["plan"],
  },
  // `auto` and `dontAsk` are bantai-only modes today: no known ACP agent
  // implements them, so the table is intentionally empty. Adding entries
  // when a future ACP agent supports them is a one-line registry change.
  auto: {
    acpIds: [],
    uriFragments: [],
  },
  dontAsk: {
    acpIds: [],
    uriFragments: [],
  },
}

/** Look up the preferred ACP mode id for a bantai PermissionMode (Gemini path).
 *  Returns `null` when no ACP agent in the table supports this mode. */
export function bantaiToAcpId(mode: PermissionMode): string | null {
  return ACP_PERMISSION_MODE_MAP[mode].acpIds[0] ?? null
}

/** Look up the preferred URI fragment / config-option name for a bantai
 *  PermissionMode (Copilot path). Returns `null` when no ACP agent in the
 *  table uses a fragment for this mode. */
export function bantaiToAcpFragment(mode: PermissionMode): string | null {
  return ACP_PERMISSION_MODE_MAP[mode].uriFragments[0] ?? null
}

/** Reverse lookup: given an ACP-side id (Gemini-style or Copilot URI),
 *  return the bantai PermissionMode it represents, or `undefined` if the
 *  id isn't recognised. */
export function acpIdToBantai(acpId: string): PermissionMode | undefined {
  // Direct id match (Gemini "default" / "autoEdit" / "yolo" / "plan").
  for (const [bantai, mapping] of Object.entries(ACP_PERMISSION_MODE_MAP) as [
    PermissionMode,
    AcpPermissionModeMapping,
  ][]) {
    if (mapping.acpIds.includes(acpId)) return bantai
  }
  // URI fragment match (Copilot "https://…#agent" → "agent").
  const fragment = acpId.split("#").pop()
  if (fragment && fragment !== acpId) {
    for (const [bantai, mapping] of Object.entries(ACP_PERMISSION_MODE_MAP) as [
      PermissionMode,
      AcpPermissionModeMapping,
    ][]) {
      if (mapping.uriFragments.includes(fragment)) return bantai
    }
  }
  return undefined
}

/** Reverse lookup for Copilot's `mode` config option, where the option's
 *  *name* (lowercased) is the URI fragment without the leading `#`. */
export function acpFragmentToBantai(fragment: string): PermissionMode | undefined {
  const lower = fragment.toLowerCase()
  for (const [bantai, mapping] of Object.entries(ACP_PERMISSION_MODE_MAP) as [
    PermissionMode,
    AcpPermissionModeMapping,
  ][]) {
    if (mapping.uriFragments.includes(lower)) return bantai
  }
  return undefined
}
