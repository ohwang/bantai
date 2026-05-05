/**
 * Session Context — Session state + cost tracking
 *
 * Tracks the session lifecycle state, cost totals, and session metadata.
 */

import {
  createContext,
  useContext,
  type ParentProps,
} from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type {
  SessionState,
  SessionMetadata,
  CostTotals,
  ErrorEvent,
  RateLimits,
  AgentSlashCommand,
  ConfigOption,
  PermissionMode,
} from "../../../protocol/types"

export interface SessionContextState {
  sessionState: SessionState
  session: SessionMetadata | null
  cost: CostTotals
  lastError: ErrorEvent | null
  turnNumber: number
  lastTurnInputTokens: number
  /** Milliseconds from query start to the first streamed token for the
   *  most recent completed turn (SDK 0.2.112+ `ttft_ms`). `null` when the
   *  backend didn't report one (non-Claude or pre-0.2.112). Reset on each
   *  new `turn_start` so the status bar doesn't leak stale figures. */
  lastTurnTtftMs: number | null
  currentModel: string
  currentEffort: string
  rateLimits: RateLimits | null
  agentCommands: AgentSlashCommand[]
  configOptions: ConfigOption[]
  /** Permission modes the active backend currently supports. Mirrored
   *  from `ConversationState.supportedPermissionModes`. The Shift+Tab
   *  cycler in the status bar reads this; backends emit it via the
   *  `capabilities_updated` event so the cycler refreshes when modes are
   *  discovered post-handshake (F-13). */
  supportedPermissionModes: PermissionMode[]
  /** True while session history is being parsed (or the Gemini replay window
   *  is draining). Populated from ConversationState.resuming. Consumed by the
   *  input area to render a spinner and block typing. */
  resuming: boolean

  /** Live working directory as reported by the backend (Claude SDK
   *  `CwdChanged` hook). Null until the first change is observed — the
   *  header bar falls back to `agent.config.cwd` in that case. */
  currentCwd: string | null

  /** Active worktree, set by `worktree_created`, cleared by `worktree_removed`.
   *  Only populated for the Claude backend when the agent uses the built-in
   *  `EnterWorktree` tool. */
  worktree: { path: string; name?: string } | null
}

export interface SessionContextValue {
  state: SessionContextState
  setState: SetStoreFunction<SessionContextState>
}

export const SessionContext = createContext<SessionContextValue>()

export function SessionProvider(props: ParentProps) {
  const [state, setState] = createStore<SessionContextState>({
    sessionState: "INITIALIZING",
    session: null,
    cost: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0,
    },
    lastError: null,
    turnNumber: 0,
    lastTurnInputTokens: 0,
    lastTurnTtftMs: null,
    currentModel: "",
    currentEffort: "",
    rateLimits: null,
    agentCommands: [],
    configOptions: [],
    supportedPermissionModes: [],
    resuming: false,
    currentCwd: null,
    worktree: null,
  })

  return (
    <SessionContext.Provider value={{ state, setState }}>
      {props.children}
    </SessionContext.Provider>
  )
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error("useSession must be used within SessionProvider")
  return ctx
}
