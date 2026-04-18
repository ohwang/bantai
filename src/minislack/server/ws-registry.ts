/**
 * WsRegistry — tracks live Socket Mode connections per appId.
 *
 * Distinct from the SocketRegistry in methods/apps.ts (which is a one-shot
 * handshake map of pending socketId → appId). This registry owns the live
 * ServerWebSocket handles AFTER the handshake, and lets callers push
 * non-Events API envelopes (slash_commands, interactive) directly to the
 * connected app — plus collect the ack payload a bot sends back when
 * `accepts_response_payload` is true.
 */

import type { ServerWebSocket } from "bun"
import type { WsData } from "./websocket"

export interface WsRegistry {
  register(appId: string, socket: ServerWebSocket<WsData>): void
  unregister(socket: ServerWebSocket<WsData>): void
  /** Serialize + write to every live socket for appId. Returns count sent. */
  sendToApp(appId: string, envelope: { envelope_id: string }): number
  /** Resolve with the client's ack payload; rejects on timeout. */
  awaitAckPayload(envelopeId: string, timeoutMs?: number): Promise<unknown>
  /** Delivered by websocket.ts when a client ack arrives with a payload. */
  resolveAck(envelopeId: string, payload: unknown): void
}

export function createWsRegistry(): WsRegistry {
  const byApp = new Map<string, Set<ServerWebSocket<WsData>>>()
  const waiters = new Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >()

  return {
    register(appId, socket) {
      let set = byApp.get(appId)
      if (!set) {
        set = new Set()
        byApp.set(appId, set)
      }
      set.add(socket)
    },
    unregister(socket) {
      const appId = socket.data.appId
      if (!appId) return
      const set = byApp.get(appId)
      if (!set) return
      set.delete(socket)
      if (set.size === 0) byApp.delete(appId)
    },
    sendToApp(appId, envelope) {
      const set = byApp.get(appId)
      if (!set) return 0
      const json = JSON.stringify(envelope)
      let n = 0
      for (const sock of set) {
        try {
          sock.send(json)
          n++
        } catch {
          // Socket closed between subscribe + send — drop silently.
        }
      }
      return n
    },
    awaitAckPayload(envelopeId, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(envelopeId)
          reject(new Error(`ack timeout for envelope ${envelopeId}`))
        }, timeoutMs)
        waiters.set(envelopeId, { resolve, timer })
      })
    },
    resolveAck(envelopeId, payload) {
      const w = waiters.get(envelopeId)
      if (!w) return
      clearTimeout(w.timer)
      waiters.delete(envelopeId)
      w.resolve(payload)
    },
  }
}
