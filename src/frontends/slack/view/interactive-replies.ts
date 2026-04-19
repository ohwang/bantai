/**
 * Interactive-reply DSL compiler.
 *
 * Lets an agent author Block Kit buttons / selects in its outbound
 * reply by including inline directives:
 *
 *   Ship or hold?
 *
 *   [[slack_buttons: Ship:ship:primary, Hold:hold, Abort:abort:danger]]
 *
 * or
 *
 *   [[slack_select: Pick env | canary:canary, production:production]]
 *
 * plus an auto-promotion of a trailing `Options: a, b, c.` line into a
 * select when the options are simple tokens (<= 12 items).
 *
 * Returns a `{ text, blocks?, interactive }` triple. When directives
 * are present, `text` is the cleaned visible text and `blocks` contains
 * one section per pre/between/post segment plus an `actions` block for
 * each directive. When no directives match, the payload is returned
 * unchanged so callers can unconditionally funnel their final-text
 * payload through this compiler.
 *
 * Ported from OpenClaw's `extensions/slack/src/interactive-replies.ts`
 * + `blocks-render.ts` (MIT). Bantai-specific changes:
 *   - action_id prefix is `bantai:reply_button:` / `bantai:reply_select:`.
 *   - drop OpenClaw's capability-flag check (`channels.slack.capabilities
 *     .interactiveReplies`) — bantai gates this at the config layer in
 *     the event-renderer instead.
 *   - no `ReplyPayload.channelData.slack.blocks` fast-exit; bantai's
 *     final-text path never carries pre-authored Slack blocks.
 */

import type { KnownBlock } from "@slack/types"

const SLACK_BUTTON_MAX_ITEMS = 5
const SLACK_SELECT_MAX_ITEMS = 100
const SLACK_DIRECTIVE_RE = /\[\[(slack_buttons|slack_select):\s*([^\]]+)\]\]/gi
const SLACK_OPTIONS_LINE_RE = /^\s*Options:\s*(.+?)\s*\.?\s*$/i
const SLACK_AUTO_SELECT_MAX_ITEMS = 12
const SLACK_SIMPLE_OPTION_RE = /^[a-z0-9][a-z0-9 _+/-]{0,31}$/i

const BUTTON_ACTION_PREFIX = "bantai:reply_button"
const SELECT_ACTION_PREFIX = "bantai:reply_select"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InteractiveButtonStyle = "primary" | "danger"

export interface InteractiveChoice {
  label: string
  value: string
  style?: InteractiveButtonStyle
}

