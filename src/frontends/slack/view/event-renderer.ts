/**
 * Event renderer — AgentEvent → Slack side-effects.
 *
 * The renderer is bound to one (channel, parentTs, triggerTs) triple: the
 * channel + thread ts the bot's replies post to, plus the ts of the user
 * message that opened the turn (used for status reactions).
 *
 * Per turn it drives:
 *   - an OutboundStream (view/outbox.ts) — draft `chat.postMessage` →
 *     throttled `chat.update` tier-2 streaming, tier-3 chunked fallback
 *     on failure. Started on the first `text_delta` and stopped on
 *     `turn_complete`.
 *   - a StatusReactionController (view/reactions.ts) — emoji state
 *     machine on the trigger message.
 *   - error posts rendered inline with a terse `[error|warn] code: message`
 *     reply.
 *
 * Tool-specific cards, plan updates, and thinking breakouts are still S3+
 * — we only react to their events via the reaction state machine at S2.
 *
 * We feed events through the shared 16ms EventBatcher (same coalescer the
 * TUI uses) so bursts of deltas don't pummel Slack.
 */

import type { App } from "@slack/bolt"
import type { ConversationEvent } from "../../../protocol/types"
import { EventBatcher } from "../../../utils/event-batcher"
import { log } from "../../../utils/logger"
import type { ApprovalHook } from "../approvals/coordinator"
import type { ElicitationHook } from "../elicitations/coordinator"
import {
  createOutboundStream,
  type OutboundStream,
  type SendAdapter,
} from "./outbox"
import {
  createStatusReactionController,
  type ReactionAdapter,
  type StatusReactionController,
} from "./reactions"

export interface RendererBinding {
  /** Channel id to post replies in. */
  channel: string
  /** Thread anchor ts for replies. */
  threadTs: string
  /**
   * ts of the user message that triggered the session. The reaction state
   * machine lands on this ts. Undefined → reactions disabled.
   */
  triggerTs?: string
}

export interface EventRenderer {
  /** Subscriber to pass into registry.entry.subscribe. */
  onEvent(event: ConversationEvent): void
  /** Update the trigger ts (e.g. on a new turn from a different message). */
  setTriggerTs(ts: string): void
  /** Force-flush any pending events (e.g. on shutdown). */
  flush(): void
  /** Stop the renderer. Does NOT post any pending text. */
  destroy(): void
}

export interface CreateRendererOpts {
  app: App
  binding: RendererBinding
  /**
   * Test hook: replaces the live SendAdapter (chat.postMessage + chat.update)
   * so tests don't need a live WebClient.
   */
  sendAdapter?: SendAdapter
  /**
   * Test hook: replaces the live ReactionAdapter (reactions.add + reactions.remove).
   */
  reactionAdapter?: ReactionAdapter
  /**
   * Optional approval hook. When present, every `permission_request` event
   * is handed off to the hook; the launcher wires this to the approval
   * coordinator so cards land in Slack and clicks route back to the
   * backend's canUseTool resolver.
   */
  approvals?: ApprovalHook
  /**
   * Optional elicitation hook. Same shape as `approvals` — the launcher
   * wires it to the elicitation coordinator so `elicitation_request` events
   * surface as an inline "Answer questions" card + modal, and the click
   * path round-trips back through `backend.respondToElicitation` /
   * `backend.cancelElicitation`.
   */
  elicitations?: ElicitationHook
}

