/**
 * Reducer tests for V1 TodoWrite semantics (`todos_updated` event).
 *
 * Scope:
 *  - Full-list replacement on each event (the reducer stores what the agent
 *    sent — no auto-clear).
 *  - All-completed payloads ARE stored as-is; the UI handles auto-hide with
 *    a delay (see TaskChecklist component, matching Claude Code's V2 timer
 *    described in team/backlog/done/task-view.md §6.3).
 *  - Reset to [] on `session_init` (new session == fresh todo list).
 *  - Persistence across `turn_start` (todos deliberately survive turn
 *    boundaries, unlike activeTasks which is pruned).
 *  - Reset on backend switch via `resetVolatileSessionState()`.
 */

import { describe, expect, test } from "bun:test"
import { reduce } from "../../src/protocol/reducer"
import {
  createInitialState,
  resetVolatileSessionState,
  type AgentEvent,
  type ConversationState,
  type TodoItem,
} from "../../src/protocol/types"

function applyEvents(events: AgentEvent[]): ConversationState {
  return events.reduce((s, e) => reduce(s, e), createInitialState())
}

const T = (
  content: string,
  status: TodoItem["status"] = "pending",
  activeForm?: string,
): TodoItem => ({
  content,
  activeForm: activeForm ?? content.replace(/^(\w+)/, (m) => `${m}ing`),
  status,
})

describe("todos_updated", () => {
  test("initial state starts with an empty todos list", () => {
    expect(createInitialState().todos).toEqual([])
  })

  test("replaces the todos array with the event payload", () => {
    const state = applyEvents([
      { type: "session_init", tools: [], models: [] },
      {
        type: "todos_updated",
        todos: [
          T("Run tests", "pending"),
          T("Write docs", "in_progress", "Writing docs"),
        ],
      },
    ])
    expect(state.todos).toHaveLength(2)
    expect(state.todos[0]!.content).toBe("Run tests")
    expect(state.todos[1]!.status).toBe("in_progress")
  })

  test("a second todos_updated fully replaces the first (not merge)", () => {
    const state = applyEvents([
      { type: "session_init", tools: [], models: [] },
      {
        type: "todos_updated",
        todos: [T("A"), T("B"), T("C")],
      },
      {
        type: "todos_updated",
        // Different length, different contents — full replace semantics.
        todos: [T("Only one", "in_progress", "Doing only one")],
      },
    ])
    expect(state.todos).toHaveLength(1)
    expect(state.todos[0]!.content).toBe("Only one")
  })

  test("stores an all-completed list as-is (auto-hide is UI-only)", () => {
    // The reducer no longer auto-clears when every item is completed.
    // Auto-hide with a 5s delay is handled in the TaskChecklist component,
    // matching Claude Code's V2 hide timer. Keeping the data in state lets
    // the UI render the "all done" moment before it fades out.
    const state = applyEvents([
      { type: "session_init", tools: [], models: [] },
      {
        type: "todos_updated",
        todos: [
          T("A", "completed"),
          T("B", "completed"),
          T("C", "completed"),
        ],
      },
    ])
    expect(state.todos).toHaveLength(3)
    expect(state.todos.every((t) => t.status === "completed")).toBe(true)
  })

  test("a subsequent all-completed payload replaces prior list as-is", () => {
    // Regression guard for the reducer behavior flip: previously this would
    // auto-clear to []. Now it must store the incoming list verbatim.
    const state = applyEvents([
      { type: "session_init", tools: [], models: [] },
      {
        type: "todos_updated",
        todos: [T("A", "in_progress", "Aing"), T("B", "pending")],
      },
      {
        type: "todos_updated",
        todos: [T("A", "completed"), T("B", "completed")],
      },
    ])
    expect(state.todos).toHaveLength(2)
    expect(state.todos[0]!.status).toBe("completed")
    expect(state.todos[1]!.status).toBe("completed")
  })

  test("does NOT auto-clear when at least one item is not completed", () => {
    const state = applyEvents([
      { type: "session_init", tools: [], models: [] },
      {
        type: "todos_updated",
        todos: [
          T("A", "completed"),
          T("B", "in_progress", "Bing"),
          T("C", "completed"),
        ],
      },
    ])
    expect(state.todos).toHaveLength(3)
    expect(state.todos[1]!.status).toBe("in_progress")
  })

  test("empty incoming list is stored as [] (explicit clear)", () => {
    const state = applyEvents([
      { type: "session_init", tools: [], models: [] },
      { type: "todos_updated", todos: [T("A"), T("B")] },
      { type: "todos_updated", todos: [] },
    ])
    expect(state.todos).toEqual([])
  })
})

describe("todos lifecycle", () => {
  test("session_init resets todos to []", () => {
    const state = applyEvents([
      { type: "session_init", tools: [], models: [] },
      {
        type: "todos_updated",
        todos: [T("A", "in_progress", "Aing"), T("B", "pending")],
      },
      // A fresh session_init (e.g. /new, resetSession) wipes the list.
      { type: "session_init", tools: [], models: [] },
    ])
    expect(state.todos).toEqual([])
  })

  test("turn_start does NOT clear todos (they persist across turns)", () => {
    const todos: TodoItem[] = [
      T("A", "in_progress", "Aing"),
      T("B", "pending"),
    ]
    const state = applyEvents([
      { type: "session_init", tools: [], models: [] },
      { type: "todos_updated", todos },
      // A new turn starts — unlike activeTasks, todos should survive.
      { type: "turn_start" },
    ])
    expect(state.todos).toHaveLength(2)
    expect(state.todos[0]!.content).toBe("A")
    expect(state.todos[1]!.status).toBe("pending")
  })

  test("turn_complete does not clear todos either", () => {
    const todos: TodoItem[] = [T("A", "in_progress", "Aing")]
    const state = applyEvents([
      { type: "session_init", tools: [], models: [] },
      { type: "todos_updated", todos },
      { type: "turn_start" },
      { type: "turn_complete" },
    ])
    expect(state.todos).toHaveLength(1)
    expect(state.todos[0]!.status).toBe("in_progress")
  })
})

describe("todos on backend switch", () => {
  test("resetVolatileSessionState clears todos", () => {
    const dirty: ConversationState = {
      ...createInitialState(),
      todos: [T("A", "in_progress", "Aing"), T("B", "pending")],
    }
    const after = resetVolatileSessionState(dirty)
    expect(after.todos).toEqual([])
  })
})
