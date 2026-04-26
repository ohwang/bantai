/**
 * Crossagent MCP Tools — programmatic subagent control via MCP.
 *
 * These tools allow the Claude model (via the SDK's in-process MCP server)
 * to spawn, monitor, and communicate with cross-backend subagents.
 *
 * Prefix: crossagent_ (to distinguish from backend-native subagent capabilities)
 * Transport: SDK in-process only (not HTTP-exposed)
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { SubagentManager } from "./manager"
import { loadAllDefinitions } from "./definitions"

// ---------------------------------------------------------------------------
// Result helpers (same pattern as mcp/tools.ts)
// ---------------------------------------------------------------------------

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] }
}

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true }
}

// ---------------------------------------------------------------------------
// Module-level state (same pattern as state-bridge.ts)
// ---------------------------------------------------------------------------

let _manager: SubagentManager | null = null
let _sdkConfig: McpSdkServerConfigWithInstance | null = null

export function setSubagentManager(mgr: SubagentManager): void {
  _manager = mgr
}

export function getSubagentManager(): SubagentManager | null {
  return _manager
}

export function getCrossagentSdkMcpConfig(): McpSdkServerConfigWithInstance | null {
  if (_sdkConfig) return _sdkConfig

  _sdkConfig = createSdkMcpServer({
    name: "bantai-crossagent",
    version: "0.0.1",
    tools: [
      tool(
        "crossagent_spawn",
        "Spawn a new cross-backend subagent. The subagent runs asynchronously. Use this for delegating tasks to specific backends (e.g., spawn a Gemini subagent for research while you continue working). For same-backend delegation within your own workflow, use your native Agent tool instead. After spawning, use crossagent_wait to block until completion, or crossagent_status to poll progress.",
        {
          definition_name: z.string().describe("Name of the agent definition (from .claude/agents/ files)"),
          prompt: z.string().describe("Initial prompt/task for the subagent"),
          backend: z.string().optional().describe("Override backend (any id from the registry — see /backend)"),
          model: z.string().optional().describe("Override model"),
        },
        async (args) => {
          if (!_manager) return errorResult("SubagentManager not initialized")

          const definitions = loadAllDefinitions()
          const def = definitions.find(d => d.name === args.definition_name)
          if (!def) {
            const available = definitions.map(d => d.name).join(", ")
            return errorResult(`No agent definition found with name "${args.definition_name}". Available: ${available || "none"}`)
          }

          const subagentId = _manager.spawn({
            definition: def,
            prompt: args.prompt,
            backendOverride: args.backend,
            modelOverride: args.model,
          })

          return jsonResult({
            subagent_id: subagentId,
            definition: def.name,
            backend: args.backend ?? def.backend ?? "claude",
          })
        },
        { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
      ),

      tool(
        "crossagent_list",
        "List all cross-backend subagents (running, completed, and errored). Shows status, backend, elapsed time, and progress for each.",
        {},
        async () => {
          if (!_manager) return errorResult("SubagentManager not initialized")
          const statuses = _manager.listAll()
          if (statuses.length === 0) return textResult("No subagents have been spawned.")
          return jsonResult(statuses)
        },
        { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }
      ),

      tool(
        "crossagent_status",
        "Get detailed status of a specific cross-backend subagent. Shows state, output, tool usage, turn count, and token consumption. During tool-heavy runs (common with Codex), output may be empty while the model works — check toolUseCount, recentTools, and activeTurn for progress.",
        {
          subagent_id: z.string().describe("The subagent ID returned by crossagent_spawn"),
        },
        async (args) => {
          if (!_manager) return errorResult("SubagentManager not initialized")
          const status = _manager.getStatus(args.subagent_id)
          if (!status) return errorResult(`No subagent found with ID "${args.subagent_id}"`)
          return jsonResult(status)
        },
        { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }
      ),

      tool(
        "crossagent_wait",
        "Wait for a cross-backend subagent to complete. Blocks until the subagent finishes (completed or error) or the timeout elapses. Use this after crossagent_spawn instead of polling crossagent_status. Returns the final status including full output.",
        {
          subagent_id: z.string().describe("The subagent ID returned by crossagent_spawn"),
          timeout_ms: z.number().optional().describe("Maximum time to wait in milliseconds. If omitted, waits indefinitely."),
        },
        async (args) => {
          if (!_manager) return errorResult("SubagentManager not initialized")
          const status = await _manager.waitForCompletion(args.subagent_id, args.timeout_ms)
          if (!status) return errorResult(`No subagent found with ID "${args.subagent_id}"`)
          return jsonResult(status)
        },
        { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }
      ),

      tool(
        "crossagent_send",
        "Send a follow-up message to a running cross-backend subagent. The message is queued and delivered on the subagent's next turn boundary.",
        {
          subagent_id: z.string().describe("The subagent ID"),
          message: z.string().describe("Message to send to the subagent"),
        },
        async (args) => {
          if (!_manager) return errorResult("SubagentManager not initialized")
          const status = _manager.getStatus(args.subagent_id)
          if (!status) return errorResult(`No subagent found with ID "${args.subagent_id}"`)
          if (status.state !== "running") return errorResult(`Subagent "${args.subagent_id}" is not running (state: ${status.state})`)
          _manager.sendMessage(args.subagent_id, args.message)
          return jsonResult({ success: true, subagent_id: args.subagent_id })
        },
        { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
      ),

      tool(
        "crossagent_stop",
        "Stop a running cross-backend subagent. The subagent's backend is closed and its status changes to completed.",
        {
          subagent_id: z.string().describe("The subagent ID to stop"),
        },
        async (args) => {
          if (!_manager) return errorResult("SubagentManager not initialized")
          const status = _manager.getStatus(args.subagent_id)
          if (!status) return errorResult(`No subagent found with ID "${args.subagent_id}"`)
          if (status.state !== "running") return errorResult(`Subagent "${args.subagent_id}" is not running (state: ${status.state})`)
          _manager.stop(args.subagent_id)
          return jsonResult({ success: true, subagent_id: args.subagent_id })
        },
        { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }
      ),
    ],
  })

  return _sdkConfig
}
