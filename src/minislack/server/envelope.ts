/**
 * Socket Mode envelope construction.
 *
 * Each Slack event sent over Socket Mode is wrapped in:
 *
 *   {
 *     envelope_id: <uuid>,
 *     type: "events_api" | "slash_commands" | "interactive" | "hello" | "disconnect",
 *     accepts_response_payload: boolean,
 *     payload: { team_id, api_app_id, event, event_id, event_time, type: "event_callback" }
 *   }
 *
 * The client acks with { envelope_id, payload: {} } — unacked envelopes
 * may be redelivered with `retry_attempt` + `retry_reason` set.
 */

import { randomUUID } from "node:crypto"
import type {
  EventEnvelope,
  EventsApiPayload,
  Workspace,
} from "../types/slack"
import type { SlackEvent } from "../types/events"
import type {
  InteractivePayload,
  SlashCommandPayload,
} from "../types/interactive"

/** Time the process booted — used to stamp `debug_info.started` on `hello`. */
const BOOT_ISO = new Date().toISOString()

export interface HelloPayload {
  num_connections: number
  connection_info: { app_id: string }
  debug_info: {
    host: string
    started: string
    build_number: number
    approximate_connection_time: number
  }
}

export function buildHello(appId: string): EventEnvelope<HelloPayload> {
  return {
    envelope_id: randomUUID(),
    type: "hello",
    accepts_response_payload: false,
    payload: {
      num_connections: 1,
      connection_info: { app_id: appId },
      debug_info: {
        host: "minislack",
        started: BOOT_ISO,
        build_number: 1,
        approximate_connection_time: 18060,
      },
    },
  }
}

export function buildEventsApi(
  ws: Workspace,
  appId: string,
  evt: SlackEvent,
): EventEnvelope<EventsApiPayload<SlackEvent>> {
  const event_id = `Ev${randomId(11).toUpperCase()}`
  const event_time = Math.floor(Date.now() / 1000)
  const app = ws.apps.get(appId)
  const botUserId = app?.bot_user_id ?? ""
  return {
    envelope_id: randomUUID(),
    type: "events_api",
    accepts_response_payload: false,
    payload: {
      token: "minislack-legacy-token",
      team_id: ws.team.id,
      api_app_id: appId,
      event: evt,
      event_id,
      event_time,
      type: "event_callback",
      authorizations: [
        {
          enterprise_id: null,
          team_id: ws.team.id,
          user_id: botUserId,
          is_bot: true,
          is_enterprise_install: false,
        },
      ],
      is_ext_shared_channel: false,
      context_team_id: ws.team.id,
      context_enterprise_id: null,
    },
  }
}

export function buildSlashCommand(
  payload: SlashCommandPayload,
): EventEnvelope<SlashCommandPayload> {
  return {
    envelope_id: randomUUID(),
    type: "slash_commands",
    // Slash commands support a response payload on ack (Slack will post it
    // back to the user if the handler returns one).
    accepts_response_payload: true,
    payload,
  }
}

export function buildInteractive(
  payload: InteractivePayload,
): EventEnvelope<InteractivePayload> {
  return {
    envelope_id: randomUUID(),
    type: "interactive",
    // view_submission acks can carry a response_action; block_actions can
    // carry a replacement message. Either way the framing is the same.
    accepts_response_payload: true,
    payload,
  }
}

/**
 * Build a synthetic SlashCommandPayload given a minimal set of inputs.
 * Callers inject `app.id` + the inviting user + the channel.
 */
export interface SlashCommandInput {
  workspace: Workspace
  appId: string
  userId: string
  userName: string
  channelId: string
  channelName: string
  command: string      // e.g. "/deploy"
  text: string
  responseUrl: string  // e.g. `${baseHttp}/_minislack/response/${token}`
  /**
   * Optional thread parent `ts`. When set, mirrors Slack's behaviour of
   * including `thread_ts` on the payload when the command was fired
   * from inside a thread. Absent → invoked from the channel's top-level
   * message box.
   */
  threadTs?: string
}

export function makeSlashCommandPayload(input: SlashCommandInput): SlashCommandPayload {
  return {
    token: "minislack-legacy-token",
    team_id: input.workspace.team.id,
    team_domain: input.workspace.team.domain,
    enterprise_id: null,
    enterprise_name: null,
    channel_id: input.channelId,
    channel_name: input.channelName,
    user_id: input.userId,
    user_name: input.userName,
    command: input.command,
    text: input.text,
    api_app_id: input.appId,
    response_url: input.responseUrl,
    trigger_id: `${Date.now()}.${randomId(6)}`,
    is_enterprise_install: false,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
  }
}

function randomId(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let out = ""
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}
