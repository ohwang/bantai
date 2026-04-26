/**
 * Run Command — headless/non-interactive mode
 *
 * `bantai run <message..>` sends a single message to the default backend,
 * streams events to stdout in the requested `--output-format`, and exits on
 * `turn_complete`.
 *
 * Output formats (mirror `claude -p`):
 *   - `text`         — final assistant text only.
 *   - `stream-text`  — DEFAULT. Live text deltas, tool-interleaved segments
 *                      separated by `\n\n`.
 *   - `json`         — single JSON array of every event, dumped on completion.
 *   - `stream-json`  — NDJSON, one event per line, live.
 *
 * Designed for scripting and CI pipelines — no TUI, no interactive input.
 */

import type { CLIFlags, OutputFormat } from "../options"
import { DEFAULT_OUTPUT_FORMAT, isStructuredOutputFormat } from "../options"
import type { AgentBackend, ConversationEvent } from "../../protocol/types"
import { instantiateBackend } from "../../protocol/registry"
import { log } from "../../utils/logger"
import { backendTrace } from "../../utils/backend-trace"

// ---------------------------------------------------------------------------
// Formatter — per-format strategy. `onEvent` returns bytes to write live;
// `onComplete` returns trailing bytes to flush after the stream ends. Pure
// over the event stream so it's unit-testable without a real backend.
// ---------------------------------------------------------------------------

export interface RunFormatter {
  onEvent(event: ConversationEvent): string | null
  onComplete(): string | null
}

/**
 * Tracks whether a text-breaking event (e.g. a tool call) occurred between
 * runs of `text_delta` events, and emits a `\n\n` separator before the next
 * text segment so consecutive agent "paragraphs" don't run into each other.
 *
 * Used by the `stream-text` formatter; exported for unit-testability.
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

function createStreamTextFormatter(): RunFormatter {
  const sep = createTextSegmentSeparator()
  return {
    onEvent(event) {
      switch (event.type) {
        case "text_delta":
          return sep.prefixForText() + event.text
        case "tool_use_start":
          sep.markBreak()
          return null
        default:
          return null
      }
    },
    // Trailing newline so the prompt isn't pasted onto the agent's last word.
    onComplete: () => "\n",
  }
}

function createTextFormatter(): RunFormatter {
  // Final-only mode: buffer the most recent run of text_deltas, reset on tool
  // calls. The last buffer at turn_complete is the "final answer", which is
  // what claude -p emits as `result.result`.
  let lastSegment = ""
  return {
    onEvent(event) {
      switch (event.type) {
        case "text_delta":
          lastSegment += event.text
          return null
        case "tool_use_start":
          lastSegment = ""
          return null
        default:
          return null
      }
    },
    onComplete: () => lastSegment + "\n",
  }
}

function createJsonFormatter(): RunFormatter {
  const events: ConversationEvent[] = []
  return {
    onEvent(event) {
      events.push(event)
      return null
    },
    onComplete: () => JSON.stringify(events) + "\n",
  }
}

function createStreamJsonFormatter(): RunFormatter {
  return {
    onEvent: (event) => JSON.stringify(event) + "\n",
    onComplete: () => null,
  }
}

export function createRunFormatter(format: OutputFormat): RunFormatter {
  switch (format) {
    case "text":
      return createTextFormatter()
    case "stream-text":
      return createStreamTextFormatter()
    case "json":
      return createJsonFormatter()
    case "stream-json":
      return createStreamJsonFormatter()
  }
}

// ---------------------------------------------------------------------------
// runHeadless — drives the backend stream and pipes events through the chosen
// formatter to stdout.
// ---------------------------------------------------------------------------

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
  const outputFormat: OutputFormat = flags.outputFormat ?? DEFAULT_OUTPUT_FORMAT
  log.info("Starting bantai run (headless)", {
    backend: flags.backend,
    cwd: flags.config.cwd,
    outputFormat,
  })

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
    backend = instantiateBackend(flags.backend, {
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
  const formatter = createRunFormatter(outputFormat)
  const isStructuredFormat = isStructuredOutputFormat(outputFormat)

  const writeFromFormatter = (event: ConversationEvent) => {
    const out = formatter.onEvent(event)
    if (out !== null) process.stdout.write(out)
  }

  try {
    for await (const event of stream) {
      writeFromFormatter(event)

      switch (event.type) {
        case "turn_complete": {
          const tail = formatter.onComplete()
          if (tail !== null) process.stdout.write(tail)
          backend.close()
          process.exit(0)
          break
        }
        case "error": {
          // For text-oriented formats the error needs a human-visible
          // surface on stderr; structured formats already captured it as
          // an event in the stream.
          if (!isStructuredFormat) {
            console.error(`\nError: ${event.message}`)
          }
          backend.close()
          process.exit(1)
          break
        }
        case "permission_request": {
          if (flags.config.permissionMode === "bypassPermissions" || flags.config.permissionMode === "dontAsk") {
            backend.approveToolUse(event.id)
          } else {
            backend.denyToolUse(event.id, "Denied: running in non-interactive mode. Use --dangerously-skip-permissions to auto-approve.")
          }
          break
        }

        default:
          break
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!isStructuredFormat) {
      console.error(`\nError: ${msg}`)
    }
    backend.close()
    process.exit(1)
  }

  // Stream ended without turn_complete — flush trailing bytes and clean up.
  const tail = formatter.onComplete()
  if (tail !== null) process.stdout.write(tail)
  backend.close()
}
