/**
 * Slack-compatible data model.
 *
 * Shapes mirror Slack's Web API responses so that a bantai Slack frontend
 * written against @slack/web-api unifies with minislack responses for free.
 * Where @slack/types has overly loose fields (lots of `any`/optional), we
 * narrow to what minislack actually populates.
 */

import type { KnownBlock, Block } from "@slack/types"
import type { MessageAttachment } from "@slack/types"

// ---------------------------------------------------------------------------
// Workspace / Team
// ---------------------------------------------------------------------------

export interface Workspace {
  team: Team
  users: Map<string, User>      // keyed by user id (U…/B…)
  apps: Map<string, App>         // keyed by app id (A…)
  channels: Map<string, Channel> // keyed by channel id (C…/G…/D…)
  files: Map<string, File>       // keyed by file id (F…)
  /** Monotonic per-channel timestamp state: channelId -> { lastUnix, seq }. */
  tsState: Map<string, { lastUnix: number; seq: number }>
  /** Deterministic counters for id minting, keyed by prefix. */
  idCounters: Map<string, number>
  /**
   * Ephemerals posted via chat.postEphemeral. Chronological, append-only
   * within a single process lifetime — ephemerals don't persist across
   * restart (matches real Slack, where they're UI-only and expire when the
   * client reloads).
   */
  ephemerals: EphemeralRecord[]
}

/**
 * A single chat.postEphemeral delivery. Visible only to `user` in the web
 * SPA; not fanned out on the Events API bus (matching real Slack).
 */
export interface EphemeralRecord {
  /** Per-channel monotonic ts so callers can correlate with their response. */
  ts: string
  channel: string
  /** Target user id (the only one who "sees" the message). */
  user: string
  /** Posting principal — the user or bot that called chat.postEphemeral. */
  posted_by: string
  /** Present when posted via a bot token. */
  bot_id?: string
  app_id?: string
  text: string
  blocks?: (KnownBlock | Block)[]
  attachments?: MessageAttachment[]
  thread_ts?: string
}

export interface Team {
  id: string           // T…
  name: string
  domain: string       // e.g. "acme" (sub-domain part of x.slack.com)
  url: string          // e.g. "https://acme.slack.com/"
}

// ---------------------------------------------------------------------------
// Users, Bots, Apps
// ---------------------------------------------------------------------------

export interface User {
  id: string           // U… (real users) or B… (bot users tied to an app)
  team_id: string
  name: string         // handle (no @)
  real_name: string
  is_bot: boolean
  /** For bot users, the app that owns them. */
  app_id?: string
  /** For bot users, the Bot record associated with that app. */
  bot_id?: string      // B…
  deleted: boolean
  profile: UserProfile
  /** Unix seconds of last profile update. Slack clients read this for cache busting. */
  updated: number
  /** Slack-style hex color string (no #). Clients render it behind the avatar. */
  color: string
  tz: string           // IANA tz, e.g. "America/Los_Angeles"
  tz_label: string     // human label, e.g. "Pacific Daylight Time"
  tz_offset: number    // seconds east of UTC
  is_admin: boolean
  is_owner: boolean
  is_primary_owner: boolean
  is_restricted: boolean
  is_ultra_restricted: boolean
  /** True for app-only users (no human login). */
  is_app_user: boolean
  has_2fa: boolean
  locale?: string
}

export interface UserProfile {
  real_name: string
  display_name: string
  /** Server-computed normalized forms. Slack mirrors these; clients key off them. */
  real_name_normalized: string
  display_name_normalized: string
  email?: string
  /** Slack-style 40-char hash used as a cache key for avatar CDN. */
  avatar_hash: string
  status_text: string
  status_emoji: string
  status_expiration: number
  /** The user's team id. Mirrors User.team_id in most profiles. */
  team: string
  first_name?: string
  last_name?: string
  title?: string
  phone?: string
  image_24?: string
  image_32?: string
  image_48?: string
  image_72?: string
  image_192?: string
  image_512?: string
  image_1024?: string
}

