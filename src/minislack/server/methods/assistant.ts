/**
 * assistant.threads.* — Slack Assistant API chrome writes.
 *
 * Three methods manage per-thread presentation state that the Slack client
 * renders in its Assistant pane:
 *
 *   - setStatus            "bantai is thinking…" status strip
 *   - setSuggestedPrompts  inline prompt chips the user can one-click
 *   - setTitle             human-readable thread title
 *
 * All three store onto the thread parent's `assistant_state` field. The
 * write is published as an SSE-only event (see events.ts for the event
 * shapes and websocket.ts for the fan-out filter) — real Slack never
 * delivers these events back to bot apps because the direction of data
 * flow is bot → client, not client → bot.
 */

import { MinislackError } from "../../core/channels"
import { nextTs } from "../../core/ts"
import type { EventBus } from "../../core/events"
import type { Message, Workspace } from "../../types/slack"
import type {
  AssistantThreadStatusChangedEvent,
  AssistantThreadSuggestedPromptsChangedEvent,
  AssistantThreadTitleChangedEvent,
} from "../../types/events"
import type { AuthContext } from "../auth"

// ---------------------------------------------------------------------------
// setStatus
// ---------------------------------------------------------------------------

export interface AssistantSetStatusArgs {
  channel_id: string
  thread_ts: string
  status: string
}

export interface AssistantSetStatusResponse {
  ok: true
}

export function assistantThreadsSetStatus(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: AssistantSetStatusArgs,
): AssistantSetStatusResponse {
  const { parent, channelId } = resolveThreadParent(ws, ctx, args.channel_id, args.thread_ts)
  const state = (parent.assistant_state ??= {})
  state.status = args.status
  const evt: AssistantThreadStatusChangedEvent = {
    type: "assistant_thread_status_changed",
    event_ts: nextTs(ws, channelId),
    channel: channelId,
    thread_ts: parent.ts,
    status: args.status,
  }
  bus.publish(evt)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// setSuggestedPrompts
// ---------------------------------------------------------------------------

export interface AssistantPrompt {
  title: string
  message: string
}

export interface AssistantSetSuggestedPromptsArgs {
  channel_id: string
  thread_ts: string
  prompts: AssistantPrompt[]
  title?: string
}

export interface AssistantSetSuggestedPromptsResponse {
  ok: true
}

export function assistantThreadsSetSuggestedPrompts(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: AssistantSetSuggestedPromptsArgs,
): AssistantSetSuggestedPromptsResponse {
  if (!Array.isArray(args.prompts) || args.prompts.length === 0) {
    throw new MinislackError("invalid_arguments", "prompts must be a non-empty array")
  }
  for (const p of args.prompts) {
    if (typeof p?.title !== "string" || typeof p?.message !== "string") {
      throw new MinislackError("invalid_arguments", "each prompt needs title + message strings")
    }
  }
  const { parent, channelId } = resolveThreadParent(ws, ctx, args.channel_id, args.thread_ts)
  const state = (parent.assistant_state ??= {})
  state.suggested_prompts = {
    prompts: args.prompts.map((p) => ({ title: p.title, message: p.message })),
    ...(args.title ? { title: args.title } : {}),
  }
  const evt: AssistantThreadSuggestedPromptsChangedEvent = {
    type: "assistant_thread_suggested_prompts_changed",
    event_ts: nextTs(ws, channelId),
    channel: channelId,
    thread_ts: parent.ts,
    prompts: state.suggested_prompts.prompts,
    ...(state.suggested_prompts.title ? { title: state.suggested_prompts.title } : {}),
  }
  bus.publish(evt)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// setTitle
// ---------------------------------------------------------------------------

export interface AssistantSetTitleArgs {
  channel_id: string
  thread_ts: string
  title: string
}

export interface AssistantSetTitleResponse {
  ok: true
}

export function assistantThreadsSetTitle(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: AssistantSetTitleArgs,
): AssistantSetTitleResponse {
  if (typeof args.title !== "string" || args.title.length === 0) {
    throw new MinislackError("invalid_arguments", "title must be a non-empty string")
  }
  const { parent, channelId } = resolveThreadParent(ws, ctx, args.channel_id, args.thread_ts)
  const state = (parent.assistant_state ??= {})
  state.title = args.title
  const evt: AssistantThreadTitleChangedEvent = {
    type: "assistant_thread_title_changed",
    event_ts: nextTs(ws, channelId),
    channel: channelId,
    thread_ts: parent.ts,
    title: args.title,
  }
  bus.publish(evt)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Shared: resolve + auth the thread parent the caller is writing to.
// ---------------------------------------------------------------------------

function resolveThreadParent(
  ws: Workspace,
  ctx: AuthContext,
  channelId: string,
  threadTs: string,
): { parent: Message; channelId: string } {
  if (!ctx.userId) throw new MinislackError("not_authed")
  const ch = ws.channels.get(channelId)
  if (!ch) throw new MinislackError("channel_not_found", channelId)
  const parent = ch.messages.get(threadTs)
  if (!parent || parent.tombstone) {
    throw new MinislackError("message_not_found", threadTs)
  }
  // Slack flattens threads to one level — if caller passes a reply's ts,
  // hoist to the top-level parent so the state lands on the visible root.
  if (parent.thread_ts && parent.thread_ts !== parent.ts) {
    const root = ch.messages.get(parent.thread_ts)
    if (!root || root.tombstone) {
      throw new MinislackError("message_not_found", parent.thread_ts)
    }
    return { parent: root, channelId: ch.id }
  }
  return { parent, channelId: ch.id }
}
