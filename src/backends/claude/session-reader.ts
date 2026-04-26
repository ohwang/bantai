/**
 * Session JSONL Reader
 *
 * Reads a Claude Code session JSONL file and converts it to Block[]
 * for pre-populating the conversation view on resume/continue.
 *
 * The SDK's query() API doesn't replay historical messages — it loads
 * context internally. We read the JSONL directly to render history.
 *
 * JSONL entry types:
 * - `user` — User message (message.content: ContentBlock[] | string)
 * - `assistant` — Assistant response (message.content: ContentBlock[] | string)
 * - `queue-operation` — Internal queue bookkeeping (skip)
 * - `last-prompt` — Last prompt cache (skip)
 * - `permission-mode` — Permission mode change (skip)
 * - `file-history-snapshot` — File version tracking (skip)
 * - `system` — System events, compaction (skip for now)
 *
 * ## Content shape — string vs array
 *
 * `message.content` is typed by the Anthropic SDK as
 * `string | Array<ContentBlockParam>` — both forms are valid. The JSONL uses
 * string form for SDK-injected synthetic turns (post-compaction summaries,
 * `<command-name>` slash-command markers, `<local-command-caveat>` blocks)
 * and array form for everything else. We MUST handle both; dropping one form
 * silently caused the resume-renders-no-user-messages regression.
 *
 * Any unrecognised shape is surfaced via `log.warn` — never silently ignored —
 * so that future protocol changes produce a visible signal instead of data
 * loss.
 */

import { readFileSync } from "fs"
import { join } from "path"
import { log } from "../../utils/logger"
import type {
  Block,
  ParsedSession,
  SessionResumeSummary,
  SessionResumeUsage,
  TodoItem,
  ToolStatus,
} from "../../protocol/types"
import { stripImagePlaceholders } from "../../protocol/text-utils"
import { synthesizeTodosUpdatedEvent } from "./event-mapper"
import {
  detectSyntheticReason,
  extractUserMessageText,
  safeStringifySnippet,
  type SyntheticReason,
} from "./jsonl-shapes"

// Re-export for backwards compatibility — `detectSyntheticReason` is
// imported by name from this module by `follow/event-from-jsonl.ts`.
export { detectSyntheticReason }
export type { SyntheticReason }

