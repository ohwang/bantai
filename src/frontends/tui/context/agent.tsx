/**
 * Agent Context — AppContext provider
 *
 * Central DI container for the TUI. Created at startup via factory functions.
 * Components access via useAgent().
 *
 * The `backend` field is a live reference that can be swapped at runtime by
 * `/switch`. Consumers read `agent.backend` through a property getter backed
 * by a SolidJS signal, so every call site automatically picks up the current
 * adapter without needing explicit re-subscription.
 *
 * `permissionMode` is the single reactive source of truth for the active
 * permission mode across the TUI. It is seeded from `config.permissionMode`
 * at launch and mutated only via `setPermissionMode`, which both pushes the
 * new mode down to the live backend and updates the signal so every UI
 * surface (status bar, diagnostics panel, status-line command) re-renders
 * within the same frame. Reading `config.permissionMode` directly from a
 * component is a bug — that field is a launch-time snapshot and goes stale
 * the moment the user hits Shift+Tab.
 */

import {
  createContext,
  createSignal,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import type {
  AgentBackend,
  PermissionMode,
  SessionConfig,
} from "../../../protocol/types"
import { log } from "../../../utils/logger"

/**
 * The context value exposes `backend` as a live getter (not a snapshot).
 * Call sites written as `agent.backend.capabilities()` keep working; they
 * re-read the current backend on every invocation. Reactive consumers that
 * want to track swaps explicitly can use `backendAccessor`.
 */
export interface AgentContextValue {
  /** Live reference to the current adapter. Re-read on every access. */
  readonly backend: AgentBackend
  /** SolidJS accessor form — use inside createEffect/createMemo to re-run on swap. */
  readonly backendAccessor: Accessor<AgentBackend>
  /** Swap in a new adapter. Callers are responsible for closing the old one. */
  setBackend: (next: AgentBackend) => void
  /** Mutable session config — the same object is reused across backend swaps. */
  config: SessionConfig
  /**
   * Reactive accessor for the active permission mode. Every TUI surface that
   * displays the mode (status bar, diagnostics panel, status-line input)
   * MUST read through this accessor — never `config.permissionMode`, which
   * is the launch-time seed and does not update on Shift+Tab.
   */
  readonly permissionMode: Accessor<PermissionMode>
  /**
   * Apply a new permission mode end-to-end: push it to the live backend
   * (which may reject it for unsupported modes) and, on success, update the
   * reactive signal + mirror it onto `config.permissionMode` so any future
   * backend swap inherits the latest user choice. Returns the resolved mode
   * (the requested one on success, the previous one if the backend threw).
   */
  setPermissionMode: (mode: PermissionMode) => Promise<PermissionMode>
}

const AgentContext = createContext<AgentContextValue>()

/** Factory for the context value. Call once at app start. */
export function createAgentContextValue(
  initialBackend: AgentBackend,
  config: SessionConfig,
): AgentContextValue {
  const [backend, setBackend] = createSignal<AgentBackend>(initialBackend)
  const [permissionMode, setPermissionModeSignal] = createSignal<PermissionMode>(
    config.permissionMode ?? "default",
  )

  const setPermissionMode = async (mode: PermissionMode): Promise<PermissionMode> => {
    const previous = permissionMode()
    if (mode === previous) return previous
    try {
      await backend().setPermissionMode(mode)
    } catch (err) {
      // Backend rejected (e.g. follow mode is read-only, or ACP agent doesn't
      // advertise this mode). Leave the signal alone so the UI keeps showing
      // the previously-applied mode rather than a state that never took.
      log.warn("Failed to set permission mode", { mode, error: String(err) })
      return previous
    }
    setPermissionModeSignal(mode)
    // Mirror onto config so a subsequent /switch (which constructs a new
    // adapter from the same config) inherits the live mode rather than the
    // launch-time one.
    config.permissionMode = mode
    return mode
  }

  return {
    get backend() {
      return backend()
    },
    backendAccessor: backend,
    setBackend,
    config,
    permissionMode,
    setPermissionMode,
  }
}

export function AgentProvider(
  props: ParentProps<{ value: AgentContextValue }>,
) {
  return (
    <AgentContext.Provider value={props.value}>
      {props.children}
    </AgentContext.Provider>
  )
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error("useAgent must be used within AgentProvider")
  return ctx
}
