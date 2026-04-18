/**
 * Translate core Messages (stored shape) into SlackEvent payloads that match
 * real Slack's Events API. Keeping this in one place — server methods call
 * these when publishing to the EventBus.
 */

import type { Channel, Message } from "../types/slack"
import type { MessageEvent } from "../types/events"

export function channelTypeOf(ch: Channel): MessageEvent["channel_type"] {
  if (ch.is_im) return "im"
  if (ch.is_mpim) return "mpim"
  if (ch.is_group) return "group"
  return "channel"
}

export function messageToMessageEvent(
  msg: Message,
  channel: Channel,
): MessageEvent {
  return {
    type: "message",
    event_ts: msg.ts,
    ts: msg.ts,
    channel: msg.channel,
    channel_type: channelTypeOf(channel),
    user: msg.user,
    text: msg.text,
    ...(msg.team ? { team: msg.team } : {}),
    ...(msg.bot_id ? { bot_id: msg.bot_id } : {}),
    ...(msg.app_id ? { app_id: msg.app_id } : {}),
    ...(msg.subtype ? { subtype: msg.subtype } : {}),
    ...(msg.thread_ts ? { thread_ts: msg.thread_ts } : {}),
    ...(msg.parent_user_id ? { parent_user_id: msg.parent_user_id } : {}),
    ...(msg.blocks ? { blocks: msg.blocks } : {}),
    ...(msg.attachments ? { attachments: msg.attachments } : {}),
    ...(msg.files ? { files: msg.files } : {}),
    ...(msg.client_msg_id ? { client_msg_id: msg.client_msg_id } : {}),
    ...(msg.reactions ? { reactions: msg.reactions } : {}),
  }
}
