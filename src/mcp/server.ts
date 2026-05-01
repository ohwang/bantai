/**
 * MCP Diagnostics Server — exposes TUI internal state as MCP tools.
 *
 * Two transports:
 *   1. HTTP via Bun.serve() — for external clients (curl, MCP Inspector)
 *   2. In-process SDK transport — for the Claude adapter (Phase 2)
 *
 * Port is written to ~/.bantai/mcp-servers.json for discoverability.
 */

import { join, dirname } from "path"
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs"
import { homedir } from "os"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { getState, getConversation, getLogs, getScreenshot, getDiagnostics } from "./tools"

const SERVERS_FILE = join(homedir(), ".bantai", "mcp-servers.json")

// ---------------------------------------------------------------------------
// HTTP server state
// ---------------------------------------------------------------------------

let _httpServer: ReturnType<typeof Bun.serve> | null = null
let _mcpServer: McpServer | null = null

// ---------------------------------------------------------------------------
// SDK in-process server (Phase 2)
// ---------------------------------------------------------------------------

let _sdkConfig: McpSdkServerConfigWithInstance | null = null

const READONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const

export function getDiagnosticsSdkMcpConfig(): McpSdkServerConfigWithInstance | null {
  if (_sdkConfig) return _sdkConfig

  _sdkConfig = createSdkMcpServer({
    name: "bantai-diagnostics",
    version: "0.0.1",
    // Diagnostic tools are introspection primitives — small, read-only, and
    // most useful when the model can reach for them without a tool-search
    // round-trip. Opt out of the SDK's default tool-search deferral
    // (introduced in 0.2.121) so the 5 tools stay always-loaded in the
    // prompt. Crossagent (`src/subagents/mcp-tools.ts`) intentionally does
    // NOT set this — its 6 spawn/control tools are advanced delegation
    // features and benefit from tool-search gating.
    alwaysLoad: true,
    tools: [
      tool("get_state", "Read your own session state — lifecycle stage, model, token/cost usage, rate limits, and errors. Use this to understand where you are in a conversation.", {}, async () => getState(), { annotations: READONLY_ANNOTATIONS }),
      tool("get_conversation", "Read your own conversation history as the user sees it — messages, tool uses, thinking blocks, and errors. Use this to review what has happened so far.", {
        last_n: z.number().optional().describe("Return only the last N blocks"),
        type_filter: z.string().optional().describe("Filter by block type: user, assistant, tool, thinking, system, compact, shell, error"),
      }, async (args) => getConversation(args), { annotations: READONLY_ANNOTATIONS }),
      tool("get_logs", "Read your own internal log entries from this session. Useful for debugging issues or understanding what happened behind the scenes.", {
        level: z.enum(["debug", "info", "warn", "error"]).optional().describe("Minimum log level to include"),
        last_n: z.number().optional().describe("Return only the last N lines (default: 50)"),
      }, async (args) => getLogs(args), { annotations: READONLY_ANNOTATIONS }),
      tool("get_screenshot", "See what the user sees right now — captures your own terminal UI as plain text. Useful for understanding the current visual state.", {}, async () => getScreenshot(), { annotations: READONLY_ANNOTATIONS }),
      tool("get_diagnostics", "Read your own system diagnostics — memory, git state, backend capabilities, context window utilization, and conversation statistics.", {}, async () => getDiagnostics(), { annotations: READONLY_ANNOTATIONS }),
    ],
  })

  return _sdkConfig
}

// ---------------------------------------------------------------------------
// HTTP MCP server (for external clients)
// ---------------------------------------------------------------------------

function registerHttpTools(server: McpServer): void {
  server.registerTool("get_state", {
    description: "Read your own session state — lifecycle stage, model, token/cost usage, rate limits, and errors. Use this to understand where you are in a conversation.",
    annotations: READONLY_ANNOTATIONS,
  }, async () => getState())

  server.registerTool("get_conversation", {
    description: "Read your own conversation history as the user sees it — messages, tool uses, thinking blocks, and errors. Use this to review what has happened so far.",
    annotations: READONLY_ANNOTATIONS,
    inputSchema: {
      last_n: z.number().optional().describe("Return only the last N blocks"),
      type_filter: z.string().optional().describe("Filter by block type: user, assistant, tool, thinking, system, compact, shell, error"),
    },
  }, async (args) => getConversation(args))

  server.registerTool("get_logs", {
    description: "Read your own internal log entries from this session. Useful for debugging issues or understanding what happened behind the scenes.",
    annotations: READONLY_ANNOTATIONS,
    inputSchema: {
      level: z.enum(["debug", "info", "warn", "error"]).optional().describe("Minimum log level to include"),
      last_n: z.number().optional().describe("Return only the last N lines (default: 50)"),
    },
  }, async (args) => getLogs(args))

  server.registerTool("get_screenshot", {
    description: "See what the user sees right now — captures your own terminal UI as plain text. Useful for understanding the current visual state.",
    annotations: READONLY_ANNOTATIONS,
  }, async () => getScreenshot())

  server.registerTool("get_diagnostics", {
    description: "Read your own system diagnostics — memory, git state, backend capabilities, context window utilization, and conversation statistics.",
    annotations: READONLY_ANNOTATIONS,
  }, async () => getDiagnostics())
}

export async function startMcpHttpServer(): Promise<{ port: number; url: string }> {
  const mcpServer = new McpServer(
    { name: "bantai-diagnostics", version: "0.0.1" },
    { capabilities: { tools: {} } },
  )
  registerHttpTools(mcpServer)

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  })

  await mcpServer.connect(transport)

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/mcp") {
        return transport.handleRequest(req)
      }
      return new Response("Not Found", { status: 404 })
    },
  })

  _httpServer = server
  _mcpServer = mcpServer

  const port = server.port!
  const mcpUrl = `http://localhost:${port}/mcp`

  // Write port file
  writePortEntry("diagnostics", { port, url: mcpUrl, pid: process.pid })

  return { port, url: mcpUrl }
}

export async function stopMcpHttpServer(): Promise<void> {
  if (_httpServer) {
    _httpServer.stop()
    _httpServer = null
  }
  if (_mcpServer) {
    await _mcpServer.close().catch(() => {})
    _mcpServer = null
  }

  removePortEntry("diagnostics")
}

// ---------------------------------------------------------------------------
// Port file management (~/.bantai/mcp-servers.json)
// ---------------------------------------------------------------------------

function readPortFile(): Record<string, unknown> {
  try {
    const data = readFileSync(SERVERS_FILE, "utf-8")
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writePortEntry(name: string, entry: { port: number; url: string; pid: number }): void {
  const data = readPortFile()
  data[name] = entry
  mkdirSync(dirname(SERVERS_FILE), { recursive: true })
  writeFileSync(SERVERS_FILE, JSON.stringify(data, null, 2))
}

function removePortEntry(name: string): void {
  const data = readPortFile()
  delete data[name]
  if (Object.keys(data).length === 0) {
    try { unlinkSync(SERVERS_FILE) } catch { /* ignore */ }
  } else {
    try { writeFileSync(SERVERS_FILE, JSON.stringify(data, null, 2)) } catch { /* ignore */ }
  }
}
