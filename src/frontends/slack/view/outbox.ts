/**
 * Outbound stream — the Slack side of the streaming lifecycle.
 *
 * A single instance owns the visible message for one agent turn:
 *   - `start()` posts a draft via `chat.postMessage`.
 *   - `append(textChunk)` appends to the accumulator; every ≥minUpdateMs
 *     a throttled `chat.update` pushes the latest text.
 *   - `stop(finalText?)` issues one last `chat.update` with the canonical
 *     text and releases the instance.
 *
 * Phases:
 *   - Tier 2 (current): draft `chat.postMessage` → throttled `chat.update`.
 *   - Tier 3 fallback: when either the draft post or an update call throws,
 *     we switch to "buffer locally, post everything on stop()" mode with
 *     `markdownToSlackMrkdwnChunks` chunking. That survives rate limits,
 *     retention throttles, and the workspace opting out of `chat.update`
 *     (rare, but supported).
 *   - Tier 1 (`chat.startStream`) is plan §6's native path — minislack
 *     doesn't implement it yet, and real Slack only exposes it on paid
 *     workspaces with the Assistant API. Adding it is a drop-in for the
 *     `SendAdapter` interface below; deferred to a later phase.
 *
 * The outbox is pure of Bolt types — only `SendAdapter` methods are
 * called. Tests wire in a fake SendAdapter so they don't need a live
 * WebClient.
 */

import { markdownToSlackMrkdwnChunks } from "./format"
import { log } from "../../../utils/logger"

// ---------------------------------------------------------------------------
// SendAdapter — narrow surface the outbox talks to.
// ---------------------------------------------------------------------------

export interface SendAdapter {
  postMessage(args: { channel: string; text: string; threadTs?: string }): Promise<{ ts: string; channel: string }>
  updateMessage(args: { channel: string; ts: string; text: string }): Promise<void>
}

export interface OutboxOpts {
  adapter: SendAdapter
  channel: string
  threadTs: string
  /** Minimum ms between chat.update calls (default 250ms per plan §6). */
  minUpdateMs?: number
  /** Max chars per chat.update body (default 2900). */
  maxChunkLen?: number
  /** Test hook: override Date.now for deterministic throttling. */
  now?: () => number
}

export interface OutboundStream {
  /** Append more text to the current turn. Safe to call before/after start(). */
  append(chunk: string): void
  /**
   * Finalise the turn. `finalText`, when provided, replaces the accumulator
   * with the canonical text (the backend's `text_complete`). Always posts
   * at least one message, even if nothing was streamed.
   */
  stop(finalText?: string): Promise<void>
  /** Current accumulated text — useful for tests + diagnostics. */
  currentText(): string
  /**
   * True when the stream has fallen back to tier 3 (buffered) because
   * tier-2 updates failed.
   */
  fellBack(): boolean
}

export function createOutboundStream(opts: OutboxOpts): OutboundStream {
  const minUpdateMs = opts.minUpdateMs ?? 250
  const maxChunkLen = opts.maxChunkLen ?? 2900
  const now = opts.now ?? Date.now

  let accumulator = ""
  let draftTs: string | undefined
  let draftStarted = false
  let lastFlushAt = 0
  let pendingTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let fellBack = false
  let inflightUpdate: Promise<void> = Promise.resolve()
  const markFallback = (err: unknown) => {
    if (!fellBack) log.warn(`slack outbox: falling back to tier-3 — ${String(err)}`)
    fellBack = true
  }

  async function startDraftIfNeeded(): Promise<void> {
    if (draftStarted || stopped || fellBack) return
    draftStarted = true
    try {
      const res = await opts.adapter.postMessage({
        channel: opts.channel,
        threadTs: opts.threadTs,
        text: visibleHead(accumulator, maxChunkLen) || placeholderText(),
      })
      draftTs = res.ts
      lastFlushAt = now()
    } catch (err) {
      markFallback(err)
    }
  }

  async function flush(): Promise<void> {
    if (stopped) return
    if (fellBack) return
    if (!draftStarted) {
      await startDraftIfNeeded()
      return
    }
    if (!draftTs) return
    const body = visibleHead(accumulator, maxChunkLen)
    if (body.length === 0) return
    try {
      await opts.adapter.updateMessage({
        channel: opts.channel,
        ts: draftTs,
        text: body,
      })
      lastFlushAt = now()
    } catch (err) {
      markFallback(err)
    }
  }

  function scheduleFlush(): void {
    if (stopped || fellBack || pendingTimer) return
    const elapsed = now() - lastFlushAt
    const delay = Math.max(0, minUpdateMs - elapsed)
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined
      inflightUpdate = inflightUpdate.then(flush)
    }, delay)
  }

  return {
    append(chunk) {
      if (stopped) return
      if (chunk.length === 0) return
      accumulator += chunk
      if (!draftStarted && !fellBack) {
        inflightUpdate = inflightUpdate.then(startDraftIfNeeded)
      } else {
        scheduleFlush()
      }
    },

    async stop(finalText) {
      if (stopped) return
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = undefined
      if (finalText !== undefined) accumulator = finalText
      // Let any pending throttled update settle first.
      await inflightUpdate

      const postTier3 = async () => {
        const chunks = markdownToSlackMrkdwnChunks(accumulator, { maxLen: maxChunkLen })
        // If the accumulator is empty we still emit nothing — the caller
        // (event-renderer) guarantees this path is only taken when the turn
        // produced text or the caller deliberately wants an empty ack, so no
        // placeholder is needed here.
        for (const chunk of chunks) {
          try {
            await opts.adapter.postMessage({
              channel: opts.channel,
              threadTs: opts.threadTs,
              text: chunk,
            })
          } catch (err) {
            log.error(`slack outbox (tier-3): postMessage chunk failed: ${String(err)}`)
          }
        }
      }

      if (fellBack) {
        await postTier3()
        stopped = true
        return
      }

      // Tier-2: ensure a draft exists, then do one final update with the
      // authoritative text.
      if (!draftStarted) {
        await startDraftIfNeeded()
      }
      if (fellBack) {
        await postTier3()
        stopped = true
        return
      }
      if (draftTs) {
        const body = visibleHead(accumulator, maxChunkLen)
        try {
          await opts.adapter.updateMessage({
            channel: opts.channel,
            ts: draftTs,
            text: body,
          })
        } catch (err) {
          log.error(`slack outbox (tier-2 final update): ${String(err)}`)
        }
      }
      stopped = true
    },

    currentText() {
      return accumulator
    },

    fellBack() {
      return fellBack
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Placeholder text for an empty draft post so Slack doesn't reject it. */
function placeholderText(): string {
  return "…" // an ellipsis — visually matches "still working" and survives mrkdwn.
}

/**
 * Return the visible head of `text` that fits within `maxLen`. When the
 * accumulator exceeds the limit we show a trailing ellipsis so the reader
 * knows there's more arriving — the overflow is flushed at `stop()` as
 * additional messages via the tier-3 chunker. This matches Slack's 3000-
 * char cap on a single text block.
 */
function visibleHead(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 1)}…`
}
