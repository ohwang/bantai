/**
 * Backend Factory — creates AgentBackend instances for any supported backend.
 *
 * Used by both the primary backend (index.ts) and SubagentManager.
 * Consolidates the backend construction switch into a single reusable function.
 */

import { ClaudeAdapter } from "../backends/claude/adapter"
import { CodexAdapter } from "../backends/codex/adapter"
import { AcpAdapter } from "../backends/acp/adapter"
import { ACP_PRESETS } from "../backends/acp/types"
import { MockAdapter } from "../backends/mock/adapter"
import type { AgentBackend } from "../protocol/types"
import type { BackendFactoryOptions } from "./types"

/**
 * Create an AgentBackend instance for the given backend type.
 * Throws on unknown backend or missing required options (e.g., acpCommand for "acp").
 */
export function createBackend(opts: BackendFactoryOptions): AgentBackend {
  switch (opts.backend) {
    case "claude":
    case "claude-v1":
      return new ClaudeAdapter()
    case "codex":
      return new CodexAdapter()
    case "gemini":
    case "copilot":
    case "qwen": {
      const preset = ACP_PRESETS[opts.backend]!
      return new AcpAdapter({ ...preset, presetName: opts.backend })
    }
    case "acp": {
      if (!opts.acpCommand) {
        throw new Error("Backend 'acp' requires acpCommand option")
      }
      return new AcpAdapter({
        command: opts.acpCommand,
        args: opts.acpArgs ?? [],
        displayName: `ACP (${opts.acpCommand})`,
        presetName: "acp",
      })
    }
    case "mock":
      return new MockAdapter()
    default:
      throw new Error(`Unknown backend: ${opts.backend}`)
  }
}
