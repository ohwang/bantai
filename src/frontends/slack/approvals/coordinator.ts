/**
 * Approval coordinator — glue between the per-session EventRenderer, the
 * cross-session ApprovalRegistry, and Bolt's block_actions handler.
 *
 *   permission_request
 *      └─ renderer  → hook.onRequest
 *                        └─ post Block Kit card   (chat.postMessage)
 *                        └─ registry.track(...)
 *
 *   user clicks button
 *      └─ block_action                            (bolt app.action)
 *         └─ coordinator.handleBlockAction(evt)
 *              └─ parseApprovalActionId
 *              └─ registry.resolve   (atomic first-of-click wins)
 *              └─ chat.update(card → resolved variant)
 *              └─ session.backend.approveToolUse / denyToolUse
 *
 *   TTL fires (registry onTimeout)
 *      └─ chat.update(card → "timed out, auto-denied")
 *      └─ session.backend.denyToolUse(id, "timed out")
 *
 *   interrupt / renderer.destroy
 *      └─ hook.onCancel(id) for every tracked id
 *         └─ treat like a timeout: post "interrupted" variant + deny
 *
 * The coordinator is frontend-agnostic IO: it only talks to `SendAdapter`
 * (for post / update) and a `lookupSession(sessionKey)` callback the
 * launcher supplies to hand it an AgentBackend for the session in
 * question.
 */

import type { PermissionRequestEvent } from "../../../protocol/types"
import { log } from "../../../utils/logger"
import type { SendAdapter } from "../view/outbox"
import {
  buildApprovalBlocks,
  buildResolvedApprovalBlocks,
  parseApprovalActionId,
  type ApprovalDecision,
} from "../view/blocks/approval"
import {
  createApprovalRegistry,
  DEFAULT_APPROVAL_TTL_MS,
  type ApprovalRegistry,
  type PendingApprovalRecord,
} from "../view/approvals"

export interface ApprovalHook {
  /**
   * Called by the renderer on every `permission_request`. The hook posts
   * the Block Kit card and registers the pending approval. Safe to call
   * concurrently (each call posts independently).
   */
  onRequest(args: {
    request: PermissionRequestEvent
    channel: string
    threadTs: string
  }): void
  /**
   * Called by the renderer on interrupt / destroy for every outstanding
   * permission_request that hasn't yet been resolved. No-ops if unknown
   * (registry may have already resolved it via user click).
   */
  onCancel(id: string): void
}

export interface SessionApprovalBinding {
  sessionKey: string
  approvers: string[]
  /** Override the TTL for approvals this hook creates. */
  ttlMs?: number
}

/** Backend-facing callbacks the coordinator calls once a decision lands. */
export interface ApprovalBackendCallbacks {
  approve(id: string, opts?: { alwaysAllow?: boolean }): void
  deny(id: string, reason?: string): void
}

export interface BlockActionInput {
  actionId: string
  userId: string
  /**
   * For the case where we want to post an ephemeral "not authorised"
   * message back — optional (launcher may choose to swallow). The block-
   * action body carries `response_url`, but we don't rely on it here;
   * ephemeral is best-effort.
   */
  channel?: string
}

export interface BlockActionResult {
  kind: "resolved" | "unauthorized" | "unknown" | "malformed"
  permissionId?: string
}

export interface ApprovalCoordinator {
  /** Build a per-session hook for the EventRenderer. */
  bindSession(binding: SessionApprovalBinding): ApprovalHook
  /** Handle a Slack block_action payload (approval button click). */
  handleBlockAction(input: BlockActionInput): Promise<BlockActionResult>
  /** Debug / shutdown helper. */
  registry: ApprovalRegistry
  /** Auto-deny every outstanding approval. Used on launcher shutdown. */
  closeAll(): void
}

export interface CreateCoordinatorOpts {
  adapter: SendAdapter
  /**
   * Return the session's approve/deny hooks by sessionKey. The coordinator
   * uses this at decision-time to route `backend.approveToolUse` /
   * `denyToolUse`. When the session has already been garbage-collected
   * (idle eviction) we log + skip the backend call — the card still
   * updates visually so the approver sees the outcome.
   */
  lookupSession(sessionKey: string): ApprovalBackendCallbacks | undefined
  /** Default TTL if a SessionApprovalBinding doesn't override. */
  defaultTtlMs?: number
  /** Test hook — inject clock/timer overrides into the internal registry. */
  clock?: {
    now?: () => number
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
    clearTimer?: (t: ReturnType<typeof setTimeout>) => void
  }
}

