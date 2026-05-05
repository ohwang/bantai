/**
 * Permission Mode Cycler — pure helpers + reactive factory for the
 * status-bar Shift-Tab cycler, including the WAITING_FOR_PERM queue.
 *
 * Background — F-15 (`bantai-team/permission-audit.md`):
 *   While `state.sessionState === "WAITING_FOR_PERM"` the Shift-Tab cycler
 *   used to silently no-op. The user's most likely moment to want a mode
 *   change ("this dialog is annoying, give me bypassPermissions") looked
 *   like the keypress was eaten. We now QUEUE the next mode in a signal
 *   and apply it once the session leaves WAITING_FOR_PERM.
 *
 * The signal + effect live in this module rather than inline in
 * `status-bar.tsx` so the queue/apply behavior can be unit-tested without
 * spinning up the JSX tree, the `useKeyboard` hook, or the OpenTUI
 * renderer. The component just wires the inputs (state accessor, mode
 * accessor, available modes, apply callback) and reads `pendingPermissionMode`
 * for the visual hint.
 *
 * The "available modes" list passed in is the intersection of
 * `cyclerPermissionModeIds()` with the active backend's
 * `supportedPermissionModes` — same list the live cycler advances over
 * outside WAITING_FOR_PERM, so the queued path stays in lockstep.
 */

import { createEffect, createSignal, untrack, type Accessor } from "solid-js"
import type { PermissionMode, SessionState } from "../../../protocol/types"

/**
 * Compute the next pending permission mode for a Shift-Tab press while the
 * session is blocked on a permission dialog.
 *
 * Inputs:
 *   - `currentMode` — the mode actually in effect right now (what the
 *     backend last accepted). This is the anchor we compare against to
 *     detect "cycled all the way back".
 *   - `pendingMode` — the previously-queued mode (or `null` on the first
 *     Shift-Tab press during this dialog). We advance from here, not from
 *     `currentMode`, so multiple presses walk the cycle.
 *   - `availableModes` — cycler modes intersected with backend caps, in
 *     the canonical cycle order from `cyclerPermissionModeIds()`.
 *
 * Returns the mode to write into the pending signal. `null` means "clear
 * the pending state" — either because the cycle is too short to advance
 * or because we've come back around to the live mode (no-op apply).
 */
export function nextPendingPermissionMode(
  currentMode: PermissionMode,
  pendingMode: PermissionMode | null,
  availableModes: readonly PermissionMode[],
): PermissionMode | null {
  // No cycle → no-op. Mirrors the live (non-WAITING) cycler's `length <= 1`
  // guard so we don't accidentally queue when there's nowhere to cycle to.
  if (availableModes.length <= 1) return null

  // Walk forward from the most recent intent — the queued mode if present,
  // otherwise the live mode. If the anchor isn't in the backend's available
  // list (e.g. backend swap dropped support after queueing), fall back to
  // index -1 so the next step lands at index 0.
  const anchor = pendingMode ?? currentMode
  const startIdx = availableModes.indexOf(anchor)
  const nextIdx = (startIdx + 1) % availableModes.length
  const next = availableModes[nextIdx]
  if (next === undefined) return null

  // If the user cycled all the way back to the live mode, drop the queue —
  // applying it would be a no-op (same as setPermissionMode's own short
  // circuit) but the visual hint would imply a pending change. Cleaner to
  // clear and let the status bar look settled.
  if (next === currentMode) return null

  return next
}

/**
 * Inputs for the cycler controller. All accessors are read reactively;
 * `applyMode` is invoked imperatively (it is the live `setPermissionMode`
 * helper from AgentContext, which pushes the mode to the backend).
 */
export interface PermissionModeCyclerInputs {
  /** Live session state — drives the queue-vs-apply branch. */
  sessionState: Accessor<SessionState>
  /** Mode in effect right now (signal from AgentContext). */
  currentMode: Accessor<PermissionMode>
  /** Cycler modes ∩ backend caps, in canonical order. */
  availableModes: Accessor<readonly PermissionMode[]>
  /**
   * Apply a mode end-to-end (push to backend + update the live signal).
   * Mirrors `AgentContext.setPermissionMode`. Returning the resolved mode
   * is unused here; we discard it because the live signal drives the UI.
   */
  applyMode: (mode: PermissionMode) => Promise<unknown> | unknown
}

