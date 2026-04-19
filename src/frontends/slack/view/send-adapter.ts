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
import type { SendAdapter } from "./outbox"

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
      const res = await app.client.chat.postMessage({
        channel: args.channel,
        text: args.text,
        ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
        ...(args.blocks ? { blocks: args.blocks as never } : {}),
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
