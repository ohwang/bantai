/**
 * Permission-mode cycler queue tests — F-15
 *
 * Audit reference: `bantai-team/permission-audit.md` §F-15.
 *
 * The Shift-Tab cycler used to silently no-op while
 * `state.sessionState === "WAITING_FOR_PERM"`, leaving users with no
 * feedback at the moment they are most likely to want a mode change
 * ("this dialog is annoying, switch me to bypassPermissions"). The fix
 * queues the next mode in `pendingPermissionMode` and applies it on the
 * transition out of WAITING_FOR_PERM.
 *
 * These tests pin:
 *   1. Pure cycle math (`nextPendingPermissionMode`).
 *   2. Reactive queue behavior (`createPermissionModeCycler`):
 *      - Shift-Tab during WAITING_FOR_PERM advances the queue without
 *        applying.
 *      - Multiple presses walk the cycle.
 *      - Cycling back to the live mode clears the queue (no-op apply).
 *      - The queued mode is applied exactly once when state transitions
 *        OUT of WAITING_FOR_PERM, then the signal is cleared.
 *      - WAITING_FOR_ELIC stays a hard no-op (no queue, no apply).
 *      - Outside WAITING_FOR_PERM the cycler applies immediately
 *        (legacy behavior preserved).
 */

import { describe, test, expect } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createPermissionModeCycler,
  nextPendingPermissionMode,
} from "../../src/frontends/tui/status-bar/permission-mode-cycler"
import type {
  PermissionMode,
  SessionState,
} from "../../src/protocol/types"
import { cyclerPermissionModeIds } from "../../src/protocol/permission-modes"

/**
 * Wait for SolidJS to flush queued effects.
 *
 * `createEffect` runs on the macrotask queue, not microtasks, so awaiting
 * `Promise.resolve()` is not enough — the effect callback hasn't fired
 * yet. A single `setTimeout(0)` round-trip is sufficient to drain the
 * scheduler. The apply path inside the effect is fire-and-forget
 * (returns a Promise we don't await), but the apply itself runs
 * synchronously up to its first `await`, which is past the assertion
 * point in these tests.
 */
function flushReactive(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const FULL_CYCLE = cyclerPermissionModeIds()

// A representative subset that covers the example from the prompt:
// default → acceptEdits → bypass(Permissions) — all three live in
// `cyclerPermissionModeIds()` so this is a real backend slice.
const THREE_MODE_CYCLE: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
]

describe("nextPendingPermissionMode — pure cycle math", () => {
  test("first press from current mode advances to the next available mode", () => {
    expect(nextPendingPermissionMode("default", null, THREE_MODE_CYCLE)).toBe(
      "acceptEdits",
    )
  })

  test("subsequent press advances from the queued mode, not the live mode", () => {
    expect(
      nextPendingPermissionMode("default", "acceptEdits", THREE_MODE_CYCLE),
    ).toBe("bypassPermissions")
  })

  test("cycling back to the live mode returns null (clear the queue)", () => {
    // default → acceptEdits → bypass → default(live) → clear
    expect(
      nextPendingPermissionMode(
        "default",
        "bypassPermissions",
        THREE_MODE_CYCLE,
      ),
    ).toBeNull()
  })

  test("returns null when the cycle has only one available mode", () => {
    expect(nextPendingPermissionMode("default", null, ["default"])).toBeNull()
    expect(nextPendingPermissionMode("default", null, [])).toBeNull()
  })

  test("falls back to index 0 when the anchor isn't in the available list", () => {
    // anchor "auto" not in subset → indexOf returns -1 → next is 0
    expect(
      nextPendingPermissionMode("auto", null, THREE_MODE_CYCLE),
    ).toBe("default")
  })

  test("walks the full cycle from cyclerPermissionModeIds()", () => {
    // Sanity check against the full registry (drift contract): make sure
    // every entry is reachable and the cycle eventually clears.
    let pending: PermissionMode | null = null
    const visited: PermissionMode[] = []
    for (let i = 0; i < FULL_CYCLE.length + 1; i++) {
      pending = nextPendingPermissionMode("default", pending, FULL_CYCLE)
      if (pending === null) break
      visited.push(pending)
    }
    // Visited every mode except `default` (the live mode), then cleared.
    expect(visited.length).toBe(FULL_CYCLE.length - 1)
    expect(pending).toBeNull()
    for (const mode of FULL_CYCLE) {
      if (mode === "default") continue
      expect(visited).toContain(mode)
    }
  })
})

