/**
 * Run Command — headless/non-interactive mode
 *
 * `bantai run <message..>` sends a single message to the default backend,
 * streams text_delta events to stdout, and exits on turn_complete.
 *
 * Designed for scripting and CI pipelines — no TUI, no interactive input.
 */

import type { CLIFlags } from "../options"
import type { AgentBackend, ConversationEvent } from "../../protocol/types"
import { createBackend } from "../../subagents/backend-factory"
import { log } from "../../utils/logger"
import { backendTrace } from "../../utils/backend-trace"

/**
 * Tracks whether a text-breaking event (e.g. a tool call) occurred between two
 * runs of `text_delta` events, and emits a `\n\n` separator before the next
 * text segment so consecutive agent "paragraphs" don't run into each other in
 * the headless transcript.
 *
 * Exported for unit-testability; `runHeadless` consumes it directly.
 */
export function createTextSegmentSeparator() {
  let hasWrittenText = false
  let pendingBreak = false
  return {
    /** Prefix to write immediately before a `text_delta`'s payload. */
    prefixForText(): string {
      const prefix = pendingBreak ? "\n\n" : ""
      pendingBreak = false
      hasWrittenText = true
      return prefix
    },
    /** Mark that a tool call (or other text-breaking event) occurred. The next
     *  `text_delta` will be preceded by `\n\n`, but only if some text has
     *  already been emitted (so we don't write a leading separator). */
    markBreak(): void {
      if (hasWrittenText) pendingBreak = true
    },
  }
}

/**
 * Format a single agent event for the headless transcript. Pure function over
 * the separator state so it can be unit-tested without a real backend.
 *
 * Returns `null` when the event produces no transcript output (everything that
 * isn't a `text_delta` today).
 */
export function formatHeadlessEvent(
  event: ConversationEvent,
  sep: ReturnType<typeof createTextSegmentSeparator>,
): string | null {
  switch (event.type) {
    case "text_delta":
      return sep.prefixForText() + event.text
    case "tool_use_start":
      sep.markBreak()
      return null
    default:
      return null
  }
}

/**
 * Run a single message through the backend and stream output to stdout.
 */
export async function runHeadless(flags: CLIFlags, message: string): Promise<void> {
  const launchCwd = process.cwd()

  if (!flags.config.cwd) {
    flags.config.cwd = launchCwd
  }

  // Configure logging
  if (flags.debug) {
    log.setLevel("debug")
  }
  backendTrace.setEnabled(flags.debugBackend)
  log.info("Starting bantai run (headless)", { backend: flags.backend, cwd: flags.config.cwd })

  // Fill in persisted defaults
  const { loadConfig } = await import("../../config/settings")
  const resolved = await loadConfig({ cwd: flags.config.cwd })
  if (flags.config.model === undefined && resolved.values.model) {
    const modelSource = resolved.sources.model
    const isClaudeBackend = !flags.backend || flags.backend === "claude"
    if (modelSource !== "claude-fallback" || isClaudeBackend) {
      flags.config.model = resolved.values.model
    }
  }
  if (flags.config.permissionMode === undefined && resolved.values.permissionMode) {
    flags.config.permissionMode = resolved.values.permissionMode
  }

  // Create backend
  let backend: AgentBackend
  try {
    backend = createBackend({
      backend: flags.backend,
      acpCommand: flags.acpCommand,
      acpArgs: flags.acpArgs,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error: ${msg}`)
    process.exit(1)
  }

  log.info("Backend created", { backend: flags.backend })

  // Set initial prompt so the backend starts a turn immediately
  flags.config.initialPrompt = message

  // Start the session and stream events
  const stream = backend.start(flags.config)
  const separator = createTextSegmentSeparator()

  try {
    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
        case "tool_use_start": {
          const out = formatHeadlessEvent(event, separator)
          if (out !== null) process.stdout.write(out)
          break
        }

        case "turn_complete":
          // End of the assistant's response — newline and exit
          process.stdout.write("\n")
          backend.close()
          process.exit(0)
          break

        case "error":
          console.error(`\nError: ${event.message}`)
          backend.close()
          process.exit(1)
          break

        case "permission_request":
          // In headless mode, auto-approve if dangerously-skip-permissions,
          // otherwise deny with explanation
          if (flags.config.permissionMode === "bypassPermissions" || flags.config.permissionMode === "dontAsk") {
            backend.approveToolUse(event.id)
          } else {
            backend.denyToolUse(event.id, "Denied: running in non-interactive mode. Use --dangerously-skip-permissions to auto-approve.")
          }
          break

        default:
          // Silently consume other events (tool_use_end, thinking_delta, …).
          break
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`\nError: ${msg}`)
    backend.close()
    process.exit(1)
  }

  // Stream ended without turn_complete — clean exit
  backend.close()
}