export interface Bot {
  id: string           // B…
  app_id: string       // A…
  user_id: string      // U… backing user (some apps don't have one; we always mint one for simplicity)
  name: string
  deleted: boolean
}

export interface App {
  id: string           // A…
  name: string
  scopes: string[]
  subscribed_events: string[]
  bot_id: string       // B…
  bot_user_id: string  // U… of the bot's user record
  tokens: {
    /** xoxb-… style bot token used by Web API calls. */
    bot: string
    /** xapp-… style app-level token used by apps.connections.open. */
    app: string
  }
}

// ---------------------------------------------------------------------------
// Channels (discriminated)
// ---------------------------------------------------------------------------

export type Channel =
  | PublicChannel
  | PrivateChannel
  | DirectMessage
  | MultiPartyIm

interface ChannelBase {
  id: string
  created: number       // unix seconds
  creator: string       // user id
  /** Last mutation timestamp (unix ms). Slack clients use this for cache invalidation. */
  updated: number
  /** Ordered member ids. */
  members: string[]
  /** Message ts -> Message, sorted logically by ts ascending. */
  messages: Map<string, Message>
  /** ts of the last read position (not modeled per-user in v0). */
  last_read?: string
  /** Slack "shared channels" flags — minislack is always single-workspace. */
  is_shared: boolean
  is_org_shared: boolean
  is_ext_shared: boolean
  is_pending_ext_shared: boolean
  pending_shared: string[]
  shared_team_ids: string[]
  /** Whether the caller is a member. Populated by the API layer, not the store. */
  is_member: boolean
  /** Size of members[] — cheap to compute, bolt reads it before paginating. */
  num_members: number
  /** Team that this channel's context belongs to. */
  context_team_id: string
  previous_names: string[]
  unlinked: number
}

export interface PublicChannel extends ChannelBase {
  is_channel: true
  is_group: false
  is_im: false
  is_mpim: false
  is_private: false
  is_general: boolean
  is_archived: boolean
  name: string
  name_normalized: string
  topic: ChannelTopic
  purpose: ChannelPurpose
}

export interface PrivateChannel extends ChannelBase {
  is_channel: false
  is_group: true
  is_im: false
  is_mpim: false
  is_private: true
  is_archived: boolean
  name: string
  name_normalized: string
  topic: ChannelTopic
  purpose: ChannelPurpose
}

export interface DirectMessage extends ChannelBase {
  is_channel: false
  is_group: false
  is_im: true
  is_mpim: false
  is_private: true
  /** The other user id (for 1:1 DMs — members[] has exactly two). */
  user: string
  is_user_deleted: boolean
  is_open: boolean
}

export interface MultiPartyIm extends ChannelBase {
  is_channel: false
  is_group: false
  is_im: false
  is_mpim: true
  is_private: true
  name: string         // e.g. "mpdm-alice--bob--charlie-1"
  name_normalized: string
  is_open: boolean
}

export interface ChannelTopic {
  value: string
  creator: string
  last_set: number
}
export type ChannelPurpose = ChannelTopic

// ---------------------------------------------------------------------------
// Messages, Reactions, Files
// ---------------------------------------------------------------------------

