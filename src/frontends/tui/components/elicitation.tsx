/**
 * Elicitation Dialog — AskUserQuestion multi-choice
 *
 * Renders when the agent uses AskUserQuestion (via canUseTool).
 * Arrow keys to navigate, number keys to select, Enter to confirm.
 * Always includes "Other" option for free text.
 *
 * Answers are keyed by question text to match the SDK's expected format:
 *   { "Which library?": "React", "Which version?": "18" }
 *
 * Escape cancels the entire elicitation via cancelElicitation (deny).
 *
 * NOT a modal overlay. Renders inline in the conversation flow.
 */

import { createRenderEffect, createSignal, Index, Show, type Accessor } from "solid-js"
import { TextAttributes, type TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { usePermissions } from "../context/permissions"
import { useAgent } from "../context/agent"
import { useSession } from "../context/session"
import { colors } from "../theme/tokens"
import type { ElicitationQuestion, ElicitationRequestEvent } from "../../../protocol/types"

/** Truncate long option labels to prevent terminal overflow */
function truncateLabel(label: string, maxLen: number = 60): string {
  if (label.length <= maxLen) return label
  return label.slice(0, maxLen - 1) + "\u2026"
}

/**
 * Install a render-effect that fires `reset()` synchronously whenever the
 * current `ElicitationQuestion` reference changes. Used by `QuestionView`
 * to clear per-question UI state (selection cursor, free-text toggle,
 * `submitting` latch) when the parent advances to the next question in a
 * multi-question elicitation.
 *
 * Regression target: with no reset, the same `QuestionView` instance is
 * reused across questions in a multi-question elicitation. Answering Q1
 * sets `submitting = true` to debounce double-submit; that latch then
 * carries over to Q2, where every `selectOption(...)` early-returns on
 * `if (submitting()) return` — so Enter does nothing and the user is
 * stuck (Esc still works because it bypasses the latch). Mirrors F-9
 * (permission dialog selection carry-over) — same shape, different
 * dialog.
 *
 * `createRenderEffect` lands the reset BEFORE paint and runs once at
 * subscription time in both the browser and SSR builds of solid-js, so
 * the helper is unit-testable under default `bun test` without
 * `--conditions=browser`.
 *
 * Must be called inside a SolidJS reactive scope (component body or
 * `createRoot`).
 */
export function installQuestionReset(
  currentQuestion: Accessor<ElicitationQuestion>,
  reset: () => void,
): void {
  let lastSeen: ElicitationQuestion | null = null
  createRenderEffect(() => {
    const q = currentQuestion()
    if (q !== lastSeen) {
      lastSeen = q
      reset()
    }
  })
}

function QuestionView(props: {
  question: ElicitationQuestion
  onAnswer: (value: string) => void
  onCancel: () => void
}) {
  const [selected, setSelected] = createSignal(0)
  const [showFreeText, setShowFreeText] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)
  let freeTextRef: TextareaRenderable | undefined
  let freeTextOnlyInitialized = false

  // Reset per-question state when the parent advances to a new question in a
  // multi-question elicitation. Without this, `submitting` stays `true` after
  // answering Q1 and `selectOption` for Q2 early-returns on
  // `if (submitting()) return` — Enter appears dead, only Esc escapes. See
  // `installQuestionReset` doc for the full F-9-style rationale.
  installQuestionReset(
    () => props.question,
    () => {
      setSelected(0)
      setShowFreeText(false)
      setSubmitting(false)
      freeTextOnlyInitialized = false
    },
  )

  // When there are no predefined options but free text is allowed,
  // skip the option list entirely and go straight to free text input
  const freeTextOnly = () =>
    props.question.options.length === 0 && props.question.allowFreeText !== false

  const options = () => {
    const opts = props.question.options.map((o) => ({
      label: o.label,
      description: o.description,
      isOther: false,
    }))
    if (props.question.allowFreeText !== false) {
      opts.push({ label: "Other (type your answer)", description: undefined, isOther: true })
    }
    return opts
  }

  const selectOption = (idx: number) => {
    if (submitting()) return
    const opt = options()[idx]
    if (!opt) return
    if (opt.isOther) {
      setShowFreeText(true)
    } else {
      setSubmitting(true)
      // Answer value is the option label, matching SDK expectation
      props.onAnswer(opt.label)
    }
  }

  useKeyboard((event) => {
    // Auto-enter free text mode when there are no predefined options
    if (freeTextOnly() && !freeTextOnlyInitialized) {
      freeTextOnlyInitialized = true
      setShowFreeText(true)
    }

    if (showFreeText()) {
      if (event.name === "escape") {
        event.preventDefault()
        // In free-text-only mode, escape cancels the whole elicitation
        if (freeTextOnly()) {
          props.onCancel()
          return
        }
        setShowFreeText(false)
        setSubmitting(false)
        return
      }
      if (event.name === "return") {
        event.preventDefault()
        if (submitting()) return
        // Handle free text submit directly since useKeyboard fires before textarea's onSubmit
        const text = freeTextRef?.plainText?.trim() ?? ""
        if (text) {
          setSubmitting(true)
          props.onAnswer(text)
          setShowFreeText(false)
        }
        return
      }
      return // Let other keys through to textarea in free-text mode
    }

    // In option-selection mode, consume ALL key events to prevent
    // scrollbox from handling arrow keys / j / k as scroll commands.
    event.preventDefault()

    const len = options().length
    if (len === 0) return // guard against empty options list

    if (event.name === "up" || event.name === "k") {
      setSelected((prev) => (prev - 1 + len) % len)
    } else if (event.name === "down" || event.name === "j") {
      setSelected((prev) => (prev + 1) % len)
    } else if (event.name === "return") {
      selectOption(selected())
    } else if (event.name >= "1" && event.name <= "9") {
      const idx = parseInt(event.name) - 1
      if (idx < len) {
        selectOption(idx)
      }
    } else if (event.name === "escape") {
      props.onCancel()
    }
  })

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={colors.border.permission}
      paddingLeft={1}
      paddingRight={1}
    >
      <Show when={props.question.header}>
        <text fg={colors.text.muted}>
          {props.question.header}
        </text>
      </Show>
      <text fg={colors.border.permission} attributes={TextAttributes.BOLD}>
        {props.question.question}
      </text>

      <Show when={!showFreeText() && !freeTextOnly()}>
        <Index each={options()}>
          {(option, index) => (
            <box flexDirection="column">
              <box flexDirection="row">
                <text fg={index === selected() ? colors.border.permission : colors.text.primary}>
                  {index === selected() ? " > " : "   "}
                </text>
                <text fg={index === selected() ? colors.border.permission : colors.text.primary}>
                  {index + 1}) {truncateLabel(option().label)}
                </text>
              </box>
              <Show when={!option().isOther && option().description}>
                <text fg={colors.text.muted}>
                  {"      "}{option().description}
                </text>
              </Show>
            </box>
          )}
        </Index>
        <text fg={colors.text.secondary}>
          {"  "}Arrow keys to navigate, Enter to select, Esc to cancel
        </text>
      </Show>

      <Show when={showFreeText() || freeTextOnly()}>
        <text fg={colors.text.secondary}>Type your answer · Enter to submit · Shift+Enter for newline · Esc to go back</text>
        <textarea
          ref={(el: TextareaRenderable) => { freeTextRef = el }}
          focused
          height={2}
          placeholder="Type here..."
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
          ]}
          onSubmit={() => {
            if (submitting()) return
            const text = freeTextRef?.plainText?.trim() ?? ""
            if (text) {
              setSubmitting(true)
              props.onAnswer(text)
            }
          }}
        />
      </Show>
    </box>
  )
}