export interface PermissionModeCyclerController {
  /**
   * Reactive accessor for the queued mode. `null` when nothing is queued.
   * The status bar reads this to decide whether to show the
   * " → bypass permissions on (after this dialog)" hint.
   */
  pendingPermissionMode: Accessor<PermissionMode | null>
  /**
   * Handle a Shift-Tab press from the keyboard hook. During
   * WAITING_FOR_PERM we advance the queue; otherwise we apply the next
   * mode immediately (the legacy live-cycler path). WAITING_FOR_ELIC is
   * still a hard no-op — elicitation is an in-message question, not a
   * mode-policy gate, so silently swallowing the keypress matches the
   * existing behavior we want to preserve.
   *
   * Returns `true` if the press was consumed (queued or applied), `false`
   * if it was ignored (e.g. WAITING_FOR_ELIC, or no available modes).
   */
  handleShiftTab: () => boolean
}

/**
 * Wire the queue/apply behavior described in F-15. Must be called inside
 * a SolidJS reactive root (the component scope, or `createRoot` in tests).
 *
 * The internal `createEffect` watches `sessionState`. On the transition
 * OUT of WAITING_FOR_PERM, if the queue is non-empty, we apply it and
 * clear the signal. We deliberately track the previous state inside the
 * effect (rather than reading both old + new from the signal) so the
 * apply only fires on the edge — re-renders that read the same state
 * don't double-apply.
 */
export function createPermissionModeCycler(
  inputs: PermissionModeCyclerInputs,
): PermissionModeCyclerController {
  const [pendingPermissionMode, setPending] =
    createSignal<PermissionMode | null>(null)

  // Track previous session state so we only react to the OUT-of-WAITING
  // edge. We seed `previousState` synchronously from the inputs accessor
  // (read inside an `untrack` so we don't add a phantom dependency at
  // construction time) — `createEffect` is deferred and would otherwise
  // miss the very first transition if a Shift-Tab + state change happen
  // before its first run.
  let previousState: SessionState = untrack(() => inputs.sessionState())
  createEffect(() => {
    const current = inputs.sessionState()
    const prev = previousState
    previousState = current

    if (prev === "WAITING_FOR_PERM" && current !== "WAITING_FOR_PERM") {
      const queued = pendingPermissionMode()
      if (queued !== null) {
        setPending(null)
        // Fire-and-forget: applyMode is the AgentContext helper which
        // logs its own errors and short-circuits if the mode is already
        // active. We don't want this effect to await — it would block
        // the reactive flush.
        void Promise.resolve(inputs.applyMode(queued))
      }
    }
  })

  const handleShiftTab = (): boolean => {
    const session = inputs.sessionState()
    // WAITING_FOR_ELIC stays a hard no-op — elicitation is a structured
    // user-input request, not a permission gate, so queueing a mode
    // change wouldn't unblock anything and the visual hint would be
    // misleading. Preserve legacy silent return.
    if (session === "WAITING_FOR_ELIC") return false

    const modes = inputs.availableModes()
    if (modes.length <= 1) return false

    if (session === "WAITING_FOR_PERM") {
      const next = nextPendingPermissionMode(
        inputs.currentMode(),
        pendingPermissionMode(),
        modes,
      )
      // `next === null` means the cycle landed back on the live mode (or
      // the cycle is too short). Either way: clear any prior queue so
      // the hint disappears and the status bar reads as settled.
      setPending(next)
      return true
    }

    // Outside WAITING_FOR_PERM — legacy live-apply path. Advance from the
    // current mode (no queue to track) and push immediately.
    const startIdx = modes.indexOf(inputs.currentMode())
    const nextIdx = (startIdx + 1) % modes.length
    const nextMode = modes[nextIdx] ?? "default"
    void Promise.resolve(inputs.applyMode(nextMode))
    return true
  }

  return { pendingPermissionMode, handleShiftTab }
}
