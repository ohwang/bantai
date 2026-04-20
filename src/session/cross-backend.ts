/**
 * Cross-Backend Session Resume
 *
 * Enables resuming a session from one backend using a different backend.
 * E.g., `--backend codex --resume <claude-session-id>` loads the Claude
 * session's conversation history and injects it as context into Codex.
 *
 * Flow:
 *   1. detectSessionOrigin() — check if session ID belongs to a known backend
 *   2. readForeignSession() — read session data into Block[]
 *   3. formatFullHistory() — convert Block[] to a full-text prompt for injection
 *
 * Supports reading sessions from Claude (JSONL), Codex (JSONL), and
 * Gemini (JSON) session files on disk.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, basename } from "node:path"
import { log } from "../utils/logger"
import { readSessionHistory } from "../backends/claude/session-reader"
import { findClaudeSessionFileAnywhere } from "../backends/follow/find-session"
import type {
  Block,
  ParsedSession,
  SessionInfo,
  SessionResumeSummary,
  SessionResumeUsage,
  ToolStatus,
} from "../protocol/types"

/** Known backend names that can originate sessions */
export type SessionOrigin = "claude" | "codex" | "gemini" | null

// ---------------------------------------------------------------------------
// Home directory helper
// ---------------------------------------------------------------------------

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "~"
}

// ---------------------------------------------------------------------------
// Codex session file paths: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// ---------------------------------------------------------------------------

/** Get the Codex sessions root directory */
function codexSessionsDir(): string {
  return join(homeDir(), ".codex", "sessions")
}

/**
 * Recursively find all .jsonl files under a directory.
 * Returns absolute paths.
 */
function findJsonlFiles(dir: string): string[] {
  const results: string[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...findJsonlFiles(fullPath))
      } else if (entry.name.endsWith(".jsonl")) {
        results.push(fullPath)
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }
  return results
}

/**
 * Find a Codex session file by session ID.
 * Codex session filenames contain the UUID: rollout-TIMESTAMP-UUID.jsonl
 */
