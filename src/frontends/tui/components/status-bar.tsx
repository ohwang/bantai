/**
 * Status Bar — Dispatches to native presets or an external statusline command.
 *
 * Rendering modes (in precedence order):
 *
 *   1. External statusLine command (configured via `statusLine` in settings)
 *      — runs a shell script periodically, pipes JSON on stdin, renders the
 *      script's stdout. This path is separate and always wins when configured;
 *      preset selection does not affect it.
 *
 *   2. Native preset — one of the built-in status bar layouts registered in
 *      `src/tui/status-bar/registry.ts` (default / minimal / detailed). The
 *      active preset is stored in `activeStatusBarId` and swapped live by
 *      `/status-bar <id>`, `/settings set statusBar <id>`, or startup resolution.
 *      Unknown preset ids soft-fail to `default`.
 *
 * The permission mode row (line 2) is rendered here, NOT in presets, so
 * that cycling / sandbox hints / right-aligned rate-limit percentages stay
 * consistent across presets.
 */

import { createSignal, createEffect, createMemo, onCleanup, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { StyledText, TextRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useSession } from "../context/session"
import { useAgent } from "../context/agent"
import { colors } from "../theme/tokens"
import type { PermissionMode } from "../../../protocol/types"
import { cyclerPermissionModeIds } from "../../../protocol/permission-modes"
import { getBackendDescriptor } from "../../../protocol/registry"
import { getStatusLineConfig, buildStatusLineInput, executeStatusLineCommand } from "../../../utils/statusline"
import { ansiToStyledText } from "../../../utils/ansi-to-styled"
import { useStatusBarData, rateLimitColor } from "../status-bar/data"
import { resolveStatusBar } from "../status-bar/registry"
import { activeStatusBarId } from "../status-bar/active"
import { createPermissionModeCycler } from "../status-bar/permission-mode-cycler"
import type { StatusBarPreset } from "../status-bar/types"

// ---------------------------------------------------------------------------
// Permission mode cycle order — single source of truth in
// `protocol/permission-modes.ts`. The cycler intersects this with the active
// backend's `supportedPermissionModes`, so adding a mode to the registry with
// `inCycler: true` automatically wires it into Shift-Tab.
// ---------------------------------------------------------------------------

const PERM_MODE_CYCLE: readonly PermissionMode[] = cyclerPermissionModeIds()

function permissionModeLabel(mode: PermissionMode | undefined): string {
  switch (mode) {
    case "default":
      return "default"
    case "acceptEdits":
      return "accept edits"
    case "bypassPermissions":
      return "bypass permissions on"
    case "plan":
      return "plan"
    case "dontAsk":
      return "deny unlisted"
    case "auto":
      return "auto mode on"
    default:
      return "default"
  }
}

// ---------------------------------------------------------------------------
// Status line command debounce / refresh intervals
// ---------------------------------------------------------------------------

const STATUS_LINE_DEBOUNCE_MS = 300
const STATUS_LINE_REFRESH_MS = 5_000

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StatusBar(props: { hint?: string | null }) {
  const { state } = useSession()
  const agent = useAgent()

  // -- Permission mode (read from AgentContext — single reactive source of
  //    truth for status bar + diagnostics + status-line command). --
  const permMode = agent.permissionMode

  // -- External status line command --
  const statusLineConfig = getStatusLineConfig()
  const [statusLineText, setStatusLineText] = createSignal<StyledText | null>(null)
  const [statusLineLines, setStatusLineLines] = createSignal(1)
  let statusLineRef: TextRenderable | undefined

  // -- Available permission modes (filtered against backend capabilities) --
  //    Read from `state.supportedPermissionModes` first — that's the live
  //    value populated by the adapter's `capabilities_updated` event.
  //    `backend.capabilities()` is a plain method call SolidJS can't watch,
  //    so memoising directly off it captured the empty / fallback list at
  //    mount time and never recomputed (F-13: Gemini reports four modes via
  //    `session/new`, but the cycler stayed on the two-mode startup
  //    fallback). Fall back to the static method only when the adapter
  //    hasn't emitted yet (e.g. backends that never publish modes).
  const availableModes = createMemo(() => {
    const fromState = state.supportedPermissionModes
    const supported = fromState.length > 0
      ? fromState
      : agent.backend.capabilities().supportedPermissionModes
    return PERM_MODE_CYCLE.filter(m => supported.includes(m))
  })

  // F-23: backends whose permission policy is sent per-turn (codex sends
  // approval + sandbox in `turn/start` params) cannot honour a mid-turn
  // setPermissionMode() — the in-flight turn keeps the policy it started
  // with, even though `this.config.permissionMode` swaps. Gate the cycler
  // during RUNNING for those backends so the status-bar label can't drift
  // ahead of actual enforcement.
  const permissionModeAppliesOnNextTurn = createMemo(() => {
    const id = agent.backend.capabilities().name
    return getBackendDescriptor(id)?.permissionModeAppliesOnNextTurn === true
  })

  // -- Cycler controller: handles Shift-Tab, including the WAITING_FOR_PERM
  //    queue (F-15). During a permission dialog we accumulate the next mode
  //    in `pendingPermissionMode` and apply it once state leaves
  //    WAITING_FOR_PERM, so the keypress is no longer silently eaten. --
  const cycler = createPermissionModeCycler({
    sessionState: () => state.sessionState,
    currentMode: permMode,
    availableModes,
    applyMode: (mode) => agent.setPermissionMode(mode),
  })
  const pendingPermissionMode = cycler.pendingPermissionMode

  useKeyboard((event) => {
    if (event.shift && event.name === "tab") {
      // F-23: gate Shift-Tab during RUNNING for backends whose permission
      // policy only applies on the next turn (codex). Without this gate the
      // status bar swaps instantly while the running turn keeps its old
      // approval/sandbox policy — a misleading UX with safety implications.
      // The WAITING_FOR_PERM / WAITING_FOR_ELIC cases are handled inside
      // `cycler.handleShiftTab()` (F-15: WAITING_FOR_PERM queues the press
      // for after the dialog resolves; WAITING_FOR_ELIC stays a no-op).
      if (
        state.sessionState === "RUNNING" &&
        permissionModeAppliesOnNextTurn()
      ) {
        return
      }
      cycler.handleShiftTab()
    }
  })

  // -- Terminal dimensions (needed for status line command input) --
  const dims = useTerminalDimensions()

  // -- Status line command execution (debounced + periodic) --
  if (statusLineConfig) {
    let debounceTimer: ReturnType<typeof setTimeout> | undefined

    const runStatusLineCommand = () => {
      const input = buildStatusLineInput(state, {
        permissionMode: permMode(),
        configModel: agent.config.model,
        terminalWidth: dims()?.width,
        backendName: agent.backend.capabilities().name,
      })
      executeStatusLineCommand(statusLineConfig.command, input)
        .then((text) => {
          if (text) {
            const styled = ansiToStyledText(text)
            const lineCount = Math.min(4, Math.max(1, text.split("\n").length))
            setStatusLineLines(lineCount)
            setStatusLineText(styled)
            if (statusLineRef) {
              statusLineRef.content = styled
            }
          }
        })
        .catch(() => { /* silently ignore errors */ })
    }

    const scheduleUpdate = () => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(runStatusLineCommand, STATUS_LINE_DEBOUNCE_MS)
    }

    createEffect(() => {
      void state.sessionState
      void state.cost.totalCostUsd
      void state.turnNumber
      void state.currentModel
      void state.rateLimits
      void permMode()
      scheduleUpdate()
    })

    const periodicTimer = setInterval(runStatusLineCommand, STATUS_LINE_REFRESH_MS)
    runStatusLineCommand()

    onCleanup(() => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer)
      clearInterval(periodicTimer)
    })
  }

  // -- Shared preset data (only built when no external statusLine) --
  const data = useStatusBarData(permMode)

  // -- Active preset (reactive) --
  const activePreset = createMemo(() => resolveStatusBar(activeStatusBarId()).preset)

  // -- Permission mode color (line 2) --
  // Each mode gets a visually distinct dot color so the active mode is
  // recognisable at a glance without reading the label. In particular
  // `acceptEdits` and `auto` must NOT share a color — they are the two
  // modes users cycle between most often, and the wrong dot has real
  // safety implications (auto-approving edits vs classifier-judged).
  const permModeColor = () => {
    switch (permMode()) {
      case "default": return colors.state.idle           // green
      case "acceptEdits": return colors.state.waiting    // amber
      case "auto": return colors.accent.highlight        // cyan — distinct from amber
      case "plan": return colors.state.running           // periwinkle
      case "bypassPermissions": return colors.state.error // red
      case "dontAsk": return colors.state.error          // red
      default: return colors.state.idle
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const statusLinePadding = statusLineConfig?.padding ?? 0

  return (
    <box flexDirection="column">
      {/* Line 1+: external command output OR active native preset */}
      {statusLineConfig && statusLineText() ? (
        <box height={statusLineLines()} flexDirection="row" paddingLeft={2 + statusLinePadding} paddingRight={1 + statusLinePadding}>
          <text ref={(el: TextRenderable) => {
            statusLineRef = el
            const styled = statusLineText()
            if (styled) el.content = styled
          }}>{" "}</text>
        </box>
      ) : (
        /* Keyed Show re-mounts when the active preset id changes. Inside the
           child fn we invoke the preset's render component directly —
           matching the pattern used by the storybook preview pane, which is
           verified to work with OpenTUI's reconciler (unlike <Dynamic>). The
           `get hint()` passthrough preserves reactivity for transient exit
           hints across preset lifetimes. */
        <Show when={activePreset()} keyed>
          {(preset: StatusBarPreset) =>
            preset.render({
              data,
              get hint() { return props.hint },
            })
          }
        </Show>
      )}

      {/* Line 2: permission mode indicator (left-aligned) + rate-limit row (right-aligned) */}
      <box height={1} flexDirection="row" paddingLeft={2} paddingRight={1}>
        {/* Follow-mode pill — read via accessor so the runtime-mutable config
            rule is respected. Config is only ever set at launch today, but
            the pattern keeps the component safe if that ever changes. */}
        <Show when={Boolean(agent.config.readOnly)}>
          <text fg={colors.accent.highlight} attributes={TextAttributes.BOLD}>
            {"FOLLOW "}
          </text>
        </Show>
        <text fg={permModeColor()}>{"\u25CF "}</text>
        <text fg={colors.permission.modeLabel}>{permissionModeLabel(permMode())}</text>
        {data.sandboxHint() && (
          <text fg={colors.text.muted} attributes={TextAttributes.DIM}>{` (${data.sandboxHint()})`}</text>
        )}
        {/* F-15: when a Shift-Tab press during WAITING_FOR_PERM has queued
            a mode change, surface it inline so the user sees their input
            was registered (even though the dialog is still blocking the
            apply). The hint clears the moment the dialog resolves and the
            queued mode takes effect. */}
        <Show when={pendingPermissionMode()}>
          {(pending: () => PermissionMode) => (
            <text fg={colors.accent.highlight} attributes={TextAttributes.DIM}>
              {` → ${permissionModeLabel(pending())} (after this dialog)`}
            </text>
          )}
        </Show>
        {/* F-23: when the backend only honours permission-mode changes on the
            next turn (codex), tell the user during RUNNING why Shift-Tab is
            ignored — otherwise the gate looks like a broken keystroke. */}
        {state.sessionState === "RUNNING" && permissionModeAppliesOnNextTurn() ? (
          <text fg={colors.text.muted} attributes={TextAttributes.DIM}>
            {" (applies next turn — shift+tab disabled while running)"}
          </text>
        ) : (
          <text fg={colors.text.muted}>{" (shift+tab to cycle)"}</text>
        )}

        <box flexGrow={1} />

        <box flexDirection="row" visible={data.rateLimits().length > 0}>
          {data.rateLimits().map((entry, index) => (
            <>
              {index > 0 && <text fg={colors.text.secondary}>{"  "}</text>}
              <text fg={colors.text.muted}>{`${entry.label}:`}</text>
              <text fg={rateLimitColor(entry.usedPercentage)}>{`${Math.round(entry.usedPercentage)}%`}</text>
            </>
          ))}
        </box>
      </box>
    </box>
  )
}