export interface CompiledInteractiveReply {
  /** Cleaned visible text with directives removed. */
  text: string
  /** Block Kit payload when at least one directive compiled successfully. */
  blocks?: KnownBlock[]
  /**
   * True when this compiler inserted interactive blocks into `blocks`.
   * The caller uses this to decide whether the message needs an action
   * handler to be wired — when false, the payload is plain text only.
   */
  hasInteractive: boolean
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile an outbound agent text into `{ text, blocks? }`. When no
 * directives are present, `blocks` is undefined and `text` is the input
 * unchanged.
 */
export function compileSlackInteractiveReplies(
  text: string,
): CompiledInteractiveReply {
  if (!text) return { text, hasInteractive: false }

  const generated: KnownBlock[] = []
  const visibleParts: string[] = []
  let cursor = 0
  let matchedDirective = false
  let interactiveCount = 0

  SLACK_DIRECTIVE_RE.lastIndex = 0
  for (const match of text.matchAll(SLACK_DIRECTIVE_RE)) {
    matchedDirective = true
    const matchText = match[0]
    const directiveType = (match[1] ?? "").toLowerCase()
    const body = match[2] ?? ""
    const index = match.index ?? 0
    const preceding = text.slice(cursor, index)
    visibleParts.push(preceding)
    const section = buildTextSection(preceding)
    if (section) generated.push(section)
    const block =
      directiveType === "slack_buttons"
        ? buildButtonsBlock(body, interactiveCount)
        : buildSelectBlock(body, interactiveCount)
    if (block) {
      generated.push(block)
      interactiveCount += 1
    }
    cursor = index + matchText.length
  }

  const trailing = text.slice(cursor)
  visibleParts.push(trailing)
  const trailingSection = buildTextSection(trailing)
  if (trailingSection) generated.push(trailingSection)

  const cleanedText = visibleParts.join("").trim()

  if (!matchedDirective || interactiveCount === 0) {
    // Fallback path — try the "Options: a, b, c." auto-promotion.
    return parseTrailingOptionsLine(text)
  }

  return {
    text: cleanedText,
    blocks: generated,
    hasInteractive: true,
  }
}

/**
 * Parse an action ID emitted by this compiler back into its kind + index.
 * Returns null when the action ID is not ours (the caller should fall
 * through to other coordinators — approvals, elicitations, etc).
 */
export function parseInteractiveReplyActionId(
  actionId: string,
): { kind: "button" | "select"; index: number } | null {
  // Button format: "bantai:reply_button:<n>:<m>" (n = directive index,
  // m = button position within the directive — unused at dispatch but
  // preserved so rapid re-clicks of the same button share an id.)
  if (actionId.startsWith(`${BUTTON_ACTION_PREFIX}:`)) {
    const parts = actionId.split(":")
    const index = Number(parts[2])
    return Number.isFinite(index)
      ? { kind: "button", index }
      : null
  }
  if (actionId.startsWith(`${SELECT_ACTION_PREFIX}:`)) {
    const parts = actionId.split(":")
    const index = Number(parts[2])
    return Number.isFinite(index)
      ? { kind: "select", index }
      : null
  }
  return null
}

// ---------------------------------------------------------------------------
// Directive parsers
// ---------------------------------------------------------------------------

function parseChoice(
  raw: string,
  options: { allowStyle: boolean },
): InteractiveChoice | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const delimiter = trimmed.indexOf(":")
  if (delimiter === -1) {
    return { label: trimmed, value: trimmed }
  }
  const label = trimmed.slice(0, delimiter).trim()
  let value = trimmed.slice(delimiter + 1).trim()
  if (!label || !value) return null
  let style: InteractiveButtonStyle | undefined
  if (options.allowStyle) {
    const styleDelimiter = value.lastIndexOf(":")
    if (styleDelimiter !== -1) {
      const maybeStyle = value.slice(styleDelimiter + 1).trim().toLowerCase()
      const resolved = normaliseStyle(maybeStyle)
      if (resolved) {
        const unstyled = value.slice(0, styleDelimiter).trim()
        if (unstyled) {
          value = unstyled
          style = resolved
        }
      }
    }
  }
  return style ? { label, value, style } : { label, value }
}

function parseChoices(
  raw: string,
  maxItems: number,
  options: { allowStyle: boolean },
): InteractiveChoice[] {
  return raw
    .split(",")
    .map((entry) => parseChoice(entry, options))
    .filter((entry): entry is InteractiveChoice => Boolean(entry))
    .slice(0, maxItems)
}

/**
 * Map user-facing style tokens to the Block Kit subset that Slack
 * actually honours on buttons. `success` → `primary`, `secondary` →
 * undefined (Slack has no "secondary" button style; the API 400s if
 * we try to send it). Mirror of OpenClaw `blocks-render.ts:22-32`.
 */
function normaliseStyle(raw: string): InteractiveButtonStyle | undefined {
  switch (raw) {
    case "primary":
    case "success":
      return "primary"
    case "danger":
      return "danger"
    default:
      return undefined
  }
}

function buildTextSection(text: string): KnownBlock | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  return {
    type: "section",
    text: { type: "mrkdwn", text: trimmed },
  }
}