export function ElicitationDialog() {
  const { state } = usePermissions()
  const { state: session } = useSession()
  const agent = useAgent()

  // Accumulate answers across multiple questions, keyed by question text
  const [answers, setAnswers] = createSignal<Record<string, string>>({})
  const [currentIdx, setCurrentIdx] = createSignal(0)

  const handleAnswer = (questionText: string, value: string) => {
    if (!state.pendingElicitation) return

    const questions = state.pendingElicitation.questions
    const updated = { ...answers(), [questionText]: value }
    setAnswers(updated)

    // If all questions are answered, send the complete response
    if (Object.keys(updated).length >= questions.length) {
      const id = state.pendingElicitation.id
      agent.backend.respondToElicitation(id, updated)
      setAnswers({})
      setCurrentIdx(0)
    } else {
      // Advance to next question
      setCurrentIdx((prev) => prev + 1)
    }
  }

  const handleCancel = () => {
    if (!state.pendingElicitation) return
    const id = state.pendingElicitation.id
    agent.backend.cancelElicitation(id)
    setAnswers({})
    setCurrentIdx(0)
  }

  return (
    <Show when={session.sessionState === "WAITING_FOR_ELIC" && state.pendingElicitation}>
      {(elicitation: Accessor<ElicitationRequestEvent>) => {
        const questions = elicitation().questions

        // Guard: empty questions array — auto-cancel since there's nothing to answer
        if (questions.length === 0) {
          handleCancel()
          return (
            <box flexDirection="column">
              <text fg={colors.text.muted}>
                {"  No options available"}
              </text>
            </box>
          )
        }

        // Clamp currentIdx to valid range to prevent undefined access
        const question = (): ElicitationQuestion => {
          const idx = Math.min(currentIdx(), questions.length - 1)
          const q = questions[idx]
          if (!q) {
            // Shouldn't happen due to empty-guard above, but satisfy TS
            return questions[0] ?? { question: "", options: [] }
          }
          return q
        }

        return (
          <box flexDirection="column">
            {/* Progress indicator for multi-question elicitations */}
            <Show when={questions.length > 1}>
              <text fg={colors.text.muted}>
                {"  Question " + (Math.min(currentIdx(), questions.length - 1) + 1) + "/" + questions.length}
              </text>
            </Show>
            <QuestionView
              question={question()}
              onAnswer={(value) => handleAnswer(question().question, value)}
              onCancel={handleCancel}
            />
          </box>
        )
      }}
    </Show>
  )
}
