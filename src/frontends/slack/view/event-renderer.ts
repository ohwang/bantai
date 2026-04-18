/**
 * Event renderer — AgentEvent → Slack side-effects.
 *
 * Phase S1 scope: accumulate `text_delta`/`text_complete` into a buffer and
 * post one `chat.postMessage` per `turn_complete`. `error` events are
 * rendered as a terse "[error] …" reply. Tool calls, thinking, plan updates,
 * reactions, and streaming are all no-ops at S1 — they land in S2+.
 *
 * The renderer is bound to one (channel, parentTs) pair: the registry's
 * entry.routing. Subscribers live for as long as the session does; idle
 * eviction (via the registry) is what closes them.
 *
 * We feed events through the shared EventBatcher (the same 16ms coalescer
 * the TUI uses) so the renderer stays uniform with the rest of the stack.
 * Even though S1 doesn't stream, the batcher lets us process events in
 * dependency order per-tick and keeps the subscriber lightweight.
 */

import type { App } from "@slack/bolt"
import type { ConversationEvent } from "../../../protocol/types"
import { EventBatcher } from "../../../utils/event-batcher"
import { log } from "../../../utils/logger"
import { postMessage } from "../transport/events"

export interface RendererBinding {
  /** Channel id to post replies in. */
  channel: string
  /** Thread anchor ts for replies. */
  threadTs: string
}

export interface EventRenderer {
  /** Subscriber to pass into registry.entry.subscribe. */
  onEvent(event: ConversationEvent): void
  /** Force-flush any pending events (e.g. on shutdown). */
  flush(): void
  /** Stop the renderer. Does NOT post any pending text. */
  destroy(): void
}

export interface CreateRendererOpts {
  app: App
  binding: RendererBinding
  /**
   * Optional override for tests: replaces the real `postMessage` so tests
   * don't need a live WebClient. Must be async.
   */
  postMessage?: (args: {
    channel: string
    text: string
    threadTs?: string
  }) => Promise<{ ts: string; channel: string }>
}

export function createEventRenderer(opts: CreateRendererOpts): EventRenderer {
  const { app, binding } = opts
  const post =
    opts.postMessage ??
    (async (args) =>
      postMessage(app, {
        channel: args.channel,
        text: args.text,
        threadTs: args.threadTs,
      }))

  // Per-turn accumulators. Reset on `turn_start`.
  let assistantText = ""
  let turnHadError = false

  function applyEvents(events: ConversationEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "turn_start":
          assistantText = ""
          turnHadError = false
          break
        case "text_delta":
          assistantText += event.text
          break
        case "text_complete":
          // text_complete carries the full canonical text of the turn; prefer it
          // over accumulated deltas in case we missed one (defensive — deltas
          // may have been coalesced by the backend).
          assistantText = event.text
          break
        case "turn_complete":
          void flushTurn()
          break
        case "error":
          turnHadError = true
          void postError(event.code, event.message, event.severity ?? "recoverable")
          break
        default:
          // Every other event type is ignored at S1; S2+ handlers extend
          // this switch. Suppressions are intentional (per the event-mapper
          // rule in AGENTS.md: `log.debug` for expected-suppressed, `log.warn`
          // for unexpected).
          log.debug(`slack renderer: ignored ${event.type} at S1 verbosity`)
          break
      }
    }
  }

  async function flushTurn(): Promise<void> {
    const body = assistantText.trim()
    if (body.length === 0 && !turnHadError) {
      log.debug("slack renderer: empty turn, skipping post")
      return
    }
    if (body.length === 0) {
      // Error already posted inline; don't double-reply with a blank line.
      return
    }
    try {
      await post({
        channel: binding.channel,
        threadTs: binding.threadTs,
        text: body,
      })
    } catch (err) {
      log.error(`slack renderer: chat.postMessage failed: ${String(err)}`)
    } finally {
      assistantText = ""
      turnHadError = false
    }
  }

  async function postError(code: string, message: string, severity: string): Promise<void> {
    try {
      await post({
        channel: binding.channel,
        threadTs: binding.threadTs,
        text: `[${severity === "fatal" ? "error" : "warn"}] ${code}: ${message}`,
      })
    } catch (err) {
      log.error(`slack renderer: error-post failed: ${String(err)}`)
    }
  }

  const batcher = new EventBatcher(applyEvents, 16)

  return {
    onEvent(event) {
      batcher.push(event)
    },
    flush() {
      batcher.flush()
    },
    destroy() {
      batcher.destroy()
    },
  }
}
