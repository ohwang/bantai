/**
 * event-from-jsonl — translate a parsed Claude JSONL entry into AgentEvents.
 *
 * The follow backend's reducer is the same one every live backend uses. To
 * avoid drifting from live-session rendering, this translator emits the same
 * AgentEvents a live backend would, just reconstructed from the on-disk
 * record. The rules mirror `src/backends/claude/event-mapper.ts` wherever we
 * can observe the relevant field, and degrade gracefully where we can't:
 *
 *   - **No `text_delta`**. Claude Code's JSONL stores whole assistant
 *     messages; per-token streaming is unrecoverable. The translator emits
 *     `text_complete` directly. This is a known, intentional loss of
 *     fidelity documented in `team/bantai-follow-tui.md`.
 *   - **No `permission_request`**. The JSONL records a tool_use call and
 *     eventually a tool_result; the in-flight approval is not persisted.
 *     The follower sees "tool ran" after the fact.
 *   - **Tool pairing is stateful**. A `tool_use` block lives in an
 *     assistant entry; the matching `tool_result` lives as a content block
 *     inside a later user entry. The translator's `TranslatorState`
 *     tracks pending tool_use ids so `tool_use_end` can be emitted only
 *     when the paired result arrives. Unmatched `tool_result`s are
 *     logged — never silently dropped.
 *   - **Synthetic user entries** (compaction summary, slash-command marker,
 *     local-command wrappers) are detected via
 *     `detectSyntheticReason` from session-reader. compaction_summary →
 *     emit a `compact` event; every other reason → log.debug and skip.
 *     Bare-drops here were the "user messages vanish on resume" bug.
 *   - **Unknown shapes** `log.warn` with the uuid and a snippet, per the
 *     AGENTS.md "never silently drop external data" rule.
 */

import { log } from "../../utils/logger"
import { detectSyntheticReason } from "../claude/session-reader"
import type { AgentEvent, TokenUsage } from "../../protocol/types"

// ---------------------------------------------------------------------------
// State passed through the translator so it can pair tool_use with tool_result
// across entries. Created once per session replay; reused on live-tail events.
// ---------------------------------------------------------------------------

export interface TranslatorState {
  /** Tool-use ids emitted as `tool_use_start` but not yet closed with
   *  `tool_use_end`. Pairs with `tool_result` blocks in subsequent user
   *  entries. */
  pendingToolUses: Set<string>
  /** True once we've emitted a `turn_start` for the current turn but not
   *  yet a `turn_complete`. Each assistant entry opens+closes exactly one
   *  turn; user entries that carry a visible prompt also open one. */
  inTurn: boolean
}

export function createTranslatorState(): TranslatorState {
  return { pendingToolUses: new Set(), inTurn: false }
}

/**
 * Translate one parsed JSONL entry into zero or more AgentEvents.
 *
 * Mutates `state` — callers should reuse the same object across a session.
 * The entry is typed `unknown` because JSONL shapes evolve; all accesses
 * go through narrow runtime checks that log on surprises.
 */
export function eventsFromJsonlEntry(
  entry: unknown,
  state: TranslatorState,
): AgentEvent[] {
  if (!entry || typeof entry !== "object") {
    log.warn("JSONL entry is not an object — skipping", {
      snippet: safeSnippet(entry),
    })
    return []
  }

  const e = entry as Record<string, any>
  switch (e.type) {
    case "user":
      return fromUserEntry(e, state)
    case "assistant":
      return fromAssistantEntry(e, state)
    case "system":
      return fromSystemEntry(e)
    // Entries with no renderable output. Log at debug so the follower
    // doesn't go silent on unknown-but-benign rows.
    case "queue-operation":
    case "last-prompt":
    case "permission-mode":
    case "file-history-snapshot":
      log.debug("Skipping non-render JSONL entry", {
        uuid: e.uuid,
        entryType: e.type,
      })
      return []
    case undefined:
      log.warn("JSONL entry missing `type` field — skipping", {
        uuid: e.uuid,
        snippet: safeSnippet(entry),
      })
      return []
    default:
      log.warn("Unknown JSONL entry type — skipping", {
        uuid: e.uuid,
        entryType: e.type,
      })
      return []
  }
}

// ---------------------------------------------------------------------------
// User entries
// ---------------------------------------------------------------------------

