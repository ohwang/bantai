/**
 * Inbound file attachment ingestion (plan §S6).
 *
 * When a user posts a message with attached files, Slack delivers the file
 * metadata (id, name, mimetype, url_private) on the `message` event. The
 * bytes themselves live behind the workspace's authenticated URL — we fetch
 * with the bot token, then:
 *
 *   - images (png / jpg / gif / webp) → base64-embedded into
 *     UserMessage.images so the agent can vision-process them directly
 *     (matches Claude SDK's expected shape).
 *   - everything else → written into a channel-scoped staging directory
 *     and referenced by absolute path in the inbound turn text
 *     ("[attached: /path/to/file.log]"). The agent can then Read/Grep the
 *     file like any other.
 *
 * The staging layout is
 *   <stagingDir>/<channelId>/<ts>/<safe-filename>
 * so each inbound turn gets a fresh subdirectory (no file collisions between
 * turns, easy to GC later by mtime or channel).
 *
 * Pure of launcher glue: this module takes `InboundFile` metadata + a
 * fetcher config and returns a `FetchedAttachments` bundle. The inbox /
 * turn-builder folds the bundle into the outbound UserMessage.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ImageContent } from "../../../protocol/types"
import { log } from "../../../utils/logger"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal slice of the Slack `FileObject` we care about. */
export interface InboundFile {
  id: string
  name?: string
  mimetype?: string
  filetype?: string
  url_private?: string
  url_private_download?: string
}

export interface FetchedAttachments {
  images: ImageContent[]
  /** Absolute paths for non-image attachments written to the staging dir. */
  paths: string[]
  /**
   * Human-readable hint to append to the turn text, listing the attachments
   * that landed on disk. Empty string when there are no non-image files.
   */
  textHint: string
}

export interface AttachmentFetcherOpts {
  /** Slack bot token used for the authenticated file download. */
  botToken: string
  /** Root directory for the channel-scoped staging tree. */
  stagingDir: string
  /**
   * Override the global fetch. Tests pass a stub that responds with canned
   * bytes without touching the network.
   */
  fetchImpl?: typeof fetch
  /**
   * Optional rewrite for Slack's file URLs — tests pointing at minislack
   * use the workspace url; this fn lets us swap the host if needed.
   */
  rewriteUrl?: (url: string) => string
  /**
   * Maximum number of files to ingest per message. Extras are dropped
   * with a log.warn so a flood doesn't hang the turn on downloads.
   * Defaults to 8.
   */
  maxFilesPerTurn?: number
  /**
   * Skip any file whose size exceeds this many bytes, independent of
   * type. Defaults to 25 MB — Slack's own upload cap.
   */
  maxFileBytes?: number
}

export interface AttachmentFetcher {
  fetch(files: InboundFile[], opts: { channelId: string; ts: string }): Promise<FetchedAttachments>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAttachmentFetcher(
  opts: AttachmentFetcherOpts,
): AttachmentFetcher {
  const fetchImpl = opts.fetchImpl ?? fetch
  const maxFiles = opts.maxFilesPerTurn ?? 8
  const maxBytes = opts.maxFileBytes ?? 25 * 1024 * 1024

  async function downloadOne(file: InboundFile): Promise<Uint8Array | undefined> {
    const url = file.url_private_download ?? file.url_private
    if (!url) {
      log.warn(`slack attachments: ${file.id} missing url_private; skipping`)
      return undefined
    }
    const effective = opts.rewriteUrl ? opts.rewriteUrl(url) : url
    try {
      const resp = await fetchImpl(effective, {
        headers: { Authorization: `Bearer ${opts.botToken}` },
      })
      if (!resp.ok) {
        log.warn(`slack attachments: ${file.id} fetch returned ${resp.status}`)
        return undefined
      }
      const buf = await resp.arrayBuffer()
      if (buf.byteLength > maxBytes) {
        log.warn(
          `slack attachments: ${file.id} exceeds ${maxBytes} bytes; skipping`,
        )
        return undefined
      }
      return new Uint8Array(buf)
    } catch (err) {
      log.warn(`slack attachments: ${file.id} fetch threw: ${String(err)}`)
      return undefined
    }
  }

  return {
    async fetch(files, { channelId, ts }) {
      const images: ImageContent[] = []
      const paths: string[] = []
      if (!files || files.length === 0) {
        return { images, paths, textHint: "" }
      }

      const ingestable = files.slice(0, maxFiles)
      if (files.length > maxFiles) {
        log.warn(
          `slack attachments: dropping ${files.length - maxFiles} extra files (cap=${maxFiles})`,
        )
      }

      const turnDir = join(opts.stagingDir, channelId, ts)
      let dirEnsured = false

      for (const file of ingestable) {
        const bytes = await downloadOne(file)
        if (!bytes) continue

        const mime = (file.mimetype ?? "").toLowerCase()
        const imageMediaType = asSupportedImageType(mime)
        if (imageMediaType) {
          images.push({
            mediaType: imageMediaType,
            data: bytesToBase64(bytes),
          })
          continue
        }

        if (!dirEnsured) {
          await mkdir(turnDir, { recursive: true })
          dirEnsured = true
        }
        const safeName = sanitiseFilename(file.name ?? `${file.id}.bin`)
        const absPath = join(turnDir, safeName)
        try {
          await writeFile(absPath, bytes)
          paths.push(absPath)
        } catch (err) {
          log.warn(
            `slack attachments: write failed for ${file.id} → ${absPath}: ${String(err)}`,
          )
        }
      }

      const textHint = renderTextHint(paths)
      return { images, paths, textHint }
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUPPORTED_IMAGE_TYPES: Record<string, ImageContent["mediaType"]> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
}

function asSupportedImageType(mime: string): ImageContent["mediaType"] | undefined {
  return SUPPORTED_IMAGE_TYPES[mime]
}

function sanitiseFilename(name: string): string {
  // Collapse whitespace + strip anything but [A-Za-z0-9._-]. Preserves
  // extensions so agent tools can pick the right reader.
  const base = name.replace(/\s+/g, "_")
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "")
  if (safe.length > 0) return safe.slice(0, 120)
  return "attachment.bin"
}

function bytesToBase64(bytes: Uint8Array): string {
  // Slack SDK image payloads are plain base64 (no data URI prefix).
  // Bun ships `Buffer`; fall back to Uint8Array reduction if not present.
  const Buf = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer
  if (Buf) return Buf.from(bytes).toString("base64")
  // Slow path — only hit in environments without Buffer (never in Bun).
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export function renderTextHint(paths: string[]): string {
  if (paths.length === 0) return ""
  const bullets = paths.map((p) => `[attached: ${p}]`).join("\n")
  return `\n\n${bullets}`
}
