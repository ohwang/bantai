/**
 * startMinislack — the library + test API.
 *
 * Boots an in-memory workspace, HTTP server, and WS server on either a
 * specified port or an ephemeral one. Returns a MinislackHandle that
 * exposes a live read-only workspace, scoped UserClients, app registration,
 * an EventBus subscription, a snapshot() helper, and a clean stop().
 */

import type { Server } from "bun"
import { createWorkspace, registerApp, createUser, tokenForUser } from "../core/workspace"
import type { RegisteredApp } from "../core/workspace"
import { createEventBus, type EventBus, type EventFilter, type Unsubscribe } from "../core/events"
import { handleHttp, createSocketsRegistry } from "../server/http"
import { buildWebSocketHandler, type WsData } from "../server/websocket"
import { buildWebBundle, type WebBundle } from "../server/web-bundle"
import type { Workspace, User, Channel, Message } from "../types/slack"
import type { SlackEvent } from "../types/events"
import { applyFixture, type FixtureName } from "./fixtures"
import { readFile } from "node:fs/promises"
import { createDiskStorage } from "../storage/disk"
import { createMemoryStorage } from "../storage/memory"
import type { StorageBackend } from "../storage/types"
import { createWsRegistry } from "../server/ws-registry"
import { setWorkspaceEmoji } from "../server/methods/emoji"
import {
  buildInteractive,
  buildSlashCommand,
  makeSlashCommandPayload,
} from "../server/envelope"
import type {
  InteractivePayload,
  SlashCommandPayload,
} from "../types/interactive"

export interface UserClient {
  user: User
  token: string
  sendMessage(channel: string, text: string, opts?: { thread_ts?: string }): Promise<Message>
  history(channel: string, opts?: { latest?: string; oldest?: string; limit?: number; inclusive?: boolean }): Promise<Message[]>
}

export interface RegisterAppOpts {
  name: string
  scopes?: string[]
  subscribed_events?: string[]
}

export interface MinislackHandle {
  port: number
  url: string
  wsUrl(socketId: string): string
  workspace: Workspace
  bus: EventBus
  asUser(nameOrId: string): UserClient
  registerApp(opts: RegisterAppOpts): RegisteredApp
  events: {
    subscribe(filter: EventFilter, handler: (evt: SlackEvent) => void): Unsubscribe
  }
  /**
   * Fire a slash command at the connected Socket Mode app for `appId`.
   * Resolves with the ack payload when the app responds (if any).
   */
  fireSlashCommand(appId: string, opts: FireSlashCommandOpts): Promise<{
    envelope_id: string
    payload: SlashCommandPayload
    ack?: unknown
  }>
  /**
   * Push a block_actions / view_submission / shortcut payload at the app.
   */
  fireInteractive(appId: string, payload: InteractivePayload): Promise<{
    envelope_id: string
    ack?: unknown
  }>
  snapshot(): WorkspaceSnapshot
  stop(): Promise<void>
}

export interface FireSlashCommandOpts {
  userId: string
  channelId: string
  command: string        // "/deploy"
  text?: string
  /** ms to wait for the ack payload; 0 = don't wait. Default 0 (fire-and-forget). */
  awaitAckMs?: number
}

export interface WorkspaceSnapshot {
  team: Workspace["team"]
  users: User[]
  channels: Array<Omit<Channel, "messages"> & { messages: Message[] }>
  apps: Array<ReturnType<typeof appSummary>>
}

export interface StartMinislackOpts {
  /** 0 = ephemeral port (default for tests). */
  port?: number
  /** Preset to seed a fresh workspace. Ignored if --persist has saved state. */
  fixture?: FixtureName
  /**
   * When set, persist workspace state to this directory.
   * `<persist>/workspace.json` + `<persist>/files/<id>.bin` are loaded at
   * startup (if present) and rewritten on mutations.
   */
  persist?: string
  /**
   * Path to a JSON file containing either raw Slack `emoji.list` output
   * (`{ ok: true, emoji: { name: url, ... } }`) or a flat
   * `{ name: url-or-alias, ... }` map. Loaded at boot and served as-is
   * from `emoji.list`.
   */
  emojisFile?: string
  /** Reserved for Phase 2. */
  serveWeb?: boolean
}

