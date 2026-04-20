/**
 * StoryContextProvider — wraps a story's render() output with the
 * full context provider stack, pre-seeded with mock values.
 *
 * Creates stores with the story's initial values directly rather than
 * using default providers + setState override. This avoids SolidJS
 * timing issues where children are evaluated before setState runs.
 */

import { type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import type { StoryContext } from "../types"
import { NoopBackend } from "../fixtures/backend"
import { AgentProvider, createAgentContextValue } from "../../frontends/tui/context/agent"
import {
  SessionContext,
  type SessionContextState,
  type SessionContextValue,
} from "../../frontends/tui/context/session"
import {
  MessagesContext,
  type MessagesState,
  type MessagesContextValue,
} from "../../frontends/tui/context/messages"
import {
  PermissionsContext,
  type PermissionsState,
  type PermissionsContextValue,
} from "../../frontends/tui/context/permissions"
import { SyncContext, type SyncContextValue } from "../../frontends/tui/context/sync"
import { AnimationProvider } from "../../frontends/tui/context/animation"
import { ToastProvider } from "../../frontends/tui/context/toast"
import { ModalProvider } from "../../frontends/tui/context/modal"

const DEFAULT_SESSION: SessionContextState = {
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
  resuming: false,
  currentCwd: null,
  worktree: null,
}

const DEFAULT_MESSAGES: MessagesState = {
  blocks: [],
  streamingText: "",
  streamingThinking: "",
  streamingOutputTokens: 0,
  activeTasks: [],
  backgrounded: false,
}

const DEFAULT_PERMISSIONS: PermissionsState = {
  pendingPermission: null,
  pendingElicitation: null,
}

const NOOP_SYNC: SyncContextValue = {
  pushEvent: () => {},
  startEventLoop: () => {},
  clearConversation: () => {},
  resetCost: () => {},
  switchBackend: async () => {},
  switchProgress: () => null,
}

export function StoryContextProvider(props: ParentProps<{ context?: StoryContext }>) {
  // Capture context eagerly — SolidJS props are reactive getters
  const ctx = props.context

  const agentValue = createAgentContextValue(
    (ctx?.agent?.backend ?? new NoopBackend()) as any,
    { cwd: process.cwd(), ...ctx?.agent?.config } as any,
  )

  // Pre-seed stores with story values merged over defaults
  const sessionInit = { ...DEFAULT_SESSION, ...ctx?.session } as SessionContextState
  const [sessionState, setSessionState] = createStore<SessionContextState>(sessionInit)

  const [messagesState, setMessagesState] = createStore<MessagesState>({
    ...DEFAULT_MESSAGES,
    ...ctx?.messages,
  } as MessagesState)

  const [permissionsState, setPermissionsState] = createStore<PermissionsState>({
    ...DEFAULT_PERMISSIONS,
    ...ctx?.permissions,
  } as PermissionsState)

  const sessionValue: SessionContextValue = { state: sessionState, setState: setSessionState }
  const messagesValue: MessagesContextValue = { state: messagesState, setState: setMessagesState }
  const permissionsValue: PermissionsContextValue = { state: permissionsState, setState: setPermissionsState }

  return (
    <AgentProvider value={agentValue}>
      <SessionContext.Provider value={sessionValue}>
        <MessagesContext.Provider value={messagesValue}>
          <PermissionsContext.Provider value={permissionsValue}>
            <SyncContext.Provider value={NOOP_SYNC}>
              <AnimationProvider>
                <ToastProvider>
                  <ModalProvider>
                    {props.children}
                  </ModalProvider>
                </ToastProvider>
              </AnimationProvider>
            </SyncContext.Provider>
          </PermissionsContext.Provider>
        </MessagesContext.Provider>
      </SessionContext.Provider>
    </AgentProvider>
  )
}
