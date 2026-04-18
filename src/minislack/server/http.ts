/**
 * HTTP dispatch — Web API + (future) web SPA + file serving.
 *
 * Phase 1 coverage: auth.test, apps.connections.open, chat.postMessage,
 * conversations.list, conversations.history, conversations.info.
 *
 * Later phases add more /api/<method> entries in `dispatchMethod`, and
 * mount /files/:id (Phase 7), / + /main.js for the SPA (Phase 2), and
 * /_minislack/events SSE (Phase 2).
 */

import { MinislackError } from "../core/channels"
import { createUser } from "../core/workspace"
import { getFileBytes, storePendingBytes } from "../core/files"
import { extractBearer, resolveToken, userTokenForUser, type AuthContext } from "./auth"
import { authTest } from "./methods/auth"
import {
  appsConnectionsOpen,
  createSocketRegistry,
  type SocketRegistry,
} from "./methods/apps"
import {
  chatDelete,
  chatMeMessage,
  chatPostEphemeral,
  chatPostMessage,
  chatUpdate,
} from "./methods/chat"
import {
  reactionsAdd,
  reactionsGet,
  reactionsRemove,
} from "./methods/reactions"
import {
  conversationsCreate,
  conversationsHistory,
  conversationsInfo,
  conversationsJoin,
  conversationsLeave,
  conversationsList,
  conversationsMembers,
  conversationsOpen,
  conversationsReplies,
} from "./methods/conversations"
import {
  usersConversations,
  usersInfo,
  usersList,
  usersLookupByEmail,
  usersProfileGet,
} from "./methods/users"
import { teamInfo } from "./methods/team"
import { botsInfo } from "./methods/bots"
import { emojiList } from "./methods/emoji"
import {
  filesCompleteUploadExternal,
  filesGetUploadURLExternal,
  filesInfo,
  filesUploadV1,
} from "./methods/files"
import { sseEventsResponse } from "./internal-events"
import type { WebBundle } from "./web-bundle"
import type { Channel, User, Workspace } from "../types/slack"
import type { EventBus } from "../core/events"

export interface HttpContext {
  ws: Workspace
  bus: EventBus
  sockets: SocketRegistry
  /** The base ws:// URL for apps.connections.open. */
  wsBase: () => string
  /** The base http:// URL for file URLs and external upload URLs. */
  baseHttp: () => string
  /** Optional web bundle for the SPA. When absent, / returns a plain text notice. */
  web?: WebBundle
}

export function createSocketsRegistry(): SocketRegistry {
  return createSocketRegistry()
}

/**
 * Top-level request router. Returns a Response for Bun.serve. The caller is
 * responsible for WS upgrades (server.upgrade()) — that's handled in the
 * launcher because only Bun.serve can perform the upgrade.
 */
export async function handleHttp(req: Request, ctx: HttpContext): Promise<Response> {
  const url = new URL(req.url)
  const { pathname } = url

  // Method routing
  if (pathname.startsWith("/api/")) {
    return dispatchApi(req, pathname.slice("/api/".length), ctx)
  }

  // File serving — raw bytes keyed by file id.
  if (pathname.startsWith("/files/") && req.method === "GET") {
    const id = pathname.slice("/files/".length).split("?")[0] ?? ""
    const file = ctx.ws.files.get(id)
    const bytes = getFileBytes(ctx.ws, id)
    if (!file || !bytes) return new Response("file not found", { status: 404 })
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": file.mimetype || "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-cache",
      },
    })
  }

  // v2 upload — the externally-addressable byte upload target. Never called
  // by the Slack API dispatch above; its URL is handed out by
  // files.getUploadURLExternal. Real Slack accepts both a raw `PUT` with the
  // bytes as the body and a `POST multipart/form-data` with the bytes under
  // the `file` field. We honour both here so clients written against either
  // shape (Slack's own @slack/web-api posts multipart, some wrappers PUT
  // raw) round-trip cleanly.
  if (
    pathname.startsWith("/_files/upload/") &&
    (req.method === "PUT" || req.method === "POST")
  ) {
    const token = pathname.slice("/_files/upload/".length).split("?")[0] ?? ""
    const contentType = req.headers.get("content-type") ?? ""
    let bytes: Uint8Array
    if (req.method === "POST" && contentType.includes("multipart/form-data")) {
      const form = await req.formData()
      const part = form.get("file")
      if (!(part instanceof Blob)) {
        return new Response("missing file field", { status: 400 })
      }
      bytes = new Uint8Array(await part.arrayBuffer())
    } else {
      bytes = new Uint8Array(await req.arrayBuffer())
    }
    const ok = storePendingBytes(ctx.ws, token, bytes)
    if (!ok) return new Response("unknown upload token", { status: 404 })
    return new Response("OK", { status: 200 })
  }

  // Internal (dev tool) endpoints
  if (pathname === "/_minislack/events") {
    return sseEventsResponse(ctx.bus)
  }
  if (pathname.startsWith("/_minislack/")) {
    return handleInternal(req, pathname, ctx)
  }

  // Static assets served from the web bundle (index.html, main.js, app.css)
  if (ctx.web) {
    const asset = ctx.web.get(pathname)
    if (asset) {
      return new Response(asset.body, {
        status: 200,
        headers: { "Content-Type": asset.contentType, "Cache-Control": "no-cache" },
      })
    }
  }

  if (pathname === "/") {
    return new Response("minislack — web UI disabled (--no-web). Use /api/* for the Slack-protocol surface.", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })
  }
  if (pathname === "/healthz") {
    return new Response("ok", { status: 200 })
  }
  return new Response("Not Found", { status: 404 })
}