export function findCodexSessionFile(sessionId: string): string | null {
  const root = codexSessionsDir()
  if (!existsSync(root)) return null

  const files = findJsonlFiles(root)
  for (const file of files) {
    const name = basename(file)
    if (name.includes(sessionId)) {
      return file
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Gemini session file paths: ~/.gemini/tmp/<project>/chats/session-*.json
//
// Gemini CLI maps each project root to a short identifier via
// ~/.gemini/projects.json (e.g. /Users/x/dev/repo -> "repo"). Sessions are
// stored under ~/.gemini/tmp/<identifier>/chats/. `session/load` will ONLY
// find sessions under the identifier matching the current cwd — showing
// sessions from other projects in the picker leads to JSON-RPC -32603
// "Invalid session identifier" because Gemini searches the wrong dir.
// ---------------------------------------------------------------------------

/**
 * Look up the Gemini project identifier for a given cwd by reading
 * ~/.gemini/projects.json. Returns null if the cwd isn't registered.
 */
function geminiProjectIdentifier(cwd: string): string | null {
  const registryPath = join(homeDir(), ".gemini", "projects.json")
  if (!existsSync(registryPath)) return null
  try {
    const raw = readFileSync(registryPath, "utf-8")
    const registry = JSON.parse(raw) as { projects?: Record<string, string> }
    return registry.projects?.[cwd] ?? null
  } catch {
    return null
  }
}

/**
 * Get the Gemini chats directory for a specific cwd.
 * Returns null when the cwd isn't registered or the chats dir doesn't exist.
 */
function geminiChatDirForCwd(cwd: string): string | null {
  const identifier = geminiProjectIdentifier(cwd)
  if (!identifier) return null
  const chatDir = join(homeDir(), ".gemini", "tmp", identifier, "chats")
  return existsSync(chatDir) ? chatDir : null
}

/** Get all Gemini chat directories (across all projects). */
function geminiChatDirs(): string[] {
  const dirs: string[] = []
  const tmpDir = join(homeDir(), ".gemini", "tmp")
  try {
    const projects = readdirSync(tmpDir, { withFileTypes: true })
    for (const proj of projects) {
      if (proj.isDirectory()) {
        const chatDir = join(tmpDir, proj.name, "chats")
        if (existsSync(chatDir)) {
          dirs.push(chatDir)
        }
      }
    }
  } catch {
    // .gemini/tmp doesn't exist
  }
  return dirs
}

/**
 * Find a Gemini session file by session ID.
 * Gemini session filenames use a truncated UUID prefix (first 8 chars):
 *   session-2026-04-10T06-27-a84cb185.json
 * But the full sessionId inside the JSON is:
 *   a84cb185-f706-415d-b9d2-eada2ba5d0a6
 *
 * We match by checking if the filename contains the UUID prefix,
 * then verify the full sessionId inside the JSON content.
 */
export function findGeminiSessionFile(sessionId: string): string | null {
  const shortId = sessionId.split("-")[0] ?? sessionId // First 8 chars of UUID
  for (const chatDir of geminiChatDirs()) {
    try {
      const files = readdirSync(chatDir)
      for (const file of files) {
        if (!file.endsWith(".json")) continue
        // Check if filename contains either the full ID or the short prefix
        if (file.includes(sessionId) || file.includes(shortId)) {
          // Verify by reading the JSON to confirm the full sessionId matches
          try {
            const content = JSON.parse(readFileSync(join(chatDir, file), "utf-8"))
            if (content.sessionId === sessionId) {
              return join(chatDir, file)
            }
          } catch {
            // Parse error — skip this file
          }
        }
      }
    } catch {
      // Not readable
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// detectSessionOrigin — now supports Claude, Codex, and Gemini
// ---------------------------------------------------------------------------

/**
 * Detect which backend originally created a session.
 *
 * Checks session storage on disk for Claude, Codex, and Gemini.
 * Returns null if the session ID doesn't match any known backend's files.
 *
 * For Claude the caller's `cwd` is used only as a fast-path hint: the lookup
 * falls back to scanning every directory under `~/.claude/projects/` so a
 * session created in one repo can be addressed from any other shell (this is
 * the expected usage for `bantai follow <session-id>`). Codex and Gemini are
 * already globally indexed, so they need no cwd coupling.
 */
export function detectSessionOrigin(
  sessionId: string,
  cwd: string,
): SessionOrigin {
  // Check if it's a Claude session (JSONL file on disk). Scan all project
  // dirs — `cwd` is only a fast-path hint.
  if (findClaudeSessionFileAnywhere(sessionId, cwd)) {
    return "claude"
  }

  // Check if it's a Codex session (rollout-*.jsonl files under ~/.codex/sessions/)
  if (findCodexSessionFile(sessionId)) {
    return "codex"
  }

  // Check if it's a Gemini/ACP session (session-*.json files under ~/.gemini/tmp/)
  if (findGeminiSessionFile(sessionId)) {
    return "gemini"
  }

  return null
}

// ---------------------------------------------------------------------------
// Codex session reader
// ---------------------------------------------------------------------------

/**
 * Parse a Codex JSONL session file.
 *
 * Codex JSONL format (each line is a JSON object):
 * - {type: "session_meta", payload: {id, timestamp, cwd}} — metadata
 * - {type: "response_item", payload: {role: "user", content: [{type: "input_text", text}]}}
 * - {type: "response_item", payload: {role: "assistant", content: [{type: "output_text", text}]}}
 * - {type: "response_item", payload: {type: "reasoning", summary: [...], content: null, encrypted_content: "..."}}
 * - {type: "event_msg", payload: {type: "user_message", message: "..."}} — user prompts
 * - {type: "event_msg", payload: {type: "token_count", info: {total_token_usage, last_token_usage, model_context_window}}}
 * - {type: "response_item", payload: {type: "function_call", name, arguments}}
 * - {type: "response_item", payload: {type: "function_call_output", output}}
 *
 * Images: Codex can include image inputs in response_item content, but we
 * intentionally skip them when replaying history — see the corresponding
 * comment in src/backends/claude/session-reader.ts and the follow-up
 * "Image round-tripping" item in plans/quirky-dreaming-book.md.
 */
export function parseCodexSession(filePath: string): Block[] {
  return parseCodexSessionWithSummary(filePath).blocks
}

/** Codex parser that also returns aggregate session metadata for the
 *  resume summary. Used by same-backend Codex resume in the TUI sync layer. */
export function parseCodexSessionWithSummary(filePath: string): ParsedSession {
  const sessionIdFromName = (() => {
    // rollout-TIMESTAMP-UUID.jsonl — strip prefix + .jsonl to recover UUID
    const match = basename(filePath, ".jsonl").match(/rollout-[^-]+-[^-]+-[^-]+-[^-]+-(.+)$/)
    return match ? match[1] : basename(filePath, ".jsonl")
  })()

  const emptySummary: SessionResumeSummary = {
    sessionId: sessionIdFromName ?? basename(filePath, ".jsonl"),
    origin: "codex",
    target: "codex",
    messageCount: 0,
    toolCallCount: 0,
    turnCount: 0,
    filePath,
  }

  let raw: string
  try {
    raw = readFileSync(filePath, "utf-8")
  } catch (err) {
    log.warn("Failed to read Codex session file", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    })
    // Codex has no TodoWrite equivalent — always return an empty todos list.
    return { blocks: [], summary: emptySummary, todos: [] }
  }

  const blocks: Block[] = []
  const lines = raw.split("\n")

  let sessionId: string | undefined
  let contextWindowTokens: number | undefined
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCachedInputTokens = 0
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

    if (entry.type === "session_meta") {
      sessionId = entry.payload?.id ?? sessionId
      continue
    }

    if (entry.type === "event_msg") {
      const payload = entry.payload
      if (payload?.type === "user_message" && payload.message) {
        blocks.push({ type: "user", text: payload.message })
        messageCount++
        turnCount++
        continue
      }

      if (payload?.type === "token_count" && payload.info) {
        const info = payload.info as Record<string, any>
        if (typeof info.model_context_window === "number") {
          contextWindowTokens = info.model_context_window
        }
        const total = info.total_token_usage
        if (total && typeof total === "object") {
          if (typeof total.input_tokens === "number") totalInputTokens = total.input_tokens
          if (typeof total.output_tokens === "number") totalOutputTokens = total.output_tokens
          if (typeof total.cached_input_tokens === "number") totalCachedInputTokens = total.cached_input_tokens
        }
        const last = info.last_token_usage
        if (last && typeof last === "object" && typeof last.input_tokens === "number") {
          // Codex's last_token_usage.input_tokens already INCLUDES cached_input_tokens,
          // so this is the total prompt size for the most recent turn — perfect for
          // "effective context occupied".
          lastContextTokens = last.input_tokens
        }
        continue
      }

      log.debug("Skipped Codex event_msg", { payloadType: payload?.type })
      continue
    }

    if (entry.type === "response_item") {
      const payload = entry.payload
      if (!payload) continue

      // User message with content array
      if (payload.role === "user" && Array.isArray(payload.content)) {
        let text = ""
        for (const block of payload.content) {
          if (block.type === "input_text" && block.text) {
            text += (text ? "\n" : "") + block.text
          }
          // Skip input_image / other non-text content — see image comment above.
        }
        if (text) {
          blocks.push({ type: "user", text })
          messageCount++
          turnCount++
        }
        continue
      }

      // Assistant message with content array
      if (payload.role === "assistant" && Array.isArray(payload.content)) {
        let hasText = false
        for (const block of payload.content) {
          if (block.type === "output_text" && block.text) {
            blocks.push({ type: "assistant", text: block.text })
            hasText = true
          }
        }
        if (hasText) messageCount++
        continue
      }

      // Reasoning (thinking) block. `summary` is an array of free-text
      // summaries when unencrypted; `content` holds the raw CoT when the
      // model returns one. `encrypted_content` is opaque to the client and
      // intentionally dropped.
      if (payload.type === "reasoning") {
        const summaryArr = Array.isArray(payload.summary) ? payload.summary : []
        const parts: string[] = []
        for (const s of summaryArr) {
          if (typeof s === "string") parts.push(s)
          else if (s && typeof s === "object" && typeof s.text === "string") parts.push(s.text)
        }
        if (typeof payload.content === "string" && payload.content) {
          parts.push(payload.content)
        } else if (Array.isArray(payload.content)) {
          for (const c of payload.content) {
            if (c && typeof c === "object" && typeof c.text === "string") parts.push(c.text)
          }
        }
        const reasoningText = parts.join("\n\n").trim()
        if (reasoningText) {
          blocks.push({ type: "thinking", text: reasoningText })
        }
        continue
      }

      // Function call (tool use)
      if (payload.type === "function_call" && payload.name) {
        toolCallCount++
        blocks.push({
          type: "tool",
          id: payload.id ?? payload.call_id ?? `codex-${Date.now()}`,
          tool: payload.name,
          input: payload.arguments ?? "",
          status: "done" as ToolStatus,
          output: "",
          startTime: entryTs ?? Date.now(),
        })
        continue
      }

      // Function call output — attach to the preceding tool block
      if (payload.type === "function_call_output" && payload.output != null) {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]!
          if (b.type === "tool" && !b.output) {
            ;(b as any).output = String(payload.output)
            break
          }
        }
        continue
      }

      log.debug("Skipped Codex response_item", { role: payload.role, type: payload.type })
    }
  }

  // Codex's token fields use a different accounting model from Claude:
  //   - `input_tokens` already INCLUDES `cached_input_tokens` (subset).
  // Normalize by subtracting so the aggregate fields are disjoint (matches
  // the SessionResumeUsage shape used across backends).
  const nonCachedInput = Math.max(0, totalInputTokens - totalCachedInputTokens)
  const usage: SessionResumeUsage | undefined =
    totalInputTokens || totalOutputTokens || totalCachedInputTokens
      ? {
          inputTokens: nonCachedInput,
          outputTokens: totalOutputTokens,
          cacheReadTokens: totalCachedInputTokens,
          cacheCreationTokens: 0, // Codex's API surface doesn't distinguish cache creation
          totalCostUsd: 0,         // Not recorded in the JSONL; computed elsewhere if needed
          contextTokens: lastContextTokens ?? totalInputTokens,
        }
      : undefined

  const summary: SessionResumeSummary = {
    sessionId: sessionId ?? emptySummary.sessionId,
    origin: "codex",
    target: "codex",
    messageCount,
    toolCallCount,
    turnCount,
    lastActiveAt,
    usage,
    contextWindowTokens,
    filePath,
  }

  log.info("Codex session parsed", {
    filePath,
    blocks: blocks.length,
    users: blocks.filter(b => b.type === "user").length,
    assistants: blocks.filter(b => b.type === "assistant").length,
    tools: blocks.filter(b => b.type === "tool").length,
    thinking: blocks.filter(b => b.type === "thinking").length,
    usage,
  })

  // Codex has no TodoWrite-equivalent built-in; the TUI todo panel only lights
  // up for Claude-origin sessions. Always return an empty list.
  return { blocks, summary, todos: [] }
}

// ---------------------------------------------------------------------------
// Gemini session reader
// ---------------------------------------------------------------------------

/**
 * Parse a Gemini JSON session file into Block[].
 *
 * Gemini JSON format:
 * {
 *   sessionId, startTime, lastUpdated,
 *   messages: [
 *     {type: "user", content: [{text: "..."}] | "string"},
 *     {type: "gemini", content: "...", thoughts: [...], tokens: {...}}
 *   ]
 * }
 */
export function parseGeminiSession(filePath: string): Block[] {
  return parseGeminiSessionWithSummary(filePath).blocks
}

/** Gemini parser that also returns aggregate session metadata for the
 *  resume summary. Used by same-backend Gemini resume in the TUI sync layer.
 *
 *  Note on images: Gemini's session JSON may include image parts inside
 *  `content` arrays. They're intentionally not replayed into the conversation
 *  history (same rationale as Claude/Codex — see the comment in
 *  src/backends/claude/session-reader.ts and the "Image round-tripping"
 *  follow-up in plans/quirky-dreaming-book.md).
 */
export function parseGeminiSessionWithSummary(filePath: string): ParsedSession {
  const fallbackId = basename(filePath, ".json")
  const emptySummary: SessionResumeSummary = {
    sessionId: fallbackId,
    origin: "gemini",
    target: "gemini",
    messageCount: 0,
    toolCallCount: 0,
    turnCount: 0,
    filePath,
  }

  let raw: string
  try {
    raw = readFileSync(filePath, "utf-8")
  } catch (err) {
    log.warn("Failed to read Gemini session file", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    })
    // Gemini has no TodoWrite equivalent — always return an empty todos list.
    return { blocks: [], summary: emptySummary, todos: [] }
  }

  let session: any
  try {
    session = JSON.parse(raw)
  } catch (err) {
    log.warn("Failed to parse Gemini session JSON", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    })
    return { blocks: [], summary: emptySummary, todos: [] }
  }

  const blocks: Block[] = []
  const messages = session.messages ?? []

  let messageCount = 0
  let toolCallCount = 0
  let turnCount = 0
  let totalInputNonCached = 0
  let totalOutput = 0
  let totalCached = 0
  let totalThoughtTokens = 0
  let lastContextTokens: number | undefined
  let lastActiveAt: number | undefined

  for (const msg of messages) {
    const msgTs = msg.timestamp ? new Date(msg.timestamp).getTime() : undefined
    if (msgTs !== undefined) {
      lastActiveAt = lastActiveAt === undefined ? msgTs : Math.max(lastActiveAt, msgTs)
    }

    if (msg.type === "user") {
      let text = ""
      if (typeof msg.content === "string") {
        text = msg.content
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part?.text) {
            text += (text ? "\n" : "") + part.text
          }
          // Skip image parts — see image note above.
        }
      }
      if (text) {
        blocks.push({ type: "user", text })
        messageCount++
        turnCount++
      }
    } else if (msg.type === "gemini") {
      // Extract thinking/thoughts first
      if (Array.isArray(msg.thoughts)) {
        for (const thought of msg.thoughts) {
          const thoughtText = typeof thought === "string" ? thought : thought?.text
          if (thoughtText) {
            blocks.push({ type: "thinking", text: thoughtText })
          }
        }
      }

      // Extract assistant content
      const content = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((p: any) => p?.text ?? "").filter(Boolean).join("\n")
          : ""
      if (content) {
        blocks.push({ type: "assistant", text: content })
        messageCount++
      }

      // Tool calls attached to this assistant turn
      if (Array.isArray(msg.toolCalls)) {
        for (const call of msg.toolCalls) {
          toolCallCount++
          // Flatten the "result" array into a text output. Gemini wraps
          // results in functionResponse.response.output — grab the output
          // string when present, otherwise stringify the whole thing.
          let outputText = ""
          if (Array.isArray(call?.result)) {
            const parts: string[] = []
            for (const r of call.result) {
              const response = r?.functionResponse?.response
              if (response && typeof response.output === "string") {
                parts.push(response.output)
              } else if (response) {
                try { parts.push(JSON.stringify(response)) } catch { /* ignore */ }
              }
            }
            outputText = parts.join("\n")
          }
          const startTime = msgTs ?? Date.now()
          blocks.push({
            type: "tool",
            id: String(call?.id ?? `gemini-${toolCallCount}`),
            tool: String(call?.name ?? "tool"),
            input: call?.args ?? {},
            status: (call?.status === "success" ? "done" : call?.status === "error" ? "error" : "done") as ToolStatus,
            output: outputText,
            startTime,
          })
        }
      }

      // Token usage for this turn
      const tokens = msg.tokens
      if (tokens && typeof tokens === "object") {
        const input = Number(tokens.input ?? 0)
        const cached = Number(tokens.cached ?? 0)
        const output = Number(tokens.output ?? 0)
        const thoughtTokens = Number(tokens.thoughts ?? 0)
        // Gemini's `input` field includes cached tokens; keep the fields
        // disjoint to match the Claude/Codex accounting in SessionResumeUsage.
        totalInputNonCached += Math.max(0, input - cached)
        totalCached += cached
        totalOutput += output
        totalThoughtTokens += thoughtTokens
        lastContextTokens = input // already total prompt for the turn
      }
    } else {
      log.debug("Skipped Gemini message type", { type: msg.type })
    }
  }

  const usage: SessionResumeUsage | undefined =
    totalInputNonCached || totalOutput || totalCached || totalThoughtTokens
      ? {
          inputTokens: totalInputNonCached,
          outputTokens: totalOutput + totalThoughtTokens, // thinking tokens billed as output in Gemini
          cacheReadTokens: totalCached,
          cacheCreationTokens: 0,
          totalCostUsd: 0,
          contextTokens: lastContextTokens ?? (totalInputNonCached + totalCached),
        }
      : undefined

  const summary: SessionResumeSummary = {
    sessionId: typeof session.sessionId === "string" ? session.sessionId : fallbackId,
    origin: "gemini",
    target: "gemini",
    messageCount,
    toolCallCount,
    turnCount,
    lastActiveAt: lastActiveAt ?? (session.lastUpdated ? new Date(session.lastUpdated).getTime() : undefined),
    usage,
    filePath,
  }

  log.info("Gemini session parsed", {
    filePath,
    blocks: blocks.length,
    users: blocks.filter(b => b.type === "user").length,
    assistants: blocks.filter(b => b.type === "assistant").length,
    thinking: blocks.filter(b => b.type === "thinking").length,
    tools: blocks.filter(b => b.type === "tool").length,
    usage,
  })

  // Gemini has no TodoWrite-equivalent built-in; the TUI todo panel only lights
  // up for Claude-origin sessions. Always return an empty list.
  return { blocks, summary, todos: [] }
}

