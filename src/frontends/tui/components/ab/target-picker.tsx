/**
 * A/B Target Picker — review-phase UI.
 *
 * Lets the user pick Target A and Target B from the backend registry. Each
 * target = backend id + optional model. Keyboard:
 *   - Tab / Shift+Tab — move focus between A column and B column
 *   - Up/Down — change backend selection within focused column
 *   - Left/Right — change model selection within focused column
 *   - Enter — confirm and start (or advance from row to row)
 *   - Esc — cancel the comparison
 *
 * We intentionally don't use a textarea here — the modal key handler model
 * (same as HistorySearchModal) keeps the input flow simple and avoids the
 * focus-juggling that <textarea> introduces.
 */

import { TextAttributes } from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import { createMemo, createSignal, Index, onCleanup, Show } from "solid-js"
import { friendlyBackendName, friendlyModelName, MODEL_NAMES } from "../../../../protocol/models"
import { setModalKeyHandler } from "../../context/modal"
import { listBackends, type BackendDescriptor } from "../../../../protocol/registry"
import type { Target } from "../../../../ab/types"
import { colors } from "../../theme/tokens"
import { ShortcutBar, ShortcutHint } from "../primitives"

export interface TargetPickerProps {
  /** Initial prompt to surface as context. */
  prompt: string
  initialA?: Target
  initialB?: Target
  onConfirm: (a: Target, b: Target) => void
  onCancel: () => void
}

interface BackendOption {
  descriptor: BackendDescriptor
  models: string[]
}

/** Build the list of selectable backends + the canonical model list per backend.
 *  The model list is intentionally curated from `MODEL_NAMES`; users can still
 *  switch to other models inside the running session via /model later. */
function buildOptions(): BackendOption[] {
  const all = listBackends().filter((b) => !b.requiresExtraConfig)
  return all.map((descriptor) => {
    let models: string[] = []
    if (descriptor.id === "claude") {
      models = Object.keys(MODEL_NAMES).filter((id) => id.startsWith("claude-"))
    } else if (descriptor.id === "gemini") {
      models = Object.keys(MODEL_NAMES).filter((id) => id.startsWith("gemini") || id.startsWith("auto-gemini"))
    } else if (descriptor.id === "copilot") {
      models = ["claude-haiku-4.5", "gpt-5-mini", "gpt-4.1"]
    } else if (descriptor.id === "codex") {
      models = ["gpt-5.5", "gpt-5.5-pro", "gpt-5-codex", "gpt-5", "o4-mini"]
    } else if (descriptor.id === "mock") {
      models = ["claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-4-6"]
    }
    return { descriptor, models }
  })
}

interface ColumnState {
  backendIndex: number
  modelIndex: number
}

function targetFromState(opts: BackendOption[], state: ColumnState): Target {
  const opt = opts[state.backendIndex]!
  const model = opt.models[state.modelIndex]
  return { backendId: opt.descriptor.id, model }
}

function findInitialState(opts: BackendOption[], target: Target | undefined, fallbackBackendIdx: number): ColumnState {
  if (!target) return { backendIndex: fallbackBackendIdx, modelIndex: 0 }
  const backendIdx = Math.max(0, opts.findIndex((o) => o.descriptor.id === target.backendId))
  const opt = opts[backendIdx]!
  const modelIdx = target.model ? Math.max(0, opt.models.indexOf(target.model)) : 0
  return { backendIndex: backendIdx, modelIndex: modelIdx }
}