async function handleInternal(req: Request, pathname: string, ctx: HttpContext): Promise<Response> {
  try {
    if (pathname === "/_minislack/workspace" && req.method === "GET") {
      return jsonOk(workspaceSummary(ctx.ws))
    }
    if (pathname === "/_minislack/users" && req.method === "POST") {
      const body = (await safeJson(req)) as { name?: string; real_name?: string; email?: string } | null
      const name = body?.name?.trim()
      if (!name) return jsonErr("missing_name", 400)
      const u = createUser(ctx.ws, {
        name,
        real_name: body?.real_name,
        email: body?.email,
      })
      return jsonOk({ user: u, token: userTokenForUser(u.id) })
    }
    if (pathname.startsWith("/_minislack/token/") && req.method === "GET") {
      const userId = pathname.slice("/_minislack/token/".length)
      const u = ctx.ws.users.get(userId)
      if (!u) return jsonErr("user_not_found", 404)
      return jsonOk({ token: userTokenForUser(u.id) })
    }
    return new Response("not found", { status: 404 })
  } catch (err) {
    console.error("[minislack] internal route error:", err)
    return jsonErr("internal_error", 500)
  }
}

function workspaceSummary(ws: Workspace): {
  team: Workspace["team"]
  users: User[]
  channels: Channel[]
} {
  return {
    team: ws.team,
    users: Array.from(ws.users.values()),
    channels: Array.from(ws.channels.values()).map(stripMessages),
  }
}

