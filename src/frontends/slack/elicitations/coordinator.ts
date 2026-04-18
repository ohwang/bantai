/**
 * Elicitation coordinator — the counterpart to approvals/coordinator.ts.
 *
 * Lifecycle:
 *
 *   elicitation_request
 *      └─ renderer → hook.onRequest
 *                    └─ chat.postMessage inline "Answer questions" card
 *                    └─ track pending by elicitation id
 *
 *   user clicks "Answer questions"
 *      └─ block_action (open/cancel)
 *         └─ coordinator.handleBlockAction
 *              ├─ open   → views.open(modal)
 *              └─ cancel → backend.cancelElicitation + card update
 *
 *   user submits the modal
 *      └─ view_submission
 *         └─ coordinator.handleViewSubmission
 *              └─ parse values → backend.respondToElicitation
 *              └─ chat.update card → ":white_check_mark: answered by @user"
 *
 *   shutdown / session close
 *      └─ closeAll / onCancel → cancel backend, update card
 *
 * One registry is shared across sessions so view_submission (which carries
 * only the callback_id, not a channel/thread) can still find the record.
 */

import type { App } from "@slack/bolt"
import type { ElicitationRequestEvent } from "../../../protocol/types"
import { log } from "../../../utils/logger"
import type { SendAdapter } from "../view/outbox"
import {
  buildElicitationCard,
  buildElicitationModal,
  buildResolvedElicitationCard,
  parseElicitationActionId,
  parseElicitationSubmission,
} from "../view/blocks/elicitation"

export interface ElicitationHook {
  onRequest(args: {
    request: ElicitationRequestEvent
    channel: string
    threadTs: string
  }): void
  onCancel(id: string): void
}

export interface ElicitationBackendCallbacks {
  respond(id: string, answers: Record<string, string>): void
  cancel(id: string): void
}

export interface SessionElicitationBinding {
  sessionKey: string
}

export interface ElicitationBlockActionInput {
  actionId: string
  userId: string
  triggerId: string
  channel?: string
}

export interface ElicitationBlockActionResult {
  kind: "open" | "cancel" | "malformed" | "unknown"
  id?: string
}

export interface ElicitationViewSubmissionInput {
  callbackId: string
  userId: string
  values: Record<string, unknown>
}

export interface ElicitationViewSubmissionResult {
  kind: "submitted" | "malformed" | "unknown" | "no_answers"
  id?: string
}

export interface ElicitationCoordinator {
  bindSession(binding: SessionElicitationBinding): ElicitationHook
  handleBlockAction(input: ElicitationBlockActionInput): Promise<ElicitationBlockActionResult>
  handleViewSubmission(input: ElicitationViewSubmissionInput): Promise<ElicitationViewSubmissionResult>
  /** Auto-cancel all pending elicitations (shutdown). */
  closeAll(): void
  /** Debug / diagnostics. */
  size(): number
}

export interface CreateElicitationCoordinatorOpts {
  adapter: SendAdapter
  /**
   * Return the backend callbacks for a given session key.  At resolve-time
   * the session may have been evicted; we still update the card (so the
   * user sees the outcome) but skip the backend call.
   */
  lookupSession(sessionKey: string): ElicitationBackendCallbacks | undefined
  /**
   * Bolt app for `views.open`. Tests pass a stub implementing only the
   * fields we touch (`client.views.open`).
   */
  app: Pick<App, "client">
}

interface PendingRecord {
  request: ElicitationRequestEvent
  channel: string
  threadTs: string
  messageTs: string
  sessionKey: string
}

