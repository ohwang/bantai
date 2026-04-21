/**
 * TaskChecklist component tests.
 *
 * Mix of pure-helper assertions (truncation, prioritization, hidden-summary
 * formatting) and rendered-frame assertions via @opentui/solid's testRender.
 */

import { describe, it, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import stringWidth from "string-width"
import {
  TaskChecklist,
  computeMaxDisplay,
  computeMaxSubjectWidth,
  truncateSubject,
  pickSubject,
  prioritizeTodos,
  buildHiddenSummary,
  computeShouldHide,
  nextFirstAllCompleteAt,
  AUTO_HIDE_DELAY_MS,
} from "../../src/frontends/tui/components/task-checklist"
import type { TodoItem } from "../../src/protocol/types"

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("computeMaxDisplay", () => {
  it("returns 0 for tiny terminals (rows <= 10)", () => {
    expect(computeMaxDisplay(3)).toBe(0)
    expect(computeMaxDisplay(10)).toBe(0)
  })

  it("returns max(3, rows - 14) capped at 10", () => {
    expect(computeMaxDisplay(11)).toBe(3) // clamp floor
    expect(computeMaxDisplay(18)).toBe(4) // rows - 14
    expect(computeMaxDisplay(24)).toBe(10) // capped
    expect(computeMaxDisplay(100)).toBe(10) // capped
  })
})

describe("computeMaxSubjectWidth", () => {
  it("enforces a floor of 15 on narrow terminals", () => {
    expect(computeMaxSubjectWidth(10)).toBe(15)
    expect(computeMaxSubjectWidth(29)).toBe(15)
  })

  it("scales with terminal width otherwise", () => {
    expect(computeMaxSubjectWidth(80)).toBe(65)
    expect(computeMaxSubjectWidth(120)).toBe(105)
  })
})

describe("truncateSubject", () => {
  it("returns unchanged when within budget", () => {
    expect(truncateSubject("short", 20)).toBe("short")
    expect(truncateSubject("Hello", 10)).toBe("Hello")
  })

  it("truncates ASCII with ellipsis when over budget (display width <= maxWidth)", () => {
    const out = truncateSubject("this is a long subject line", 10)
    expect(stringWidth(out)).toBeLessThanOrEqual(10)
    expect(out.endsWith("\u2026")).toBe(true)
  })

  it("produces a 15-column result for ASCII input at maxWidth=15", () => {
    const out = truncateSubject("Very long subject line here", 15)
    expect(stringWidth(out)).toBeLessThanOrEqual(15)
    expect(out.endsWith("\u2026")).toBe(true)
  })

  it("respects display width for CJK (each ideograph = 2 columns)", () => {
    // "部署到生产环境" is 7 CJK chars = 14 display columns. Capping at 10
    // cols should drop enough chars for stringWidth(out) <= 10, ending
    // in the ellipsis. The pre-fix code-unit truncation would keep 9 CJK
    // chars (9 code units) = 18 columns, overflowing the terminal.
    const subject = "部署到生产环境"
    expect(stringWidth(subject)).toBe(14)
    const out = truncateSubject(subject, 10)
    expect(stringWidth(out)).toBeLessThanOrEqual(10)
    expect(out.endsWith("\u2026")).toBe(true)
  })

  it("respects display width for emoji (astral-plane characters)", () => {
    // Each 🎉 is typically rendered 2 columns wide. Must iterate by code
    // points so we don't split surrogate pairs mid-character.
    const subject = "🎉🎉🎉🎉"
    const out = truncateSubject(subject, 5)
    expect(stringWidth(out)).toBeLessThanOrEqual(5)
    expect(out.endsWith("\u2026")).toBe(true)
    // Must not contain a stray lone surrogate (would show as mojibake).
    for (const ch of out) {
      const cp = ch.codePointAt(0)!
      expect(cp < 0xd800 || cp > 0xdfff).toBe(true)
    }
  })

  it("returns just the ellipsis when maxWidth is 1 and truncation is needed", () => {
    expect(truncateSubject("abcdef", 1)).toBe("\u2026")
  })

  it("returns empty string when maxWidth is <= 0", () => {
    expect(truncateSubject("abcdef", 0)).toBe("")
  })
})

describe("pickSubject", () => {
  it("uses content for pending and completed", () => {
    expect(
      pickSubject({ content: "Run tests", activeForm: "Running tests", status: "pending" }),
    ).toBe("Run tests")
    expect(
      pickSubject({ content: "Run tests", activeForm: "Running tests", status: "completed" }),
    ).toBe("Run tests")
  })

  it("uses content for in_progress (not activeForm)", () => {
    // Matches Claude Code's TaskListV2: row text is always `task.subject`
    // (= content). activeForm is reserved for the spinner verb.
    expect(
      pickSubject({ content: "Run tests", activeForm: "Running tests", status: "in_progress" }),
    ).toBe("Run tests")
  })

  it("still returns content when activeForm is empty", () => {
    expect(
      pickSubject({ content: "Run tests", activeForm: "", status: "in_progress" }),
    ).toBe("Run tests")
  })
})

describe("prioritizeTodos", () => {
  const mk = (content: string, status: TodoItem["status"]): TodoItem => ({
    content,
    activeForm: content + "ing",
    status,
  })

  it("orders recent completed first, then in_progress, then pending, then older completed", () => {
    const todos: TodoItem[] = [
      mk("c1", "completed"),
      mk("c2", "completed"),
      mk("c3", "completed"),
      mk("c4", "completed"),
      mk("p1", "pending"),
      mk("ip1", "in_progress"),
      mk("p2", "pending"),
    ]
    const out = prioritizeTodos(todos)
    // recent completed (upper half — indices 2,3): c3, c4 — first
    expect(out.slice(0, 2).map((t) => t.content)).toEqual(["c3", "c4"])
    // then in_progress
    expect(out[2]?.content).toBe("ip1")
    // then pending in insertion order
    expect(out.slice(3, 5).map((t) => t.content)).toEqual(["p1", "p2"])
    // then older completed (lower half): c1, c2
    expect(out.slice(5).map((t) => t.content)).toEqual(["c1", "c2"])
  })

  it("truncation prioritizes recent-completed before in-progress (12 todos, maxDisplay=3)", () => {
    // 4 completed, 2 in_progress, 6 pending. With maxDisplay=3, expect visible
    // to START with the 2 most-recent completed (later indices) then 1 in_progress.
    const todos: TodoItem[] = [
      mk("c1", "completed"),
      mk("c2", "completed"),
      mk("c3", "completed"),
      mk("c4", "completed"),
      mk("ip1", "in_progress"),
      mk("ip2", "in_progress"),
      mk("p1", "pending"),
      mk("p2", "pending"),
      mk("p3", "pending"),
      mk("p4", "pending"),
      mk("p5", "pending"),
      mk("p6", "pending"),
    ]
    const visible = prioritizeTodos(todos).slice(0, 3)
    // Upper half of completed = indices 2,3 → c3, c4. Then first in_progress.
    expect(visible.map((t) => t.content)).toEqual(["c3", "c4", "ip1"])
  })

  it("handles all-pending without crash", () => {
    const todos = [mk("a", "pending"), mk("b", "pending")]
    expect(prioritizeTodos(todos).map((t) => t.content)).toEqual(["a", "b"])
  })
})

describe("auto-hide helpers", () => {
  const mk = (status: TodoItem["status"]): TodoItem => ({
    content: "x",
    activeForm: "x",
    status,
  })

  it("AUTO_HIDE_DELAY_MS is 5 seconds (matches Claude Code's V2 hide timer)", () => {
    expect(AUTO_HIDE_DELAY_MS).toBe(5_000)
  })

  describe("nextFirstAllCompleteAt", () => {
    it("returns null when the list is empty", () => {
      expect(nextFirstAllCompleteAt(null, [], 1_000)).toBeNull()
      // Even if a prior timestamp existed, an empty list resets it.
      expect(nextFirstAllCompleteAt(500, [], 1_000)).toBeNull()
    })

    it("returns null when not all items are completed", () => {
      const list = [mk("completed"), mk("in_progress"), mk("pending")]
      expect(nextFirstAllCompleteAt(null, list, 1_000)).toBeNull()
      // Previous timestamp is cleared when list regresses.
      expect(nextFirstAllCompleteAt(500, list, 1_000)).toBeNull()
    })

    it("latches the first all-completed timestamp and does not restart", () => {
      const list = [mk("completed"), mk("completed")]
      // First all-completed moment: stamp with `now`.
      expect(nextFirstAllCompleteAt(null, list, 1_000)).toBe(1_000)
      // Subsequent all-completed ticks keep the original timestamp.
      expect(nextFirstAllCompleteAt(1_000, list, 3_500)).toBe(1_000)
      expect(nextFirstAllCompleteAt(1_000, list, 9_999)).toBe(1_000)
    })

    it("returns null when sessionActive=true even for an all-completed list", () => {
      // The 5-second auto-hide is deferred during any non-IDLE session
      // state (RUNNING, WAITING_FOR_PERM, WAITING_FOR_ELIC, …). During
      // active work the agent may call TodoWrite again with a fresh list,
      // so the user should keep seeing the existing context.
      const allDone = [mk("completed"), mk("completed")]
      expect(nextFirstAllCompleteAt(null, allDone, 1_000, true)).toBeNull()
      // Even if a previous timestamp had latched (session went IDLE, then
      // started a new turn mid-grace-window), sessionActive wipes it.
      expect(nextFirstAllCompleteAt(500, allDone, 1_000, true)).toBeNull()
    })

    it("sessionActive=false matches the default (timer runs)", () => {
      // Explicit false should behave identically to omitting the argument.
      const allDone = [mk("completed"), mk("completed")]
      expect(nextFirstAllCompleteAt(null, allDone, 1_000, false)).toBe(1_000)
      expect(nextFirstAllCompleteAt(1_000, allDone, 3_500, false)).toBe(1_000)
      // Not-all-completed still resets regardless of the flag.
      const mixed = [mk("completed"), mk("pending")]
      expect(nextFirstAllCompleteAt(1_000, mixed, 2_000, false)).toBeNull()
    })
  })

  describe("computeShouldHide", () => {
    it("returns false when no all-completed timestamp is set", () => {
      expect(computeShouldHide(null, 0)).toBe(false)
      expect(computeShouldHide(null, 1_000_000)).toBe(false)
    })

    it("renders for <5s (grace window) before hiding", () => {
      expect(computeShouldHide(1_000, 1_100)).toBe(false) // +100ms
      expect(computeShouldHide(1_000, 1_000 + AUTO_HIDE_DELAY_MS - 1)).toBe(false)
    })

    it("hides at or after 5s from the first all-completed moment", () => {
      expect(computeShouldHide(1_000, 1_000 + AUTO_HIDE_DELAY_MS)).toBe(true)
      expect(computeShouldHide(1_000, 1_000 + AUTO_HIDE_DELAY_MS + 1)).toBe(true)
      expect(computeShouldHide(1_000, 10_000)).toBe(true)
    })

    it("regressing to not-all-completed BEFORE 5s resets the timer (keeps rendering)", () => {
      // Scenario: at t=1000 the list became all-completed (stamp=1000).
      // At t=4000 the agent pushes an update that includes a new pending
      // item. nextFirstAllCompleteAt now returns null, and computeShouldHide
      // with a null stamp is false — so the list remains visible.
      const stampAt1s = nextFirstAllCompleteAt(
        null,
        [mk("completed"), mk("completed")],
        1_000,
      )
      expect(stampAt1s).toBe(1_000)

      // At t=4000 (3s later — before the 5s deadline) a pending item arrives.
      const resetAt4s = nextFirstAllCompleteAt(
        stampAt1s,
        [mk("completed"), mk("pending")],
        4_000,
      )
      expect(resetAt4s).toBeNull()

      // Even well past the original 5s deadline, without a stamp the list
      // continues rendering indefinitely.
      expect(computeShouldHide(resetAt4s, 10_000)).toBe(false)
    })
  })
})

describe("buildHiddenSummary", () => {
  const mk = (status: TodoItem["status"]): TodoItem => ({
    content: "x",
    activeForm: "x",
    status,
  })

  it("returns empty string for an empty hidden list", () => {
    expect(buildHiddenSummary([])).toBe("")
  })

  it("lists only non-zero categories, in fixed order", () => {
    expect(
      buildHiddenSummary([mk("in_progress"), mk("pending"), mk("pending"), mk("completed")]),
    ).toBe(" \u2026 +1 in progress, 2 pending, 1 completed")
  })

  it("skips zero categories", () => {
    expect(buildHiddenSummary([mk("pending"), mk("pending")])).toBe(" \u2026 +2 pending")
    expect(buildHiddenSummary([mk("completed")])).toBe(" \u2026 +1 completed")
  })
})

// ---------------------------------------------------------------------------
// Rendered component assertions
// ---------------------------------------------------------------------------

describe("TaskChecklist rendering", () => {
  it("renders nothing for an empty todo list", async () => {
    const setup = await testRender(() => <TaskChecklist todos={[]} />, {
      width: 80,
      height: 24,
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    // No icons should appear.
    expect(frame).not.toContain("\u2714")
    expect(frame).not.toContain("\u25FC")
    expect(frame).not.toContain("\u25FB")
    setup.renderer.destroy()
  })

  it("emits the correct icon per status", async () => {
    const todos: TodoItem[] = [
      { content: "Finish the refactor", activeForm: "Finishing the refactor", status: "completed" },
      { content: "Run the tests", activeForm: "Running the tests", status: "in_progress" },
      { content: "Ship it", activeForm: "Shipping it", status: "pending" },
    ]
    const setup = await testRender(() => <TaskChecklist todos={todos} />, {
      width: 80,
      height: 24,
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("\u2714") // completed check
    expect(frame).toContain("\u25FC") // in-progress filled square
    expect(frame).toContain("\u25FB") // pending empty square
    // Subject text — all statuses use content (matches Claude Code reference).
    expect(frame).toContain("Finish the refactor")
    expect(frame).toContain("Run the tests")
    expect(frame).toContain("Ship it")
    setup.renderer.destroy()
  })

  it("in-progress row renders content, not activeForm", async () => {
    // Regression guard: an earlier bug rendered `activeForm` for the
    // in-progress row ("Writing hello into the file") instead of
    // `content` ("Write hello"). Claude Code's TaskListV2 unconditionally
    // uses `content`; `activeForm` belongs to the spinner verb only.
    const todos: TodoItem[] = [
      { content: "Write hello", activeForm: "Writing hello", status: "in_progress" },
    ]
    const setup = await testRender(() => <TaskChecklist todos={todos} />, {
      width: 80,
      height: 24,
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Write hello")
    expect(frame).not.toContain("Writing hello")
    setup.renderer.destroy()
  })

  it("standalone mode shows the summary header with total, done, in-progress, open", async () => {
    const todos: TodoItem[] = [
      { content: "A", activeForm: "A-ing", status: "completed" },
      { content: "B", activeForm: "B-ing", status: "in_progress" },
      { content: "C", activeForm: "C-ing", status: "pending" },
    ]
    const setup = await testRender(
      () => <TaskChecklist todos={todos} isStandalone={true} />,
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("3 tasks")
    expect(frame).toContain("1 done")
    expect(frame).toContain("1 in progress")
    expect(frame).toContain("1 open")
    setup.renderer.destroy()
  })

  it("standalone header omits 'in progress' segment when count is zero", async () => {
    const todos: TodoItem[] = [
      { content: "A", activeForm: "A-ing", status: "completed" },
      { content: "B", activeForm: "B-ing", status: "pending" },
    ]
    const setup = await testRender(
      () => <TaskChecklist todos={todos} isStandalone={true} />,
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("2 tasks")
    expect(frame).toContain("1 done")
    expect(frame).toContain("1 open")
    expect(frame).not.toContain("in progress")
    setup.renderer.destroy()
  })

  it("shows a hidden-summary line when truncating", async () => {
    // 12 pending tasks on a terminal with maxDisplay=10 → 2 hidden.
    const todos: TodoItem[] = Array.from({ length: 12 }, (_, i) => ({
      content: `Task ${i}`,
      activeForm: `Working on task ${i}`,
      status: "pending" as const,
    }))
    const setup = await testRender(() => <TaskChecklist todos={todos} />, {
      width: 80,
      height: 30,
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    // Hidden summary mentions the 2 leftover pending items.
    expect(frame).toContain("+2 pending")
    setup.renderer.destroy()
  })

  it("renders an all-completed list while still within the 5s grace window", async () => {
    // Hook into the render path and assert that immediately after mount the
    // list is still visible (shouldHide hasn't flipped yet). We don't advance
    // time; a renderOnce() tick takes well under AUTO_HIDE_DELAY_MS.
    const todos: TodoItem[] = [
      { content: "Finish A", activeForm: "Finishing A", status: "completed" },
      { content: "Finish B", activeForm: "Finishing B", status: "completed" },
    ]
    const setup = await testRender(() => <TaskChecklist todos={todos} />, {
      width: 80,
      height: 24,
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    // Within the grace window: list should still be visible.
    expect(frame).toContain("Finish A")
    expect(frame).toContain("Finish B")
    expect(frame).toContain("\u2714")
    setup.renderer.destroy()
  })

  it("suppresses the hidden-summary line on tiny terminals (maxDisplay=0)", async () => {
    // Parity with Claude Code's TaskListV2: when rows ≤ 10 (maxDisplay=0)
    // the reference hides the "… +N pending" summary entirely. Previously
    // we rendered it unconditionally whenever hiddenSummary was non-empty.
    const todos: TodoItem[] = Array.from({ length: 5 }, (_, i) => ({
      content: `Task ${i}`,
      activeForm: `Working on task ${i}`,
      status: "pending" as const,
    }))
    const setup = await testRender(() => <TaskChecklist todos={todos} />, {
      width: 80,
      height: 10, // computeMaxDisplay(10) === 0
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("pending")
    expect(frame).not.toContain("\u2026")
    setup.renderer.destroy()
  })

  it("sessionActive={true} keeps an all-completed list visible past 5s", async () => {
    // The 5s auto-hide should only fire when the session is IDLE. While a
    // turn is in flight (RUNNING / WAITING_FOR_PERM / WAITING_FOR_ELIC),
    // the user needs ongoing task context — the agent may be about to call
    // TodoWrite again. Sleep past AUTO_HIDE_DELAY_MS and verify the list
    // is still rendered.
    const todos: TodoItem[] = [
      { content: "Finish A", activeForm: "Finishing A", status: "completed" },
      { content: "Finish B", activeForm: "Finishing B", status: "completed" },
    ]
    const setup = await testRender(
      () => <TaskChecklist todos={todos} sessionActive={true} />,
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    await new Promise((r) => setTimeout(r, AUTO_HIDE_DELAY_MS + 200))
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Finish A")
    expect(frame).toContain("Finish B")
    expect(frame).toContain("\u2714")
    setup.renderer.destroy()
  }, 10_000)

  // Note: the IDLE-state "hides at 5s" behavior is covered by the pure
  // helper tests above (computeShouldHide + nextFirstAllCompleteAt with
  // sessionActive=false). Pinning it with a real-time rendered assertion
  // is flaky under load — the reactivity path fires deterministically in
  // isolation but can miss a re-render when the whole TUI suite runs in
  // one Bun process.
})
