/**
 * Tests for `installPermissionDialogReset` — the SolidJS render-effect that
 * resets the permission dialog's radio selector to "Allow" (option 0)
 * whenever a new `permission_request.id` arrives.
 *
 * Regression target: F-9 in `bantai-team/permission-audit.md`. The previous
 * implementation kept the reset inside `useKeyboard`, which only fired on
 * the next keypress — so a user who reflex-pressed Enter on a freshly-
 * opened dialog would confirm the PREVIOUS dialog's selection (e.g. "Deny
 * for session" carrying over from a just-denied prompt).
 *
 * The fix uses `createRenderEffect` watching `state.pendingPermission?.id`
 * so the reset lands synchronously at subscription time AND on every later
 * id change — BEFORE the user can press a key.
 *
 * Test environment caveat (mirrors `tests/utils/throttled-value.test.ts`):
 * default `bun test` does not pass `--conditions=browser`, so solid-js
 * loads its SSR build. Under SSR, `createSignal` returns a non-reactive
 * pair and `createRenderEffect` only runs once at subscription time. That
 * still lets us verify the load-bearing F-9 invariant: when the helper
 * subscribes with an already-pending permission, it MUST reset the
 * selection to 0. The previous useKeyboard-based reset would have left
 * the selection at whatever the previous dialog ended on; the new helper
 * resets immediately. Reactive id-change behavior in production is
 * exercised via manual smoke test (see audit §F-9 repro) and via the
 * larger TUI integration story.
 */

import { describe, test, expect } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { installPermissionDialogReset } from "../../src/frontends/tui/components/permission-dialog"
import type { PermissionRequestEvent } from "../../src/protocol/types"
import type { PermissionsState } from "../../src/frontends/tui/context/permissions"

function makePerm(id: string, overrides?: Partial<PermissionRequestEvent>): PermissionRequestEvent {
  return {
    type: "permission_request",
    id,
    tool: "Bash",
    input: { command: "echo hi" },
    ...overrides,
  }
}

describe("installPermissionDialogReset (F-9)", () => {
  // Core F-9 regression test mirroring the audit's repro shape:
  //   1. Mount the dialog with `pendingPermission.id = "a"` and
  //      selectedOption set to 3 (Deny for session).
  //   2. Update `pendingPermission.id = "b"` (simulating a fresh dialog).
  //   3. Assert `selectedOption()` is now 0 (Allow), without any keypress.
  //
  // Under SSR we cannot drive step 2's reactive update — instead we
  // simulate it the way the dialog actually re-mounts in practice: by
  // running the helper a second time against a new state. This captures
  // the same essential property: a fresh subscription with a pending
  // permission whose selection was previously non-zero MUST land on 0
  // before any keypress.
  test("resets selectedOption to 0 when a fresh permission_request arrives — without any keypress", () => {
    createRoot(dispose => {
      const [state, setState] = createStore<PermissionsState>({
        pendingPermission: makePerm("a"),
        pendingElicitation: null,
      })
      // The user had previously navigated to option 3 ("Deny for session").
      const [selected, setSelected] = createSignal(3)

      // Step 1: dialog "a" is mounted. The render-effect fires at
      // subscription and resets the carried-over selection.
      installPermissionDialogReset(
        () => state.pendingPermission?.id,
        setSelected,
      )
      expect(selected()).toBe(0)

      // Step 2: simulate the user denying dialog "a" with `d` and a fresh
      // dialog "b" appearing. We model the practical effect — the
      // selection was set back to 3 just before "b" arrives — and verify
      // a fresh subscription against state with id "b" resets to 0.
      setSelected(3)
      setState("pendingPermission", reconcile(makePerm("b")))

      installPermissionDialogReset(
        () => state.pendingPermission?.id,
        setSelected,
      )

      // Step 3: a reflex Enter would now land on Allow, not Deny-for-
      // session. This is the F-9 invariant.
      expect(selected()).toBe(0)

      dispose()
    })
  })

  test("invokes onReset callback alongside the selection reset (clears justActed debounce)", () => {
    createRoot(dispose => {
      const [state] = createStore<PermissionsState>({
        pendingPermission: makePerm("a"),
        pendingElicitation: null,
      })
      const [, setSelected] = createSignal(3)
      let onResetCalls = 0

      installPermissionDialogReset(
        () => state.pendingPermission?.id,
        setSelected,
        () => { onResetCalls += 1 },
      )

      // Subscription with a pending permission must invoke the onReset
      // callback so the dialog's `justActed` debounce flag is cleared
      // even when this dialog opens within 200ms of the previous one.
      expect(onResetCalls).toBe(1)

      dispose()
    })
  })

  test("does not reset when there is no pending permission (no spurious side-effect)", () => {
    createRoot(dispose => {
      const [state] = createStore<PermissionsState>({
        pendingPermission: null,
        pendingElicitation: null,
      })
      const [selected, setSelected] = createSignal(2)
      let onResetCalls = 0

      installPermissionDialogReset(
        () => state.pendingPermission?.id,
        setSelected,
        () => { onResetCalls += 1 },
      )

      // No id present → the helper must not touch the selection or fire
      // the debounce-clear callback. (In production this guards against
      // resetting state when the dialog is hidden.)
      expect(selected()).toBe(2)
      expect(onResetCalls).toBe(0)

      dispose()
    })
  })
})
