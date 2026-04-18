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