export function TargetPicker(props: TargetPickerProps) {
  const options = buildOptions()
  const claudeIdx = Math.max(0, options.findIndex((o) => o.descriptor.id === "claude"))
  const codexIdx = options.findIndex((o) => o.descriptor.id === "codex")
  const fallbackB = codexIdx >= 0 ? codexIdx : Math.min(options.length - 1, claudeIdx + 1)

  const [stateA, setStateA] = createSignal<ColumnState>(
    findInitialState(options, props.initialA, claudeIdx),
  )
  const [stateB, setStateB] = createSignal<ColumnState>(
    findInitialState(options, props.initialB, fallbackB),
  )
  const [focused, setFocused] = createSignal<"A" | "B">("A")

  const targetA = createMemo(() => targetFromState(options, stateA()))
  const targetB = createMemo(() => targetFromState(options, stateB()))

  const cycleBackend = (delta: number) => {
    const set = focused() === "A" ? setStateA : setStateB
    set((s) => {
      const next = (s.backendIndex + delta + options.length) % options.length
      return { backendIndex: next, modelIndex: 0 }
    })
  }

  const cycleModel = (delta: number) => {
    const set = focused() === "A" ? setStateA : setStateB
    set((s) => {
      const opt = options[s.backendIndex]!
      if (opt.models.length === 0) return s
      const next = (s.modelIndex + delta + opt.models.length) % opt.models.length
      return { ...s, modelIndex: next }
    })
  }

  const handleKey = (event: KeyEvent): boolean => {
    if (event.name === "escape") {
      props.onCancel()
      return true
    }
    if (event.name === "tab") {
      setFocused((f) => (f === "A" ? "B" : "A"))
      return true
    }
    if (event.name === "left") {
      cycleModel(-1)
      return true
    }
    if (event.name === "right") {
      cycleModel(1)
      return true
    }
    if (event.name === "up") {
      cycleBackend(-1)
      return true
    }
    if (event.name === "down") {
      cycleBackend(1)
      return true
    }
    if (event.name === "return") {
      props.onConfirm(targetA(), targetB())
      return true
    }
    return false
  }

  setModalKeyHandler(handleKey)
  onCleanup(() => setModalKeyHandler(null))

  return (
    <box flexDirection="column" padding={2}>
      <box
        borderStyle="single"
        borderColor={colors.border.default}
        flexDirection="column"
        padding={2}
      >
        <text fg={colors.accent.primary} attributes={TextAttributes.BOLD}>
          {"A/B Comparison — Pick Two Targets"}
        </text>

        <box marginTop={1} flexDirection="column">
          <text fg={colors.text.secondary}>{"Prompt:"}</text>
          <text fg={colors.text.primary}>
            {truncate(props.prompt, 200)}
          </text>
        </box>

        <box marginTop={1} flexDirection="row">
          <Column
            label="A"
            focused={focused() === "A"}
            options={options}
            state={stateA()}
          />
          <box width={4} />
          <Column
            label="B"
            focused={focused() === "B"}
            options={options}
            state={stateB()}
          />
        </box>

        <box marginTop={1} flexDirection="column">
          <text fg={colors.text.secondary}>
            {`A: ${describeTarget(targetA())}   B: ${describeTarget(targetB())}`}
          </text>
          <Show when={sameTarget(targetA(), targetB())}>
            <text fg={colors.status.warning}>
              {"Heads up: A and B are identical — comparison will be redundant."}
            </text>
          </Show>
        </box>

        <box marginTop={1}>
          <ShortcutBar>
            <ShortcutHint shortcut="Tab" action="switch column" />
            <ShortcutHint shortcut={"\u2191/\u2193"} action="backend" />
            <ShortcutHint shortcut={"\u2190/\u2192"} action="model" />
            <ShortcutHint shortcut="Enter" action="start" />
            <ShortcutHint shortcut="Esc" action="cancel" />
          </ShortcutBar>
        </box>
      </box>
    </box>
  )
}

function Column(props: {
  label: "A" | "B"
  focused: boolean
  options: BackendOption[]
  state: ColumnState
}) {
  // Render the backend list and the model list for the currently highlighted
  // backend. Both lists derive purely from props — `<Index>` is appropriate.
  const accent = () => (props.focused ? colors.accent.primary : colors.text.secondary)
  const headerAttr = () => (props.focused ? TextAttributes.BOLD : 0)

  return (
    <box flexDirection="column" minWidth={28}>
      <text fg={accent()} attributes={headerAttr()}>
        {`${props.focused ? "▶ " : "  "}Target ${props.label}`}
      </text>
      <box marginTop={1} flexDirection="column">
        <text fg={colors.text.muted}>{"Backend"}</text>
        <Index each={props.options}>
          {(opt, i) => {
            const isSel = () => i === props.state.backendIndex
            return (
              <text
                fg={isSel() ? accent() : colors.text.primary}
                attributes={isSel() ? headerAttr() : 0}
              >
                {`${isSel() ? "›" : " "} ${opt().descriptor.displayName}${opt().descriptor.isAvailable() ? "" : " (unavailable)"}`}
              </text>
            )
          }}
        </Index>
      </box>
      <Show when={props.options[props.state.backendIndex]!.models.length > 0}>
        <box marginTop={1} flexDirection="column">
          <text fg={colors.text.muted}>{"Model"}</text>
          <Index each={props.options[props.state.backendIndex]!.models}>
            {(model, i) => {
              const isSel = () => i === props.state.modelIndex
              return (
                <text
                  fg={isSel() ? accent() : colors.text.primary}
                  attributes={isSel() ? headerAttr() : 0}
                >
                  {`${isSel() ? "›" : " "} ${friendlyModelName(model())}`}
                </text>
              )
            }}
          </Index>
        </box>
      </Show>
    </box>
  )
}

function describeTarget(t: Target): string {
  const backend = friendlyBackendName(t.backendId)
  return t.model ? `${backend} (${friendlyModelName(t.model)})` : backend
}

function sameTarget(a: Target, b: Target): boolean {
  return a.backendId === b.backendId && (a.model ?? "") === (b.model ?? "")
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}
