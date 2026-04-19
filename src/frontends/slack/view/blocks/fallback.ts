/**
 * Block Kit size-limit fallback.
 *
 * Slack's Block Kit has hard limits that, when exceeded, cause the
 * whole message to be rejected (`invalid_blocks` / `invalid_blocks_format`)
 * or silently truncated server-side — either way, the user sees a
 * broken post. The limits we guard against here:
 *
 *   - Max 50 blocks per message (`chat.postMessage` / `chat.update`).
 *   - Max 3000 chars on any section / mrkdwn `text` field.
 *   - Max ~40 KB serialized JSON payload (undocumented but observed in
 *     practice — Slack tightens periodically).
 *
 * If a candidate `{ text, blocks }` is over any of those limits, we drop
 * the blocks and fall back to a plain-text post. The fallback text is
 * derived by extracting the best candidate from the block payload
 * (header → first section → context) when the caller's `text` is empty
 * or a generic placeholder like the tool-name summary.
 *
 * Ported from OpenClaw's `extensions/slack/src/blocks-fallback.ts` (MIT).
 */

import type { KnownBlock } from "@slack/types"
import { truncateSlackMrkdwn } from "./truncate"

// ---------------------------------------------------------------------------
// Slack-imposed limits. Tightened slightly from the documented maxima
// to leave headroom for Bolt wrapping + thread_ts / blocks JSON overhead.
// ---------------------------------------------------------------------------

/** Max blocks per message. Slack's documented cap is 50. */
export const MAX_BLOCKS_PER_MESSAGE = 50

/** Max chars in any single section / mrkdwn / plain_text field. */
export const MAX_BLOCK_TEXT_CHARS = 3000

/**
 * Soft cap on total serialized payload size. Slack's hard cap is
 * around 40 KB; we fall back well under that so headers + signatures
 * don't push us over on the wire.
 */
export const MAX_SERIALIZED_BYTES = 30_000

// ---------------------------------------------------------------------------
// Fallback-text extraction.
// ---------------------------------------------------------------------------

type PlainTextObject = { text?: string }

type SlackBlockWithFields = {
  type?: string
  text?: PlainTextObject & { type?: string }
  title?: PlainTextObject
  alt_text?: string
  elements?: Array<{ text?: string; type?: string }>
}

function cleanCandidate(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length > 0 ? normalized : undefined
}

export function buildSlackBlocksFallbackText(blocks: KnownBlock[]): string {
  for (const raw of blocks) {
    const block = raw as SlackBlockWithFields
    switch (block.type) {
      case "header":
      case "section": {
        const t = cleanCandidate(block.text?.text)
        if (t) return t
        break
      }
      case "image": {
        const t =
          cleanCandidate(block.alt_text) ?? cleanCandidate(block.title?.text)
        return t ?? "Shared an image"
      }
      case "video": {
        const t =
          cleanCandidate(block.title?.text) ?? cleanCandidate(block.alt_text)
        return t ?? "Shared a video"
      }
      case "file":
        return "Shared a file"
      case "context": {
        if (Array.isArray(block.elements)) {
          const t = block.elements
            .map((e) => cleanCandidate(e.text))
            .filter((v): v is string => Boolean(v))
            .join(" ")
          if (t.length > 0) return t
        }
        break
      }
      default:
        break
    }
  }
  return "Shared a Block Kit message"
}

// ---------------------------------------------------------------------------
// Fallback decision.
// ---------------------------------------------------------------------------

export interface BlockKitPayload {
  text: string
  blocks?: KnownBlock[]
}

export interface BlockKitLimits {
  maxBlocks?: number
  maxBlockTextChars?: number
  maxSerializedBytes?: number
}

/**
 * If `input.blocks` fits within Slack's limits, return the payload
 * unchanged. Otherwise, return a text-only fallback — the original
 * `text` when non-empty, else a candidate extracted from the blocks.
 *
 * Mutually exclusive with the size-limit silent truncation Slack does
 * server-side: we'd rather emit a plain-text summary than have a block
 * payload rejected in flight.
 */
export function withBlockKitFallback(
  input: BlockKitPayload,
  limits: BlockKitLimits = {},
): BlockKitPayload {
  const blocks = input.blocks
  if (!blocks || blocks.length === 0) return input

  const maxBlocks = limits.maxBlocks ?? MAX_BLOCKS_PER_MESSAGE
  const maxBlockTextChars = limits.maxBlockTextChars ?? MAX_BLOCK_TEXT_CHARS
  const maxSerializedBytes =
    limits.maxSerializedBytes ?? MAX_SERIALIZED_BYTES

  if (blocks.length > maxBlocks) {
    return fallback(input, blocks)
  }

  if (overAnyTextField(blocks, maxBlockTextChars)) {
    return fallback(input, blocks)
  }

  if (serializedLen(blocks) > maxSerializedBytes) {
    return fallback(input, blocks)
  }

  return input
}

function overAnyTextField(
  blocks: KnownBlock[],
  maxBlockTextChars: number,
): boolean {
  for (const raw of blocks) {
    const block = raw as SlackBlockWithFields
    if (block.text?.text && block.text.text.length > maxBlockTextChars) {
      return true
    }
    if (Array.isArray(block.elements)) {
      for (const e of block.elements) {
        if (e.text && e.text.length > maxBlockTextChars) return true
      }
    }
  }
  return false
}

function serializedLen(blocks: KnownBlock[]): number {
  try {
    return JSON.stringify(blocks).length
  } catch {
    // A cyclic / unserialisable block should itself be a fallback
    // trigger, so return a large value to force the fallback path.
    return Number.POSITIVE_INFINITY
  }
}

function fallback(
  input: BlockKitPayload,
  blocks: KnownBlock[],
): BlockKitPayload {
  const text =
    input.text && input.text.trim().length > 0
      ? input.text
      : buildSlackBlocksFallbackText(blocks)
  return { text: truncateSlackMrkdwn(text, MAX_BLOCK_TEXT_CHARS) }
}