// ---------------------------------------------------------------------------
// readForeignSession — now supports Codex and Gemini
// ---------------------------------------------------------------------------

/**
 * Read a session's conversation history from its original backend.
 *
 * Returns Block[] in the universal conversation format.
 * Returns empty array if the session can't be read.
 */
export function readForeignSession(
  sessionId: string,
  origin: SessionOrigin,
  cwd: string,
): Block[] {
  switch (origin) {
    case "claude":
      return readSessionHistory(sessionId, cwd).blocks

    case "codex": {
      const codexFile = findCodexSessionFile(sessionId)
      if (!codexFile) {
        log.warn("Codex session file not found", { sessionId })
        return []
      }
      return parseCodexSession(codexFile)
    }

    case "gemini": {
      const geminiFile = findGeminiSessionFile(sessionId)
      if (!geminiFile) {
        log.warn("Gemini session file not found", { sessionId })
        return []
      }
      return parseGeminiSession(geminiFile)
    }

    default:
      log.warn("Cannot read session with unknown origin", { sessionId })
      return []
  }
}

// ---------------------------------------------------------------------------
// Disk-based session listing — for use before transport is alive
// ---------------------------------------------------------------------------

/**
 * List Codex sessions from disk (~/.codex/sessions/).
 * Used as a fallback when the Codex transport is not alive.
 */
