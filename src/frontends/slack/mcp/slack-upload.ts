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
  const readFileImpl =
    opts.readFileImpl ?? (async (p: string) => new Uint8Array(await nodeReadFile(p)))
  const statImpl =
    opts.statImpl ?? (async (p: string) => ({ size: (await nodeStat(p)).size }))

  return createSdkMcpServer({
    name: "bantai-slack-upload",
    version: "0.1.0",
    tools: [
      tool(
        "slack_upload",
        "Attach a file from disk to the current Slack thread. Use this when you want to share a build output, a diff, or a generated artefact with the user. Relative paths are resolved against the session's working directory.",
        {
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
        },
        async (args) => {
          try {
            const resolved = resolvePath(args.path, opts.cwd)
            const sizeInfo = await statImpl(resolved)
            if (sizeInfo.size > maxBytes) {
              return errorResult(
                `refusing to upload: ${sizeInfo.size} bytes exceeds cap of ${maxBytes} bytes`,
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
        },
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
