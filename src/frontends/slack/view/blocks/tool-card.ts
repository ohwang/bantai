/**
 * Block Kit builder for tool-use cards (plan §8.4).
 *
 * Verbosity contract (plan §3.3):
 *
 *   silent   → never renders anything
 *   concise  → rendered as a count line ("💭 3 tools") — aggregation is the
 *              caller's job; this builder produces per-tool cards only, not
 *              the aggregator.
 *   normal   → one-line summary: `:emoji: Tool name — short arg preview`.
 *              Final output is a truncated 6-line preview.
 *   verbose  → full card with a section block per tool, code-fenced input +
 *              output (truncated at 2600 chars per block).
 *   debug    → verbose + a mrkdwn block with the raw JSON payload of the
 *              tool_use_end event (input + output + error).
 *
 * Running state vs. completed state:
 *
 *   * `buildToolRunningCard` — rendered on `tool_use_start`. Shows a hint
 *     "(running…)" next to the tool name; no output yet.
 *   * `buildToolCompletedCard` — rendered on `tool_use_end`. Shows the
 *     outcome (:white_check_mark: / :no_entry_sign:), truncated output, an
 *     elapsed hint when known, and — at `verbose`+ — the full input + output
 *     fences.
 *
 * action_ids are absent by design; tool cards are read-only. "Show output"
 * expansion is left as S6's file-upload fallback (when the output is too
 * big for a single block).
 */

import type { KnownBlock } from "@slack/types"
import type { VerbosityLevel } from "../../config/schema"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCardInput {
  /** Tool invocation id — stable across start / progress / end. */
  id: string
  /** Tool name ("Bash", "Read", "Write", "Grep", ...). */
  tool: string
  /** Agent-supplied input — any JSON-serialisable value. */
  input: unknown
}

export interface ToolRunningCardInput extends ToolCardInput {
  verbosity: VerbosityLevel
}

export interface ToolCompletedCardInput extends ToolCardInput {
  verbosity: VerbosityLevel
  /** Stringified tool output. May be empty. */
  output: string
  /** Error string from the tool end event. Truthy → renders as denied. */
  error?: string
  /** Elapsed ms when known. Rendered as a subtle context hint. */
  elapsedMs?: number
}

export interface RenderedCard {
  text: string
  blocks: KnownBlock[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FENCE_CHARS = 2600
const MAX_ONE_LINER_ARG = 60
const MAX_OUTPUT_PREVIEW_LINES = 6

// Tool-family → emoji mapping (mirrors reactions.ts but for the card header).
const TOOL_EMOJI: Record<string, string> = {
  Bash: ":hammer_and_wrench:",
  Shell: ":hammer_and_wrench:",
  Read: ":eyes:",
  Glob: ":mag:",
  Grep: ":mag:",
  Write: ":pencil2:",
  Edit: ":pencil2:",
  NotebookEdit: ":pencil2:",
  WebFetch: ":globe_with_meridians:",
  WebSearch: ":globe_with_meridians:",
  Task: ":robot_face:",
  Skill: ":robot_face:",
}

// ---------------------------------------------------------------------------
// Running card — emitted on tool_use_start
// ---------------------------------------------------------------------------

export function buildToolRunningCard(input: ToolRunningCardInput): RenderedCard | null {
  if (input.verbosity === "silent" || input.verbosity === "concise") return null
  const emoji = TOOL_EMOJI[input.tool] ?? ":tools:"
  const arg = summarizeInput(input.input)
  const headline =
    input.verbosity === "normal"
      ? `${emoji} *${input.tool}* — ${truncate(arg, MAX_ONE_LINER_ARG)} _(running…)_`
      : `${emoji} *${input.tool}* — ${truncate(arg, 120)} _(running…)_`

  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: headline } },
  ]
  if (input.verbosity === "verbose" || input.verbosity === "debug") {
    const fence = codeFence(serializeInput(input.input))
    if (fence) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: fence },
      })
    }
  }
  return { text: `${input.tool} — running`, blocks }
}

// ---------------------------------------------------------------------------
// Completed card — emitted on tool_use_end
// ---------------------------------------------------------------------------

