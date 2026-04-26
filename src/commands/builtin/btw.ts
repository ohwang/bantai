/**
 * /btw — Side chat overlay (Claude Code `/btw`-equivalent).
 *
 * Opens a transient overlay that asks a tool-less question against a fork of
 * the live session. The answer streams into the overlay only — it never enters
 * `ConversationState` and never persists to the session JSONL.
 *
 * Routing is intentionally NOT through `backend.sendMessage()` — that would
 * push the question into the main turn queue, which is the exact failure mode
 * `/btw` is designed to avoid. Instead the command hands the question to the
 * frontend bridge's `openSideChat()` hook, which mounts the overlay component
 * and drives `backend.sideQuery()` itself.
 *
 * MVP scope: Claude only. Other backends surface a clean error from
 * `sideQuery` (or its absence). Single transient overlay — no tabs.
 */

import type { SlashCommand } from "../registry"

const HELP_TEXT = "/btw <question> — ask a quick side question without polluting the main conversation. Forked, tool-less, ephemeral."

export const btwCommand: SlashCommand = {
  name: "btw",
  description: "Ask a quick side question (forked, tool-less, ephemeral)",
  argumentHint: "<question>",
  execute: (args, ctx) => {
    const question = args.trim()
    if (!question) {
      ctx.pushEvent({
        type: "system_message",
        text: HELP_TEXT,
        ephemeral: true,
      })
      return
    }

    // Backend support gate — sideQuery is optional on AgentBackend.
    if (typeof ctx.backend.sideQuery !== "function") {
      ctx.pushEvent({
        type: "system_message",
        text: "Side chat requires session forking, which this backend does not support yet. Currently supported: claude.",
        ephemeral: true,
      })
      return
    }

    // Frontend support gate — needs an overlay to render into.
    const opened = ctx.frontend?.openSideChat?.(ctx.backend, question) ?? false
    if (!opened) {
      ctx.pushEvent({
        type: "system_message",
        text: "Side chat is not available in this frontend.",
        ephemeral: true,
      })
    }
  },
}
