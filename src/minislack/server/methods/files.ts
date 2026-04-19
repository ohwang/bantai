/**
 * files.* — uploads (v1 + v2), info, serving.
 *
 * v1 multipart (`files.upload`) and v2 two-step external
 * (`files.getUploadURLExternal` + `files.completeUploadExternal`) both land
 * here. Byte streaming (`/files/:id`, `/_files/upload/:token`) lives in
 * server/http.ts because it bypasses the API dispatch layer.
 */

import { MinislackError } from "../../core/channels"
import {
  attachFileToMessage,
  consumePending,
  createFileRecord,
  reserveUpload,
} from "../../core/files"
import { postMessage } from "../../core/messages"
import { messageToMessageEvent } from "../../core/event-mappers"
import {
  parseMultipart,
  pickUploadFile,
  type MultipartFilePart,
} from "../multipart"
import type { EventBus } from "../../core/events"
import type { File, Workspace } from "../../types/slack"
import type { AuthContext } from "../auth"

// ---------------------------------------------------------------------------
// v1 — multipart files.upload
// ---------------------------------------------------------------------------

export interface FilesUploadV1Response {
  ok: true
  file: File
}

/**
 * Slack's v1 `files.upload`. Accepts the raw Request so we can decode
 * multipart once without forcing the caller to pre-parse it.
 *
 * Three body shapes, all matching real Slack:
 *   - multipart/form-data with a `file` part (bytes + filename)
 *   - multipart/form-data with only a `content` string field
 *   - application/x-www-form-urlencoded (or JSON) with `content`
 *
 * Returns `no_file_data` when neither a file part nor `content` is set,
 * mirroring Slack's behaviour.
 */
export async function filesUploadV1(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  req: Request,
  baseHttp: () => string,
): Promise<FilesUploadV1Response> {
  const userId = ctx.userId
  if (!userId) throw new MinislackError("not_authed", "files.upload requires a user or bot token")

  const source = await readUploadSource(req)

  const channelsCsv = source.fields.channels ?? ""
  const channelIds = channelsCsv
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((idOrName) => resolveChannelId(ws, idOrName))

  const filetypeHint = source.fields.filetype
  const filenameField = source.fields.filename

  let bytes: Uint8Array
  let filename: string
  let mimetype: string
  if (source.part) {
    bytes = source.part.bytes
    filename = filenameField || source.part.filename
    mimetype = filetypeHint
      ? normaliseMime(filetypeHint, source.part.mimetype)
      : source.part.mimetype
  } else if (source.fields.content !== undefined) {
    bytes = new TextEncoder().encode(source.fields.content)
    filename = filenameField || defaultContentFilename(filetypeHint)
    // Pass "" as fallback so the filetype hint drives the MIME — real Slack
    // treats `content` as a text-body primitive and derives type from hint.
    mimetype = filetypeHint ? normaliseMime(filetypeHint, "") : "text/plain"
  } else {
    throw new MinislackError("no_file_data", "files.upload requires a file part or content field")
  }

  const title = source.fields.title

  const file = createFileRecord(ws, baseHttp, {
    user: userId,
    name: filename,
    title,
    mimetype,
    bytes,
    channels: [],
  })

  const initialComment = source.fields.initial_comment?.trim()
  const threadTs = source.fields.thread_ts?.trim() || undefined

  // Attach to each channel. If an initial_comment is set, post a message per
  // channel with the file attached (Slack's v1 behaviour). Otherwise, create
  // a lightweight file-share message so the file shows up in history.
  for (const channelId of channelIds) {
    const msg = postMessage(ws, {
      channelId,
      userId,
      text: initialComment ?? "",
      files: [file],
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(ctx.kind === "bot"
        ? { bot_id: ctx.botId, app_id: ctx.appId }
        : {}),
    })
    attachFileToMessage(ws, bus, file.id, channelId, msg.ts)
    // Publish the message event so SSE/web sees the new post instantly.
    const ch = ws.channels.get(channelId)
    if (ch) bus.publish(messageToMessageEvent(msg, ch))
  }

  return { ok: true, file }
}

/**
 * Normalised source for the v1 upload pipeline. Either a multipart file
 * part (bytes + filename) is present, or the caller passed `content` in
 * the fields map — both paths feed the same downstream create + attach
 * logic.
 */
interface UploadSource {
  fields: Record<string, string>
  part?: MultipartFilePart
}

async function readUploadSource(req: Request): Promise<UploadSource> {
  const ct = req.headers.get("content-type") ?? ""
  if (ct.includes("multipart/form-data")) {
    const parsed = await parseMultipart(req)
    const part = pickUploadFile(parsed)
    return part ? { fields: parsed.fields, part } : { fields: parsed.fields }
  }

  if (ct.includes("application/json")) {
    const body = await safeJson(req)
    return { fields: stringifyFields(body) }
  }

  if (ct.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData()
    const fields: Record<string, string> = {}
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") fields[k] = v
    }
    return { fields }
  }

  // Real Slack tolerates raw querystring bodies too (legacy clients).
  const text = await req.text()
  if (text) {
    const params = new URLSearchParams(text)
    const fields: Record<string, string> = {}
    for (const [k, v] of params.entries()) fields[k] = v
    return { fields }
  }
  return { fields: {} }
}

async function safeJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function stringifyFields(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue
    out[k] = typeof v === "string" ? v : String(v)
  }
  return out
}

function defaultContentFilename(filetypeHint: string | undefined): string {
  const ext = filetypeHint?.trim().toLowerCase()
  return ext ? `upload.${ext}` : "upload.txt"
}

// ---------------------------------------------------------------------------
// v2 — files.getUploadURLExternal
// ---------------------------------------------------------------------------