function fromUserEntry(
  entry: Record<string, any>,
  state: TranslatorState,
): AgentEvent[] {
  const rawContent = entry.message?.content
  const out: AgentEvent[] = []

  // Normalise to an array of blocks. String-form content is a first-class
  // shape in the SDK; treating it as "not an array → drop" is the bug that
  // caused user messages to disappear on resume.
  const blocks = normaliseUserContentToBlocks(rawContent, entry)
  if (blocks === null) return out

  // Extract the three things a user entry can carry: a text prompt, a
  // compaction marker, and zero or more tool_result blocks.
  let text = ""
  let sawText = false
  const toolResults: Array<{ id: string; output: string; error?: string }> = []
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") {
          text += (text ? "\n" : "") + block.text
          sawText = true
        }
        break
      case "tool_result": {
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : ""
        if (!id) {
          log.warn("tool_result without tool_use_id — skipping", {
            uuid: entry.uuid,
          })
          break
        }
        const { output, error } = extractToolResultOutput(block)
        toolResults.push({ id, output, error })
        break
      }
      case "image":
        // See session-reader.ts: intentionally not replayed into follow.
        log.debug("Skipping image block in follow translator", {
          uuid: entry.uuid,
        })
        break
      default:
        log.warn("Unknown user content block type — skipping", {
          uuid: entry.uuid,
          blockType: typeof block.type === "string" ? block.type : typeof block.type,
        })
        break
    }
  }

  // Emit paired tool_use_end first — they belong to the previous turn.
  for (const tr of toolResults) {
    if (!state.pendingToolUses.has(tr.id)) {
      log.warn("tool_result has no matching tool_use_start — skipping", {
        uuid: entry.uuid,
        toolUseId: tr.id,
      })
      continue
    }
    state.pendingToolUses.delete(tr.id)
    const event: AgentEvent = { type: "tool_use_end", id: tr.id, output: tr.output }
    if (tr.error) event.error = tr.error
    out.push(event)
  }

  // Handle the text side of the entry.
  if (sawText) {
    const reason = detectSyntheticReason(text, entry)
    if (reason === "compaction_summary") {
      out.push({
        type: "compact",
        summary: text.trim(),
        trigger: "auto",
      })
      log.debug("Emitted compact event from synthetic user entry", {
        uuid: entry.uuid,
      })
      return out
    }
    if (reason) {
      log.debug("Skipping synthetic user entry", {
        uuid: entry.uuid,
        reason,
        prefix: text.slice(0, 40),
      })
      return out
    }
    const trimmed = text.trim()
    if (!trimmed) {
      log.debug("User entry had no renderable text — skipping", {
        uuid: entry.uuid,
      })
      return out
    }
    // Real user prompt — open a turn around it so the reducer can anchor
    // the subsequent assistant output. user_message alone doesn't open a
    // turn in the reducer; the SDK-driven backends emit turn_start from
    // a separate event. We mirror that here.
    closeTurnIfOpen(state, out)
    out.push({ type: "turn_start" })
    state.inTurn = true
    out.push({ type: "user_message", text: trimmed })
    // The turn will be closed when the following assistant entry finishes.
    return out
  }

  // Pure tool_result user turn — no prompt, just the leg that ships tool
  // outputs back to the model. No additional events beyond tool_use_end.
  return out
}

/** Normalise user content to the array shape; returns null on hopelessly
 *  unrecognised input (logged). */
function normaliseUserContentToBlocks(
  content: unknown,
  entry: Record<string, any>,
): any[] | null {
  if (typeof content === "string") {
    return [{ type: "text", text: content }]
  }
  if (Array.isArray(content)) return content
  if (content === undefined || content === null) {
    log.debug("User entry missing content — skipping", { uuid: entry.uuid })
    return null
  }
  log.warn("Unrecognised user content shape — skipping", {
    uuid: entry.uuid,
    contentType: typeof content,
    snippet: safeSnippet(content),
  })
  return null
}

function extractToolResultOutput(block: Record<string, any>): {
  output: string
  error?: string
} {
  const isError = Boolean(block.is_error)
  const raw = block.content
  let text = ""
  if (typeof raw === "string") {
    text = raw
  } else if (Array.isArray(raw)) {
    for (const part of raw) {
      if (part && typeof part === "object" && typeof part.text === "string") {
        text += part.text
      }
    }
  } else if (raw !== undefined && raw !== null) {
    // Unknown shape — keep a best-effort string so the tool block doesn't
    // render empty, but log it.
    text = safeSnippet(raw)
    log.warn("Unrecognised tool_result content shape — coerced to snippet", {
      toolUseId: block.tool_use_id,
    })
  }
  return isError ? { output: text, error: text } : { output: text }
}

// ---------------------------------------------------------------------------
// Assistant entries
// ---------------------------------------------------------------------------