function stripMessages(ch: Channel): Channel {
  // The SPA doesn't consume stored messages through /_minislack/workspace —
  // it fetches per-channel via conversations.history instead. Strip the
  // Map<ts, Message> to keep the payload lean and JSON-serializable.
  return { ...ch, messages: new Map() as Channel["messages"] }
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

function jsonOk(payload: object): Response {
  return new Response(JSON.stringify({ ok: true, ...payload }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}

function jsonErr(code: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: code }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}

async function dispatchApi(req: Request, method: string, ctx: HttpContext): Promise<Response> {
  try {
    // files.upload needs the raw Request (multipart) — don't pre-parse.
    // We still need the token up front for auth, but that comes from headers
    // or a form field we can peek at after multipart parsing inside the
    // handler. For uniform auth, extract from the Authorization header here
    // and fall through with an already-consumed body for non-upload methods.
    const isMultipartUpload = method === "files.upload"

    let args: Record<string, unknown>
    if (isMultipartUpload) {
      args = {}
    } else {
      args = await readArgs(req)
    }

    const authHeader = req.headers.get("authorization")
    const token = extractBearer(authHeader) ?? (typeof args.token === "string" ? args.token : undefined)
    const authResult = resolveToken(ctx.ws, token)

    // auth.test and apps.connections.open both require a token
    if (authResult === undefined) {
      return slackError("not_authed")
    }
    if (authResult === null) {
      return slackError("invalid_auth")
    }

    const auth: AuthContext = authResult

    switch (method) {
      case "auth.test":
        return slackOk(authTest(ctx.ws, auth))
      case "apps.connections.open":
        return slackOk(
          appsConnectionsOpen(auth, ctx.wsBase(), ctx.sockets),
        )
      case "chat.postMessage":
        return slackOk(
          chatPostMessage(ctx.ws, ctx.bus, auth, {
            channel: str(args.channel),
            text: args.text as string | undefined,
            thread_ts: args.thread_ts as string | undefined,
            reply_broadcast: toBool(args.reply_broadcast),
            blocks: args.blocks as chatBlocks,
            attachments: args.attachments as chatAttachments,
            client_msg_id: args.client_msg_id as string | undefined,
          }),
        )
      case "chat.update":
        return slackOk(
          chatUpdate(ctx.ws, ctx.bus, auth, {
            channel: str(args.channel),
            ts: str(args.ts),
            text: args.text as string | undefined,
            blocks: args.blocks as chatBlocks,
            attachments: args.attachments as chatAttachments,
          }),
        )
      case "chat.delete":
        return slackOk(
          chatDelete(ctx.ws, ctx.bus, auth, {
            channel: str(args.channel),
            ts: str(args.ts),
          }),
        )
      case "chat.postEphemeral":
        return slackOk(
          chatPostEphemeral(ctx.ws, ctx.bus, auth, {
            channel: str(args.channel),
            user: str(args.user),
            text: args.text as string | undefined,
            blocks: args.blocks as chatBlocks,
            attachments: args.attachments as chatAttachments,
            thread_ts: args.thread_ts as string | undefined,
          }),
        )
      case "chat.meMessage":
        return slackOk(
          chatMeMessage(ctx.ws, ctx.bus, auth, {
            channel: str(args.channel),
            text: str(args.text),
          }),
        )
      case "reactions.add":
        return slackOk(
          reactionsAdd(ctx.ws, ctx.bus, auth, {
            channel: str(args.channel),
            timestamp: str(args.timestamp),
            name: str(args.name),
          }),
        )
      case "reactions.remove":
        return slackOk(
          reactionsRemove(ctx.ws, ctx.bus, auth, {
            channel: str(args.channel),
            timestamp: str(args.timestamp),
            name: str(args.name),
          }),
        )
      case "reactions.get":
        return slackOk(
          reactionsGet(ctx.ws, {
            channel: str(args.channel),
            timestamp: str(args.timestamp),
            full: toBool(args.full),
          }),
        )
      case "conversations.list":
        return slackOk(
          conversationsList(ctx.ws, {
            types: args.types as string | undefined,
            exclude_archived: toBool(args.exclude_archived),
            limit: toNum(args.limit),
            cursor: args.cursor as string | undefined,
          }),
        )
      case "conversations.history":
        return slackOk(
          conversationsHistory(ctx.ws, {
            channel: str(args.channel),
            latest: args.latest as string | undefined,
            oldest: args.oldest as string | undefined,
            inclusive: toBool(args.inclusive),
            limit: toNum(args.limit),
          }),
        )
      case "conversations.info":
        return slackOk(conversationsInfo(ctx.ws, { channel: str(args.channel) }))
      case "conversations.members":
        return slackOk(
          conversationsMembers(ctx.ws, {
            channel: str(args.channel),
            limit: toNum(args.limit),
            cursor: args.cursor as string | undefined,
          }),
        )
      case "conversations.join": {
        if (!auth.userId) throw new MinislackError("not_authed")
        return slackOk(
          conversationsJoin(ctx.ws, ctx.bus, auth.userId, {
            channel: str(args.channel),
          }),
        )
      }
      case "conversations.leave": {
        if (!auth.userId) throw new MinislackError("not_authed")
        return slackOk(
          conversationsLeave(ctx.ws, ctx.bus, auth.userId, {
            channel: str(args.channel),
          }),
        )
      }
      case "conversations.create": {
        if (!auth.userId) throw new MinislackError("not_authed")
        return slackOk(
          conversationsCreate(ctx.ws, ctx.bus, auth.userId, {
            name: str(args.name),
            is_private: toBool(args.is_private),
          }),
        )
      }
      case "conversations.replies":
        return slackOk(
          conversationsReplies(ctx.ws, {
            channel: str(args.channel),
            ts: str(args.ts),
            latest: args.latest as string | undefined,
            oldest: args.oldest as string | undefined,
            inclusive: toBool(args.inclusive),
            limit: toNum(args.limit),
          }),
        )
      case "conversations.open": {
        if (!auth.userId) throw new MinislackError("not_authed")
        const result = conversationsOpen(ctx.ws, auth.userId, {
          users: args.users as string | undefined,
          channel: args.channel as string | undefined,
          return_im: toBool(args.return_im),
        })
        const ch = result.channel
        if (!result.already_open && (ch.is_im || ch.is_mpim)) {
          ctx.bus.publish({
            type: "im_open",
            event_ts: `${Math.floor(Date.now() / 1000)}.000000`,
            user: auth.userId,
            channel: ch.id,
          })
        }
        return slackOk(result)
      }
      case "conversations.close": {
        if (!auth.userId) throw new MinislackError("not_authed")
        const chId = str(args.channel)
        const ch = ctx.ws.channels.get(chId)
        if (!ch) throw new MinislackError("channel_not_found", chId)
        if (!(ch.is_im || ch.is_mpim)) {
          throw new MinislackError("method_not_supported_for_channel_type")
        }
        const wasOpen = ch.is_open
        ch.is_open = false
        if (wasOpen) {
          ctx.bus.publish({
            type: "im_close",
            event_ts: `${Math.floor(Date.now() / 1000)}.000000`,
            user: auth.userId,
            channel: ch.id,
          })
        }
        return slackOk({ ok: true, no_op: !wasOpen, already_closed: !wasOpen })
      }
      case "users.list":
        return slackOk(
          usersList(ctx.ws, {
            include_deleted: toBool(args.include_deleted),
            limit: toNum(args.limit),
            cursor: args.cursor as string | undefined,
          }),
        )
      case "users.info":
        return slackOk(usersInfo(ctx.ws, { user: str(args.user) }))
      case "users.lookupByEmail":
        return slackOk(
          usersLookupByEmail(ctx.ws, { email: args.email as string | undefined }),
        )
      case "team.info":
        return slackOk(teamInfo(ctx.ws))
      case "bots.info":
        return slackOk(botsInfo(ctx.ws, { bot: args.bot as string | undefined }))
      case "emoji.list":
        return slackOk(emojiList(ctx.ws))
      case "users.conversations":
        return slackOk(
          usersConversations(ctx.ws, auth, {
            user: args.user as string | undefined,
            types: args.types as string | undefined,
            exclude_archived: toBool(args.exclude_archived),
            limit: toNum(args.limit),
            cursor: args.cursor as string | undefined,
          }),
        )
      case "users.profile.get":
        return slackOk(
          usersProfileGet(ctx.ws, auth, {
            user: args.user as string | undefined,
          }),
        )
      case "files.upload":
        return slackOk(await filesUploadV1(ctx.ws, ctx.bus, auth, req, ctx.baseHttp))
      case "files.getUploadURLExternal":
        return slackOk(
          filesGetUploadURLExternal(
            ctx.ws,
            auth,
            {
              filename: args.filename as string | undefined,
              length: args.length as number | string | undefined,
            },
            ctx.baseHttp,
          ),
        )
      case "files.completeUploadExternal":
        return slackOk(
          filesCompleteUploadExternal(
            ctx.ws,
            ctx.bus,
            auth,
            {
              files: args.files as Array<{ id: string; title?: string }>,
              channels: args.channels as string | undefined,
              channel_id: args.channel_id as string | undefined,
              thread_ts: args.thread_ts as string | undefined,
              initial_comment: args.initial_comment as string | undefined,
            },
            ctx.baseHttp,
          ),
        )
      case "files.info":
        return slackOk(filesInfo(ctx.ws, { file: str(args.file) }))
      default:
        return slackError("unknown_method")
    }
  } catch (err) {
    if (err instanceof MinislackError) {
      return slackError(err.code)
    }
    console.error("[minislack] unhandled error:", err)
    return slackError("internal_error")
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type chatBlocks = Parameters<typeof chatPostMessage>[3]["blocks"]
type chatAttachments = Parameters<typeof chatPostMessage>[3]["attachments"]

function slackOk(payload: unknown): Response {
  // Slack always returns { ok: true, ...payload } at the top level — mix them.
  const body = payload && typeof payload === "object" ? { ...(payload as object) } : { ok: true }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}

function slackError(code: string): Response {
  return new Response(JSON.stringify({ ok: false, error: code }), {
    status: 200, // Slack replies 200 with ok:false
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}

async function readArgs(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET") {
    const url = new URL(req.url)
    const out: Record<string, unknown> = {}
    for (const [k, v] of url.searchParams.entries()) out[k] = v
    return out
  }
  const ct = req.headers.get("content-type") ?? ""
  if (ct.includes("application/json")) {
    try {
      const body = (await req.json()) as unknown
      return body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await req.formData()
    const out: Record<string, unknown> = {}
    for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? coerceFormField(k, v) : v
    return out
  }
  // Unknown content-type — try JSON, then fall back to querystring
  try {
    const body = (await req.json()) as unknown
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  } catch {
    const url = new URL(req.url)
    const out: Record<string, unknown> = {}
    for (const [k, v] of url.searchParams.entries()) out[k] = coerceFormField(k, v)
    return out
  }
}

/**
 * Real Slack accepts `blocks`, `attachments`, `files`, and `metadata` as
 * JSON-encoded strings under form-urlencoded / multipart bodies. bolt-js
 * serializes them that way by default. Parse them eagerly so downstream
 * `Array.isArray` checks work the same on JSON vs form callers.
 */
const JSON_FORM_FIELDS = new Set(["blocks", "attachments", "files", "metadata", "authorizations", "options"])

function coerceFormField(key: string, value: string): unknown {
  if (!JSON_FORM_FIELDS.has(key)) return value
  const trimmed = value.trim()
  if (trimmed.length === 0) return value
  const first = trimmed[0]
  if (first !== "[" && first !== "{") return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function str(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new MinislackError("invalid_arguments", "expected string")
  }
  return v
}

function toBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === "boolean") return v
  if (typeof v === "string") return v === "true" || v === "1"
  return undefined
}

function toNum(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === "number") return v
  if (typeof v === "string") {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
