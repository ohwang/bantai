/**
 * Pending-approval registry (plan §8.1 / S4).
 *
 * Tracks in-flight `permission_request` events that have been rendered as
 * Block Kit cards. Owns:
 *
 *   - the permission_request payload (so we can re-render the card on
 *     resolution with the original tool + input),
 *   - the Slack channel + message ts where the card was posted (so the
 *     block-actions handler knows where to chat.update),
 *   - the authorised-approver allow-list for the channel,
 *   - a TTL timer that auto-denies if nobody clicks in time.
 *
 * The critical invariant is "first-of-click wins": concurrent clicks on the
 * same card (two humans racing, the bot itself auto-denying because another
 * approval just fired) must produce exactly one decision on the backend.
 * We enforce this with an atomic `take()` that removes the record before
 * returning it; any caller who observes `undefined` must no-op.
 *
 * The registry has no IO — `resolve()` returns the decision the caller
 * should act on; wiring into the backend + chat.update happens in the
 * launcher (`handleApprovalClick`).
 */

import type { PermissionRequestEvent } from "../../../protocol/types"
import { log } from "../../../utils/logger"
import type { ApprovalDecision } from "./blocks/approval"

/** Default approval TTL: 15 minutes. Matches plan §4 "awaiting approval". */
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000

export interface PendingApprovalInput {
  /** The raw permission_request event (id, tool, input, displayName, ...). */
  request: PermissionRequestEvent
  /** Channel the approval card was posted in. */
  channel: string
  /** Thread ts of the card's containing thread (for the resolved re-post). */
  threadTs: string
  /** ts of the Block Kit approval message itself (for chat.update). */
  messageTs: string
  /** Session key so the launcher knows which SessionHost to call. */
  sessionKey: string
  /** Approver allow-list. Empty → any channel member may approve. */
  approvers: string[]
  /** Override the default TTL. */
  ttlMs?: number
}

export interface PendingApprovalRecord {
  request: PermissionRequestEvent
  channel: string
  threadTs: string
  messageTs: string
  sessionKey: string
  approvers: string[]
  createdAt: number
  ttlMs: number
}

export type ApprovalResolution =
  | { ok: true; record: PendingApprovalRecord; decision: ApprovalDecision; resolverUserId: string }
  | { ok: false; code: "unknown" | "unauthorized" | "timeout"; record?: PendingApprovalRecord }

export interface ApprovalRegistry {
  /** Track a newly-posted approval card. Starts the TTL timer. */
  track(input: PendingApprovalInput): void
  /** Peek at a pending record without taking it. */
  peek(id: string): PendingApprovalRecord | undefined
  /**
   * Atomically resolve a pending approval. Returns `{ ok: true, ... }` when
   * the caller owns the decision (first-of-click wins), `{ ok: false }` when
   * the id is unknown (already resolved or never existed) or the user isn't
   * on the approver allow-list.
   */
  resolve(args: {
    id: string
    decision: ApprovalDecision
    userId: string
  }): ApprovalResolution
  /** Current number of pending approvals. */
  size(): number
  /** Close every pending approval (auto-deny on shutdown). */
  closeAll(): PendingApprovalRecord[]
}

export interface CreateApprovalRegistryOpts {
  /**
   * Called when a record hits its TTL without a decision. The launcher uses
   * this to re-render the card as "auto-denied" and deny the backend
   * permission_request. No-op default — pure record GC.
   */
  onTimeout?: (record: PendingApprovalRecord) => void
  /** Inject a fake clock for tests. Defaults to Date.now. */
  now?: () => number
  /**
   * Inject a fake setTimeout for tests. Defaults to setTimeout. Must honour
   * `unref`-compatible semantics (we don't hold refs to timers).
   */
  setTimer?: (fn: () => void, ms: number) => Timer
  /** Inject a matching clearTimeout. */
  clearTimer?: (t: Timer) => void
}

type Timer = ReturnType<typeof setTimeout>

export function createApprovalRegistry(
  opts: CreateApprovalRegistryOpts = {},
): ApprovalRegistry {
  const now = opts.now ?? (() => Date.now())
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t))
  const pending = new Map<string, { record: PendingApprovalRecord; timer: Timer }>()

  function deleteEntry(id: string): { record: PendingApprovalRecord; timer: Timer } | undefined {
    const entry = pending.get(id)
    if (!entry) return undefined
    pending.delete(id)
    clearTimer(entry.timer)
    return entry
  }

  return {
    track(input) {
      const id = input.request.id
      if (pending.has(id)) {
        log.warn(`slack approvals: duplicate track for ${id} — replacing prior record`)
        deleteEntry(id)
      }
      const ttlMs = input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS
      const record: PendingApprovalRecord = {
        request: input.request,
        channel: input.channel,
        threadTs: input.threadTs,
        messageTs: input.messageTs,
        sessionKey: input.sessionKey,
        approvers: input.approvers,
        createdAt: now(),
        ttlMs,
      }
      const timer = setTimer(() => {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        try {
          opts.onTimeout?.(entry.record)
        } catch (err) {
          log.error(`slack approvals: onTimeout threw for ${id}: ${String(err)}`)
        }
      }, ttlMs)
      pending.set(id, { record, timer })
    },

    peek(id) {
      return pending.get(id)?.record
    },

    resolve({ id, decision, userId }) {
      const entry = pending.get(id)
      if (!entry) return { ok: false, code: "unknown" }
      const { record } = entry
      if (record.approvers.length > 0 && !record.approvers.includes(userId)) {
        return { ok: false, code: "unauthorized", record }
      }
      deleteEntry(id)
      return { ok: true, record, decision, resolverUserId: userId }
    },

    size() {
      return pending.size
    },

    closeAll() {
      const out: PendingApprovalRecord[] = []
      for (const [, entry] of pending) {
        clearTimer(entry.timer)
        out.push(entry.record)
      }
      pending.clear()
      return out
    },
  }
}
