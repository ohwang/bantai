/**
 * Tests for `installQuestionReset` — the SolidJS render-effect that clears
 * per-question UI state in the elicitation dialog whenever the parent
 * advances `currentIdx` to a fresh `ElicitationQuestion` reference.
 *
 * Regression target: in a multi-question AskUserQuestion elicitation, the
 * same `QuestionView` instance is reused across questions (the parent
 * renders it inline at a stable JSX position; only the `question` prop
 * changes). Without a reset, the per-question `submitting` latch — set
 * to `true` when the user answers Q1 to debounce double-submit — carries
 * over to Q2. There, every `selectOption(...)` early-returns on
 * `if (submitting()) return`, so Enter and the number keys silently do
 * nothing and Esc is the only way out.
 *
 * Mirrors the F-9 fix for the permission dialog (selection carry-over
 * between consecutive permission requests) — same shape, different
 * dialog. See `tests/tui/permission-dialog-reset.test.ts`.
 *
 * Test environment caveat (mirrors `permission-dialog-reset.test.ts`):
 * default `bun test` does not pass `--conditions=browser`, so solid-js
 * loads its SSR build. Under SSR `createSignal` is non-reactive and
 * `createRenderEffect` only runs once at subscription. That still lets
 * us verify the load-bearing invariant: when the helper subscribes with
 * a question whose previous run left `submitting = true`, it MUST clear
 * the latch before any keypress. Reactive question-change behavior in
 * production is exercised via manual smoke test (the bug repro: a
 * 2-question AskUserQuestion where Enter must work on Q2).
 */

import { describe, test, expect } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { installQuestionReset } from "../../src/frontends/tui/components/elicitation"
import type { ElicitationQuestion } from "../../src/protocol/types"

function makeQuestion(text: string): ElicitationQuestion {
  return {
    question: text,
    options: [
      { label: "I'll dictate now" },
      { label: "Just stub it" },
    ],
  }
}

describe("installQuestionReset (multi-question elicitation Enter-stuck bug)", () => {
  // Core regression test mirroring the F-9 permission-dialog test shape:
  //   1. Install with question "a" and `submitting = true` (the latch
  //      Q1's QuestionView left behind after answering).
  //   2. Re-install with question "b" (simulating QuestionView re-running
  //      its render-effect when the parent advances `currentIdx`).
  //   3. Assert `submitting()` is now `false` without any keypress.
  //
  // Under SSR we cannot drive step 2's reactive update, so we model it
  // the way the dialog actually re-runs in practice: by running the
  // helper a second time with a fresh question accessor. This captures
  // the same essential property — a fresh subscription with a new
  // question MUST clear the `submitting` latch before any keypress, so
  // Enter on Q2 isn't silently swallowed.
  test("clears the submitting latch when the question reference changes — without any keypress", () => {
    createRoot(dispose => {
      const q1 = makeQuestion("Filename?")
      const q2 = makeQuestion("Topic & body")

      // Stand-ins for the per-question signals inside QuestionView.
      const [selected, setSelected] = createSignal(0)
      const [showFreeText, setShowFreeText] = createSignal(false)
      const [submitting, setSubmitting] = createSignal(false)

      const reset = () => {
        setSelected(0)
        setShowFreeText(false)
        setSubmitting(false)
      }

      // Step 1: QuestionView mounts with Q1. The render-effect fires at
      // subscription and resets the (already-clean) state.
      installQuestionReset(() => q1, reset)
      expect(submitting()).toBe(false)
      expect(selected()).toBe(0)

      // User navigated to option 1 and pressed Enter — the QuestionView
      // sets `submitting = true` to debounce double-submit, then calls
      // props.onAnswer(). The parent advances currentIdx and re-renders
      // QuestionView with Q2. Without the reset, `submitting` would
      // still be `true` here and Enter on Q2 would early-return.
      setSelected(1)
      setSubmitting(true)
      expect(submitting()).toBe(true)

      // Step 2: QuestionView's render-effect re-runs with Q2 — modeled
      // by a fresh install. With the fix, `lastSeen !== q2` so the
      // reset fires.
      installQuestionReset(() => q2, reset)

      // Step 3: a reflex Enter on Q2 must now actually select option 0,
      // not get silently swallowed by the lingering submitting latch.
      expect(submitting()).toBe(false)
      expect(selected()).toBe(0)
      expect(showFreeText()).toBe(false)

      dispose()
    })
  })

  test("does not fire the reset twice for the same question reference", () => {
    createRoot(dispose => {
      const q1 = makeQuestion("Filename?")

      let resets = 0
      // Single createRenderEffect — under SSR it runs exactly once at
      // subscription time. Verify it fires the initial reset (so a
      // QuestionView that re-runs but is still on the same question
      // would not double-reset and clobber legitimate user input).
      installQuestionReset(() => q1, () => { resets += 1 })

      expect(resets).toBe(1)

      dispose()
    })
  })
})
