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

function randomId(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let out = ""
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}