export function createApprovalCoordinator(
  opts: CreateCoordinatorOpts,
): ApprovalCoordinator {
  const defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_APPROVAL_TTL_MS

  const registry: ApprovalRegistry = createApprovalRegistry({
    onTimeout: (record) => {
      void finalise(record, "timeout", { userId: "bantai" }).catch((err) =>
        log.error(`slack approvals: timeout finalise threw: ${String(err)}`),
      )
    },
    ...(opts.clock?.now ? { now: opts.clock.now } : {}),
    ...(opts.clock?.setTimer ? { setTimer: opts.clock.setTimer } : {}),
    ...(opts.clock?.clearTimer ? { clearTimer: opts.clock.clearTimer } : {}),
  })

  async function finalise(
    record: PendingApprovalRecord,
    decision: ApprovalDecision | "timeout",
    resolver: { userId: string },
  ): Promise<void> {
    // 1. Update the card in place.
    try {
      const rendered = buildResolvedApprovalBlocks({
        previous: {
          id: record.request.id,
          tool: record.request.tool,
          input: record.request.input,
          displayName: record.request.title ?? undefined,
          description: record.request.description ?? undefined,
          approvers: record.approvers,
          ttlMs: record.ttlMs,
        },
        resolver,
        decision,
      })
      await opts.adapter.updateMessage({
        channel: record.channel,
        ts: record.messageTs,
        text: rendered.text,
        blocks: rendered.blocks,
      })
    } catch (err) {
      log.error(`slack approvals: chat.update failed for ${record.request.id}: ${String(err)}`)
    }

    // 2. Call the backend.
    const session = opts.lookupSession(record.sessionKey)
    if (!session) {
      log.warn(
        `slack approvals: session ${record.sessionKey} not found for ${record.request.id}; ` +
          `card updated but backend will remain blocked until timeout`,
      )
      return
    }
    try {
      if (decision === "allow") session.approve(record.request.id)
      else if (decision === "allowAlways") session.approve(record.request.id, { alwaysAllow: true })
      else session.deny(record.request.id, decision === "timeout" ? "timed out, auto-denied" : undefined)
    } catch (err) {
      log.error(`slack approvals: backend approve/deny threw for ${record.request.id}: ${String(err)}`)
    }
  }

  return {
    bindSession(binding) {
      return {
        onRequest({ request, channel, threadTs }) {
          const ttlMs = binding.ttlMs ?? defaultTtlMs
          void (async () => {
            try {
              const rendered = buildApprovalBlocks({
                id: request.id,
                tool: request.tool,
                input: request.input,
                displayName: request.title ?? undefined,
                description: request.description ?? undefined,
                approvers: binding.approvers,
                ttlMs,
              })
              const { ts } = await opts.adapter.postMessage({
                channel,
                threadTs,
                text: rendered.text,
                blocks: rendered.blocks,
              })
              registry.track({
                request,
                channel,
                threadTs,
                messageTs: ts,
                sessionKey: binding.sessionKey,
                approvers: binding.approvers,
                ttlMs,
              })
            } catch (err) {
              log.error(
                `slack approvals: failed to post approval card for ${request.id}: ${String(err)}. ` +
                  `Auto-denying to unblock the backend.`,
              )
              // If we can't even post the card, deny immediately so the
              // backend doesn't hang forever.
              try {
                const session = opts.lookupSession(binding.sessionKey)
                session?.deny(request.id, "approval card could not be posted")
              } catch (denyErr) {
                log.error(`slack approvals: deny fallback threw: ${String(denyErr)}`)
              }
            }
          })()
        },

        onCancel(id) {
          const record = registry.peek(id)
          if (!record) return
          void (async () => {
            // resolve() to grab the record atomically — we want to ensure
            // that if a user is mid-click at the same moment, exactly one
            // decision lands.
            const res = registry.resolve({ id, decision: "deny", userId: "bantai" })
            if (!res.ok) {
              // Another path won the race; their finaliser will do the
              // visible update and the backend call.
              return
            }
            await finalise(res.record, "timeout", { userId: "bantai" })
          })()
        },
      }
    },

    async handleBlockAction({ actionId, userId }) {
      const parsed = parseApprovalActionId(actionId)
      if (!parsed) return { kind: "malformed" }
      const res = registry.resolve({
        id: parsed.id,
        decision: parsed.decision,
        userId,
      })
      if (!res.ok) {
        if (res.code === "unauthorized" && res.record) {
          log.info(
            `slack approvals: ${userId} is not on the approver list for ${parsed.id} ` +
              `(channel=${res.record.channel})`,
          )
          return { kind: "unauthorized", permissionId: parsed.id }
        }
        return { kind: "unknown", permissionId: parsed.id }
      }
      await finalise(res.record, res.decision, { userId: res.resolverUserId })
      return { kind: "resolved", permissionId: parsed.id }
    },

    registry,

    closeAll() {
      const outstanding = registry.closeAll()
      for (const record of outstanding) {
        void finalise(record, "timeout", { userId: "bantai" }).catch((err) =>
          log.error(`slack approvals: closeAll finalise threw: ${String(err)}`),
        )
      }
    },
  }
}