describe("createPermissionModeCycler — WAITING_FOR_PERM queue behavior", () => {
  function setup(initial: {
    sessionState: SessionState
    currentMode: PermissionMode
    available?: readonly PermissionMode[]
  }) {
    const [sessionState, setSessionState] =
      createSignal<SessionState>(initial.sessionState)
    const [currentMode, setCurrentMode] =
      createSignal<PermissionMode>(initial.currentMode)
    const [availableModes, setAvailableModes] = createSignal<
      readonly PermissionMode[]
    >(initial.available ?? THREE_MODE_CYCLE)
    const applyCalls: PermissionMode[] = []
    const cycler = createPermissionModeCycler({
      sessionState,
      currentMode,
      availableModes,
      applyMode: async (mode) => {
        applyCalls.push(mode)
        // Mimic AgentContext.setPermissionMode: when the apply succeeds
        // the live signal flips so subsequent reads see the new mode.
        setCurrentMode(mode)
        return mode
      },
    })
    return {
      cycler,
      applyCalls,
      setSessionState,
      setAvailableModes,
      currentMode,
    }
  }

  test("Shift-Tab during WAITING_FOR_PERM queues without applying", () => {
    createRoot((dispose) => {
      const { cycler, applyCalls } = setup({
        sessionState: "WAITING_FOR_PERM",
        currentMode: "default",
      })

      expect(cycler.pendingPermissionMode()).toBeNull()

      const consumed = cycler.handleShiftTab()
      expect(consumed).toBe(true)
      expect(cycler.pendingPermissionMode()).toBe("acceptEdits")
      // No apply yet — dialog is still blocking.
      expect(applyCalls).toEqual([])

      dispose()
    })
  })

  test("multiple presses during WAITING_FOR_PERM walk the cycle", () => {
    createRoot((dispose) => {
      const { cycler, applyCalls } = setup({
        sessionState: "WAITING_FOR_PERM",
        currentMode: "default",
      })

      cycler.handleShiftTab()
      expect(cycler.pendingPermissionMode()).toBe("acceptEdits")
      cycler.handleShiftTab()
      expect(cycler.pendingPermissionMode()).toBe("bypassPermissions")
      // No applies fired during queueing.
      expect(applyCalls).toEqual([])

      dispose()
    })
  })

  test("cycling back to the live mode clears the queue", () => {
    createRoot((dispose) => {
      const { cycler, applyCalls } = setup({
        sessionState: "WAITING_FOR_PERM",
        currentMode: "default",
      })

      // default → acceptEdits → bypass → default (cleared)
      cycler.handleShiftTab()
      cycler.handleShiftTab()
      expect(cycler.pendingPermissionMode()).toBe("bypassPermissions")
      cycler.handleShiftTab()
      expect(cycler.pendingPermissionMode()).toBeNull()
      expect(applyCalls).toEqual([])

      dispose()
    })
  })

  test("queued mode is applied when state transitions OUT of WAITING_FOR_PERM", async () => {
    await createRoot(async (dispose) => {
      const { cycler, applyCalls, setSessionState, currentMode } = setup({
        sessionState: "WAITING_FOR_PERM",
        currentMode: "default",
      })

      cycler.handleShiftTab()
      cycler.handleShiftTab()
      expect(cycler.pendingPermissionMode()).toBe("bypassPermissions")
      expect(applyCalls).toEqual([])

      // User resolves the dialog → state leaves WAITING_FOR_PERM.
      setSessionState("RUNNING")
      // SolidJS effects flush on the macrotask queue (not microtasks), so
      // wait one tick before asserting. The apply itself is fire-and-forget,
      // so a single setTimeout(0) is enough to settle both.
      await flushReactive()

      expect(applyCalls).toEqual(["bypassPermissions"])
      expect(cycler.pendingPermissionMode()).toBeNull()
      expect(currentMode()).toBe("bypassPermissions")

      dispose()
    })
  })

  test("no apply fires when the dialog resolves with an empty queue", async () => {
    await createRoot(async (dispose) => {
      const { applyCalls, setSessionState } = setup({
        sessionState: "WAITING_FOR_PERM",
        currentMode: "default",
      })

      // No Shift-Tab presses — user just resolves the dialog.
      setSessionState("RUNNING")
      await flushReactive()

      expect(applyCalls).toEqual([])

      dispose()
    })
  })

  test("WAITING_FOR_ELIC is a hard no-op (no queue, no apply)", async () => {
    await createRoot(async (dispose) => {
      const { cycler, applyCalls, setSessionState } = setup({
        sessionState: "WAITING_FOR_ELIC",
        currentMode: "default",
      })

      const consumed = cycler.handleShiftTab()
      expect(consumed).toBe(false)
      expect(cycler.pendingPermissionMode()).toBeNull()

      // Even after leaving WAITING_FOR_ELIC, no apply — the press never
      // queued anything, and the queue effect only watches WAITING_FOR_PERM.
      setSessionState("RUNNING")
      await flushReactive()
      expect(applyCalls).toEqual([])

      dispose()
    })
  })

  test("outside WAITING_FOR_PERM, Shift-Tab applies immediately (legacy path)", async () => {
    await createRoot(async (dispose) => {
      const { cycler, applyCalls } = setup({
        sessionState: "IDLE",
        currentMode: "default",
      })

      const consumed = cycler.handleShiftTab()
      expect(consumed).toBe(true)
      // Pending stays empty — we apply directly, not queue.
      expect(cycler.pendingPermissionMode()).toBeNull()
      // applyMode is async; flush.
      await flushReactive()
      expect(applyCalls).toEqual(["acceptEdits"])

      dispose()
    })
  })

  test("queue survives a WAITING_FOR_PERM → WAITING_FOR_PERM re-entry without applying", async () => {
    // Real-world shape: the user mashes Shift-Tab, the agent finishes one
    // permission request and immediately raises another (e.g. a tool that
    // chains two prompts). State briefly hits IDLE in between or stays in
    // WAITING_FOR_PERM the whole time depending on the backend. We treat
    // any leave-then-return as an apply edge — the queue should fire on
    // the first leave and be empty for the second dialog.
    await createRoot(async (dispose) => {
      const { cycler, applyCalls, setSessionState } = setup({
        sessionState: "WAITING_FOR_PERM",
        currentMode: "default",
      })

      cycler.handleShiftTab()
      expect(cycler.pendingPermissionMode()).toBe("acceptEdits")

      setSessionState("RUNNING")
      await flushReactive()
      expect(applyCalls).toEqual(["acceptEdits"])
      expect(cycler.pendingPermissionMode()).toBeNull()

      // Second dialog opens with an empty queue.
      setSessionState("WAITING_FOR_PERM")
      expect(cycler.pendingPermissionMode()).toBeNull()

      dispose()
    })
  })
})
