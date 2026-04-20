/**
 * TaskChecklist component tests.
 *
 * Mix of pure-helper assertions (truncation, prioritization, hidden-summary
 * formatting) and rendered-frame assertions via @opentui/solid's testRender.
 */

import { describe, it, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import {
  TaskChecklist,
  computeMaxDisplay,
  computeMaxSubjectWidth,
  truncateSubject,
  pickSubject,
  prioritizeTodos,
  buildHiddenSummary,
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
  })

  it("truncates with ellipsis when over budget", () => {
    const out = truncateSubject("this is a long subject line", 10)
    expect(out.length).toBe(10)
    expect(out.endsWith("\u2026")).toBe(true)
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
})
