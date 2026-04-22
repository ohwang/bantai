/**
 * 3-step file upload helper (Slack v2) — plan §8.4 "file snippet" fallback.
 *
 *   1. files.getUploadURLExternal(filename, length)      → { upload_url, file_id }
 *   2. POST bytes to upload_url                          (multipart)
 *   3. files.completeUploadExternal(files, channel_id?, thread_ts?, initial_comment?)
 *
 * This wraps the three calls into one `uploadFile()` function. Optional
 * channel_id + thread_ts means the upload can either stand alone (returns
 * the file id; caller posts a link) or auto-post into a thread with an
 * initial comment.
 *
 * Pure of IO adapter — takes a narrow `SlackFileClient` surface so tests
 * can inject a fake without standing up a live WebClient.
 */

import type { App } from "@slack/bolt"
import { log } from "../../../utils/logger"

export interface UploadFileInput {
  /** Filename as it should appear in Slack. */
  filename: string
  /** Raw body (string or bytes). Strings are UTF-8 encoded. */
  content: string | Uint8Array
  /** Optional title override (defaults to filename). */
  title?: string
  /** Channel to post the file share into. When absent, file uploads without
   *  posting a share message — caller gets the permalink. */
  channel?: string
  /** Thread ts for the file share (requires channel). */
  threadTs?: string
  /** Optional comment posted above the file share. */
  initialComment?: string
}

export interface UploadResult {
  fileId: string
  permalink?: string
  name: string
}

export interface SlackFileClient {
  getUploadURLExternal(args: { filename: string; length: number }): Promise<{
    ok: boolean
    upload_url?: string
    file_id?: string
    error?: string
  }>
  postUploadBytes(args: {
    uploadUrl: string
    content: Uint8Array
    contentType: string
    filename: string
  }): Promise<void>
  completeUploadExternal(args: {
    files: Array<{ id: string; title?: string }>
    channel_id?: string
    thread_ts?: string
    initial_comment?: string
  }): Promise<{
    ok: boolean
    files?: Array<{ id: string; name?: string; permalink?: string }>
    error?: string
  }>
}

export async function uploadFile(
  client: SlackFileClient,
  input: UploadFileInput,
): Promise<UploadResult> {
  const bytes = asBytes(input.content)

  // 1. Reserve the upload URL.
  const reserve = await client.getUploadURLExternal({
    filename: input.filename,
    length: bytes.byteLength,
  })
  if (!reserve.ok || !reserve.upload_url || !reserve.file_id) {
    throw new Error(
      `files.getUploadURLExternal failed: ${reserve.error ?? "unknown"}`,
    )
  }

  // 2. POST the bytes to the presigned upload endpoint.
  await client.postUploadBytes({
    uploadUrl: reserve.upload_url,
    content: bytes,
    contentType: guessContentType(input.filename),
    filename: input.filename,
  })

  // 3. Finalise.
  const complete = await client.completeUploadExternal({
    files: [
      {
        id: reserve.file_id,
        ...(input.title ? { title: input.title } : {}),
      },
    ],
    ...(input.channel ? { channel_id: input.channel } : {}),
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    ...(input.initialComment ? { initial_comment: input.initialComment } : {}),
  })
  if (!complete.ok) {
    throw new Error(
      `files.completeUploadExternal failed: ${complete.error ?? "unknown"}`,
    )
  }
  const first = complete.files?.[0]
  return {
    fileId: reserve.file_id,
    ...(first?.permalink ? { permalink: first.permalink } : {}),
    name: first?.name ?? input.filename,
  }
}

/**
 * Build a `SlackFileClient` from a raw bot token, without depending on a
 * live Bolt App. This is the variant used by the stdio MCP subprocess
 * (`mcp/slack-upload-stdio.ts`) — the subprocess receives the bot token
 * over env and can't drag Bolt into its process.
 *
 * Keep this pure-`fetch`: Slack's upload endpoints accept either a
 * `Bearer` token on the JSON POSTs, or a presigned URL (no auth header)
 * for the multipart byte POST.
 */
