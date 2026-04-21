/**
 * Slash commands + interactive payload shapes, mirroring Slack's wire format.
 *
 * Docs:
 *   https://docs.slack.dev/interactivity/implementing-slash-commands
 *   https://docs.slack.dev/interactivity/handling-user-interaction#payloads
 *
 * These are the `payload` nested inside a Socket Mode envelope of type
 * `slash_commands` or `interactive`. They are ALSO the shape a classic
 * HTTP app receives on its request URL — identical bytes, different
 * transport.
 */

import type { Block, KnownBlock, MessageAttachment } from "@slack/types"

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

export interface SlashCommandPayload {
  /** Verification token (legacy; bolt still logs it). */
  token: string
  /** "T…" workspace id. */
  team_id: string
  team_domain: string
  enterprise_id: string | null
  enterprise_name: string | null
  /** Channel the command was invoked from. */
  channel_id: string
  channel_name: string
  /** User who typed the command. */
  user_id: string
  user_name: string
  /** Full command text including the leading slash, e.g. "/deploy". */
  command: string
  /** Anything after the command name. */
  text: string
  api_app_id: string
  /** POST-only URL the bot uses to send delayed replies (up to 30 min). */
  response_url: string
  /** Triggers an interactive dialog (views.open). */
  trigger_id: string
  is_enterprise_install: boolean
  /**
   * When the command is invoked from inside a thread (e.g. the reply
   * composer in the thread side panel), Slack includes the parent
   * message's `ts`. Absent when the command is invoked from the
   * channel's top-level message box. Bantai's thread-scoped commands
   * (`/bantai new`, `/bantai stop`, …) require this field — see
   * `src/frontends/slack/commands/slash-adapter.ts`.
   */
  thread_ts?: string
}

// ---------------------------------------------------------------------------
// Interactive components — block_actions, view_submission, view_closed,
// message_action (global shortcut), shortcut (message shortcut).
// ---------------------------------------------------------------------------

export interface InteractiveUser {
  id: string
  username: string
  name: string
  team_id: string
}

export interface InteractiveTeam {
  id: string
  domain: string
}

export interface InteractiveChannel {
  id: string
  name: string
}

/** The primitive union the outer envelope discriminates on. */
export type InteractivePayload =
  | BlockActionsPayload
  | ViewSubmissionPayload
  | ViewClosedPayload
  | MessageActionPayload
  | GlobalShortcutPayload

export interface BlockActionsPayload {
  type: "block_actions"
  team: InteractiveTeam
  user: InteractiveUser
  api_app_id: string
  token: string
  container: {
    type: "message" | "view"
    message_ts?: string
    channel_id?: string
    is_ephemeral?: boolean
    view_id?: string
  }
  trigger_id: string
  channel?: InteractiveChannel
  message?: {
    type: "message"
    user: string
    ts: string
    text: string
    blocks?: (KnownBlock | Block)[]
    attachments?: MessageAttachment[]
  }
  response_url: string
  actions: Array<{
    action_id: string
    block_id: string
    /** Button, select, overflow, radio_buttons, checkboxes, datepicker, timepicker, etc. */
    type: string
    /** Plain-text label for buttons; selected option for selects. */
    text?: { type: "plain_text"; text: string; emoji?: boolean }
    value?: string
    selected_option?: { text: { type: "plain_text"; text: string }; value: string }
    selected_options?: Array<{ value: string }>
    selected_date?: string
    selected_time?: string
    style?: "primary" | "danger"
    action_ts: string
  }>
  is_enterprise_install: boolean
  enterprise: { id: string; name: string } | null
}

export interface ViewSubmissionPayload {
  type: "view_submission"
  team: InteractiveTeam
  user: InteractiveUser
  api_app_id: string
  token: string
  trigger_id: string
  view: ViewState
  is_enterprise_install: boolean
  enterprise: { id: string; name: string } | null
}

export interface ViewClosedPayload {
  type: "view_closed"
  team: InteractiveTeam
  user: InteractiveUser
  api_app_id: string
  token: string
  view: ViewState
  is_cleared: boolean
  is_enterprise_install: boolean
}

export interface ViewState {
  id: string
  type: "modal" | "home"
  /** Minimal subset of the `state.values` shape bolt apps read. */
  state: { values: Record<string, Record<string, unknown>> }
  callback_id: string
  private_metadata: string
  hash: string
  title?: { type: "plain_text"; text: string }
  blocks?: (KnownBlock | Block)[]
}

export interface MessageActionPayload {
  type: "message_action"
  team: InteractiveTeam
  user: InteractiveUser
  api_app_id: string
  token: string
  trigger_id: string
  response_url: string
  channel: InteractiveChannel
  callback_id: string
  message: {
    type: "message"
    user: string
    ts: string
    text: string
  }
  is_enterprise_install: boolean
}

export interface GlobalShortcutPayload {
  type: "shortcut"
  team: InteractiveTeam
  user: InteractiveUser
  api_app_id: string
  token: string
  trigger_id: string
  callback_id: string
  is_enterprise_install: boolean
}
