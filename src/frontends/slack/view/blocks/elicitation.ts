/**
 * Block Kit builder for elicitation (plan §8.2).
 *
 * An `elicitation_request` is AskUserQuestion — the backend is waiting for
 * one or more answers. We render it as a two-stage surface:
 *
 *   1. An inline thread message with a short preview + an "Answer questions"
 *      button. The button's action_id carries the elicitation id so the
 *      launcher can route the click.
 *   2. On click, the launcher opens a `views.open` modal built here. The
 *      modal contains one `input` block per question:
 *        - fixed options, single-choice   → static_select
 *        - fixed options, multi-choice    → multi_static_select
 *        - free-text                      → plain_text_input (+ optional
 *                                            enumerated placeholder from
 *                                            the question's options)
 *
 * The modal's callback_id is `bantai:elic:<id>` so the launcher can look up
 * which pending elicitation submitted. Per-question block_id is
 * `bantai:elic:<id>:q:<idx>` and each input's action_id mirrors it so
 * harvesting is keyless lookup on `view.state.values[block_id][action_id]`.
 *
 * Pure of IO — the coordinator dispatches the `views.open` call.
 */

import type { KnownBlock, View } from "@slack/types"
import type { ElicitationQuestion } from "../../../../protocol/types"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Slack option labels are capped at 75 chars and trigger "invalid_blocks"
 * otherwise. We truncate aggressively — the full description goes in the
 * option's `description` field.
 */
const MAX_LABEL_CHARS = 74
const MAX_DESCRIPTION_CHARS = 74
/**
 * Slack static_select / multi_static_select accept up to 100 options each.
 * A question with >100 options is a bug-for-bug of the backend's
 * preference surface, not our problem — truncate rather than error.
 */
const MAX_OPTIONS_PER_SELECT = 100
const MODAL_CALLBACK_PREFIX = "bantai:elic"

// ---------------------------------------------------------------------------
// Inline card
// ---------------------------------------------------------------------------

export interface ElicitationCardInput {
  /** Elicitation id (used in the action_id). */
  id: string
  questions: ElicitationQuestion[]
}

export interface ElicitationCard {
  text: string
  blocks: KnownBlock[]
}

export function buildElicitationCard(input: ElicitationCardInput): ElicitationCard {
  const count = input.questions.length
  const summary =
    count === 1
      ? `Claude asked: *${truncate(input.questions[0]?.question ?? "", 120)}*`
      : `Claude asked ${count} question${count === 1 ? "" : "s"}.`

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:question: ${summary}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: count === 1 ? "Answer" : "Answer questions", emoji: true },
          action_id: encodeOpenActionId(input.id),
          value: input.id,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Cancel", emoji: true },
          action_id: encodeCancelActionId(input.id),
          value: input.id,
        },
      ],
    },
  ]
  return {
    text: count === 1 ? `question: ${input.questions[0]?.question ?? ""}` : `${count} questions from Claude`,
    blocks,
  }
}

export function buildResolvedElicitationCard(args: {
  previous: ElicitationCardInput
  answered: boolean
  resolverUserId: string
}): ElicitationCard {
  const { previous, answered, resolverUserId } = args
  const icon = answered ? ":white_check_mark:" : ":no_entry_sign:"
  const verbSummary = answered
    ? `answered by <@${resolverUserId}>`
    : `cancelled by <@${resolverUserId}>`
  const count = previous.questions.length
  const headline =
    count === 1
      ? `${icon} Claude's question — ${verbSummary}`
      : `${icon} ${count} question${count === 1 ? "" : "s"} — ${verbSummary}`
  return {
    text: headline.replace(/:[a-z_]+:/g, "").trim(),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: headline } }],
  }
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export interface ElicitationModalInput {
  id: string
  questions: ElicitationQuestion[]
}

export function buildElicitationModal(input: ElicitationModalInput): View {
  const blocks: KnownBlock[] = []
  input.questions.forEach((q, idx) => {
    const blockId = encodeBlockId(input.id, idx)
    const actionId = blockId
    const header = q.header?.trim() ? `*${truncate(q.header, 40)}*` : undefined
    if (header) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: header },
      })
    }
    const hasOptions = q.options.length > 0
    const allowFreeText = q.allowFreeText !== false
    // Backend contract: options absent → always free text. Options present
    // + allowFreeText=false → select-only. Options present + allowFreeText=true
    // → options preferred, fall back to free text via the trailing "Other"
    // label (handled in post-processing on submit).
    const useSelect = hasOptions && !allowFreeText
    const useMultiSelect = useSelect && q.multiSelect === true

    if (useSelect) {
      const options = q.options
        .slice(0, MAX_OPTIONS_PER_SELECT)
        .map((o) => ({
          text: { type: "plain_text" as const, text: truncate(o.label, MAX_LABEL_CHARS), emoji: true },
          value: o.label,
          ...(o.description
            ? { description: { type: "plain_text" as const, text: truncate(o.description, MAX_DESCRIPTION_CHARS), emoji: true } }
            : {}),
        }))
      blocks.push({
        type: "input",
        block_id: blockId,
        label: { type: "plain_text", text: truncate(q.question, 150), emoji: true },
        element: useMultiSelect
          ? {
              type: "multi_static_select",
              action_id: actionId,
              placeholder: { type: "plain_text", text: "Pick one or more", emoji: true },
              options,
            }
          : {
              type: "static_select",
              action_id: actionId,
              placeholder: { type: "plain_text", text: "Pick one", emoji: true },
              options,
            },
      })
    } else {
      // Free-text path (either no options or allowFreeText=true).
      const placeholder = hasOptions
        ? `e.g. ${q.options[0]?.label ?? "answer"}`
        : "Type your answer"
      blocks.push({
        type: "input",
        block_id: blockId,
        label: { type: "plain_text", text: truncate(q.question, 150), emoji: true },
        element: {
          type: "plain_text_input",
          action_id: actionId,
          multiline: true,
          placeholder: { type: "plain_text", text: truncate(placeholder, 150), emoji: true },
        },
      })
    }
  })

  return {
    type: "modal",
    callback_id: encodeModalCallbackId(input.id),
    title: { type: "plain_text", text: "bantai — questions", emoji: true },
    submit: { type: "plain_text", text: "Submit", emoji: true },
    close: { type: "plain_text", text: "Cancel", emoji: true },
    blocks,
  }
}