export function listCodexSessionsFromDisk(): SessionInfo[] {
  const root = codexSessionsDir()
  if (!existsSync(root)) return []

  const files = findJsonlFiles(root)
  const sessions: SessionInfo[] = []

  for (const file of files) {
    try {
      const raw = readFileSync(file, "utf-8")
      const firstLine = raw.split("\n")[0]?.trim()
      if (!firstLine) continue

      const meta = JSON.parse(firstLine)
      if (meta.type !== "session_meta") continue

      const payload = meta.payload ?? {}
      const id = payload.id ?? basename(file, ".jsonl")
      const timestamp = payload.timestamp
        ? new Date(payload.timestamp).getTime()
        : statSync(file).mtimeMs

      // Scan up to 200 lines for the first real user message.
      // Codex injects 4-6 lines of system context (permissions, environment,
      // [System Prompt]) before the actual user message, so reading just line 2
      // almost always fails — producing UUID-only titles.
      let title = id.slice(0, 12)
      const allLines = raw.split("\n")
      const scanLimit = Math.min(allLines.length, 200)
      for (let i = 1; i < scanLimit; i++) {
        const scanLine = allLines[i]?.trim()
        if (!scanLine) continue
        let entry: any
        try { entry = JSON.parse(scanLine) } catch { continue }
        if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
          const msg = entry.payload.message
          if (typeof msg === "string" && msg.length > 0
              && !msg.startsWith("[System Prompt]")
              && !msg.startsWith("<")) {
            title = msg.slice(0, 80)
            break
          }
        }
      }

      sessions.push({
        id,
        title,
        origin: "codex",
        createdAt: timestamp,
        updatedAt: statSync(file).mtimeMs,
        fileSize: statSync(file).size,
        cwd: payload.cwd,
      })
    } catch {
      // Skip unreadable files
    }
  }

  // Sort by most recent first
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions
}