export function buildToolCompletedCard(input: ToolCompletedCardInput): RenderedCard | null {
  if (input.verbosity === "silent" || input.verbosity === "concise") return null

  const emoji = TOOL_EMOJI[input.tool] ?? ":tools:"
  const badge = input.error ? ":no_entry_sign:" : ":white_check_mark:"
  const arg = summarizeInput(input.input)

  const headlineNormal = `${badge} ${emoji} *${input.tool}* — ${truncate(arg, MAX_ONE_LINER_ARG)}`
  const headlineVerbose = `${badge} ${emoji} *${input.tool}* — ${truncate(arg, 120)}`
  const headline = input.verbosity === "normal" ? headlineNormal : headlineVerbose

  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: headline } },
  ]

  if (input.verbosity === "normal") {
    const preview = outputPreview(input.output, MAX_OUTPUT_PREVIEW_LINES)
    const previewText = input.error
      ? `_${truncate(input.error, 400)}_`
      : preview
        ? codeFence(preview)
        : "_(no output)_"
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: previewText },
    })
  } else {
    // verbose + debug: full input fence + full (truncated) output fence
    const inputFence = codeFence(serializeInput(input.input))
    if (inputFence) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: inputFence } })
    }
    if (input.error) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `:warning: ${truncate(input.error, MAX_FENCE_CHARS - 12)}` },
      })
    } else {
      const outputFence = codeFence(input.output)
      if (outputFence) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: outputFence } })
      } else {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: "_(no output)_" },
        })
      }
    }
  }

  if (input.verbosity === "debug") {
    const raw = safeJsonStringify(
      {
        id: input.id,
        tool: input.tool,
        input: input.input,
        output: input.output,
        ...(input.error !== undefined ? { error: input.error } : {}),
      },
      2,
    )
    const fence = codeFence(raw, "json")
    if (fence) blocks.push({ type: "section", text: { type: "mrkdwn", text: fence } })
  }

  if (input.elapsedMs !== undefined) {
    const hint = input.elapsedMs < 1000
      ? `took ${Math.round(input.elapsedMs)}ms`
      : `took ${(input.elapsedMs / 1000).toFixed(1)}s`
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: hint }],
    })
  }

  return {
    text: input.error
      ? `${input.tool} — error`
      : `${input.tool} — done`,
    blocks,
  }
}

// ---------------------------------------------------------------------------
// Concise aggregator — one line ("💭 3 tools: Bash, Read, Edit")
// ---------------------------------------------------------------------------

export function buildConciseToolSummary(toolNames: string[]): RenderedCard | null {
  if (toolNames.length === 0) return null
  const counts = new Map<string, number>()
  for (const name of toolNames) counts.set(name, (counts.get(name) ?? 0) + 1)
  const parts: string[] = []
  for (const [name, n] of counts) parts.push(n > 1 ? `${name} ×${n}` : name)
  const text = `:thought_balloon: ${toolNames.length} tool${toolNames.length === 1 ? "" : "s"}: ${parts.join(", ")}`
  return {
    text: `${toolNames.length} tools ran`,
    blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }],
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return ""
  if (typeof input === "string") return input.replace(/\s+/g, " ").trim()
  if (typeof input !== "object") return String(input)
  const obj = input as Record<string, unknown>
  // Preferred shortcut fields — many tools agree on a common name.
  const preferred = ["command", "file_path", "path", "pattern", "url", "query"]
  for (const key of preferred) {
    const v = obj[key]
    if (typeof v === "string" && v.length > 0) {
      const extras = Object.keys(obj).filter((k) => k !== key).length
      return extras > 0 ? `${key}: ${v} (+${extras})` : `${key}: ${v}`
    }
  }
  // Fall back to the first populated string field.
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > 0) return `${k}: ${v}`
  }
  return safeJsonStringify(obj).replace(/\s+/g, " ")
}

function serializeInput(input: unknown): string {
  if (typeof input === "string") return input
  return safeJsonStringify(input, 2)
}

function safeJsonStringify(value: unknown, indent?: number): string {
  try {
    return JSON.stringify(value, null, indent) ?? ""
  } catch {
    return String(value)
  }
}

function codeFence(body: string, lang = ""): string {
  if (!body) return ""
  const truncated =
    body.length > MAX_FENCE_CHARS ? `${body.slice(0, MAX_FENCE_CHARS - 1)}…` : body
  return ["```" + lang, truncated, "```"].join("\n")
}

function outputPreview(text: string, maxLines: number): string {
  if (!text) return ""
  const lines = text.split("\n")
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join("\n") + `\n… (+${lines.length - maxLines} lines)`
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return `${s.slice(0, Math.max(1, maxLen - 1))}…`
}
