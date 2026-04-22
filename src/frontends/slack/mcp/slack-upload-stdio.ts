/**
 * Standalone stdio MCP server that exposes the `slack_upload` tool to any
 * MCP-speaking agent — including backends that do NOT support Claude's
 * in-process SDK MCP transport (Codex, Gemini CLI via ACP, etc.).
 *
 * The in-process variant (`slack-upload.ts`) is built with
 * `createSdkMcpServer` from the Claude Agent SDK; that primitive only
 * attaches to Claude's SDK runtime. To give Codex and other backends
 * access to the same tool, the launcher spawns a copy of THIS file as a
 * child process and wires its stdio into the backend's MCP subsystem:
 *
 *   - Codex CLI reads `[mcp_servers.bantai-slack-upload]` from its TOML
 *     config (we inject via `CodexOptions.config.mcp_servers`).
 *   - Claude SDK accepts stdio MCP specs directly (`type: "stdio"`).
 *
 * Session context flows via environment variables (pre-bound by the
 * launcher so the agent cannot retarget the upload):
 *
 *   BANTAI_SLACK_CHANNEL     — target Slack channel id          (required)
 *   BANTAI_SLACK_THREAD_TS   — thread anchor ts                  (required)
 *   BANTAI_SLACK_BOT_TOKEN   — workspace bot token (files:write) (required)
 *   BANTAI_SLACK_CWD         — session working directory         (optional;
 *                              empty or missing ⇒ cwd check disabled)
 *   BANTAI_SLACK_MAX_BYTES   — hard cap on upload bytes          (optional;
 *                              default 20 MiB)
 *   BANTAI_SLACK_API_BASE    — Slack Web API base URL override   (optional;
 *                              tests/minislack only)
 *
 * Security posture: identical to the in-process variant. The bot token
 * lives in the subprocess env (not forwarded to the agent), the channel
 * and thread are pre-bound (agent cannot change them), and the cwd +
 * size caps apply as before.
 */

import { readFile as nodeReadFile, stat as nodeStat } from "node:fs/promises"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { buildSlackFileClientFromToken } from "../view/upload"
import type { SlackFileClient } from "../view/upload"
import {
  SLACK_UPLOAD_DESCRIPTION,
  slackUploadArgsSchema,
  runSlackUpload,
  type SlackUploadCoreArgs,
  type SlackUploadCoreOpts,
} from "./slack-upload"

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

export interface StdioEnv {
  BANTAI_SLACK_CHANNEL?: string
  BANTAI_SLACK_THREAD_TS?: string
  BANTAI_SLACK_BOT_TOKEN?: string
  BANTAI_SLACK_CWD?: string
  BANTAI_SLACK_MAX_BYTES?: string
  BANTAI_SLACK_API_BASE?: string
}

export interface ParsedStdioEnv {
  channel: string
  threadTs: string
  botToken: string
  cwd: string | null
  maxBytes: number
  apiBase?: string
}

/** Parse the env vars this server expects. Pure — tests can feed a plain
 *  object in. Throws a human-readable error for missing/invalid fields so
 *  the subprocess exits with a useful stderr message. */
export function parseStdioEnv(env: StdioEnv): ParsedStdioEnv {
  const missing: string[] = []
  const channel = env.BANTAI_SLACK_CHANNEL?.trim() ?? ""
  const threadTs = env.BANTAI_SLACK_THREAD_TS?.trim() ?? ""
  const botToken = env.BANTAI_SLACK_BOT_TOKEN ?? ""
  if (!channel) missing.push("BANTAI_SLACK_CHANNEL")
  if (!threadTs) missing.push("BANTAI_SLACK_THREAD_TS")
  if (!botToken) missing.push("BANTAI_SLACK_BOT_TOKEN")
  if (missing.length > 0) {
    throw new Error(
      `slack-upload-stdio: missing required env var(s): ${missing.join(", ")}`,
    )
  }
  const cwdRaw = env.BANTAI_SLACK_CWD?.trim() ?? ""
  const cwd = cwdRaw === "" ? null : cwdRaw
  let maxBytes = DEFAULT_MAX_BYTES
  if (env.BANTAI_SLACK_MAX_BYTES !== undefined && env.BANTAI_SLACK_MAX_BYTES !== "") {
    const parsed = Number(env.BANTAI_SLACK_MAX_BYTES)
    if (!Number.isFinite(parsed) || parsed <= 0 || Math.floor(parsed) !== parsed) {
      throw new Error(
        `slack-upload-stdio: BANTAI_SLACK_MAX_BYTES must be a positive integer, got "${env.BANTAI_SLACK_MAX_BYTES}"`,
      )
    }
    maxBytes = parsed
  }
  const out: ParsedStdioEnv = {
    channel,
    threadTs,
    botToken,
    cwd,
    maxBytes,
  }
  const apiBase = env.BANTAI_SLACK_API_BASE?.trim()
  if (apiBase) out.apiBase = apiBase
  return out
}

export interface BuildStdioMcpServerOpts {
  parsed: ParsedStdioEnv
  /** Test hook — override the Slack file client. Defaults to the
   *  token-authenticated fetch client from `view/upload.ts`. */
  fileClient?: SlackFileClient
  /** Test hook — override fs.readFile. */
  readFileImpl?: (path: string) => Promise<Uint8Array>
  /** Test hook — override fs.stat. */
  statImpl?: (path: string) => Promise<{ size: number }>
}

/**
 * Construct the `McpServer` with the single `slack_upload` tool registered.
 * Exported separately from `main()` so tests can drive it without spawning
 * an actual subprocess + stdio transport.
 */
export function buildStdioMcpServer(opts: BuildStdioMcpServerOpts): McpServer {
  const { parsed } = opts
  const fileClient =
    opts.fileClient ??
    buildSlackFileClientFromToken(parsed.botToken, {
      ...(parsed.apiBase ? { apiBase: parsed.apiBase } : {}),
    })

  const coreOpts: SlackUploadCoreOpts = {
    binding: { channel: parsed.channel, threadTs: parsed.threadTs },
    fileClient,
    cwd: parsed.cwd,
    maxBytes: parsed.maxBytes,
    ...(opts.readFileImpl
      ? { readFileImpl: opts.readFileImpl }
      : { readFileImpl: async (p: string) => new Uint8Array(await nodeReadFile(p)) }),
    ...(opts.statImpl
      ? { statImpl: opts.statImpl }
      : { statImpl: async (p: string) => ({ size: (await nodeStat(p)).size }) }),
  }

  const server = new McpServer({
    name: "bantai-slack-upload",
    version: "0.1.0",
  })
  server.registerTool(
    "slack_upload",
    {
      description: SLACK_UPLOAD_DESCRIPTION,
      inputSchema: slackUploadArgsSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args: SlackUploadCoreArgs) => runSlackUpload(coreOpts, args),
  )
  return server
}

/**
 * Entry point. Reads env, builds the server, attaches a StdioServerTransport.
 * The CLI subcommand `bantai slack mcp-upload-server` delegates here; the
 * Slack launcher spawns this same subcommand per session.
 *
 * Any initialization failure is written to stderr and exits non-zero so the
 * parent MCP client surfaces a clear error at tool-registration time.
 */
export async function main(): Promise<void> {
  let parsed: ParsedStdioEnv
  try {
    parsed = parseStdioEnv(process.env as StdioEnv)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message ?? String(err))
    process.exit(1)
  }
  const server = buildStdioMcpServer({ parsed })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