export function buildSlackFileClientFromToken(
  botToken: string,
  opts?: { apiBase?: string; fetchImpl?: typeof fetch },
): SlackFileClient {
  if (!botToken) {
    throw new Error("buildSlackFileClientFromToken: botToken is required")
  }
  const apiBase = opts?.apiBase ?? "https://slack.com/api"
  const doFetch = opts?.fetchImpl ?? fetch

  async function postJson(
    method: "files.getUploadURLExternal" | "files.completeUploadExternal",
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const resp = await doFetch(`${apiBase}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      throw new Error(`${method} HTTP ${resp.status} ${resp.statusText}`)
    }
    return (await resp.json()) as Record<string, unknown>
  }

  return {
    async getUploadURLExternal(args) {
      // Slack insists on application/x-www-form-urlencoded for this
      // endpoint — JSON is silently accepted but historically flaky,
      // and form encoding matches the behaviour of Bolt's client.
      const form = new URLSearchParams()
      form.set("filename", args.filename)
      form.set("length", String(args.length))
      const resp = await doFetch(`${apiBase}/files.getUploadURLExternal`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: form.toString(),
      })
      if (!resp.ok) {
        throw new Error(
          `files.getUploadURLExternal HTTP ${resp.status} ${resp.statusText}`,
        )
      }
      const res = (await resp.json()) as Record<string, unknown>
      return {
        ok: res["ok"] === true,
        ...(typeof res["upload_url"] === "string"
          ? { upload_url: res["upload_url"] as string }
          : {}),
        ...(typeof res["file_id"] === "string"
          ? { file_id: res["file_id"] as string }
          : {}),
        ...(typeof res["error"] === "string"
          ? { error: res["error"] as string }
          : {}),
      }
    },
    async postUploadBytes({ uploadUrl, content, contentType, filename }) {
      const form = new FormData()
      form.append(
        "file",
        new Blob([new Uint8Array(content) as unknown as ArrayBuffer], { type: contentType }),
        filename,
      )
      const resp = await doFetch(uploadUrl, { method: "POST", body: form })
      if (!resp.ok) {
        throw new Error(`upload_url POST failed: ${resp.status} ${resp.statusText}`)
      }
    },
    async completeUploadExternal(args) {
      if (args.files.length === 0) {
        throw new Error("completeUploadExternal requires at least one file")
      }
      const payload: Record<string, unknown> = { files: args.files }
      if (args.channel_id) payload["channel_id"] = args.channel_id
      if (args.thread_ts) payload["thread_ts"] = args.thread_ts
      if (args.initial_comment) payload["initial_comment"] = args.initial_comment
      const res = await postJson("files.completeUploadExternal", payload)
      const filesRaw = Array.isArray(res["files"])
        ? (res["files"] as Array<Record<string, unknown>>)
        : undefined
      return {
        ok: res["ok"] === true,
        ...(filesRaw
          ? {
              files: filesRaw.map((f) => ({
                id: String(f["id"] ?? ""),
                ...(f["name"] ? { name: String(f["name"]) } : {}),
                ...(f["permalink"] ? { permalink: String(f["permalink"]) } : {}),
              })),
            }
          : {}),
        ...(typeof res["error"] === "string" ? { error: res["error"] as string } : {}),
      }
    },
  }
}

/**
 * Build the production `SlackFileClient` from a live Bolt App. Uses the
 * bolt web client for the API calls and plain `fetch` for the presigned
 * bytes POST (Slack's upload endpoint rejects `Authorization` headers).
 */
export function buildSlackFileClient(app: App): SlackFileClient {
  return {
    async getUploadURLExternal(args) {
      const res = await app.client.files.getUploadURLExternal({
        filename: args.filename,
        length: args.length,
      })
      return {
        ok: res.ok === true,
        ...(typeof res.upload_url === "string" ? { upload_url: res.upload_url } : {}),
        ...(typeof res.file_id === "string" ? { file_id: res.file_id } : {}),
        ...(typeof res.error === "string" ? { error: res.error } : {}),
      }
    },
    async postUploadBytes({ uploadUrl, content, contentType, filename }) {
      // Slack's upload_url expects a multipart/form-data POST with the
      // bytes under a `file` field. Content-Type is inferred by Slack from
      // the filename — we still include it as best-practice.
      const form = new FormData()
      form.append(
        "file",
        new Blob([new Uint8Array(content) as unknown as ArrayBuffer], { type: contentType }),
        filename,
      )
      const resp = await fetch(uploadUrl, { method: "POST", body: form })
      if (!resp.ok) {
        throw new Error(`upload_url POST failed: ${resp.status} ${resp.statusText}`)
      }
    },
    async completeUploadExternal(args) {
      if (args.files.length === 0) {
        throw new Error("completeUploadExternal requires at least one file")
      }
      const [head, ...rest] = args.files
      const payload = {
        files: [head!, ...rest],
        ...(args.channel_id ? { channel_id: args.channel_id } : {}),
        ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
        ...(args.initial_comment ? { initial_comment: args.initial_comment } : {}),
      }
      // Bolt's static types require channel_id when thread_ts is set; our
      // runtime call passes the exact subset documented by Slack's API.
      const res = await app.client.files.completeUploadExternal(
        payload as Parameters<typeof app.client.files.completeUploadExternal>[0],
      )
      return {
        ok: res.ok === true,
        ...(res.files
          ? {
              files: res.files.map((f) => ({
                id: String(f.id ?? ""),
                ...(f.name ? { name: String(f.name) } : {}),
                ...(f.permalink ? { permalink: String(f.permalink) } : {}),
              })),
            }
          : {}),
        ...(typeof res.error === "string" ? { error: res.error } : {}),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asBytes(content: string | Uint8Array): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content)
  return content
}

const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  log: "text/plain",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/plain",
  jsx: "text/plain",
  py: "text/plain",
  sh: "text/plain",
  diff: "text/x-diff",
  patch: "text/x-diff",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
}

export function guessContentType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop()
  if (!ext) return "application/octet-stream"
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}

/**
 * Best-effort: skip the file upload if the workspace hasn't granted
 * `files:write`. Logs the error and returns undefined so callers can
 * render a plain-text fallback.
 */
export async function uploadFileBestEffort(
  client: SlackFileClient,
  input: UploadFileInput,
): Promise<UploadResult | undefined> {
  try {
    return await uploadFile(client, input)
  } catch (err) {
    log.warn(`slack upload: ${input.filename} failed: ${String(err)}`)
    return undefined
  }
}
