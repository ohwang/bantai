/**
 * `slack_upload` MCP tool — lets the active agent attach a file from disk
 * into the current Slack thread.
 *
 * The renderer already auto-uploads tool outputs that blow past a line
 * threshold (view/upload.ts). This MCP tool is for the case where the
 * agent has a specific artefact it wants to attach mid-turn without
 * piping the whole thing through its text output — e.g. a generated
 * diff, a screenshot, a CSV of metrics.
 *
 * The tool is constructed per-session because each session has a
 * different (channel, threadTs) binding; the launcher wires one of
 * these into `SessionConfig.mcpServers` before the backend starts.
 *
 * Security posture:
 *   - The agent already has Read access to the filesystem via its own
 *     Read tool, so exposing upload doesn't expand the blast radius
 *     beyond "can send file contents to Slack" — which the agent can
 *     do by pasting bytes into a text reply anyway.
 *   - We DO cap the body at `maxBytes` (default 20 MiB) so a runaway
 *     or confused agent can't accidentally upload a multi-GB log.
 *   - We DO require the final path to stay within the session's cwd
 *     when a `cwd` is supplied — a cheap sanity check against the
 *     agent passing absolute paths pointing at /etc secrets. Operators
 *     who want to opt out of the cwd check set `cwd: null`.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { readFile as nodeReadFile, stat as nodeStat } from "node:fs/promises"
import { basename, isAbsolute, join, normalize, relative } from "node:path"
import type { SlackFileClient } from "../view/upload"
import { uploadFile } from "../view/upload"

// ---------------------------------------------------------------------------
// Shared handler — used by both the in-process SDK MCP server (below) and
// the standalone stdio MCP server (`slack-upload-stdio.ts`). Extracting this
// keeps the Claude-SDK and MCP-SDK entry points identical in behaviour.
// ---------------------------------------------------------------------------

/** Zod schema for `slack_upload` arguments. Kept exported so the stdio MCP
 *  server can reuse the exact same validation. */
export const slackUploadArgsSchema = {
  path: z
    .string()
    .min(1)
    .describe("Path to the file to upload. Relative paths resolve against the session cwd."),
  title: z
    .string()
    .optional()
    .describe("Optional Slack file title. Defaults to the filename."),
  comment: z
    .string()
    .optional()
    .describe("Optional comment posted above the file share."),
} as const

export interface SlackUploadCoreArgs {
  path: string
  title?: string
  comment?: string
}

export interface SlackUploadCoreResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  // MCP's CallToolResult allows arbitrary metadata keys (`_meta`, etc.);
  // the index signature keeps this type assignable to both the Claude SDK
  // callback return (which expects loose extensibility) and the MCP SDK
  // `CallToolResult` (same requirement). Upload handlers never set them.
  [key: string]: unknown
}

export interface SlackUploadCoreOpts {
  binding: SlackUploadBinding
  fileClient: SlackFileClient
  cwd: string | null
  maxBytes: number
  readFileImpl?: (path: string) => Promise<Uint8Array>
  statImpl?: (path: string) => Promise<{ size: number }>
}

/** The canonical tool description. Exported so both entry points share it. */
export const SLACK_UPLOAD_DESCRIPTION =
  "Attach a local file to the current Slack thread. This is the ONLY way to share binary artefacts (images, PDFs, screenshots, archives) with the user — Slack will not render them from a path or URL in your text. Use this proactively whenever you have generated or modified an image, produced a file the user will want to open locally (CSV, PDF, zip), or a diff/log is long enough that attaching a file is friendlier than pasting. Do NOT use it for short text output — paste that inline instead. The channel and thread are pre-bound by the host; you only supply `path` (relative paths resolve against the session's working directory)."

/**
 * Run one `slack_upload` invocation. Pure of MCP transport concerns —
 * callers pass already-validated args and wire up their own transport
 * (Claude SDK in-process, or MCP-SDK stdio).
 */
export async function runSlackUpload(
  opts: SlackUploadCoreOpts,
  args: SlackUploadCoreArgs,
): Promise<SlackUploadCoreResult> {
  const readFileImpl =
    opts.readFileImpl ?? (async (p: string) => new Uint8Array(await nodeReadFile(p)))
  const statImpl =
    opts.statImpl ?? (async (p: string) => ({ size: (await nodeStat(p)).size }))
  try {
    const resolved = resolvePath(args.path, opts.cwd)
    const sizeInfo = await statImpl(resolved)
    if (sizeInfo.size > opts.maxBytes) {
      return errorResult(
        `refusing to upload: ${sizeInfo.size} bytes exceeds cap of ${opts.maxBytes} bytes`,
      )
    }
    const bytes = await readFileImpl(resolved)
    const filename = basename(resolved)
    const result = await uploadFile(opts.fileClient, {
      filename,
      content: bytes,
      ...(args.title ? { title: args.title } : {}),
      channel: opts.binding.channel,
      threadTs: opts.binding.threadTs,
      ...(args.comment ? { initialComment: args.comment } : {}),
    })
    const permalinkLine = result.permalink
      ? `\nPermalink: ${result.permalink}`
      : ""
    return {
      content: [
        {
          type: "text" as const,
          text: `Uploaded ${filename} (id ${result.fileId}) to channel.${permalinkLine}`,
        },
      ],
    }
  } catch (err) {
    return errorResult(
      `upload failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export interface SlackUploadBinding {
  /** The channel the session posts into. */
  channel: string
  /** The thread ts to anchor the upload under. */
  threadTs: string
}

export interface CreateSlackUploadMcpOpts {
  binding: SlackUploadBinding
  /** Slack file client used for the 3-step upload. */
  fileClient: SlackFileClient
  /**
   * Session working directory. Relative paths are resolved against it;
   * absolute paths outside of it are rejected. Pass `null` to disable
   * the containment check entirely.
   */
  cwd: string | null
  /** Hard cap on upload bytes. Defaults to 20 MiB. */
  maxBytes?: number
  /** Test hook — override `fs.readFile`. */
  readFileImpl?: (path: string) => Promise<Uint8Array>
  /** Test hook — override `fs.stat` (size-check path). */
  statImpl?: (path: string) => Promise<{ size: number }>
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

export function createSlackUploadMcpServer(
  opts: CreateSlackUploadMcpOpts,
): McpSdkServerConfigWithInstance {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const coreOpts: SlackUploadCoreOpts = {
    binding: opts.binding,
    fileClient: opts.fileClient,
    cwd: opts.cwd,
    maxBytes,
    ...(opts.readFileImpl ? { readFileImpl: opts.readFileImpl } : {}),
    ...(opts.statImpl ? { statImpl: opts.statImpl } : {}),
  }

  return createSdkMcpServer({
    name: "bantai-slack-upload",
    version: "0.1.0",
    tools: [
      tool(
        "slack_upload",
        SLACK_UPLOAD_DESCRIPTION,
        slackUploadArgsSchema,
        async (args) => runSlackUpload(coreOpts, args),
        { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } },
      ),
    ],
  })
}

function resolvePath(raw: string, cwd: string | null): string {
  const absolute = isAbsolute(raw) ? normalize(raw) : join(cwd ?? process.cwd(), raw)
  if (cwd === null) return absolute
  const rel = relative(cwd, absolute)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `refusing to upload outside session cwd (${cwd}): ${raw}`,
    )
  }
  return absolute
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  }
}
