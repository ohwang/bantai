/**
 * `buildCostFooter` — pure formatter for the `:moneybag:` turn-complete
 * cost footer rendered by the event renderer (and the `/bantai cost`
 * command fallback).
 *
 * At `normal` verbosity we emit a terse one-liner — one context block
 * with tokens + (approximate) cost. At `verbose` / `debug` we split out
 * input vs output and cache tokens when available. Returns null when
 * neither `usage` nor the cost-update fallback has anything meaningful
 * to say, so the renderer can skip the post entirely.
 */

import type { TokenUsage } from "../../../protocol/types"
import type { VerbosityLevel } from "../config/schema"

export function buildCostFooter(args: {
  verbosity: VerbosityLevel
  usage?: TokenUsage
  fallback?: { inputTokens: number; outputTokens: number; totalCostUsd: number }
}): {
  text: string
  blocks: Array<{
    type: string
    elements: Array<{ type: string; text: string }>
  }>
} | null {
  const usage = args.usage
  const fb = args.fallback
  const inputTokens = usage?.inputTokens ?? fb?.inputTokens ?? 0
  const outputTokens = usage?.outputTokens ?? fb?.outputTokens ?? 0
  const cacheReadTokens = usage?.cacheReadTokens ?? 0
  const cacheWriteTokens = usage?.cacheWriteTokens ?? 0
  const totalCostUsd = usage?.totalCostUsd ?? fb?.totalCostUsd ?? 0

  const total = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  if (total === 0 && totalCostUsd === 0) return null

  const compact = `${formatTokens(total)} tok · $${totalCostUsd.toFixed(4)}`
  if (args.verbosity === "normal") {
    return {
      text: `cost: ${compact}`,
      blocks: [
        { type: "context", elements: [{ type: "mrkdwn", text: `:moneybag: ${compact}` }] },
      ],
    }
  }

  const parts: string[] = []
  if (inputTokens > 0) parts.push(`in ${formatTokens(inputTokens)}`)
  if (outputTokens > 0) parts.push(`out ${formatTokens(outputTokens)}`)
  if (cacheReadTokens > 0) parts.push(`cache-r ${formatTokens(cacheReadTokens)}`)
  if (cacheWriteTokens > 0) parts.push(`cache-w ${formatTokens(cacheWriteTokens)}`)
  const breakdown = parts.length > 0 ? ` (${parts.join(", ")})` : ""
  const text = `:moneybag: ${compact}${breakdown}`
  return {
    text: `cost: ${compact}${breakdown}`,
    blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }],
  }
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}
