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

import type { KnownBlock } from "@slack/types"
import { markdownToSlackMrkdwn, markdownToSlackMrkdwnChunks } from "./format"
import { log } from "../../../utils/logger"

// ---------------------------------------------------------------------------
// SendAdapter — narrow surface the outbox talks to.
// ---------------------------------------------------------------------------

export interface SendAdapter {
  postMessage(args: {
    channel: string
    text: string
    threadTs?: string
    blocks?: unknown[]
    /**
     * Optional per-post identity override. Requires `chat:write.customize`
     * scope on the bot token; when the scope is missing, the adapter
     * retries once without the identity fields so the post still lands
     * with the default workspace identity.
     */
    identity?: OutboundIdentity
  }): Promise<{ ts: string; channel: string }>
  updateMessage(args: {
    channel: string
    ts: string
    text: string
    blocks?: unknown[]
  }): Promise<void>
}

export interface OutboundIdentity {
  username?: string
  iconUrl?: string
  iconEmoji?: string
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
  /**
   * Optional tier-1 native Slack streaming. When provided, the first
   * `append()` tries `native.start()`; subsequent appends go through
   * `native.append()` and `stop()` finalises with `native.stop()`.
   *
   * If `start()` throws (workspace doesn't have the AI-apps capability,
   * thread_ts rejected, transport error), the outbox marks this stream
   * "native-unavailable" for its lifetime and falls back to tier-2.
   */
  nativeStream?: NativeStreamCapability
  /**
   * Optional per-agent identity applied to every `chat.postMessage` the
   * outbox makes (draft, tier-3 chunked, block-kit follow-up). Requires
   * `chat:write.customize` on the bot token; when the scope is missing
   * the send-adapter silently retries without identity fields.
   */
  identity?: OutboundIdentity
}

export interface NativeStreamCapability {
  /**
   * Begin a native stream on the bound (channel, threadTs). Called on
   * the first append. Must throw on failure so the outbox can fall
   * back; no silent returns.
   */
  start(args: {
    channel: string
    threadTs: string
    initialText?: string
  }): Promise<NativeStreamHandle>
}

export interface NativeStreamHandle {
  append(text: string): Promise<void>
  stop(finalText?: string): Promise<void>
}

export interface OutboundStream {
  /** Append more text to the current turn. Safe to call before/after start(). */
  append(chunk: string): void
  /**
   * Finalise the turn. `finalText`, when provided, replaces the accumulator
   * with the canonical text (the backend's `text_complete`). `finalBlocks`,
   * when provided, are attached to the final `chat.update` (or the tier-3
   * fresh post) — use this to land interactive-reply buttons alongside
   * the canonical reply text. Always posts at least one message, even if
   * nothing was streamed.
   */
  stop(finalText?: string, finalBlocks?: KnownBlock[]): Promise<void>
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
  let accumulatorSentToNative = 0
  let draftTs: string | undefined
  let draftStarted = false
  let lastFlushAt = 0
  let pendingTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let fellBack = false
  let inflightUpdate: Promise<void> = Promise.resolve()
  // Tier-1 native stream state. `nativeAttempted` guards against
  // repeated start() calls after a fallback; `nativeSession` is the
  // live handle when start() succeeded. When nativeSession is set we
  // skip the draft-post/chat.update path entirely.
  let nativeAttempted = false
  let nativeSession: NativeStreamHandle | undefined
  const markFallback = (err: unknown) => {
    if (!fellBack) log.warn(`slack outbox: falling back to tier-3 — ${String(err)}`)
    fellBack = true
  }

  async function startNativeIfNeeded(): Promise<boolean> {
    if (!opts.nativeStream) return false
    if (nativeAttempted) return nativeSession !== undefined
    nativeAttempted = true
    try {
      nativeSession = await opts.nativeStream.start({
        channel: opts.channel,
        threadTs: opts.threadTs,
        initialText: accumulator || undefined,
      })
      if (accumulator.length > 0) {
        accumulatorSentToNative = accumulator.length
      }
      return true
    } catch (err) {
      log.warn(
        `slack outbox: native-stream start failed, falling back to tier-2: ${String(err)}`,
      )
      nativeSession = undefined
      return false
    }
  }

  async function appendNative(): Promise<void> {
    if (!nativeSession) return
    const pending = accumulator.slice(accumulatorSentToNative)
    if (pending.length === 0) return
    try {
      await nativeSession.append(pending)
      accumulatorSentToNative = accumulator.length
    } catch (err) {
      log.warn(
        `slack outbox: native-stream append failed, dropping session: ${String(err)}`,
      )
      nativeSession = undefined
    }
  }

