/**
 * Codex App-Server JSON-RPC Response Types
 *
 * Typed interfaces for the Codex app-server JSON-RPC responses. These
 * narrow `unknown` from the transport layer into concrete shapes, replacing
 * `as any` casts in the adapter.
 *
 * The transport's `request()` returns `Promise<unknown>`. These types
 * are used with type assertion at the RPC boundary — one controlled
 * assertion per response shape, instead of scattered `as any`.
 */

// ---------------------------------------------------------------------------
// thread/start, thread/resume responses
// ---------------------------------------------------------------------------

export interface CodexThreadResponse {
  thread?: {
    id?: string
  }
  model?: string
  modelProvider?: string
}

// ---------------------------------------------------------------------------
// thread/list response
// ---------------------------------------------------------------------------

export interface CodexThreadListResponse {
  threads?: CodexThreadInfo[]
}

export interface CodexThreadInfo {
  id: string
  createdAt?: number
  preview?: string
  name?: string
}

// ---------------------------------------------------------------------------
// thread/fork response
// ---------------------------------------------------------------------------

export interface CodexThreadForkResponse {
  thread?: {
    id?: string
  }
  threadId?: string
}

// ---------------------------------------------------------------------------
// turn/start response
// ---------------------------------------------------------------------------

export interface CodexTurnStartResponse {
  turn?: {
    id?: string
    status?: string
  }
}

// ---------------------------------------------------------------------------
// thread/tokenUsage/updated notification params
//
// Mirrors the codex app-server `ThreadTokenUsage` + `TokenUsageBreakdown`
// types. Generated TS bindings live in `codex app-server generate-ts`
// (v2/ThreadTokenUsage.ts, v2/TokenUsageBreakdown.ts) and are the
// authoritative schema; this is a permissive subset that tolerates
// older/newer minor variants.
// ---------------------------------------------------------------------------

export interface CodexTokenUsageParams {
  tokenUsage?: {
    last?: CodexTokenUsageEntry
    total?: CodexTokenUsageEntry
    /** Live per-model context-window cap reported by the app-server.
     *  Codex caps gpt-5.5 at 400K when invoked through the CLI even though
     *  the API model exposes 1M, so this is the only authoritative source. */
    modelContextWindow?: number | null
  }
}

export interface CodexTokenUsageEntry {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  /** Reasoning tokens are a SUBSET of outputTokens (OpenAI billing folds them
   *  in). Surfaced separately so the status bar can show a thinking/output
   *  split for o-series and gpt-5.5. Added in codex CLI 0.122. */
  reasoningOutputTokens?: number
  /** Convenience sum reported by the app-server (input + output, including
   *  the cached-input and reasoning subsets). Optional — older versions omit. */
  totalTokens?: number
}

// ---------------------------------------------------------------------------
// turn/start params (outbound)
// ---------------------------------------------------------------------------

export interface CodexTurnStartParams {
  threadId: string
  input: CodexTurnInput[]
  approvalPolicy: string
  sandboxPolicy?: CodexSandboxPolicy
  instructions?: string
  model?: string
  cwd?: string
}

export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | {
      type: "workspaceWrite"
      writableRoots: string[]
      networkAccess?: boolean
    }
  | {
      type: "readOnly"
      access?: {
        type: "fullAccess"
      }
    }
  | {
      type: "externalSandbox"
      networkAccess?: "restricted" | "enabled"
    }

export interface CodexTurnInput {
  type: "text" | "image"
  text?: string
  url?: string
}

// ---------------------------------------------------------------------------
// Item types for event mapper
// ---------------------------------------------------------------------------

/** A single file change entry in a fileChange item */
export interface CodexFileChangeEntry {
  kind?: string
  path?: string
}

/** MCP tool call result shape */
export interface CodexMcpToolResult {
  content?: CodexMcpContentBlock | CodexMcpContentBlock[]
}

export interface CodexMcpContentBlock {
  type: string
  text?: string
}

/** MCP tool call error shape */
export interface CodexMcpToolError {
  message?: string
}
