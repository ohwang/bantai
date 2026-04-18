/**
 * Files — file records + in-memory byte store + attach-to-message helper.
 *
 * Phase 7 scope: `File` records live in `ws.files` (already declared on the
 * Workspace). The raw bytes live in a separate module-level map keyed by
 * workspace reference, kept out of the Workspace snapshot intentionally —
 * Phase 8 (persist) will teach the storage layer to write bytes separately
 * from the JSON state.
 *
 * Two upload flows share these helpers:
 *   - v1 `files.upload` — multipart body, single request.
 *   - v2 `files.getUploadURLExternal` + `files.completeUploadExternal` —
 *     two-step flow. Pending uploads (id + bytes, if already uploaded) live
 *     in a second per-workspace map.
 */

import { nextId } from "./ids"
import { MinislackError } from "./channels"
import type { EventBus } from "./events"
import type { File, Message, Workspace } from "../types/slack"

// ---------------------------------------------------------------------------
// Per-workspace byte + pending-upload stores (kept outside the Workspace
// object so snapshots stay lean and JSON-serialisable).
// ---------------------------------------------------------------------------

const bytesByWorkspace = new WeakMap<Workspace, Map<string, Uint8Array>>()
const pendingByWorkspace = new WeakMap<Workspace, Map<string, PendingUpload>>()

export interface PendingUpload {
  /** The minted F… id the complete step will finalise. */
  fileId: string
  user: string
  filename: string
  /** Byte length promised at getUploadURLExternal time. */
  length: number
  /** Bytes land here once the client PUTs to /_files/upload/:token. */
  bytes?: Uint8Array
  /** ms since epoch the reservation was created (no TTL enforcement in v0). */
  created: number
}

function getBytesMap(ws: Workspace): Map<string, Uint8Array> {
  let map = bytesByWorkspace.get(ws)
  if (!map) {
    map = new Map()
    bytesByWorkspace.set(ws, map)
  }
  return map
}

function getPendingMap(ws: Workspace): Map<string, PendingUpload> {
  let map = pendingByWorkspace.get(ws)
  if (!map) {
    map = new Map()
    pendingByWorkspace.set(ws, map)
  }
  return map
}

// ---------------------------------------------------------------------------
// File record creation
// ---------------------------------------------------------------------------