export interface Message {
  type: "message"
  /** "<unixSec>.<seq6>", per-channel monotonic. */
  ts: string
  /** ts of the parent message if this is a thread reply. */
  thread_ts?: string
  /** true on the parent of a thread. */
  is_thread_parent?: boolean
  /** Reply count on the parent message. */
  reply_count?: number
  /** Array of reply user ids, parent-only. */
  reply_users?: string[]
  reply_users_count?: number
  /** ts of the most recent reply, parent-only. */
  latest_reply?: string
  channel: string
  user: string         // author user id
  /** Present when authored via a bot token. */
  bot_id?: string
  /** App that sent the message via a bot token. */
  app_id?: string
  text: string
  blocks?: (KnownBlock | Block)[]
  attachments?: MessageAttachment[]
  files?: File[]
  reactions?: Reaction[]
  edited?: { user: string; ts: string }
  /** "me_message", "bot_message", "thread_broadcast", etc. Undefined for plain posts. */
  subtype?: string
  /** Marker written on chat.delete — we keep the record so `ts` stays reserved. */
  tombstone?: boolean
  /** Client-side idempotency id; echoed back on post. */
  client_msg_id?: string
  /** Workspace id the message was posted in. Mirrors Slack responses. */
  team?: string
  /** For thread replies, the user id of the parent message's author. */
  parent_user_id?: string
  /** Whether the author is subscribed to the thread (mirror of a bolt client flag). */
  subscribed?: boolean
  /**
   * True while a chat.startStream placeholder is accepting chat.appendStream
   * appends. Cleared by chat.stopStream. Appends on a message with
   * streaming === false are rejected with `message_not_streaming`.
   */
  streaming?: boolean
  /**
   * Recipient of a streamed response — mirrors Slack's Assistant API args.
   * Informational only; not used for delivery routing.
   */
  streaming_recipient?: { team_id?: string; user_id?: string }
  /**
   * Assistant API per-thread state. Populated on the thread parent by
   * assistant.threads.setStatus / setSuggestedPrompts / setTitle. SSE-only
   * visibility to match real Slack (these don't fan out over Events API).
   */
  assistant_state?: {
    status?: string
    suggested_prompts?: { prompts: Array<{ title: string; message: string }>; title?: string }
    title?: string
  }
}

export interface Reaction {
  name: string
  count: number
  users: string[]      // user ids, insertion order
}

export interface File {
  id: string           // F…
  created: number      // unix seconds
  /** Backcompat alias for `created`. Slack emits both. */
  timestamp: number
  user: string         // uploader user id
  /** Team id the file was uploaded in. */
  user_team?: string
  name: string
  title: string
  mimetype: string
  filetype: string     // "png", "jpg", "txt", ...
  pretty_type: string  // "PNG", "JPEG", ...
  size: number
  /** "hosted" | "external" | "snippet" | "post". minislack always emits hosted. */
  mode: "hosted" | "external" | "snippet" | "post"
  editable: boolean
  is_external: boolean
  external_type: string
  is_public: boolean
  public_url_shared: boolean
  display_as_bot: boolean
  username: string
  /** URL served by minislack's /files/:id. */
  url_private: string
  url_private_download: string
  /** Slack client deep link — minislack uses a /files/:id#permalink marker. */
  permalink: string
  permalink_public: string
  /** Image files only: intrinsic pixel size when known. */
  original_w?: number
  original_h?: number
  image_exif_rotation?: number
  has_rich_preview: boolean
  /** Channels that have shared this file. */
  channels: string[]
  groups: string[]
  ims: string[]
}

// ---------------------------------------------------------------------------
// Event envelope — Socket Mode uses this shape around each Slack event.
// ---------------------------------------------------------------------------

export type SocketModeEnvelopeType =
  | "hello"
  | "events_api"
  | "slash_commands"
  | "interactive"
  | "disconnect"

export interface EventEnvelope<TPayload = unknown> {
  envelope_id: string
  type: SocketModeEnvelopeType
  accepts_response_payload: boolean
  payload: TPayload
  /** Present on redeliveries. */
  retry_attempt?: number
  retry_reason?: string
}

export interface EventsApiPayload<TEvent> {
  /** Legacy verification token. bolt-middlewares still log it. */
  token: string
  team_id: string
  api_app_id: string
  event: TEvent
  event_id: string
  event_time: number
  type: "event_callback"
  /** Each delivery carries the authorizations that applied. */
  authorizations: Array<{
    enterprise_id: string | null
    team_id: string
    user_id: string
    is_bot: boolean
    is_enterprise_install: boolean
  }>
  is_ext_shared_channel: boolean
  context_team_id: string
  context_enterprise_id: string | null
}