// ---------------------------------------------------------------------------
// Submission parsing
// ---------------------------------------------------------------------------

export interface ParsedElicitationSubmission {
  id: string
  answers: Record<string, string>
}

/**
 * Harvest `view.state.values` into `{ questionText → answer }` keyed by the
 * original question. Slack gives us `{ block_id: { action_id: value } }`;
 * we match block ids to questions by index, join multi-select into a
 * comma-separated list (matches the SDK's answer-shape expectation:
 * `answers[questionText]` is always a string).
 *
 * Returns `null` when the callback_id doesn't match. Returns an object
 * with partial `answers` when some questions were unanswered — callers
 * decide whether to reject that or fill in "" for missing ids.
 */
export function parseElicitationSubmission(args: {
  callbackId: string
  values: Record<string, unknown>
  questions: ElicitationQuestion[]
}): ParsedElicitationSubmission | null {
  const id = parseModalCallbackId(args.callbackId)
  if (!id) return null
  const answers: Record<string, string> = {}
  for (let idx = 0; idx < args.questions.length; idx++) {
    const question = args.questions[idx]!
    const blockId = encodeBlockId(id, idx)
    const raw = (args.values as Record<string, unknown>)[blockId]
    if (!raw || typeof raw !== "object") continue
    const inner = (raw as Record<string, unknown>)[blockId]
    const answer = extractAnswer(inner)
    if (answer !== undefined) answers[question.question] = answer
  }
  return { id, answers }
}

function extractAnswer(inner: unknown): string | undefined {
  if (!inner || typeof inner !== "object") return undefined
  const v = inner as {
    type?: string
    value?: string
    selected_option?: { value?: string; text?: { text?: string } }
    selected_options?: Array<{ value?: string; text?: { text?: string } }>
  }
  if (v.type === "plain_text_input") {
    const t = typeof v.value === "string" ? v.value.trim() : ""
    return t.length > 0 ? t : undefined
  }
  if (v.type === "static_select") {
    const pick = v.selected_option
    return pick?.value ?? pick?.text?.text
  }
  if (v.type === "multi_static_select") {
    const picks = v.selected_options ?? []
    const labels = picks
      .map((p) => p.value ?? p.text?.text)
      .filter((s): s is string => typeof s === "string" && s.length > 0)
    return labels.length > 0 ? labels.join(", ") : undefined
  }
  return undefined
}

// ---------------------------------------------------------------------------
// action_id / block_id / callback_id codec
// ---------------------------------------------------------------------------

export function encodeOpenActionId(id: string): string {
  return `${MODAL_CALLBACK_PREFIX}:${id}:open`
}

export function encodeCancelActionId(id: string): string {
  return `${MODAL_CALLBACK_PREFIX}:${id}:cancel`
}

export function encodeBlockId(id: string, questionIdx: number): string {
  return `${MODAL_CALLBACK_PREFIX}:${id}:q:${questionIdx}`
}

export function encodeModalCallbackId(id: string): string {
  return `${MODAL_CALLBACK_PREFIX}:${id}`
}

export type ParsedElicitationAction =
  | { kind: "open"; id: string }
  | { kind: "cancel"; id: string }

export function parseElicitationActionId(actionId: string): ParsedElicitationAction | null {
  const parts = actionId.split(":")
  if (parts.length !== 4) return null
  if (parts[0] !== "bantai" || parts[1] !== "elic") return null
  const id = parts[2]!
  const kind = parts[3]
  if (kind === "open") return { kind: "open", id }
  if (kind === "cancel") return { kind: "cancel", id }
  return null
}

export function parseModalCallbackId(callbackId: string): string | null {
  const parts = callbackId.split(":")
  if (parts.length !== 3) return null
  if (parts[0] !== "bantai" || parts[1] !== "elic") return null
  return parts[2] ?? null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return `${s.slice(0, Math.max(1, maxLen - 1))}…`
}
