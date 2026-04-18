/**
 * Thin fetch wrappers around /api/* (Slack-protocol surface) and
 * /_minislack/* (internal SPA surface).
 *
 * Slack responses come back as { ok: boolean, error?: string, ...payload }.
 * We throw on ok:false so callers don't need to check every result.
 */

import type { Channel, File as SlackFile, Message, User, Workspace } from "../types/slack"

export class SlackApiError extends Error {
  readonly code: string
  constructor(code: string) {
    super(`slack api error: ${code}`)
    this.code = code
    this.name = "SlackApiError"
  }
}

async function callSlack<T>(path: string, token: string | undefined, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  }
  const res = await fetch(path, init)
  const data = (await res.json()) as { ok: boolean; error?: string; [k: string]: unknown }
  if (!data.ok) throw new SlackApiError(data.error ?? "unknown_error")
  return data as unknown as T
}

async function callInternal<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`internal api ${path}: ${res.status}`)
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// Slack-protocol wrappers
// ---------------------------------------------------------------------------

export interface HistoryResp { ok: true; channel: string; messages: Message[]; has_more: boolean }

export function authTest(token: string) {
  return callSlack<{ ok: true; user: string; user_id: string; team: string }>("/api/auth.test", token)
}

export function postMessage(token: string, channel: string, text: string, thread_ts?: string) {
  return callSlack<{ ok: true; channel: string; ts: string; message: Message }>(
    "/api/chat.postMessage",
    token,
    { channel, text, ...(thread_ts ? { thread_ts } : {}) },
  )
}

export function conversationsList(token: string) {
  return callSlack<{ ok: true; channels: Channel[] }>(
    "/api/conversations.list",
    token,
    { types: "public_channel,private_channel,mpim,im" },
  )
}

export function conversationsHistory(token: string, channel: string, limit = 200) {
  return callSlack<HistoryResp>("/api/conversations.history", token, { channel, limit })
}

export interface RepliesResp { ok: true; messages: Message[]; has_more: boolean }

export function conversationsReplies(token: string, channel: string, ts: string, limit = 500) {
  return callSlack<RepliesResp>("/api/conversations.replies", token, { channel, ts, limit })
}

export function reactionsAdd(token: string, channel: string, timestamp: string, name: string) {
  return callSlack<{ ok: true }>("/api/reactions.add", token, { channel, timestamp, name })
}

export function reactionsRemove(token: string, channel: string, timestamp: string, name: string) {
  return callSlack<{ ok: true }>("/api/reactions.remove", token, { channel, timestamp, name })
}

export interface EmojiListResp {
  ok: true
  emoji: Record<string, string>
  categories_version: string
  categories: Array<{ name: string; emoji_names: string[] }>
}

export function emojiList() {
  return callSlack<EmojiListResp>("/api/emoji.list", undefined)
}

export async function openConversation(
  token: string,
  opts: { users?: string; channel?: string },
): Promise<Channel> {
  const out = await callSlack<{ ok: true; channel: Channel }>(
    "/api/conversations.open",
    token,
    opts,
  )
  return out.channel
}

export function closeConversation(token: string, channel: string) {
  return callSlack<{ ok: true }>("/api/conversations.close", token, { channel })
}

export interface FilesUploadResp {
  ok: true
  file: SlackFile
}

/**
 * v1 multipart `files.upload`. `channel` is a comma-separated list of channel
 * ids (Slack convention). `initialComment` is posted as a message alongside
 * the file attachment.
 */
export async function uploadFile(
  token: string,
  channels: string,
  file: File | Blob,
  filename: string,
  initialComment?: string,
): Promise<FilesUploadResp> {
  const fd = new FormData()
  fd.append("channels", channels)
  fd.append("filename", filename)
  if (initialComment) fd.append("initial_comment", initialComment)
  fd.append("file", file, filename)
  const res = await fetch("/api/files.upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  })
  const data = (await res.json()) as { ok: boolean; error?: string; [k: string]: unknown }
  if (!data.ok) throw new SlackApiError(data.error ?? "unknown_error")
  return data as unknown as FilesUploadResp
}

// ---------------------------------------------------------------------------
// Internal /_minislack/* (no auth — dev tool on localhost)
// ---------------------------------------------------------------------------

export interface WorkspaceSummary {
  team: Workspace["team"]
  users: User[]
  channels: Channel[]
}

export function getWorkspace() {
  return callInternal<WorkspaceSummary>("/_minislack/workspace")
}

export function createNewUser(name: string) {
  return fetch("/_minislack/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then(async (r) => {
    const body = (await r.json()) as { ok: boolean; user?: User; token?: string; error?: string }
    if (!body.ok || !body.user || !body.token) throw new Error(body.error ?? "create_user_failed")
    return body
  })
}

export function getUserToken(userId: string) {
  return fetch(`/_minislack/token/${userId}`).then(async (r) => {
    const body = (await r.json()) as { ok: boolean; token?: string; error?: string }
    if (!body.ok || !body.token) throw new Error(body.error ?? "token_fetch_failed")
    return body.token
  })
}