export async function startMinislack(opts: StartMinislackOpts = {}): Promise<MinislackHandle> {
  const bus = createEventBus()
  const storage: StorageBackend = opts.persist
    ? createDiskStorage({ root: opts.persist })
    : createMemoryStorage()

  let ws: Workspace | null = await storage.load()
  if (!ws) {
    ws = createWorkspace({ teamName: "Minislack", teamDomain: "minislack" })
    if (opts.fixture) applyFixture(ws, opts.fixture)
  } else if (opts.fixture) {
    console.warn(
      `[minislack] --persist loaded existing state; ignoring fixture '${opts.fixture}'`,
    )
  }

  if (opts.emojisFile) {
    try {
      const raw = await readFile(opts.emojisFile, "utf8")
      const parsed = JSON.parse(raw) as unknown
      const emoji = normalizeEmojiInput(parsed)
      setWorkspaceEmoji(ws, emoji)
      console.log(`[minislack] loaded ${Object.keys(emoji).length} custom emoji from ${opts.emojisFile}`)
    } catch (err) {
      console.error(`[minislack] failed to load --emojis file ${opts.emojisFile}:`, err)
    }
  }

  const sockets = createSocketsRegistry()
  const wsRegistry = createWsRegistry()

  let web: WebBundle | undefined
  if (opts.serveWeb !== false) {
    try {
      web = await buildWebBundle()
    } catch (err) {
      // Surface the bundler error up front so it's never mysterious.
      console.error("[minislack] web bundle failed:", err)
      throw err
    }
  }

  let resolvedPort = 0
  let wsBase = ""
  let baseHttp = ""
  const server: Server<WsData> = Bun.serve<WsData>({
    port: opts.port ?? 0,
    // SSE streams must outlive Bun's default 10s idle timeout.
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname.startsWith("/link/")) {
        const socketId = url.pathname.slice("/link/".length)
        const ok = srv.upgrade(req, { data: { socketId, ackedEnvelopes: [] } as WsData })
        if (ok) return undefined as unknown as Response
        return new Response("expected websocket", { status: 426 })
      }
      return handleHttp(req, {
        ws,
        bus,
        sockets,
        wsBase: () => wsBase,
        baseHttp: () => baseHttp,
        web,
        wsRegistry,
      })
    },
    websocket: buildWebSocketHandler({ ws, bus, sockets, wsRegistry }),
  })
  resolvedPort = server.port ?? 0
  const host = server.hostname === "0.0.0.0" || server.hostname === "::" ? "localhost" : server.hostname
  baseHttp = `http://${host}:${resolvedPort}`
  wsBase = `ws://${host}:${resolvedPort}`

  // Persisted file URLs carry an absolute base from a prior run. Rebase them
  // onto this run's host:port so clients can fetch bytes.
  for (const file of ws.files.values()) {
    file.url_private = rebaseFileUrl(file.url_private, baseHttp)
    file.url_private_download = rebaseFileUrl(file.url_private_download, baseHttp)
  }

  const unsubStorage = storage.attach(ws, bus)

  const handle: MinislackHandle = {
    port: resolvedPort,
    url: baseHttp,
    wsUrl(socketId: string) { return `${wsBase}/link/${socketId}` },
    workspace: ws,
    bus,
    asUser(nameOrId: string): UserClient {
      const user = resolveOrCreateUser(ws, nameOrId)
      const token = tokenForUser(user)
      return buildUserClient(baseHttp, user, token)
    },
    registerApp(opts) {
      return registerApp(ws, opts)
    },
    events: {
      subscribe(filter, handler) {
        return bus.subscribe(filter, handler)
      },
    },
    async fireSlashCommand(appId, input) {
      const app = ws.apps.get(appId)
      if (!app) throw new Error(`fireSlashCommand: app ${appId} not registered`)
      const user = ws.users.get(input.userId)
      const channel = ws.channels.get(input.channelId)
      if (!user) throw new Error(`fireSlashCommand: user ${input.userId} missing`)
      if (!channel) throw new Error(`fireSlashCommand: channel ${input.channelId} missing`)
      const channelName = "name" in channel ? channel.name : channel.id
      const responseToken = Math.random().toString(36).slice(2, 18)
      const payload = makeSlashCommandPayload({
        workspace: ws,
        appId,
        userId: user.id,
        userName: user.name,
        channelId: channel.id,
        channelName,
        command: input.command,
        text: input.text ?? "",
        responseUrl: `${baseHttp}/_minislack/response/${responseToken}`,
      })
      const envelope = buildSlashCommand(payload)
      const sent = wsRegistry.sendToApp(appId, envelope)
      if (sent === 0) {
        throw new Error(`fireSlashCommand: no live Socket Mode connection for app ${appId}`)
      }
      if (!input.awaitAckMs || input.awaitAckMs === 0) {
        return { envelope_id: envelope.envelope_id, payload }
      }
      try {
        const ack = await wsRegistry.awaitAckPayload(envelope.envelope_id, input.awaitAckMs)
        return { envelope_id: envelope.envelope_id, payload, ack }
      } catch {
        return { envelope_id: envelope.envelope_id, payload }
      }
    },
    async fireInteractive(appId, payload) {
      if (!ws.apps.has(appId)) {
        throw new Error(`fireInteractive: app ${appId} not registered`)
      }
      const envelope = buildInteractive(payload)
      const sent = wsRegistry.sendToApp(appId, envelope)
      if (sent === 0) {
        throw new Error(`fireInteractive: no live Socket Mode connection for app ${appId}`)
      }
      try {
        const ack = await wsRegistry.awaitAckPayload(envelope.envelope_id, 2000)
        return { envelope_id: envelope.envelope_id, ack }
      } catch {
        return { envelope_id: envelope.envelope_id }
      }
    },
    snapshot() {
      return snapshotWorkspace(ws)
    },
    async stop() {
      unsubStorage()
      await storage.stop()
      server.stop(true)
    },
  }
  return handle
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Accept either raw `emoji.list` output or a bare `{ name: url }` map and
 * return a flat map. Custom emoji URLs use aliases like `alias:smile` —
 * both forms are preserved as-is (the client only cares about the value).
 */