function buildButtonsBlock(raw: string, directiveIndex: number): KnownBlock | null {
  const choices = parseChoices(raw, SLACK_BUTTON_MAX_ITEMS, { allowStyle: true })
  if (choices.length === 0) return null
  return {
    type: "actions",
    elements: choices.map((choice, buttonIndex) => ({
      type: "button",
      text: { type: "plain_text", text: truncateLabel(choice.label, 75) },
      action_id: `${BUTTON_ACTION_PREFIX}:${directiveIndex}:${buttonIndex}`,
      value: choice.value.slice(0, 2000),
      ...(choice.style ? { style: choice.style } : {}),
    })),
  }
}

function buildSelectBlock(raw: string, directiveIndex: number): KnownBlock | null {
  const parts = raw
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const placeholder = parts.length >= 2 ? parts[0]! : "Choose an option"
  const body = parts.length >= 2 ? parts[1]! : parts[0]!
  const choices = parseChoices(body, SLACK_SELECT_MAX_ITEMS, { allowStyle: false })
  if (choices.length === 0) return null
  return {
    type: "actions",
    elements: [
      {
        type: "static_select",
        action_id: `${SELECT_ACTION_PREFIX}:${directiveIndex}:0`,
        placeholder: {
          type: "plain_text",
          text: truncateLabel(placeholder, 150),
        },
        options: choices.map((choice) => ({
          text: { type: "plain_text", text: truncateLabel(choice.label, 75) },
          value: choice.value.slice(0, 2000),
        })),
      },
    ],
  }
}

function truncateLabel(label: string, max: number): string {
  if (label.length <= max) return label
  return `${label.slice(0, Math.max(1, max - 1))}…`
}

// ---------------------------------------------------------------------------
// `Options: a, b, c.` auto-promotion
// ---------------------------------------------------------------------------

function parseTrailingOptionsLine(text: string): CompiledInteractiveReply {
  const lines = text.split("\n")
  const lastNonEmptyIndex = [...lines.keys()]
    .reverse()
    .find((i) => (lines[i] ?? "").trim())
  if (lastNonEmptyIndex === undefined) {
    return { text, hasInteractive: false }
  }
  const optionsLine = lines[lastNonEmptyIndex] ?? ""
  const match = optionsLine.match(SLACK_OPTIONS_LINE_RE)
  if (!match) return { text, hasInteractive: false }

  const choices = parseSimpleOptions(match[1] ?? "")
  if (!choices) return { text, hasInteractive: false }

  const bodyText = lines
    .filter((_, i) => i !== lastNonEmptyIndex)
    .join("\n")
    .trim()

  const blocks: KnownBlock[] = []
  const bodyBlock = buildTextSection(bodyText)
  if (bodyBlock) blocks.push(bodyBlock)

  if (choices.length <= SLACK_BUTTON_MAX_ITEMS) {
    blocks.push({
      type: "actions",
      elements: choices.map((choice, buttonIndex) => ({
        type: "button",
        text: { type: "plain_text", text: truncateLabel(choice.label, 75) },
        action_id: `${BUTTON_ACTION_PREFIX}:0:${buttonIndex}`,
        value: choice.value.slice(0, 2000),
      })),
    })
  } else {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "static_select",
          action_id: `${SELECT_ACTION_PREFIX}:0:0`,
          placeholder: { type: "plain_text", text: "Choose an option" },
          options: choices.map((choice) => ({
            text: { type: "plain_text", text: truncateLabel(choice.label, 75) },
            value: choice.value.slice(0, 2000),
          })),
        },
      ],
    })
  }

  return {
    text: bodyText,
    blocks,
    hasInteractive: true,
  }
}

function parseSimpleOptions(raw: string): InteractiveChoice[] | null {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (entries.length < 2 || entries.length > SLACK_AUTO_SELECT_MAX_ITEMS) {
    return null
  }
  if (!entries.every((entry) => SLACK_SIMPLE_OPTION_RE.test(entry))) {
    return null
  }
  const normalised = entries.map((entry) => entry.toLowerCase())
  const deduped = new Set(normalised)
  if (deduped.size !== entries.length) return null
  return entries.map((entry) => ({ label: entry, value: entry }))
}