export function createElicitationCoordinator(
  opts: CreateElicitationCoordinatorOpts,
): ElicitationCoordinator {
  const pending = new Map<string, PendingRecord>()

  async function updateCardResolved(
    record: PendingRecord,
    answered: boolean,
    resolverUserId: string,
  ): Promise<void> {
    try {
      const rendered = buildResolvedElicitationCard({
        previous: { id: record.request.id, questions: record.request.questions },
        answered,
        resolverUserId,
      })
      await opts.adapter.updateMessage({
        channel: record.channel,
        ts: record.messageTs,
        text: rendered.text,
        blocks: rendered.blocks,
      })
    } catch (err) {
      log.error(`slack elicitations: chat.update failed for ${record.request.id}: ${String(err)}`)
    }
  }

  return {
    bindSession(binding) {
      return {
        onRequest({ request, channel, threadTs }) {
          void (async () => {
            try {
              const rendered = buildElicitationCard({
                id: request.id,
                questions: request.questions,
              })
              const { ts } = await opts.adapter.postMessage({
                channel,
                threadTs,
                text: rendered.text,
                blocks: rendered.blocks,
              })
              pending.set(request.id, {
                request,
                channel,
                threadTs,
                messageTs: ts,
                sessionKey: binding.sessionKey,
              })
            } catch (err) {
              log.error(
                `slack elicitations: failed to post card for ${request.id}: ${String(err)}. ` +
                  `Cancelling to unblock the backend.`,
              )
              try {
                const session = opts.lookupSession(binding.sessionKey)
                session?.cancel(request.id)
              } catch (cancelErr) {
                log.error(`slack elicitations: cancel fallback threw: ${String(cancelErr)}`)
              }
            }
          })()
        },

        onCancel(id) {
          const record = pending.get(id)
          if (!record) return
          pending.delete(id)
          void (async () => {
            const session = opts.lookupSession(record.sessionKey)
            try {
              session?.cancel(record.request.id)
            } catch (err) {
              log.error(`slack elicitations: backend.cancel threw for ${id}: ${String(err)}`)
            }
            await updateCardResolved(record, false, "bantai")
          })()
        },
      }
    },

    async handleBlockAction({ actionId, userId, triggerId }) {
      const parsed = parseElicitationActionId(actionId)
      if (!parsed) return { kind: "malformed" }
      const record = pending.get(parsed.id)
      if (!record) return { kind: parsed.kind, id: parsed.id }

      if (parsed.kind === "cancel") {
        pending.delete(parsed.id)
        const session = opts.lookupSession(record.sessionKey)
        try {
          session?.cancel(record.request.id)
        } catch (err) {
          log.error(`slack elicitations: backend.cancel threw for ${parsed.id}: ${String(err)}`)
        }
        await updateCardResolved(record, false, userId)
        return { kind: "cancel", id: parsed.id }
      }

      // open → views.open(modal). We keep the pending record around so the
      // view_submission can still find it.
      try {
        const view = buildElicitationModal({
          id: record.request.id,
          questions: record.request.questions,
        })
        await opts.app.client.views.open({ trigger_id: triggerId, view })
      } catch (err) {
        log.error(`slack elicitations: views.open failed for ${parsed.id}: ${String(err)}`)
      }
      return { kind: "open", id: parsed.id }
    },

    async handleViewSubmission({ callbackId, userId, values }) {
      // We don't know the question list from callbackId alone — look up the
      // pending record first so we can harvest by question index.
      const maybeId = parseRawIdFromCallback(callbackId)
      if (!maybeId) return { kind: "malformed" }
      const record = pending.get(maybeId)
      if (!record) return { kind: "unknown", id: maybeId }

      const parsed = parseElicitationSubmission({
        callbackId,
        values,
        questions: record.request.questions,
      })
      if (!parsed) return { kind: "malformed", id: maybeId }

      if (Object.keys(parsed.answers).length === 0) {
        // Slack's own validation covers empty inputs; if we're here the user
        // submitted a form that produced nothing useful (all whitespace,
        // all unselected). Don't forward to the backend.
        return { kind: "no_answers", id: maybeId }
      }

      pending.delete(parsed.id)
      const session = opts.lookupSession(record.sessionKey)
      try {
        session?.respond(parsed.id, parsed.answers)
      } catch (err) {
        log.error(`slack elicitations: backend.respond threw for ${parsed.id}: ${String(err)}`)
      }
      await updateCardResolved(record, true, userId)
      return { kind: "submitted", id: parsed.id }
    },

    closeAll() {
      const records = Array.from(pending.values())
      pending.clear()
      for (const record of records) {
        const session = opts.lookupSession(record.sessionKey)
        try {
          session?.cancel(record.request.id)
        } catch (err) {
          log.error(`slack elicitations: closeAll cancel threw: ${String(err)}`)
        }
        void updateCardResolved(record, false, "bantai").catch((err) =>
          log.error(`slack elicitations: closeAll updateCard threw: ${String(err)}`),
        )
      }
    },

    size() {
      return pending.size
    },
  }
}

/** Bare extractor — mirrors parseModalCallbackId but isn't exported there. */
function parseRawIdFromCallback(callbackId: string): string | null {
  const parts = callbackId.split(":")
  if (parts.length !== 3) return null
  if (parts[0] !== "bantai" || parts[1] !== "elic") return null
  return parts[2] ?? null
}