function normalizeEmojiInput(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {}
  const obj = raw as Record<string, unknown>
  const map = "emoji" in obj && typeof obj.emoji === "object" && obj.emoji
    ? (obj.emoji as Record<string, unknown>)
    : obj
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

/**
 * Swap the scheme+host+port prefix of a persisted file URL with the current
 * server base. Leaves anything after the host untouched (path, query).
 */
function rebaseFileUrl(prev: string, baseHttp: string): string {
  const match = prev.match(/^https?:\/\/[^/]+/)
  if (!match) return prev
  return baseHttp + prev.slice(match[0].length)
}

function resolveOrCreateUser(ws: Workspace, nameOrId: string): User {
  if (ws.users.has(nameOrId)) return ws.users.get(nameOrId)!
  const handle = nameOrId.startsWith("@") ? nameOrId.slice(1) : nameOrId
  for (const u of ws.users.values()) if (u.name === handle) return u
  return createUser(ws, { name: handle })
}

function buildUserClient(base: string, user: User, token: string): UserClient {
  async function call(method: string, args: unknown): Promise<any> {
    const res = await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args ?? {}),
    })
    const body = (await res.json()) as { ok: boolean; error?: string; [k: string]: unknown }
    if (!body.ok) throw new Error(`slack api error: ${body.error}`)
    return body
  }
  return {
    user,
    token,
    async sendMessage(channel, text, opts = {}) {
      const out = await call("chat.postMessage", {
        channel,
        text,
        ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}),
      })
      return out.message as Message
    },
    async history(channel, opts = {}) {
      const out = await call("conversations.history", {
        channel,
        ...(opts.latest ? { latest: opts.latest } : {}),
        ...(opts.oldest ? { oldest: opts.oldest } : {}),
        ...(opts.limit ? { limit: opts.limit } : {}),
        ...(opts.inclusive ? { inclusive: opts.inclusive } : {}),
      })
      return out.messages as Message[]
    },
  }
}

function appSummary(app: ReturnType<Workspace["apps"]["get"]> & {}) {
  return {
    id: app.id,
    name: app.name,
    bot_id: app.bot_id,
    bot_user_id: app.bot_user_id,
    scopes: app.scopes,
    subscribed_events: app.subscribed_events,
  }
}

function snapshotWorkspace(ws: Workspace): WorkspaceSnapshot {
  const channels: WorkspaceSnapshot["channels"] = []
  for (const ch of ws.channels.values()) {
    const messages = Array.from(ch.messages.values())
    channels.push({ ...(ch as Channel & { messages: Map<string, Message> }), messages })
  }
  return {
    team: ws.team,
    users: Array.from(ws.users.values()),
    channels,
    apps: Array.from(ws.apps.values()).map((a) => appSummary(a)),
  }
}