  async function startDraftIfNeeded(): Promise<void> {
    if (draftStarted || stopped || fellBack) return
    draftStarted = true
    try {
      const res = await opts.adapter.postMessage({
        channel: opts.channel,
        threadTs: opts.threadTs,
        text: markdownToSlackMrkdwn(visibleHead(accumulator, maxChunkLen)) || placeholderText(),
        ...(opts.identity ? { identity: opts.identity } : {}),
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
    const body = markdownToSlackMrkdwn(visibleHead(accumulator, maxChunkLen))
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
      // Tier-1 native streaming wins when configured: first append kicks
      // off the stream; subsequent ones forward the delta. If native
      // start fails we fall through to tier-2.
      if (opts.nativeStream && !nativeAttempted) {
        inflightUpdate = inflightUpdate.then(async () => {
          const ok = await startNativeIfNeeded()
          if (!ok) await startDraftIfNeeded()
        })
        return
      }
      if (nativeSession) {
        inflightUpdate = inflightUpdate.then(appendNative)
        return
      }
      if (!draftStarted && !fellBack) {
        inflightUpdate = inflightUpdate.then(startDraftIfNeeded)
      } else {
        scheduleFlush()
      }
    },

    async stop(finalText, finalBlocks) {
      if (stopped) return
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = undefined
      if (finalText !== undefined) accumulator = finalText
      // Let any pending throttled update settle first.
      await inflightUpdate

      // Tier-1 native finaliser: if the stream is alive, call stop()
      // with the final accumulator text. On success we're done — no
      // tier-2 post needed. On failure we fall through so at least
      // tier-3 chunks make it out.
      if (nativeSession) {
        const deltaSinceLast = accumulator.slice(accumulatorSentToNative)
        try {
          await nativeSession.stop(
            deltaSinceLast.length > 0 ? deltaSinceLast : undefined,
          )
          // Native stream doesn't support Block Kit finale — if the
          // caller handed blocks, post them as a separate follow-up so
          // interactive-reply actions still land beneath the stream.
          if (finalBlocks && finalBlocks.length > 0) {
            try {
              await opts.adapter.postMessage({
                channel: opts.channel,
                threadTs: opts.threadTs,
                text: accumulator || placeholderText(),
                blocks: finalBlocks,
                ...(opts.identity ? { identity: opts.identity } : {}),
              })
            } catch (err) {
              log.error(
                `slack outbox: native-stream block-kit followup failed: ${String(err)}`,
              )
            }
          }
          stopped = true
          return
        } catch (err) {
          log.warn(
            `slack outbox: native-stream stop failed, falling through: ${String(err)}`,
          )
          nativeSession = undefined
        }
      }

      const postTier3 = async () => {
        const chunks = markdownToSlackMrkdwnChunks(accumulator, { maxLen: maxChunkLen })
        // If the accumulator is empty we still emit nothing — the caller
        // (event-renderer) guarantees this path is only taken when the turn
        // produced text or the caller deliberately wants an empty ack, so no
        // placeholder is needed here.
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!
          // Blocks only ride on the LAST chunk — interactive actions
          // should sit under the final body, not be duplicated across
          // an arbitrary number of fragments.
          const attachBlocks = finalBlocks && i === chunks.length - 1
          try {
            await opts.adapter.postMessage({
              channel: opts.channel,
              threadTs: opts.threadTs,
              text: chunk,
              ...(attachBlocks ? { blocks: finalBlocks } : {}),
              ...(opts.identity ? { identity: opts.identity } : {}),
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
        const chunks = markdownToSlackMrkdwnChunks(accumulator, { maxLen: maxChunkLen })
        const firstChunk = chunks.length > 0 ? chunks[0]! : placeholderText()
        const overflowChunks = chunks.slice(1)
        try {
          await opts.adapter.updateMessage({
            channel: opts.channel,
            ts: draftTs,
            text: firstChunk,
            ...(overflowChunks.length === 0 && finalBlocks ? { blocks: finalBlocks } : {}),
          })
        } catch (err) {
          log.error(`slack outbox (tier-2 final update): ${String(err)}`)
        }
        // Flush any overflow chunks as additional thread messages — matches
        // the behaviour documented in visibleHead's JSDoc (overflow promised
        // at stop() time, not silently truncated with a trailing ellipsis).
        for (let i = 0; i < overflowChunks.length; i++) {
          const isLast = i === overflowChunks.length - 1
          try {
            await opts.adapter.postMessage({
              channel: opts.channel,
              threadTs: opts.threadTs,
              text: overflowChunks[i]!,
              ...(isLast && finalBlocks != null ? { blocks: finalBlocks } : {}),
              ...(opts.identity ? { identity: opts.identity } : {}),
            })
          } catch (err) {
            log.error(`slack outbox (tier-2 overflow): postMessage chunk failed: ${String(err)}`)
          }
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
