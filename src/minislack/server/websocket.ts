/**
 * Socket Mode WebSocket endpoint.
 *
 * Path: /link/:socketId
 *
 * On connect:
 *   1. Exchange the socketId for an appId via SocketRegistry. Reject with
 *      4401 if unknown.
 *   2. Immediately send a "hello" envelope.
 *   3. Subscribe to the EventBus, filtered by the app's subscribed_events
 *      (populated at registerApp time). Each matching event is wrapped in an
 *      Events API envelope and pushed to the socket.
 *
 * On message from client: we accept `{ envelope_id, payload? }` acks. For
 * Phase 1 we don't retry unacked envelopes — we just track for tests.
 *
 * On close: unsubscribe from the bus.
 */

import type { ServerWebSocket } from "bun"
import { buildEventsApi, buildHello } from "./envelope"
import type { SocketRegistry } from "./methods/apps"
import type { EventBus, Unsubscribe } from "../core/events"
import type { Workspace } from "../types/slack"
import type { SlackEvent, SlackEventType } from "../types/events"

export interface WsData {
  socketId: string
  appId?: string
  unsubscribe?: Unsubscribe
  ackedEnvelopes: string[]
}

export interface WsContext {
  ws: Workspace
  bus: EventBus
  sockets: SocketRegistry
}

/**
 * Build the Bun.serve `websocket` config object.
 */
export function buildWebSocketHandler(ctx: WsContext) {
  return {
    open(socket: ServerWebSocket<WsData>) {
      const appId = ctx.sockets.consume(socket.data.socketId)
      if (!appId) {
        socket.close(4401, "unknown socket id")
        return
      }
      const app = ctx.ws.apps.get(appId)
      if (!app) {
        socket.close(4401, "app not found")
        return
      }
      socket.data.appId = appId

      // hello immediately
      socket.send(JSON.stringify(buildHello(appId)))

      // Subscribe with the app's event filter
      const types = (app.subscribed_events.length > 0
        ? (app.subscribed_events as SlackEventType[])
        : undefined)
      socket.data.unsubscribe = ctx.bus.subscribe(
        { types },
        (evt: SlackEvent) => {
          const envelope = buildEventsApi(ctx.ws, appId, evt)
          try {
            socket.send(JSON.stringify(envelope))
          } catch {
            // socket closed between subscribe and send — no-op
          }
        },
      )
    },
    message(socket: ServerWebSocket<WsData>, raw: string | Buffer) {
      const text = typeof raw === "string" ? raw : raw.toString("utf8")
      try {
        const parsed = JSON.parse(text) as { envelope_id?: string }
        if (parsed && typeof parsed.envelope_id === "string") {
          socket.data.ackedEnvelopes.push(parsed.envelope_id)
        }
      } catch {
        // Malformed ack — Slack just ignores these.
      }
    },
    close(socket: ServerWebSocket<WsData>) {
      socket.data.unsubscribe?.()
      socket.data.unsubscribe = undefined
    },
  }
}
