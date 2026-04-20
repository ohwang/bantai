/**
 * TaskChecklist — Renders a TodoWrite-backed task list as a checklist.
 *
 * Driven by `ConversationState.todos` (V1 TodoItem[]): an imperative
 * `content`, a present-continuous `activeForm`, and a `status` of
 * "pending" | "in_progress" | "completed".
 *
 * Visual style mirrors Claude Code's TaskListV2, minus the V2-only
 * features (owner column, blocked indicators, activity description).
 * See team/backlog/task-view.md §4 for the rendering spec.
 *
 *  ✔ Completed task      (green check, strikethrough + dim)
 *  ◼ In-progress task    (claude orange, bold)
 *  ◻ Pending task        (default color, normal)
 *   … +1 in progress, 2 pending, 5 completed   (dim hidden-summary)
 *
 * Standalone mode wraps the list in an indented container with a header
 * line summarising totals, for use between turns / when idle.
 */

import type { JSX } from "solid-js"
import { createMemo, For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { TodoItem } from "../../../protocol/types"
import { colors } from "../theme/tokens"

const ICON_COMPLETED = "\u2714" // ✔
const ICON_IN_PROGRESS = "\u25FC" // ◼
const ICON_PENDING = "\u25FB" // ◻

const DEFAULT_COLUMNS = 80
const DEFAULT_ROWS = 24

// ---------------------------------------------------------------------------
// Pure helpers (exported for test coverage)
// ---------------------------------------------------------------------------

export function computeMaxDisplay(rows: number): number {
  if (rows <= 10) return 0
  return Math.min(10, Math.max(3, rows - 14))
}

export function computeMaxSubjectWidth(columns: number): number {
  return Math.max(15, columns - 15)
}

export function truncateSubject(subject: string, maxWidth: number): string {
  if (subject.length <= maxWidth) return subject
  if (maxWidth <= 1) return subject.slice(0, maxWidth)
  return subject.slice(0, maxWidth - 1) + "\u2026"
}

/**
 * Pick the subject text to display. Always returns `content` regardless of
 * status — this matches Claude Code's TaskListV2 reference (`task.subject`
 * is unconditional on status). `activeForm` is reserved for the spinner
 * verb ("Writing hello into the file"), not for list rows.
 */
export function pickSubject(todo: TodoItem): string {
  return todo.content
}

/**
 * Priority ordering for truncation:
 *   1. recently completed (later indices first — newer completions float up)
 *   2. in-progress
 *   3. pending
 *   4. older completed
 *
 * Insertion order is preserved within each bucket (V1 TodoItem has no id).
 */
export function prioritizeTodos(todos: readonly TodoItem[]): TodoItem[] {
  const inProgress: TodoItem[] = []
  const pending: TodoItem[] = []
  const completed: Array<{ todo: TodoItem; index: number }> = []

  for (let i = 0; i < todos.length; i++) {
    const t = todos[i]!
    if (t.status === "in_progress") inProgress.push(t)
    else if (t.status === "pending") pending.push(t)
    else if (t.status === "completed") completed.push({ todo: t, index: i })
  }

  // Recent completed = upper half (later indices). Stable split keeps order
  // within each half. Without timestamps this is the best-effort heuristic.
  const half = Math.ceil(completed.length / 2)
  const recentCompleted = completed.slice(completed.length - half).map((c) => c.todo)
  const olderCompleted = completed.slice(0, completed.length - half).map((c) => c.todo)

  return [...recentCompleted, ...inProgress, ...pending, ...olderCompleted]
}

export function buildHiddenSummary(hidden: readonly TodoItem[]): string {
  if (hidden.length === 0) return ""
  let inProgress = 0
  let pending = 0
  let completed = 0
  for (const t of hidden) {
    if (t.status === "in_progress") inProgress++
    else if (t.status === "pending") pending++
    else if (t.status === "completed") completed++
  }
  const parts: string[] = []
  if (inProgress > 0) parts.push(`${inProgress} in progress`)
  if (pending > 0) parts.push(`${pending} pending`)
  if (completed > 0) parts.push(`${completed} completed`)
  if (parts.length === 0) return ""
  return ` \u2026 +${parts.join(", ")}`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TaskChecklist(props: {
  todos: TodoItem[]
  isStandalone?: boolean
}): JSX.Element {
  const dims = useTerminalDimensions()

  const columns = createMemo(() => dims()?.width ?? DEFAULT_COLUMNS)
  const rows = createMemo(() => dims()?.height ?? DEFAULT_ROWS)
  const maxDisplay = createMemo(() => computeMaxDisplay(rows()))
  const maxSubjectWidth = createMemo(() => computeMaxSubjectWidth(columns()))

  // Counts over the entire list (for standalone header + hidden-summary).
  const counts = createMemo(() => {
    let completed = 0
    let inProgress = 0
    let pending = 0
    for (const t of props.todos) {
      if (t.status === "completed") completed++
      else if (t.status === "in_progress") inProgress++
      else if (t.status === "pending") pending++
    }
    return { completed, inProgress, pending, total: props.todos.length }
  })

  // Visible / hidden split. When `maxDisplay === 0` (very small terminal) we
  // still render the summary line below if there are any tasks.
  const slices = createMemo(() => {
    const md = maxDisplay()
    const list = props.todos
    if (list.length === 0) return { visible: [], hidden: [] as TodoItem[] }
    if (list.length <= md) {
      // Preserve insertion order when nothing is truncated.
      return { visible: list.slice(), hidden: [] as TodoItem[] }
    }
    const prioritized = prioritizeTodos(list)
    return {
      visible: prioritized.slice(0, md),
      hidden: prioritized.slice(md),
    }
  })

  const renderRows = createMemo(() =>
    slices().visible.map((todo) => ({
      status: todo.status,
      subject: truncateSubject(pickSubject(todo), maxSubjectWidth()),
    })),
  )

  const hiddenSummary = createMemo(() => buildHiddenSummary(slices().hidden))

  // Bail entirely when the list is empty — never render nothing-but-margin.
  return (
    <Show when={props.todos.length > 0}>
      <Show
        when={props.isStandalone}
        fallback={
          <box flexDirection="column">
            <ChecklistBody rows={renderRows()} hiddenSummary={hiddenSummary()} />
          </box>
        }
      >
        <box flexDirection="column" marginTop={1} marginLeft={2}>
          <StandaloneHeader
            total={counts().total}
            completed={counts().completed}
            inProgress={counts().inProgress}
            pending={counts().pending}
          />
          <ChecklistBody rows={renderRows()} hiddenSummary={hiddenSummary()} />
        </box>
      </Show>
    </Show>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type RenderRow = { status: TodoItem["status"]; subject: string }

/** The body shared by standalone and inline modes: rows + optional summary. */
function ChecklistBody(props: {
  rows: RenderRow[]
  hiddenSummary: string
}): JSX.Element {
  return (
    <>
      <For each={props.rows}>
        {(row) => <TaskRow status={row.status} subject={row.subject} />}
      </For>
      <Show when={props.hiddenSummary.length > 0}>
        <text fg={colors.text.muted}>{props.hiddenSummary}</text>
      </Show>
    </>
  )
}

/** Single task row: "{icon} {subject}" — icon colored by status, subject styled. */
function TaskRow(props: { status: TodoItem["status"]; subject: string }): JSX.Element {
  // Read `colors` inline (reactive theme store) rather than snapshotting.
  return (
    <box flexDirection="row">
      <Show when={props.status === "completed"}>
        <text fg={colors.status.success}>{ICON_COMPLETED + " "}</text>
        <text
          fg={colors.text.secondary}
          attributes={TextAttributes.STRIKETHROUGH | TextAttributes.DIM}
        >
          {props.subject}
        </text>
      </Show>
      <Show when={props.status === "in_progress"}>
        <text fg={colors.accent.primary}>{ICON_IN_PROGRESS + " "}</text>
        <text fg={colors.text.primary} attributes={TextAttributes.BOLD}>
          {props.subject}
        </text>
      </Show>
      <Show when={props.status === "pending"}>
        <text fg={colors.text.primary}>{ICON_PENDING + " "}</text>
        <text fg={colors.text.primary}>{props.subject}</text>
      </Show>
    </box>
  )
}

/** Standalone-mode header: "N tasks (A done[, B in progress], C open)" */
function StandaloneHeader(props: {
  total: number
  completed: number
  inProgress: number
  pending: number
}): JSX.Element {
  return (
    <box flexDirection="row">
      <text fg={colors.text.muted} attributes={TextAttributes.BOLD}>
        {String(props.total)}
      </text>
      <text fg={colors.text.muted}>{" tasks ("}</text>
      <text fg={colors.text.muted} attributes={TextAttributes.BOLD}>
        {String(props.completed)}
      </text>
      <text fg={colors.text.muted}>{" done"}</text>
      <Show when={props.inProgress > 0}>
        <text fg={colors.text.muted}>{", "}</text>
        <text fg={colors.text.muted} attributes={TextAttributes.BOLD}>
          {String(props.inProgress)}
        </text>
        <text fg={colors.text.muted}>{" in progress"}</text>
      </Show>
      <text fg={colors.text.muted}>{", "}</text>
      <text fg={colors.text.muted} attributes={TextAttributes.BOLD}>
        {String(props.pending)}
      </text>
      <text fg={colors.text.muted}>{" open)"}</text>
    </box>
  )
}
