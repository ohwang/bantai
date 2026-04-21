/**
 * Messages Context — Message list + queue signals
 *
 * Provides reactive access to conversation messages and pending queue.
 * Updated by the sync context when events arrive.
 */

import {
  createContext,
  useContext,
  type ParentProps,
} from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type {
  Block,
  TaskInfo,
  TodoItem,
  TurnFileChange,
  TurnSummaryInfo,
} from "../../../protocol/types"

export interface MessagesState {
  blocks: Block[]
  streamingText: string
  streamingThinking: string
  activeTasks: [string, TaskInfo][]
  backgrounded: boolean
  streamingOutputTokens: number
  lastTurnFiles?: TurnFileChange[]
  /** Per-turn summary used by the conversation view to render the
   *  "Baked for X · Y tokens · $Z" line below the files-changed block.
   *  Null when the backend didn't report anything worth showing. */
  lastTurnSummary: TurnSummaryInfo | null
  todos: TodoItem[]
}

export interface MessagesContextValue {
  state: MessagesState
  setState: SetStoreFunction<MessagesState>
}

export const MessagesContext = createContext<MessagesContextValue>()

export function MessagesProvider(props: ParentProps) {
  const [state, setState] = createStore<MessagesState>({
    blocks: [],
    streamingText: "",
    streamingThinking: "",
    activeTasks: [],
    backgrounded: false,
    streamingOutputTokens: 0,
    lastTurnSummary: null,
    todos: [],
  })

  return (
    <MessagesContext.Provider value={{ state, setState }}>
      {props.children}
    </MessagesContext.Provider>
  )
}

export function useMessages(): MessagesContextValue {
  const ctx = useContext(MessagesContext)
  if (!ctx) throw new Error("useMessages must be used within MessagesProvider")
  return ctx
}
