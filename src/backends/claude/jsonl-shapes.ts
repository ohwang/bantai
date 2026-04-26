/**
 * Claude session JSONL — shared parsing primitives.
 *
 * `message.content` is `string | Array<ContentBlockParam>` per the SDK's
 * own typings. Both forms appear in real session files. Three different
 * call sites need to parse user-role JSONL entries:
 *
 *   1. `session-reader.ts`         — reads JSONL on resume to render history
 *   2. `follow/event-from-jsonl.ts` — translates JSONL into AgentEvents for
 *                                     read-only follow mode
 *   3. `event-mapper.ts`           — handles `user` SDK messages during the
 *                                     replay phase of a live `query()` call
 *
 * Each one used to inline its own version of "extract text + filter
 * synthetic turns" and they drifted: site #3 (event-mapper.ts) was the
 * thinnest version and silently leaked `<command-name>` markers /
 * compaction summaries as user turns — exactly the bug class the
 * AGENTS.md "never silently drop external data" rule warns about.
 *
 * This module is the single source of truth for both pieces of logic:
 *
 *   - `detectSyntheticReason(text, entry)` — classify a user-role text
 *     payload as one of the SDK's synthetic-turn forms.
 *   - `extractUserMessageText(content, entry)` — normalise the
 *     string-vs-array shape into a discriminated union the caller
 *     handles exhaustively.
 *
 * Don't re-implement either function elsewhere; import from here.
 */

import { log } from "../../utils/logger"

// ---------------------------------------------------------------------------
// Synthetic-turn detection
//
// Claude Code emits several kinds of user-role turns that are not actual
// user input: compaction summaries, slash-command markers, and caveats
// attached to local-command output. Rendering these in the transcript
// would be noise, but silently dropping them caused the "user messages
// missing on resume" bug — so we detect them explicitly and let the
// caller log the skip instead of dropping blindly.
// ---------------------------------------------------------------------------

export type SyntheticReason =
  | "compaction_summary"
  | "slash_command_marker"
  | "local_command_caveat"
  | "local_command_stdout"
  | "local_command_stderr"
  | "meta_flag"

const SYNTHETIC_PREFIXES: ReadonlyArray<{ prefix: string; reason: SyntheticReason }> = [
  { prefix: "This session is being continued from a previous conversation", reason: "compaction_summary" },
  { prefix: "<command-name>", reason: "slash_command_marker" },
  { prefix: "<command-message>", reason: "slash_command_marker" },
  { prefix: "<command-args>", reason: "slash_command_marker" },
  { prefix: "<local-command-caveat>", reason: "local_command_caveat" },
  { prefix: "<local-command-stdout>", reason: "local_command_stdout" },
  { prefix: "<local-command-stderr>", reason: "local_command_stderr" },
]

/**
 * Detect whether a user-role JSONL entry is an SDK-synthesised turn rather
 * than real user input.
 *
 * Exported so every JSONL consumer reuses the exact same rules. Duplicating
 * this detection is how "user messages vanished on resume" shipped — and
 * how `<command-name>` markers leaked into the live event stream (Cluster 2 / L2).
 */
export function detectSyntheticReason(
  text: string,
  entry: { isMeta?: boolean },
): SyntheticReason | null {
  if (entry.isMeta) return "meta_flag"
  const leading = text.trimStart()
  for (const { prefix, reason } of SYNTHETIC_PREFIXES) {
    if (leading.startsWith(prefix)) return reason
  }
  return null
}

// ---------------------------------------------------------------------------
// User message content extraction
//
// `message.content` is `string | Array<ContentBlockParam>` per the SDK
// types. Both forms appear in real session files and live SDK events.
// This helper normalises them into a small discriminated union so every
// caller handles the outcomes explicitly — and we never silently drop an
// unexpected shape.
// ---------------------------------------------------------------------------

export type UserContentParseResult =
  | { kind: "text"; text: string }
  | { kind: "synthetic"; reason: SyntheticReason; prefix: string }
  | { kind: "tool_result_only" }
  | { kind: "empty" }
  | { kind: "unknown"; contentType: string; snippet: string }

export function extractUserMessageText(
  content: unknown,
  entry: { isMeta?: boolean; uuid?: string },
): UserContentParseResult {
  // String shorthand form — used by Claude Code for compaction summaries,
  // slash-command markers, and local-command wrappers. Real typed user input
  // can also take this form when the SDK feeds it back verbatim.
  if (typeof content === "string") {
    const reason = detectSyntheticReason(content, entry)
    if (reason) {
      return {
        kind: "synthetic",
        reason,
        prefix: content.slice(0, 40),
      }
    }
    const trimmed = content.trim()
    if (!trimmed) return { kind: "empty" }
    return { kind: "text", text: trimmed }
  }

  if (Array.isArray(content)) {
    // Block-array form. Extract text; ignore tool_result/image by design.
    let text = ""
    let sawText = false
    let sawToolResult = false
    for (const block of content) {
      if (!block || typeof block !== "object") continue
      switch (block.type) {
        case "text":
          if (typeof block.text === "string") {
            text += (text ? "\n" : "") + block.text
            sawText = true
          }
          break
        case "tool_result":
          sawToolResult = true
          break
        case "image":
          // Intentionally skipped — large base64 payloads, no terminal
          // image primitive yet. See session-reader.ts "Note on images".
          break
        default:
          // Unknown block type — log so we notice protocol additions before
          // they turn into a silent drop.
          log.warn("Unknown user content block type in session JSONL", {
            uuid: entry.uuid,
            blockType: typeof block.type === "string" ? block.type : typeof block.type,
          })
          break
      }
    }
    if (sawText && text.trim()) {
      const reason = detectSyntheticReason(text, entry)
      if (reason) {
        return { kind: "synthetic", reason, prefix: text.slice(0, 40) }
      }
      return { kind: "text", text }
    }
    if (sawToolResult) return { kind: "tool_result_only" }
    return { kind: "empty" }
  }

  return {
    kind: "unknown",
    contentType: content === null ? "null" : typeof content,
    snippet: safeStringifySnippet(content),
  }
}

export function safeStringifySnippet(value: unknown): string {
  try {
    const s = JSON.stringify(value)
    return s.length > 120 ? s.slice(0, 117) + "..." : s
  } catch {
    return String(value).slice(0, 120)
  }
}