/** Encode a cwd path to the Claude project directory key format */
function encodeProjectKey(cwd: string): string {
  return cwd.replace(/\//g, "-")
}

/** Get the session JSONL file path */
export function getSessionFilePath(sessionId: string, cwd: string): string {
  const projectKey = encodeProjectKey(cwd)
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "~"
  return join(homeDir, ".claude", "projects", projectKey, `${sessionId}.jsonl`)
}

// `stripImagePlaceholders` is hoisted to `protocol/text-utils.ts` so the
// reducer and this resume reader share one implementation (Cluster 12).

// Synthetic-turn detection (`detectSyntheticReason`) and user-message
// content extraction (`extractUserMessageText`) used to live here. Both are
// now hoisted into `jsonl-shapes.ts` so the SDK adapter, this resume reader,
// and the follow-mode translator share one implementation. See Cluster 2 / L2
// in the anti-drift sprint.

/** Normalise assistant `message.content` into the array shape the main loop expects.
 *  Returns null if the content is missing/unrecognised (and logs a warning —
 *  silent drops here are what caused the resume regression). */
function normaliseAssistantContent(
  content: unknown,
  entry: { uuid?: string },
): any[] | null {
  if (Array.isArray(content)) return content
  if (typeof content === "string") {
    // Assistants occasionally use the string shorthand (especially for short
    // replies replayed from older transcript formats). Upgrade to the normal
    // text-block shape so the shared loop renders it.
    return [{ type: "text", text: content }]
  }
  if (content === undefined || content === null) {
    // No content on an assistant entry is unusual but not rare — it occurs on
    // thinking-only frames or interrupted turns. Downgrade to debug.
    log.debug("Assistant entry has no content — skipping", { uuid: entry.uuid })
    return null
  }
  log.warn("Unrecognised assistant message shape — skipping", {
    uuid: entry.uuid,
    contentType: typeof content,
    snippet: safeStringifySnippet(content),
  })
  return null
}

// `safeStringifySnippet` is hoisted into `jsonl-shapes.ts` (Cluster 2 / L2).

/** Read a session JSONL file and convert to blocks + summary for conversation display.
 *
 *  Note on images: Claude JSONL stores pasted screenshots as base64-encoded
 *  `image` content blocks. We intentionally do NOT replay those back to the
 *  conversation history on resume — base64 payloads are often megabytes per
 *  image, OpenTUI doesn't yet expose a terminal image primitive, and
 *  rendering them would slow down every scroll/repaint. Image blocks are
 *  dropped here and, where the SDK left a `[Image]` placeholder inside a
 *  text block, `stripImagePlaceholders` removes that too so the user sees a
 *  clean text-only transcript. See the "Image round-tripping" follow-up in
 *  plans/quirky-dreaming-book.md for the tracked reasoning.
 */
export function readSessionHistory(
  sessionId: string,
  cwd: string,
): ParsedSession {
  const filePath = getSessionFilePath(sessionId, cwd)
  log.info("Reading session history", { sessionId, filePath })

  const emptySummary: SessionResumeSummary = {
    sessionId,
    origin: "claude",
    target: "claude",
    messageCount: 0,
    toolCallCount: 0,
    turnCount: 0,
    filePath,
  }

  let raw: string
  try {
    raw = readFileSync(filePath, "utf-8")
  } catch (err) {
    log.warn("Failed to read session file", {
      sessionId,
      filePath,
      error: err instanceof Error ? err.message : String(err),
    })
    return { blocks: [], summary: emptySummary, todos: [] }
  }

  const blocks: Block[] = []
  const lines = raw.split("\n")

  // Track the `input` of the most-recently-seen TodoWrite tool_use. The
  // reducer treats `todos_updated` as a full-list replacement, so only the
  // LAST TodoWrite call in the transcript matters — earlier calls are
  // superseded. We defer parsing/validation until after the loop so we reuse
  // the single source of truth (`synthesizeTodosUpdatedEvent`) — that
  // helper already filters malformed items and warns on protocol drift.
  let lastTodoWriteInput: unknown = undefined

  // Usage aggregation. Claude's per-message `usage` contains fields that are
  // DISJOINT (input + cache_read + cache_creation = total prompt tokens for
  // that API call), so we sum across messages for cumulative totals and use
  // the last assistant turn's values for "effective context currently in play".
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let totalCostUsd = 0
  let lastContextTokens: number | undefined
  let lastActiveAt: number | undefined
  let messageCount = 0
  let toolCallCount = 0
  let turnCount = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let entry: any
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }

    const entryTs = entry.timestamp ? new Date(entry.timestamp).getTime() : undefined
    if (entryTs !== undefined) {
      lastActiveAt = lastActiveAt === undefined ? entryTs : Math.max(lastActiveAt, entryTs)
    }

    switch (entry.type) {
      case "user": {
        // `message.content` is typed `string | Array<ContentBlockParam>` by the
        // Anthropic SDK. Both forms occur in practice; silently dropping the
        // string form is the bug that caused user messages to vanish on resume.
        const rawContent = entry.message?.content
        const parsed = extractUserMessageText(rawContent, entry)

        if (parsed.kind === "unknown") {
          log.warn("Unrecognised user message shape — skipping", {
            uuid: entry.uuid,
            contentType: parsed.contentType,
            snippet: parsed.snippet,
          })
          break
        }

        if (parsed.kind === "synthetic") {
          // SDK-injected turn (compaction summary, slash-command marker,
          // local-command caveat). Not user input — don't render, but log so
          // we know why it disappeared rather than silently dropping it.
          log.debug("Skipping synthetic user entry", {
            uuid: entry.uuid,
            reason: parsed.reason,
            prefix: parsed.prefix,
          })
          break
        }

        if (parsed.kind === "tool_result_only") {
          // Pure tool-result user turn — an internal leg of the agent loop,
          // not something the user typed. Rendered inline via the tool block.
          break
        }

        if (parsed.kind === "empty") {
          log.debug("User entry had no renderable text — skipping", {
            uuid: entry.uuid,
          })
          break
        }

        blocks.push({ type: "user", text: parsed.text })
        messageCount++
        turnCount++
        break
      }

      case "assistant": {
        const rawContent = entry.message?.content
        // Assistants can also use the string-shorthand content form. Normalise
        // to the array shape so the downstream loop stays simple and we don't
        // silently drop plain-text assistant replays.
        const content = normaliseAssistantContent(rawContent, entry)
        if (content === null) break
        const usage = entry.message?.usage
        if (usage && typeof usage === "object") {
          const input = Number(usage.input_tokens ?? 0)
          const output = Number(usage.output_tokens ?? 0)
          const cacheRead = Number(usage.cache_read_input_tokens ?? 0)
          const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0)
          inputTokens += input
          outputTokens += output
          cacheReadTokens += cacheRead
          cacheCreationTokens += cacheCreate
          // Per-turn context = full prompt tokens for this API call.
          // Use the LAST assistant turn's value so the summary reflects
          // "how much context the next turn will carry".
          lastContextTokens = input + cacheRead + cacheCreate
        }
        if (typeof entry.costUSD === "number") {
          totalCostUsd += entry.costUSD
        }

        let hasAssistantBlock = false
        for (const block of content) {
          switch (block.type) {
            case "thinking":
              if (block.thinking) {
                blocks.push({ type: "thinking", text: block.thinking })
              }
              break

            case "text":
              if (block.text) {
                hasAssistantBlock = true
                blocks.push({
                  type: "assistant",
                  text: stripImagePlaceholders(block.text),
                  timestamp: entry.timestamp
                    ? new Date(entry.timestamp).getTime()
                    : undefined,
                })
              }
              break

            case "tool_use":
              toolCallCount++
              if (block.name === "TodoWrite") {
                // Record the latest TodoWrite input; only the LAST call in
                // the transcript survives (reducer uses replacement semantics).
                lastTodoWriteInput = block.input ?? {}
              }
              blocks.push({
                type: "tool",
                id: block.id,
                tool: block.name,
                input: block.input ?? {},
                status: "done" as ToolStatus,
                output: "",
                startTime: entry.timestamp
                  ? new Date(entry.timestamp).getTime()
                  : Date.now(),
              })
              break
          }
        }
        if (hasAssistantBlock) messageCount++
        break
      }

      // Skip all other entry types (queue-operation, last-prompt, etc.)
    }
  }

  const usage: SessionResumeUsage | undefined =
    inputTokens || outputTokens || cacheReadTokens || cacheCreationTokens || totalCostUsd
      ? {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          totalCostUsd,
          contextTokens: lastContextTokens ?? (inputTokens + cacheReadTokens + cacheCreationTokens),
        }
      : undefined

  const summary: SessionResumeSummary = {
    sessionId,
    origin: "claude",
    target: "claude",
    messageCount,
    toolCallCount,
    turnCount,
    lastActiveAt,
    usage,
    filePath,
  }

  // Reconstruct the todo checklist from the last TodoWrite call in history.
  // Reusing `synthesizeTodosUpdatedEvent` keeps validation + warn-on-drift
  // behaviour identical to the live event path — if we diverged, we'd ship
  // two subtly different rules for the same shape, which is how the
  // "user messages vanish on resume" class of bug keeps resurfacing.
  let todos: TodoItem[] = []
  if (lastTodoWriteInput !== undefined) {
    const event = synthesizeTodosUpdatedEvent(lastTodoWriteInput)
    if (event.type === "todos_updated") {
      todos = event.todos
    }
  }

  log.info("Session history loaded", {
    sessionId,
    blocks: blocks.length,
    users: blocks.filter((b) => b.type === "user").length,
    assistants: blocks.filter((b) => b.type === "assistant").length,
    tools: blocks.filter((b) => b.type === "tool").length,
    todos: todos.length,
    usage,
  })

  return { blocks, summary, todos }
}

/** Find the most recently modified session in a project directory */
export function findMostRecentSession(cwd: string): string | null {
  const projectKey = encodeProjectKey(cwd)
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "~"
  const projectDir = join(homeDir, ".claude", "projects", projectKey)

  try {
    const { readdirSync, statSync } = require("fs")
    const files = readdirSync(projectDir) as string[]
    const jsonlFiles = files
      .filter((f: string) => f.endsWith(".jsonl"))
      .map((f: string) => ({
        name: f,
        mtime: statSync(join(projectDir, f)).mtimeMs,
      }))
      .sort((a: any, b: any) => b.mtime - a.mtime)

    const mostRecent = jsonlFiles[0]
    if (!mostRecent) return null
    return mostRecent.name.replace(".jsonl", "")
  } catch {
    return null
  }
}
