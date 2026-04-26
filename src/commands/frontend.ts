/**
 * FrontendBridge — the seam between frontend-neutral command logic and
 * frontend-specific UI (OpenTUI panels, Slack Block Kit, Electron windows, …).
 *
 * Slash commands receive a `FrontendBridge` via `CommandContext.frontend` and
 * must never import from `src/frontends/tui/` or `@opentui/*` directly. A frontend
 * implements the bridge and passes it when it constructs a `CommandContext`.
 *
 * This file deliberately has **no** TUI imports. It is the reason the
 * command registry can be consumed by a non-TUI frontend.
 */

/**
 * Identifiers for rich panels that a frontend may know how to render.
 *
 * The string literal union is informative — frontends are free to accept
 * additional kinds. Unknown kinds should be logged and treated as a no-op.
 */
export type PanelKind =
  | "help"
  | "hotkeys"
  | "about"
  | "ab"
  | (string & {})

/** Data passed to the "help" panel. */
export interface HelpPanelData {
  commands: Array<{
    name: string
    description: string
    aliases?: string[]
    argumentHint?: string
    type?: "local" | "prompt"
  }>
}

/** Data passed to the "ab" panel (A/B comparison modal). */
export interface AbPanelData {
  orchestrator: unknown // OrchestratorHandle — opaque to core
  onDismiss: () => void
}

/** Lightweight theme descriptor surfaced to frontend-neutral code. */
export interface ThemeSummary {
  id: string
  name: string
}

/** Lightweight status bar preset descriptor surfaced to frontend-neutral code. */
export interface StatusBarSummary {
  id: string
  name: string
  description?: string
}

export interface ApplyThemeResult {
  ok: boolean
  /** Human-readable name of the theme that is now active (on success). */
  appliedName?: string
  /** Error detail when `ok: false` (unknown id, frontend refused, etc.). */
  error?: string
}

export interface ApplyStatusBarResult {
  /** The id that actually became active — may differ from the request on fallback. */
  id: string
  /** Human-readable name of the applied preset. */
  appliedName?: string
  /** True when the requested id was unknown and a default was substituted. */
  fellBack: boolean
  /** The original id the caller asked for (set when `fellBack` is true). */
  requestedId?: string
}

/**
 * Frontend capability surface available to slash commands and any other
 * frontend-neutral code that needs to ask the hosting UI to do something.
 *
 * All methods are optional so a minimally-featured frontend (e.g. headless
 * runner) can implement only the parts it cares about. Commands should treat
 * missing methods as "not supported in this frontend" — typically by pushing
 * an ephemeral `system_message` event instead.
 */
export interface FrontendBridge {
  /**
   * Open a named panel. The frontend decides how to render it. `data` is
   * panel-specific and should match the typed payload for the kind.
   */
  openPanel?(kind: PanelKind, data?: unknown): void

  /** Dismiss whatever panel/overlay is currently open, if any. */
  dismissPanel?(): void

  /**
   * Capture the current screen. TUI implementations write two files (plain
   * text + ANSI) and return their paths. Non-TUI frontends typically return
   * `null` so the command can inform the user that screenshot is unsupported.
   */
  screenshot?(opts?: {
    baseName?: string
  }): Promise<{ txtPath: string; ansPath: string } | null>

  /**
   * Copy arbitrary text to the system clipboard where supported. Returns
   * `true` if the frontend was able to copy, `false` otherwise.
   */
  copy?(text: string): Promise<boolean>

  // -------------------------------------------------------------------------
  // Theme management — TUI has a rich theme store; Slack/GUI may ignore these
  // -------------------------------------------------------------------------

  /** List every registered theme. Returns `[]` when theming is unsupported. */
  listThemes?(): ThemeSummary[]

  /** Apply a theme by id. Returns `ok: false` when the id is unknown. */
  applyTheme?(id: string): ApplyThemeResult

  /** The id of the currently active theme, or `undefined` when unsupported. */
  currentThemeId?(): string | undefined

  // -------------------------------------------------------------------------
  // Status bar preset management — TUI-only concept but keyed the same way
  // -------------------------------------------------------------------------

  listStatusBars?(): StatusBarSummary[]

  applyStatusBar?(id: string): ApplyStatusBarResult

  currentStatusBarId?(): string | undefined

  // -------------------------------------------------------------------------
  // Side chat (/btw) — open a transient overlay that streams a tool-less
  // answer from a forked session without touching main ConversationState.
  // Frontends that don't render an overlay simply omit this method; the
  // /btw command then surfaces a system_message saying side chat is
  // unsupported on this surface.
  // -------------------------------------------------------------------------

  /**
   * Open a side-chat overlay with the given question. The frontend is
   * responsible for invoking `backend.sideQuery(question, { signal })`,
   * rendering the streamed events into a parallel ephemeral store, and
   * tearing down on dismiss.
   *
   * The backend is passed in (rather than read from a singleton) so the
   * frontend bridge stays decoupled from any specific backend wiring layer
   * — TUI, headless, and tests can all call this with whatever backend
   * they have in hand.
   *
   * Returns `true` if the overlay opened, `false` if side chat is not
   * supported in this frontend (e.g. headless / Slack).
   */
  openSideChat?(
    backend: import("../protocol/types").AgentBackend,
    question: string,
  ): boolean
}

/**
 * A no-op bridge. Useful for tests and for the headless runner, which does
 * not render panels or capture screens.
 */
export const noopFrontendBridge: FrontendBridge = {
  openPanel: () => {},
  dismissPanel: () => {},
  screenshot: async () => null,
  copy: async () => false,
}