function fromAssistantEntry(
  entry: Record<string, any>,
  state: TranslatorState,
): AgentEvent[] {
  const out: AgentEvent[] = []
  const rawContent = entry.message?.content
  const blocks = normaliseAssistantContentToBlocks(rawContent, entry)
  if (blocks === null) return out

  // Every assistant entry lives inside a turn. If the caller didn't open
  // one (e.g. the prior user entry was a tool_result-only leg), open one
  // here so the reducer's contract is honoured.
  if (!state.inTurn) {
    out.push({ type: "turn_start" })
    state.inTurn = true
  }

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue
    switch (block.type) {
      case "thinking":
        if (typeof block.thinking === "string" && block.thinking) {
          // No streaming granularity — emit as a single complete chunk.
          // The reducer treats thinking as its own content stream; it
          // doesn't require a delta+complete pair.
          out.push({ type: "thinking_delta", text: block.thinking })
        }
        break
      case "text":
        if (typeof block.text === "string" && block.text) {
          out.push({ type: "text_complete", text: block.text })
        }
        break
      case "tool_use": {
        const id = typeof block.id === "string" ? block.id : ""
        const name = typeof block.name === "string" ? block.name : ""
        if (!id || !name) {
          log.warn("tool_use block missing id/name — skipping", {
            uuid: entry.uuid,
          })
          break
        }
        state.pendingToolUses.add(id)
        out.push({
          type: "tool_use_start",
          id,
          tool: name,
          input: block.input ?? {},
        })
        break
      }
      default:
        log.warn("Unknown assistant content block — skipping", {
          uuid: entry.uuid,
          blockType: typeof block.type === "string" ? block.type : typeof block.type,
        })
        break
    }
  }

  // Close the turn with usage info if we can extract it.
  const usage = extractUsage(entry)
  const sessionId =
    typeof entry.sessionId === "string" ? entry.sessionId : undefined

  const complete: AgentEvent = { type: "turn_complete" }
  if (usage) complete.usage = usage
  if (sessionId) complete.sessionId = sessionId
  out.push(complete)
  state.inTurn = false

  return out
}

function normaliseAssistantContentToBlocks(
  content: unknown,
  entry: Record<string, any>,
): any[] | null {
  if (Array.isArray(content)) return content
  if (typeof content === "string") {
    return [{ type: "text", text: content }]
  }
  if (content === undefined || content === null) {
    log.debug("Assistant entry has no content — skipping", {
      uuid: entry.uuid,
    })
    return null
  }
  log.warn("Unrecognised assistant content shape — skipping", {
    uuid: entry.uuid,
    contentType: typeof content,
    snippet: safeSnippet(content),
  })
  return null
}

function extractUsage(entry: Record<string, any>): TokenUsage | undefined {
  const raw = entry.message?.usage
  if (!raw || typeof raw !== "object") return undefined
  const inputTokens = Number(raw.input_tokens ?? 0)
  const outputTokens = Number(raw.output_tokens ?? 0)
  const cacheReadTokens =
    raw.cache_read_input_tokens !== undefined
      ? Number(raw.cache_read_input_tokens)
      : undefined
  const cacheWriteTokens =
    raw.cache_creation_input_tokens !== undefined
      ? Number(raw.cache_creation_input_tokens)
      : undefined
  const totalCostUsd =
    typeof entry.costUSD === "number" ? entry.costUSD : undefined
  const usage: TokenUsage = { inputTokens, outputTokens }
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens
  if (totalCostUsd !== undefined) usage.totalCostUsd = totalCostUsd
  return usage
}

// ---------------------------------------------------------------------------
// System entries (compaction boundary, rare housekeeping rows)
// ---------------------------------------------------------------------------

function fromSystemEntry(entry: Record<string, any>): AgentEvent[] {
  // Claude Code occasionally writes type: "system" rows at compaction
  // boundaries. If we see a structured summary, emit a compact event —
  // otherwise debug-log and move on.
  const subtype = entry.subtype ?? entry.kind
  if (subtype === "compact" || subtype === "compact_boundary") {
    const summary =
      typeof entry.summary === "string"
        ? entry.summary
        : typeof entry.message === "string"
          ? entry.message
          : ""
    return [{ type: "compact", summary, trigger: "auto" }]
  }
  log.debug("Skipping system JSONL entry", {
    uuid: entry.uuid,
    subtype,
  })
  return []
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function closeTurnIfOpen(state: TranslatorState, out: AgentEvent[]): void {
  if (state.inTurn) {
    out.push({ type: "turn_complete" })
    state.inTurn = false
  }
}

function safeSnippet(value: unknown): string {
  try {
    const s = JSON.stringify(value)
    return s.length > 120 ? s.slice(0, 117) + "..." : s
  } catch {
    return String(value).slice(0, 120)
  }
}