/**
 * List Gemini sessions from disk.
 *
 * When a cwd is provided, sessions are scoped to that project's chats dir
 * (~/.gemini/tmp/<identifier>/chats/) so every listed session can actually
 * be resumed via `session/load`. Without a cwd, falls back to scanning all
 * project dirs — only useful for cross-backend detection, not resume.
 */
export function listGeminiSessionsFromDisk(cwd?: string): SessionInfo[] {
  const sessions: SessionInfo[] = []

  const dirs = cwd
    ? (() => {
        const scoped = geminiChatDirForCwd(cwd)
        return scoped ? [scoped] : []
      })()
    : geminiChatDirs()

  for (const chatDir of dirs) {
    try {
      const files = readdirSync(chatDir).filter(f => f.startsWith("session-") && f.endsWith(".json"))
      for (const file of files) {
        const filePath = join(chatDir, file)
        try {
          const raw = readFileSync(filePath, "utf-8")
          const session = JSON.parse(raw)
          const id = session.sessionId ?? basename(file, ".json")
          const startTime = session.startTime ? new Date(session.startTime).getTime() : statSync(filePath).mtimeMs
          const lastUpdated = session.lastUpdated ? new Date(session.lastUpdated).getTime() : startTime

          // Get title from first user message
          let title = id.slice(0, 12)
          const messages = session.messages ?? []
          for (const msg of messages) {
            if (msg.type === "user") {
              const text = typeof msg.content === "string"
                ? msg.content
                : Array.isArray(msg.content)
                  ? msg.content[0]?.text ?? ""
                  : ""
              if (text) {
                title = text.slice(0, 80)
                break
              }
            }
          }

          sessions.push({
            id,
            title,
            origin: "gemini",
            createdAt: startTime,
            updatedAt: lastUpdated,
            fileSize: statSync(filePath).size,
          })
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Not readable
    }
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions
}

// ---------------------------------------------------------------------------
// Claude session listing — disk-based, parallel to Codex/Gemini
// ---------------------------------------------------------------------------

/**
 * List Claude sessions from disk (~/.claude/projects/<encoded-cwd>/).
 *
 * Scans the project directory for .jsonl session files, extracts the title
 * from the first user message, and returns SessionInfo[] sorted by most
 * recent first. Used for multi-backend preloading before transport starts.
 */
export function listClaudeSessionsFromDisk(cwd: string): SessionInfo[] {
  const projectKey = cwd.replace(/\//g, "-")
  const home = homeDir()
  const projectDir = join(home, ".claude", "projects", projectKey)

  if (!existsSync(projectDir)) return []

  const sessions: SessionInfo[] = []
  try {
    const files = readdirSync(projectDir).filter(f => f.endsWith(".jsonl"))
    for (const file of files) {
      const filePath = join(projectDir, file)
      try {
        const stat = statSync(filePath)
        const id = file.replace(".jsonl", "")

        // Read just enough to get the first user message for a title
        const raw = readFileSync(filePath, "utf-8")
        let title = id.slice(0, 12)
        const lines = raw.split("\n")
        for (let i = 0; i < Math.min(lines.length, 30); i++) {
          const line = lines[i]?.trim()
          if (!line) continue
          let entry: any
          try { entry = JSON.parse(line) } catch { continue }
          if (entry.type === "user") {
            const content = entry.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  title = block.text.slice(0, 80)
                  break
                }
              }
            }
            if (title !== id.slice(0, 12)) break
          }
        }

        sessions.push({
          id,
          title,
          origin: "claude",
          createdAt: stat.birthtimeMs || stat.mtimeMs,
          updatedAt: stat.mtimeMs,
          fileSize: stat.size,
          cwd,
        })
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Dir not readable
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions
}

// ---------------------------------------------------------------------------
// Backend-aware "most recent session" — used by --continue
// ---------------------------------------------------------------------------

/**
 * Find the most recent session for the given backend.
 *
 * When `--continue` is used with a specific backend (e.g. `bantai codex --continue`),
 * we must look in that backend's session storage — not just Claude's.
 * Falls back to scanning all backends and picking the globally most recent
 * when `backend` is null/undefined.
 */
export function findMostRecentSessionForBackend(
  backend: string | undefined,
  cwd: string,
): string | null {
  // Backend-specific: only search that backend's sessions
  if (backend === "codex") {
    const sessions = listCodexSessionsFromDisk()
    return sessions[0]?.id ?? null
  }
  if (backend === "gemini") {
    const sessions = listGeminiSessionsFromDisk(cwd)
    return sessions[0]?.id ?? null
  }
  if (backend === "claude") {
    const sessions = listClaudeSessionsFromDisk(cwd)
    return sessions[0]?.id ?? null
  }

  // No backend specified (or unknown): find the globally most recent session
  // across all backends.
  const all: Array<{ id: string; updatedAt: number }> = []
  for (const s of listClaudeSessionsFromDisk(cwd)) {
    all.push({ id: s.id, updatedAt: s.updatedAt })
  }
  for (const s of listCodexSessionsFromDisk()) {
    all.push({ id: s.id, updatedAt: s.updatedAt })
  }
  for (const s of listGeminiSessionsFromDisk(cwd)) {
    all.push({ id: s.id, updatedAt: s.updatedAt })
  }
  all.sort((a, b) => b.updatedAt - a.updatedAt)
  return all[0]?.id ?? null
}

// ---------------------------------------------------------------------------
// Session enrichment — deep-parse top-N for metadata
// ---------------------------------------------------------------------------

/**
 * Enrich sessions with deep-parsed metadata (turnCount, toolCallCount,
 * totalTokens, totalCostUsd). Only parses the first `limit` sessions to
 * bound startup latency. Remaining sessions keep their basic metadata.
 */
export function enrichSessions(
  sessions: SessionInfo[],
  cwd: string,
  limit: number = 20,
): SessionInfo[] {
  return sessions.map((session, i) => {
    if (i >= limit) return session

    try {
      let summary: SessionResumeSummary | undefined

      if (session.origin === "claude") {
        const parsed = readSessionHistory(session.id, cwd)
        summary = parsed.summary
      } else if (session.origin === "codex") {
        const file = findCodexSessionFile(session.id)
        if (file) summary = parseCodexSessionWithSummary(file).summary
      } else if (session.origin === "gemini") {
        const file = findGeminiSessionFile(session.id)
        if (file) summary = parseGeminiSessionWithSummary(file).summary
      }

      if (!summary) return session

      const usage = summary.usage
      const totalTokens = usage
        ? usage.inputTokens + usage.outputTokens + usage.cacheReadTokens
        : undefined
      const contextPercent = usage && summary.contextWindowTokens
        ? Math.round((usage.contextTokens / summary.contextWindowTokens) * 100)
        : undefined

      return {
        ...session,
        turnCount: summary.turnCount,
        toolCallCount: summary.toolCallCount,
        totalTokens,
        totalCostUsd: usage?.totalCostUsd || undefined,
        contextPercent,
      }
    } catch (err) {
      log.debug("Session enrichment failed", {
        id: session.id,
        origin: session.origin,
        error: err instanceof Error ? err.message : String(err),
      })
      return session // graceful degradation
    }
  })
}

// ---------------------------------------------------------------------------
// formatFullHistory — full-text history for cross-backend context injection
// ---------------------------------------------------------------------------

/**
 * Format Block[] as a full-text prompt for injecting into a foreign backend.
 *
 * Unlike formatHistoryAsContext(), this preserves the FULL text of every
 * message, tool call, and thinking block — no truncation. Groups blocks
 * into conversation turns for readability.
 *
 * Returns { contextText, toolCallCount, turnCount } where:
 * - contextText: the formatted full-history prompt string
 * - toolCallCount: number of tool calls included
 * - turnCount: number of user turns in the history
 */
export function formatFullHistory(
  blocks: Block[],
  origin: string,
): {
  contextText: string
  toolCallCount: number
  turnCount: number
} {
  if (blocks.length === 0) {
    return { contextText: "", toolCallCount: 0, turnCount: 0 }
  }

  const parts: string[] = []
  let toolCallCount = 0
  let turnCount = 0
  let inTurn = false

  for (const block of blocks) {
    switch (block.type) {
      case "user":
        turnCount++
        if (inTurn) {
          // Separate turns with a visual divider
          parts.push("")
        }
        inTurn = true
        parts.push(`=== Turn ${turnCount} ===`)
        parts.push(`User: ${block.text}`)
        break

      case "assistant":
        parts.push(`\nAssistant: ${block.text}`)
        break

      case "thinking":
        parts.push(`\n[Thinking: ${block.text}]`)
        break

      case "tool": {
        toolCallCount++
        const inputStr = formatToolInput(block.tool, block.input)
        parts.push(`\n[Tool: ${block.tool}]`)
        if (inputStr) {
          parts.push(`  Input: ${inputStr}`)
        }
        if (block.output) {
          parts.push(`  Output: ${block.output}`)
        }
        if (block.error) {
          parts.push(`  Error: ${block.error}`)
        }
        break
      }

      case "shell": {
        toolCallCount++
        parts.push(`\n[Shell: ${block.command}]`)
        if (block.output) {
          parts.push(`  Output: ${block.output}`)
        }
        if (block.error) {
          parts.push(`  Error: ${block.error}`)
        }
        break
      }

      case "compact":
        parts.push(`\n[Compacted context: ${block.summary}]`)
        break

      // Skip system, error, plan blocks — they don't carry conversation content
      case "system":
      case "error":
      case "plan":
        break

      default:
        log.debug("Skipped block type in full history formatting", { type: (block as Block).type })
    }
  }

  const header = `[Previous conversation history from ${origin} session \u2014 ${turnCount} turn(s), ${toolCallCount} tool call(s)]`
  const footer = `\n[Resuming session now. Continue the conversation in context of the above history.]`
  const contextText = header + "\n\n" + parts.join("\n") + footer

  return { contextText, toolCallCount, turnCount }
}

// ---------------------------------------------------------------------------
// formatHistoryAsContext (PRESERVED for backward compatibility with tests)
// ---------------------------------------------------------------------------

/**
 * Format Block[] as a text prompt for injecting into a foreign backend.
 *
 * Produces a human-readable conversation transcript that gives the target
 * backend enough context to continue the conversation meaningfully.
 *
 * Returns { contextText, toolCallCount, warningCount } where:
 * - contextText: the formatted prompt string
 * - toolCallCount: number of tool calls found (for the lossy conversion warning)
 * - warningCount: number of blocks that couldn't be fully converted
 */
export function formatHistoryAsContext(blocks: Block[]): {
  contextText: string
  toolCallCount: number
  warningCount: number
} {
  const parts: string[] = []
  let toolCallCount = 0
  let warningCount = 0

  for (const block of blocks) {
    switch (block.type) {
      case "user":
        parts.push(`User: ${block.text}`)
        break

      case "assistant":
        parts.push(`Assistant: ${block.text}`)
        break

      case "thinking":
        // Thinking blocks are internal reasoning — summarize briefly
        parts.push(`[Assistant thinking: ${truncate(block.text, 200)}]`)
        break

      case "tool": {
        toolCallCount++
        const inputSummary = summarizeToolInput(block.tool, block.input)
        const outputSummary = block.output ? truncate(block.output, 300) : "(no output)"
        parts.push(`[Tool: ${block.tool}] ${inputSummary}\n  Output: ${outputSummary}`)
        if (block.error) {
          parts.push(`  Error: ${block.error}`)
        }
        break
      }

      case "system":
        if (!block.ephemeral) {
          parts.push(`[System: ${block.text}]`)
        }
        break

      case "compact":
        parts.push(`[Compacted context: ${block.summary}]`)
        break

      case "shell": {
        toolCallCount++
        parts.push(`[Shell: ${block.command}]\n  Output: ${truncate(block.output, 300)}`)
        if (block.error) {
          parts.push(`  Error: ${block.error}`)
        }
        break
      }

      case "error":
        parts.push(`[Error: ${block.message}]`)
        warningCount++
        break

      case "plan":
        parts.push(`[Plan: ${block.entries.map(e => `${e.status ?? "pending"}: ${e.content}`).join("; ")}]`)
        break

      default:
        warningCount++
        log.debug("Skipped unknown block type in history formatting", { type: (block as Block).type })
    }
  }

  const contextText = parts.join("\n\n")
  return { contextText, toolCallCount, warningCount }
}

/**
 * Check whether a resume operation is cross-backend.
 *
 * Returns true when the session's origin differs from the target backend.
 * Returns false for same-backend resume or when origin can't be detected.
 */
export function isCrossBackendResume(
  sessionId: string,
  targetBackend: string,
  cwd: string,
): boolean {
  const origin = detectSessionOrigin(sessionId, cwd)
  if (!origin) return false
  return origin !== targetBackend
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Truncate text to maxLen characters, appending ellipsis if truncated */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + "..."
}

/** Format full tool input for the history transcript (no truncation) */
function formatToolInput(tool: string, input: unknown): string {
  if (!input || typeof input !== "object") {
    if (typeof input === "string") return input
    return ""
  }

  const obj = input as Record<string, unknown>

  switch (tool) {
    case "Read":
    case "ReadFile":
      return obj.file_path ? String(obj.file_path) : ""

    case "Edit":
    case "EditFile":
      if (obj.file_path) {
        let result = String(obj.file_path)
        if (obj.old_string) result += `\n    old: ${String(obj.old_string)}`
        if (obj.new_string) result += `\n    new: ${String(obj.new_string)}`
        return result
      }
      return ""

    case "Write":
    case "WriteFile":
      return obj.file_path ? String(obj.file_path) : ""

    case "Bash":
    case "bash":
      return obj.command ? `$ ${String(obj.command)}` : ""

    case "Grep":
    case "Search":
      return obj.pattern ? `pattern="${obj.pattern}"` : ""

    case "Glob":
      return obj.pattern ? `pattern="${obj.pattern}"` : ""

    default:
      // Full JSON for unknown tools
      try {
        return JSON.stringify(input)
      } catch {
        return ""
      }
  }
}

/** Summarize tool input for the history transcript */
function summarizeToolInput(tool: string, input: unknown): string {
  if (!input || typeof input !== "object") return ""

  const obj = input as Record<string, unknown>

  // Common tool patterns
  switch (tool) {
    case "Read":
    case "ReadFile":
      return obj.file_path ? `Read ${obj.file_path}` : ""

    case "Edit":
    case "EditFile":
      return obj.file_path ? `Edit ${obj.file_path}` : ""

    case "Write":
    case "WriteFile":
      return obj.file_path ? `Write ${obj.file_path}` : ""

    case "Bash":
    case "bash":
      return obj.command ? `$ ${truncate(String(obj.command), 200)}` : ""

    case "Grep":
    case "Search":
      return obj.pattern ? `Search for "${obj.pattern}"` : ""

    case "Glob":
      return obj.pattern ? `Glob "${obj.pattern}"` : ""

    case "ListDir":
      return obj.path ? `List ${obj.path}` : ""

    default: {
      // Generic: show first few key-value pairs
      const entries = Object.entries(obj).slice(0, 3)
      if (entries.length === 0) return ""
      return entries
        .map(([k, v]) => `${k}: ${truncate(String(v), 80)}`)
        .join(", ")
    }
  }
}