export function createEventRenderer(opts: CreateRendererOpts): EventRenderer {
  const { app, binding } = opts
  const sendAdapter: SendAdapter =
    opts.sendAdapter ?? buildDefaultSendAdapter(app)

  const reactionAdapter: ReactionAdapter =
    opts.reactionAdapter ?? {
      async addReaction(args) {
        const res = await app.client.reactions.add({
          channel: args.channel,
          timestamp: args.timestamp,
          name: args.name,
        })
        if (!res.ok) throw new Error(`reactions.add failed: ${res.error ?? "unknown"}`)
      },
      async removeReaction(args) {
        const res = await app.client.reactions.remove({
          channel: args.channel,
          timestamp: args.timestamp,
          name: args.name,
        })
        if (!res.ok) throw new Error(`reactions.remove failed: ${res.error ?? "unknown"}`)
      },
    }

  let triggerTs: string | undefined = binding.triggerTs
  let stream: OutboundStream | undefined
  let reactions: StatusReactionController | undefined
  let finalText: string | undefined
  let inTurn = false
  /** permission_request ids we've handed off to approvals but not yet heard
   *  a permission_response for. Used to auto-deny on interrupt/destroy. */
  const pendingApprovals = new Set<string>()
  /** elicitation_request ids outstanding. Auto-cancelled on interrupt/destroy. */
  const pendingElicitations = new Set<string>()

  function ensureStream(): OutboundStream {
    if (!stream) {
      stream = createOutboundStream({
        adapter: sendAdapter,
        channel: binding.channel,
        threadTs: binding.threadTs,
      })
    }
    return stream
  }

  function ensureReactions(): StatusReactionController | undefined {
    if (!triggerTs) return undefined
    if (!reactions) {
      reactions = createStatusReactionController({
        adapter: reactionAdapter,
        channel: binding.channel,
        triggerTs,
        initial: "working",
      })
    }
    return reactions
  }

  function cancelPendingApprovals(): void {
    if (!opts.approvals || pendingApprovals.size === 0) return
    const ids = Array.from(pendingApprovals)
    pendingApprovals.clear()
    for (const id of ids) {
      try {
        opts.approvals.onCancel(id)
      } catch (err) {
        log.error(`slack renderer: approval cancel threw for ${id}: ${String(err)}`)
      }
    }
  }

  function cancelPendingElicitations(): void {
    if (!opts.elicitations || pendingElicitations.size === 0) return
    const ids = Array.from(pendingElicitations)
    pendingElicitations.clear()
    for (const id of ids) {
      try {
        opts.elicitations.onCancel(id)
      } catch (err) {
        log.error(`slack renderer: elicitation cancel threw for ${id}: ${String(err)}`)
      }
    }
  }

  async function endTurn(terminal: "done" | "interrupted" | "error"): Promise<void> {
    inTurn = false
    if (terminal !== "done") {
      cancelPendingApprovals()
      cancelPendingElicitations()
    }
    const s = stream
    const r = reactions
    const final = finalText
    stream = undefined
    reactions = undefined
    finalText = undefined
    if (s) await s.stop(final)
    if (r) await r.terminate(terminal)
  }

  function applyEvents(events: ConversationEvent[]): void {
    for (const event of events) {
      // Feed every event into the reaction state machine.
      ensureReactions()?.apply(event)

      switch (event.type) {
        case "turn_start":
          inTurn = true
          finalText = undefined
          break
        case "text_delta":
          ensureStream().append(event.text)
          break
        case "text_complete":
          // Capture the canonical text for stop(finalText) to post.
          finalText = event.text
          // Touch the stream so the draft post happens for tool-only turns
          // that only speak at the very end.
          ensureStream().append("")
          break
        case "turn_complete":
          void endTurn("done").catch((err) =>
            log.error(`slack renderer: endTurn threw: ${String(err)}`),
          )
          break
        case "interrupt":
          void endTurn("interrupted").catch((err) =>
            log.error(`slack renderer: endTurn threw: ${String(err)}`),
          )
          break
        case "error":
          if (event.severity === "fatal") {
            void postErrorInline(event.code, event.message, "fatal").then(() => endTurn("error"))
          } else {
            void postErrorInline(event.code, event.message, event.severity ?? "recoverable")
          }
          break
        case "permission_request":
          if (opts.approvals) {
            pendingApprovals.add(event.id)
            try {
              opts.approvals.onRequest({
                request: event,
                channel: binding.channel,
                threadTs: binding.threadTs,
              })
            } catch (err) {
              log.error(`slack renderer: approval onRequest threw: ${String(err)}`)
            }
          } else {
            log.warn(
              `slack renderer: permission_request ${event.id} (${event.tool}) — no approval hook wired, backend will block`,
            )
          }
          break
        case "permission_response":
          pendingApprovals.delete(event.id)
          break
        case "elicitation_request":
          if (opts.elicitations) {
            pendingElicitations.add(event.id)
            try {
              opts.elicitations.onRequest({
                request: event,
                channel: binding.channel,
                threadTs: binding.threadTs,
              })
            } catch (err) {
              log.error(`slack renderer: elicitation onRequest threw: ${String(err)}`)
            }
          } else {
            log.warn(
              `slack renderer: elicitation_request ${event.id} — no hook wired, backend will block`,
            )
          }
          break
        case "elicitation_response":
          pendingElicitations.delete(event.id)
          break
        default:
          // Every other event is fed to reactions (above) but produces no
          // visible body. S3+ tool cards + plan updates hook here.
          log.debug(`slack renderer: consumed ${event.type} for reactions only`)
          break
      }
    }
  }

  async function postErrorInline(
    code: string,
    message: string,
    severity: string,
  ): Promise<void> {
    try {
      await sendAdapter.postMessage({
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
    setTriggerTs(ts) {
      triggerTs = ts
      if (reactions) {
        void reactions.terminate("done").catch(() => undefined)
        reactions = undefined
      }
    },
    flush() {
      batcher.flush()
    },
    destroy() {
      batcher.destroy()
      if (inTurn) {
        void endTurn("interrupted").catch(() => undefined)
      } else {
        cancelPendingApprovals()
        cancelPendingElicitations()
      }
    },
  }
}

/**
 * Build the production SendAdapter from a live Bolt App. Exported so the
 * banner / future Block Kit views can construct the same adapter without
 * duplicating the wiring.
 */
export function buildDefaultSendAdapter(app: App): SendAdapter {
  return {
    async postMessage(args) {
      const res = await app.client.chat.postMessage({
        channel: args.channel,
        text: args.text,
        ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
        ...(args.blocks ? { blocks: args.blocks as never } : {}),
      })
      if (!res.ok || !res.ts || !res.channel) {
        throw new Error(`chat.postMessage failed: ${res.error ?? "unknown"}`)
      }
      return { ts: String(res.ts), channel: String(res.channel) }
    },
    async updateMessage(args) {
      const res = await app.client.chat.update({
        channel: args.channel,
        ts: args.ts,
        text: args.text,
        ...(args.blocks ? { blocks: args.blocks as never } : {}),
      })
      if (!res.ok) {
        throw new Error(`chat.update failed: ${res.error ?? "unknown"}`)
      }
    },
  }
}
