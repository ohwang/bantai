/**
 * Task View — Subagent/background task display
 *
 * Shows active and completed tasks as a grouped tree.
 * Running tasks show blinking dot, completed show solid green dot.
 * Uses BlinkingDot primitive for consistent progress indication.
 */

import { createSignal, onCleanup, For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { TaskInfo } from "../../../protocol/types"
import { colors } from "../theme/tokens"
import { BlinkingDot } from "./primitives"

const MAX_VISIBLE_TASKS = 10

export function isRedundantOutput(description: string, output: string | undefined): boolean {
  if (!output) return true
  return description.trim().toLowerCase() === output.trim().toLowerCase()
}

export function TaskView(props: { tasks: [string, TaskInfo][] }) {
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((t) => t + 1), 1000)
  onCleanup(() => clearInterval(timer))

  const hasAny = () => props.tasks.length > 0
  const runningCount = () => props.tasks.filter(([, t]) => t.status === "running").length
  const completedCount = () => props.tasks.filter(([, t]) => t.status === "completed").length

  const header = () => {
    const r = runningCount()
    const c = completedCount()
    if (r > 0 && c > 0) {
      return `${r} agent${r > 1 ? "s" : ""} running \u00B7 ${c} finished`
    }
    if (r > 0) {
      return `${r} agent${r > 1 ? "s" : ""} running`
    }
    return `${c} agent${c > 1 ? "s" : ""} finished`
  }

  return (
    <Show when={hasAny()}>
      <box flexDirection="column" paddingTop={1}>
        <box flexDirection="row" paddingLeft={2}>
          <BlinkingDot status={runningCount() > 0 ? "active" : "success"} />
          <text fg={colors.accent.secondary} attributes={TextAttributes.BOLD}>
            {" " + header()}
          </text>
        </box>
        <For each={props.tasks.slice(0, MAX_VISIBLE_TASKS)}>
          {([_id, task], index) => {
            const isLast = () => index() === Math.min(props.tasks.length, MAX_VISIBLE_TASKS) - 1
            const prefix = () => (isLast() ? "\u2514\u2500" : "\u251C\u2500")
            const dotStatus = () => task.status === "running" ? "active" as const : "success" as const

            return (
              <box flexDirection="column">
                <box flexDirection="row" paddingLeft={3}>
                  <text fg={colors.text.secondary}>{prefix()} </text>
                  <BlinkingDot status={dotStatus()} />
                  <text fg={colors.text.primary}>{" " + task.description}</text>
                  <Show when={task.status === "running"}>
                    <text fg={colors.text.secondary}>
                      {" (" + (() => { tick(); return Math.max(0, Math.round((Date.now() - task.startTime) / 1000)) })() + "s)"}
                    </text>
                  </Show>
                </box>
                <Show when={task.status === "completed" && task.output && !isRedundantOutput(task.description, task.output)}>
                  <box flexDirection="row" paddingLeft={3}>
                    <text fg={colors.text.secondary}>{isLast() ? "     " : "\u2502    "}</text>
                    <text fg={colors.text.muted}>
                      {task.output!.length > 80
                        ? task.output!.slice(0, 77) + "..."
                        : task.output}
                    </text>
                  </box>
                </Show>
              </box>
            )
          }}
        </For>
        <Show when={props.tasks.length > MAX_VISIBLE_TASKS}>
          <text fg={colors.text.muted}>
            {"    ... and " + (props.tasks.length - MAX_VISIBLE_TASKS) + " more"}
          </text>
        </Show>
      </box>
    </Show>
  )
}