export interface CreateFileRecordOpts {
  user: string
  name: string
  title?: string
  mimetype: string
  bytes: Uint8Array
  channels?: string[]
  groups?: string[]
  ims?: string[]
  /** Pre-minted id (used by the v2 flow to align the pending reservation). */
  fileId?: string
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

/**
 * Create a File record, store its bytes, and return the record.
 * The `baseUrl` thunk supplies the absolute base so `url_private` points at
 * the running server (test port, ephemeral in CI).
 */
export function createFileRecord(
  ws: Workspace,
  baseUrl: () => string,
  opts: CreateFileRecordOpts,
): File {
  const id = opts.fileId ?? nextId(ws, "F")
  const { filetype, pretty_type } = mimeToFiletype(opts.mimetype)
  const created = Math.floor((opts.now?.() ?? Date.now()) / 1000)
  const base = baseUrl().replace(/\/$/, "")
  const url_private = `${base}/files/${id}`
  const url_private_download = `${base}/files/${id}?download=1`

  const file: File = {
    id,
    created,
    user: opts.user,
    name: opts.name,
    title: opts.title ?? opts.name,
    mimetype: opts.mimetype,
    filetype,
    pretty_type,
    size: opts.bytes.byteLength,
    url_private,
    url_private_download,
    channels: opts.channels ? [...opts.channels] : [],
    groups: opts.groups ? [...opts.groups] : [],
    ims: opts.ims ? [...opts.ims] : [],
    // original_w / original_h stay undefined — image decoding is out of v0 scope.
  }
  ws.files.set(id, file)
  getBytesMap(ws).set(id, opts.bytes)
  return file
}

/** Raw bytes for a stored file, or undefined if unknown. */
export function getFileBytes(ws: Workspace, fileId: string): Uint8Array | undefined {
  return getBytesMap(ws).get(fileId)
}

/**
 * Seed bytes for a file id without creating a record. Used by the storage
 * layer during rehydration so that reloaded files serve the same content.
 */
export function setFileBytes(ws: Workspace, fileId: string, bytes: Uint8Array): void {
  getBytesMap(ws).set(fileId, bytes)
}

/**
 * Attach an existing file to a channel's message `files[]` array and emit
 * `file_shared`. Safe to call multiple times — the file id is deduped and
 * the channel id is appended to the file record's channel list only once.
 */
export function attachFileToMessage(
  ws: Workspace,
  bus: EventBus,
  fileId: string,
  channelId: string,
  msgTs: string,
): void {
  const file = ws.files.get(fileId)
  if (!file) throw new MinislackError("file_not_found", fileId)
  const ch = ws.channels.get(channelId)
  if (!ch) throw new MinislackError("channel_not_found", channelId)
  const msg: Message | undefined = ch.messages.get(msgTs)
  if (!msg) throw new MinislackError("message_not_found", msgTs)

  const existing = msg.files ?? []
  if (!existing.some((f) => f.id === fileId)) {
    msg.files = [...existing, file]
  }

  // Track the channel on the file record (mirrors Slack's channels/groups/ims).
  const bucket: "channels" | "groups" | "ims" = ch.is_im
    ? "ims"
    : ch.is_group || ch.is_mpim
      ? "groups"
      : "channels"
  if (!file[bucket].includes(channelId)) file[bucket].push(channelId)

  bus.publish({
    type: "file_shared",
    event_ts: msgTs,
    file_id: fileId,
    user_id: file.user,
    file: { id: fileId },
    channel_id: channelId,
  })
}

// ---------------------------------------------------------------------------
// v2 upload flow — reserve + complete
// ---------------------------------------------------------------------------

export interface ReserveUploadOpts {
  user: string
  filename: string
  length: number
  now?: () => number
}

export interface UploadReservation {
  fileId: string
  token: string
  pending: PendingUpload
}

/**
 * Reserve a file id + upload token. The caller (server) is responsible for
 * turning the token into a URL like `${base}/_files/upload/${token}`.
 */
export function reserveUpload(
  ws: Workspace,
  opts: ReserveUploadOpts,
): UploadReservation {
  const fileId = nextId(ws, "F")
  // Token is distinct from the id — real Slack tokens are opaque. We just
  // reuse the id for determinism since this is a local fake.
  const token = fileId
  const pending: PendingUpload = {
    fileId,
    user: opts.user,
    filename: opts.filename,
    length: opts.length,
    created: opts.now?.() ?? Date.now(),
  }
  getPendingMap(ws).set(token, pending)
  return { fileId, token, pending }
}

/**
 * Stash bytes for a pending upload. Called by the PUT /_files/upload/:token
 * handler. Returns true if the token matched, false otherwise.
 */
export function storePendingBytes(
  ws: Workspace,
  token: string,
  bytes: Uint8Array,
): boolean {
  const pending = getPendingMap(ws).get(token)
  if (!pending) return false
  pending.bytes = bytes
  return true
}

export function peekPending(ws: Workspace, token: string): PendingUpload | undefined {
  return getPendingMap(ws).get(token)
}

/**
 * Consume a pending upload — returns the record and drops the reservation.
 * Used by files.completeUploadExternal.
 */
export function consumePending(ws: Workspace, token: string): PendingUpload | undefined {
  const map = getPendingMap(ws)
  const pending = map.get(token)
  if (!pending) return undefined
  map.delete(token)
  return pending
}

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

interface MimeMapping {
  filetype: string
  pretty_type: string
}

const MIME_TABLE: Record<string, MimeMapping> = {
  "image/png": { filetype: "png", pretty_type: "PNG" },
  "image/jpeg": { filetype: "jpg", pretty_type: "JPEG" },
  "image/jpg": { filetype: "jpg", pretty_type: "JPEG" },
  "image/gif": { filetype: "gif", pretty_type: "GIF" },
  "image/webp": { filetype: "webp", pretty_type: "WebP" },
  "image/svg+xml": { filetype: "svg", pretty_type: "SVG" },
  "application/pdf": { filetype: "pdf", pretty_type: "PDF" },
  "application/json": { filetype: "json", pretty_type: "JSON" },
  "text/plain": { filetype: "txt", pretty_type: "Plain Text" },
  "text/markdown": { filetype: "md", pretty_type: "Markdown" },
  "text/html": { filetype: "html", pretty_type: "HTML" },
}

export function mimeToFiletype(mime: string): MimeMapping {
  const lower = mime.toLowerCase().split(";")[0]?.trim() ?? ""
  const hit = MIME_TABLE[lower]
  if (hit) return hit
  // Fallback: use the suffix after the slash, or "bin".
  const parts = lower.split("/")
  const tail = parts.length > 1 ? parts[1] ?? "" : ""
  const filetype = tail && /^[a-z0-9]+$/.test(tail) ? tail : "bin"
  return { filetype, pretty_type: filetype.toUpperCase() }
}
