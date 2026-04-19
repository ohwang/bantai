/**
 * minislack-native event types (not to be confused with Socket Mode envelopes
 * in types/slack.ts). These are the internal EventBus payloads; the server
 * wraps them in EventEnvelope before sending over WS.
 *
 * Shapes mirror real Slack Events API payloads so that an app written
 * against real Slack receives structurally identical objects.
 */

import type { KnownBlock, Block } from "@slack/types"
import type { MessageAttachment } from "@slack/types"
import type { File, Reaction } from "./slack"

// ---------------------------------------------------------------------------
// Discriminated union of everything we publish on the bus.
// Add new variants as later phases come online.
// ---------------------------------------------------------------------------

export type SlackEvent =
  | MessageEvent
  | MessageChangedEvent
  | MessageDeletedEvent
  | EphemeralMessageEvent
  | ReactionAddedEvent
  | ReactionRemovedEvent
  | AppMentionEvent
  | ChannelCreatedEvent
  | ChannelRenameEvent
  | MemberJoinedChannelEvent
  | MemberLeftChannelEvent
  | ImOpenEvent
  | ImCloseEvent
  | FileSharedEvent

export interface MessageEvent {
  type: "message"
  /** Undefined for plain user posts; "bot_message" / "me_message" / "thread_broadcast" / "file_share" / "channel_join" etc. */
  subtype?: string
  event_ts: string
  ts: string
  thread_ts?: string
  /** For thread replies, the parent message's author. */
  parent_user_id?: string
  channel: string
  channel_type: "channel" | "group" | "im" | "mpim" | "app_home"
  user: string
  /** Team id the message was posted in. */
  team?: string
  bot_id?: string
  app_id?: string
  text: string
  blocks?: (KnownBlock | Block)[]
  attachments?: MessageAttachment[]
  files?: File[]
  client_msg_id?: string
  reactions?: Reaction[]
}

export interface MessageChangedEvent {
  type: "message"
  subtype: "message_changed"
  event_ts: string
  ts: string
  channel: string
  channel_type: MessageEvent["channel_type"]
  message: {
    type: "message"
    user: string
    text: string
    ts: string
    edited?: { user: string; ts: string }
    blocks?: (KnownBlock | Block)[]
    attachments?: MessageAttachment[]
    thread_ts?: string
    reply_count?: number
    reply_users?: string[]
    reply_users_count?: number
    latest_reply?: string
  }
  previous_message: {
    type: "message"
    user: string
    text: string
    ts: string
  }
  hidden?: boolean
}

export interface MessageDeletedEvent {
  type: "message"
  subtype: "message_deleted"
  event_ts: string
  ts: string
  deleted_ts: string
  channel: string
  channel_type: MessageEvent["channel_type"]
  previous_message: { type: "message"; user: string; text: string; ts: string }
  hidden: true
}

/**
 * chat.postEphemeral delivery. Published for the web SPA / test observers
 * only — the Events API fan-out in server/websocket.ts intentionally
 * doesn't include this type in the default subscribed_events list, because
 * real Slack never propagates ephemerals back to bot apps.
 */
export interface EphemeralMessageEvent {
  type: "ephemeral_message"
  event_ts: string
  ts: string
  channel: string
  /** Target user — only this user "sees" the message. */
  user: string
  /** Posting principal (the caller of chat.postEphemeral). */
  posted_by: string
  bot_id?: string
  app_id?: string
  text: string
  blocks?: (KnownBlock | Block)[]
  attachments?: MessageAttachment[]
  thread_ts?: string
}

export interface ReactionAddedEvent {
  type: "reaction_added"
  event_ts: string
  user: string
  reaction: string
  item_user: string
  item: { type: "message"; channel: string; ts: string }
}

export interface ReactionRemovedEvent {
  type: "reaction_removed"
  event_ts: string
  user: string
  reaction: string
  item_user: string
  item: { type: "message"; channel: string; ts: string }
}

export interface AppMentionEvent {
  type: "app_mention"
  event_ts: string
  ts: string
  user: string
  text: string
  channel: string
  thread_ts?: string
}

export interface ChannelCreatedEvent {
  type: "channel_created"
  event_ts: string
  channel: {
    id: string
    is_channel: boolean
    name: string
    name_normalized: string
    created: number
    creator: string
  }
}

export interface ChannelRenameEvent {
  type: "channel_rename"
  event_ts: string
  channel: {
    id: string
    name: string
    name_normalized: string
    created: number
  }
}

export interface MemberJoinedChannelEvent {
  type: "member_joined_channel"
  event_ts: string
  user: string
  channel: string
  channel_type: MessageEvent["channel_type"]
  team: string
  inviter?: string
}

export interface MemberLeftChannelEvent {
  type: "member_left_channel"
  event_ts: string
  user: string
  channel: string
  channel_type: MessageEvent["channel_type"]
  team: string
}

export interface ImOpenEvent {
  type: "im_open"
  event_ts: string
  user: string
  channel: string
}

export interface ImCloseEvent {
  type: "im_close"
  event_ts: string
  user: string
  channel: string
}

export interface FileSharedEvent {
  type: "file_shared"
  event_ts: string
  file_id: string
  user_id: string
  file: { id: string }
  channel_id: string
}

/** Extract the literal `type` field of a SlackEvent variant. */
export type SlackEventType = SlackEvent["type"]
