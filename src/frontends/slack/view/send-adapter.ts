/**
 * `buildDefaultSendAdapter` — the production SendAdapter used by the
 * event renderer, banner, approvals coordinator, and control-command
 * replies. Extracted from event-renderer.ts so every surface that posts
 * to Slack shares one wiring site.
 *
 * The SendAdapter interface itself lives in `./outbox.ts` alongside the
 * streaming state machine that defined it — this file is just the
 * Bolt-backed implementation.
 */

import type { App } from "@slack/bolt"
import type { KnownBlock } from "@slack/types"
import type { SendAdapter } from "./outbox"
import { withBlockKitFallback } from "./blocks/fallback"
import { log } from "../../../utils/logger"

export interface SendAdapterHooks {
  /**
   * Called after every successful `chat.postMessage`. Receives the
   * channel + thread_ts the message landed in. Use this to record bot
   * thread participation so later inbound messages in the same thread
   * can skip the mention gate.
   *
   * Not invoked for `chat.update` — updates always modify a message we
   * previously posted, so the cache entry already exists from the
   * original post.
   */
  onPostSucceeded?(args: {
    channel: string
    ts: string
    threadTs?: string
  }): void
}

export function buildDefaultSendAdapter(
  app: App,
  hooks: SendAdapterHooks = {},
): SendAdapter {
  return {
    async postMessage(args) {
      const safe = applyBlockKitFallback({
        text: args.text,
        ...(args.blocks ? { blocks: args.blocks as KnownBlock[] } : {}),
      })
      const res = await app.client.chat.postMessage({
        channel: args.channel,
        text: safe.text,
        ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
        ...(safe.blocks ? { blocks: safe.blocks as never } : {}),
      })
      if (!res.ok || !res.ts || !res.channel) {
        throw new Error(`chat.postMessage failed: ${res.error ?? "unknown"}`)
      }
      const channel = String(res.channel)
      const ts = String(res.ts)
      hooks.onPostSucceeded?.({ channel, ts, threadTs: args.threadTs })
      return { ts, channel }
    },
    async updateMessage(args) {
      const safe = applyBlockKitFallback({
        text: args.text,
        ...(args.blocks ? { blocks: args.blocks as KnownBlock[] } : {}),
      })
      const res = await app.client.chat.update({
        channel: args.channel,
        ts: args.ts,
        text: safe.text,
        ...(safe.blocks ? { blocks: safe.blocks as never } : {}),
      })
      if (!res.ok) {
        throw new Error(`chat.update failed: ${res.error ?? "unknown"}`)
      }
    },
  }
}

/**
 * Run the payload through withBlockKitFallback. When the fallback
 * actually kicks in (blocks dropped), log a single warn so operators
 * can find the culprit in the session log — a silent demotion to
 * plain-text can be confusing when designing a card.
 */
function applyBlockKitFallback(input: {
  text: string
  blocks?: KnownBlock[]
}): { text: string; blocks?: KnownBlock[] } {
  const out = withBlockKitFallback(input)
  if (input.blocks && input.blocks.length > 0 && !out.blocks) {
    log.warn(
      `slack send-adapter: block kit payload exceeded limits (${input.blocks.length} blocks) — falling back to plain text`,
    )
  }
  return out
}
