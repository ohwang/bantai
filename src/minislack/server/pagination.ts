/**
 * Opaque cursor helpers for Slack's pagination envelope.
 *
 * Real Slack cursors are opaque base64 blobs. We encode just the integer
 * offset because our in-memory list order is stable per process and this
 * keeps tests round-trip friendly. If state ordering changes between
 * requests (e.g. a channel is created mid-iteration), the cursor still
 * points at a sensible offset — duplicates and gaps are tolerated, mirroring
 * real Slack's behavior documented at docs.slack.dev/apis/web-api/pagination.
 */

import { MinislackError } from "../core/channels"

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 999

export interface PaginationArgs {
  limit?: number
  cursor?: string
}

export interface PageResult<T> {
  items: T[]
  next_cursor: string
}

export function paginate<T>(all: T[], args: PaginationArgs): PageResult<T> {
  const start = decodeCursor(args.cursor)
  const limit = normaliseLimit(args.limit)
  const end = start + limit
  const items = all.slice(start, end)
  const next_cursor = end < all.length ? encodeCursor(end) : ""
  return { items, next_cursor }
}

export function encodeCursor(offset: number): string {
  if (offset <= 0) return ""
  return Buffer.from(`o:${offset}`).toString("base64")
}

export function decodeCursor(cursor?: string): number {
  if (!cursor) return 0
  try {
    const raw = Buffer.from(cursor, "base64").toString("utf8")
    if (!raw.startsWith("o:")) throw new Error("malformed")
    const n = Number(raw.slice(2))
    if (!Number.isFinite(n) || n < 0) throw new Error("malformed")
    return Math.floor(n)
  } catch {
    throw new MinislackError("invalid_cursor", cursor)
  }
}

function normaliseLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new MinislackError("invalid_limit", String(limit))
  }
  return Math.min(Math.floor(limit), MAX_LIMIT)
}
