/**
 * Backend Capabilities — shared defaults and helpers.
 *
 * Cluster 3 from anti-drift-sprint-todo. The `BackendCapabilities`
 * interface in `types.ts` is the spec; this file provides one typed
 * default object that every adapter spreads to construct its own
 * capabilities literal. Without this, every adapter hand-rolls a fresh
 * 9-field literal — which is how `mock` and `follow` ended up with
 * `supportedPermissionModes: ["default"]`, dropping `auto` and `dontAsk`
 * from the cycler even though neither adapter actually enforces anything.
 *
 * Pattern:
 *
 *   capabilities(): BackendCapabilities {
 *     return {
 *       ...DEFAULT_CAPABILITIES,
 *       name: "claude",
 *       supportsResume: true,
 *       supportsContinue: true,
 *       supportedPermissionModes: knownPermissionModeIds(),
 *       sandboxInfo,
 *     } satisfies BackendCapabilities
 *   }
 *
 * Spreading in this order means every required field is filled — TS
 * complains if a new `supports*` lands without a default.
 */

import type { BackendCapabilities } from "./types"
import { knownPermissionModeIds } from "./permission-modes"

/**
 * Conservative defaults for a freshly-introduced backend.
 *
 * Defaults are deliberately pessimistic — every flag is `false` except for
 * the ones that are essentially always true (streaming text deltas).
 * Adapters override the bits they can actually deliver.
 *
 * `name` is intentionally absent — every adapter MUST set its own. We
 * couldn't pick a default that wasn't a footgun.
 */
export const DEFAULT_CAPABILITIES: Omit<BackendCapabilities, "name"> = {
  supportsThinking: false,
  supportsToolApproval: false,
  supportsResume: false,
  supportsContinue: false,
  supportsFork: false,
  supportsStreaming: true,
  supportsSubagents: false,
  supportsCompact: false,
  supportedPermissionModes: knownPermissionModeIds(),
}