export interface GetUploadURLExternalArgs {
  filename?: string
  length?: number | string
}

export interface GetUploadURLExternalResponse {
  ok: true
  upload_url: string
  file_id: string
}

export function filesGetUploadURLExternal(
  ws: Workspace,
  ctx: AuthContext,
  args: GetUploadURLExternalArgs,
  baseHttp: () => string,
): GetUploadURLExternalResponse {
  const userId = ctx.userId
  if (!userId) throw new MinislackError("not_authed")
  const filename = args.filename?.trim()
  if (!filename) throw new MinislackError("invalid_arguments", "filename is required")

  const length = typeof args.length === "string" ? Number(args.length) : args.length ?? 0
  if (!Number.isFinite(length) || length < 0) {
    throw new MinislackError("invalid_arguments", "length must be a non-negative number")
  }

  const { fileId, token } = reserveUpload(ws, {
    user: userId,
    filename,
    length: length as number,
  })

  const base = baseHttp().replace(/\/$/, "")
  return {
    ok: true,
    upload_url: `${base}/_files/upload/${token}`,
    file_id: fileId,
  }
}

// ---------------------------------------------------------------------------
// v2 — files.completeUploadExternal
// ---------------------------------------------------------------------------

export interface CompleteUploadExternalArgs {
  files: Array<{ id: string; title?: string }>
  channels?: string  // Slack accepts comma-separated ids here
  channel_id?: string
  thread_ts?: string
  initial_comment?: string
}

export interface CompleteUploadExternalResponse {
  ok: true
  files: File[]
}

export function filesCompleteUploadExternal(
  ws: Workspace,
  bus: EventBus,
  ctx: AuthContext,
  args: CompleteUploadExternalArgs,
  baseHttp: () => string,
): CompleteUploadExternalResponse {
  const userId = ctx.userId
  if (!userId) throw new MinislackError("not_authed")
  if (!Array.isArray(args.files) || args.files.length === 0) {
    throw new MinislackError("invalid_arguments", "files[] required")
  }

  const channelIds = collectChannels(args)
    .map((idOrName) => resolveChannelId(ws, idOrName))

  const finalised: File[] = []
  for (const entry of args.files) {
    if (!entry || typeof entry.id !== "string") {
      throw new MinislackError("invalid_arguments", "each file must have an id")
    }
    const pending = consumePending(ws, entry.id)
    if (!pending) throw new MinislackError("file_not_found", entry.id)
    if (!pending.bytes) throw new MinislackError("upload_incomplete", entry.id)

    const mime = inferMimeFromFilename(pending.filename)
    const file = createFileRecord(ws, baseHttp, {
      user: pending.user,
      name: pending.filename,
      title: entry.title ?? pending.filename,
      mimetype: mime,
      bytes: pending.bytes,
      fileId: pending.fileId,
    })
    finalised.push(file)
  }

  // Optional: attach each finalised file to every listed channel and post a
  // message (mirrors Slack's completeUploadExternal semantics).
  if (channelIds.length > 0) {
    const initial = args.initial_comment?.trim()
    const threadTs = args.thread_ts?.trim() || undefined
    for (const channelId of channelIds) {
      for (const file of finalised) {
        const msg = postMessage(ws, {
          channelId,
          userId,
          text: initial ?? "",
          files: [file],
          ...(threadTs ? { thread_ts: threadTs } : {}),
          ...(ctx.kind === "bot"
            ? { bot_id: ctx.botId, app_id: ctx.appId }
            : {}),
        })
        attachFileToMessage(ws, bus, file.id, channelId, msg.ts)
        const ch = ws.channels.get(channelId)
        if (ch) bus.publish(messageToMessageEvent(msg, ch))
      }
    }
  }

  return { ok: true, files: finalised }
}

// ---------------------------------------------------------------------------
// files.info
// ---------------------------------------------------------------------------

export interface FilesInfoArgs {
  file: string
}

export interface FilesInfoResponse {
  ok: true
  file: File
}

export function filesInfo(ws: Workspace, args: FilesInfoArgs): FilesInfoResponse {
  const id = args.file?.trim()
  if (!id) throw new MinislackError("invalid_arguments", "file is required")
  const file = ws.files.get(id)
  if (!file) throw new MinislackError("file_not_found", id)
  return { ok: true, file }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveChannelId(ws: Workspace, idOrName: string): string {
  const direct = ws.channels.get(idOrName)
  if (direct) return direct.id
  const handle = idOrName.startsWith("#") ? idOrName.slice(1) : idOrName
  for (const ch of ws.channels.values()) {
    if ("name" in ch && ch.name === handle) return ch.id
  }
  throw new MinislackError("channel_not_found", idOrName)
}

function collectChannels(args: CompleteUploadExternalArgs): string[] {
  const out: string[] = []
  if (args.channel_id) out.push(args.channel_id)
  if (args.channels) {
    for (const c of args.channels.split(",")) {
      const trimmed = c.trim()
      if (trimmed) out.push(trimmed)
    }
  }
  return out
}

function normaliseMime(filetypeHint: string, fallback: string): string {
  // Slack's `filetype` form field is a short code (png, jpg, pdf) — if the
  // browser gave us a concrete MIME, keep it; otherwise hand-map the hint.
  if (fallback && fallback !== "application/octet-stream") return fallback
  const MAP: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
  }
  return MAP[filetypeHint.toLowerCase()] ?? fallback ?? "application/octet-stream"
}

function inferMimeFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop()
  if (!ext) return "application/octet-stream"
  return (
    normaliseMime(ext, "") || "application/octet-stream"
  )
}
