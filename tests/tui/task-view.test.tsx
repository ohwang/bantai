/**
 * TaskView component tests.
 *
 * Focuses on the redundant-output suppression: when a completed task's
 * `output` echoes its `description` (after trim + case-fold normalization),
 * the second line should not render.
 */

import { describe, it, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { TaskView, isRedundantOutput } from "../../src/frontends/tui/components/task-view"
import { AnimationProvider } from "../../src/frontends/tui/context/animation"
import type { TaskInfo } from "../../src/protocol/types"

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

describe("isRedundantOutput", () => {
  it("treats undefined output as redundant", () => {
    expect(isRedundantOutput("anything", undefined)).toBe(true)
  })

  it("treats empty output as redundant", () => {
    expect(isRedundantOutput("anything", "")).toBe(true)
  })

  it("treats exact match as redundant", () => {
    expect(isRedundantOutput("Sleep 15s then echo TaskA", "Sleep 15s then echo TaskA")).toBe(true)
  })

  it("ignores leading/trailing whitespace and case", () => {
    expect(isRedundantOutput("hello world", "  Hello World  ")).toBe(true)
    expect(isRedundantOutput("  Hello World  ", "hello world")).toBe(true)
  })

  it("returns false when content actually differs", () => {
    expect(isRedundantOutput("Sleep 15s then echo TaskA", "done: TaskA")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rendered component assertions
// ---------------------------------------------------------------------------

const mkTask = (overrides: Partial<TaskInfo> & { taskId: string; description: string }): TaskInfo => ({
  taskId: overrides.taskId,
  description: overrides.description,
  output: overrides.output ?? "",
  status: overrides.status ?? "completed",
  startTime: overrides.startTime ?? Date.now(),
})

describe("TaskView rendering — redundant output suppression", () => {
  it("hides the output row when output is identical to description", async () => {
    const tasks: [string, TaskInfo][] = [
      ["t1", mkTask({
        taskId: "t1",
        description: "Sleep 15 seconds then echo TaskA",
        output: "Sleep 15 seconds then echo TaskA",
        status: "completed",
      })],
    ]
    const setup = await testRender(
      () => (
        <AnimationProvider>
          <TaskView tasks={tasks} />
        </AnimationProvider>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    // Description appears once (on the task line).
    const matches = frame.match(/Sleep 15 seconds then echo TaskA/g) ?? []
    expect(matches.length).toBe(1)
    setup.renderer.destroy()
  })

  it("hides the output row when output differs only by whitespace/case", async () => {
    const tasks: [string, TaskInfo][] = [
      ["t1", mkTask({
        taskId: "t1",
        description: "hello world",
        output: "  Hello World  ",
        status: "completed",
      })],
    ]
    const setup = await testRender(
      () => (
        <AnimationProvider>
          <TaskView tasks={tasks} />
        </AnimationProvider>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    // No "Hello World" echo below.
    const matches = frame.match(/Hello World/gi) ?? []
    expect(matches.length).toBe(1)
    setup.renderer.destroy()
  })

  it("renders the output row when output is genuinely distinct", async () => {
    const tasks: [string, TaskInfo][] = [
      ["t1", mkTask({
        taskId: "t1",
        description: "Sleep 15 seconds then echo TaskA",
        output: "Done: TaskA",
        status: "completed",
      })],
    ]
    const setup = await testRender(
      () => (
        <AnimationProvider>
          <TaskView tasks={tasks} />
        </AnimationProvider>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Sleep 15 seconds then echo TaskA")
    expect(frame).toContain("Done: TaskA")
    setup.renderer.destroy()
  })
})
