/** @jsxImportSource solid-js */
/**
 * Client-side state. Two providers:
 *
 *   SessionContext    — current user + token, backed by sessionStorage so
 *                       each browser tab is its own "user" without cookies.
 *   WorkspaceContext  — users, channels, and a messages-by-channel store
 *                       that folds SSE events in as they arrive.
 *
 * Mirrors bantai's provider-per-domain pattern and the reducer-fed store
 * used in `src/frontends/tui/context/sync.tsx`. Different framework output,
 * same shape.
 */

import { createContext, useContext, createSignal, onCleanup, batch, type ParentComponent, type Accessor } from "solid-js"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import { emojiList, getWorkspace, getUserToken, type WorkspaceSummary } from "./api"
import { subscribeEvents } from "./events"
import type { Channel, Message, User } from "../types/slack"
import type { MessageEvent, SlackEvent } from "../types/events"

// ---------------------------------------------------------------------------
// Session — current user + token (per tab)
// ---------------------------------------------------------------------------

const SESSION_KEY = "minislack.session.v1"

interface SessionRecord {
  userId: string
  token: string
}

interface SessionValue {
  current: Accessor<SessionRecord | null>
  login(userId: string): Promise<void>
  loginWith(record: SessionRecord): void
  logout(): void
}

const SessionContext = createContext<SessionValue>()

export const SessionProvider: ParentComponent = (props) => {
  const [current, setCurrent] = createSignal<SessionRecord | null>(readSession())

  const value: SessionValue = {
    current,
    async login(userId) {
      const token = await getUserToken(userId)
      const record = { userId, token }
      persistSession(record)
      setCurrent(record)
    },
    loginWith(record) {
      persistSession(record)
      setCurrent(record)
    },
    logout() {
      sessionStorage.removeItem(SESSION_KEY)
      setCurrent(null)
    },
  }
  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error("useSession outside SessionProvider")
  return ctx
}

function readSession(): SessionRecord | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    return JSON.parse(raw) as SessionRecord
  } catch {
    return null
  }
}

function persistSession(record: SessionRecord): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(record))
}

// ---------------------------------------------------------------------------
// Workspace store — driven by an initial fetch + SSE events.
// ---------------------------------------------------------------------------

export interface WorkspaceState {
  loaded: boolean
  team: WorkspaceSummary["team"] | null
  users: User[]
  usersById: Record<string, User>
  channels: Channel[]
  channelsById: Record<string, Channel>
  messagesByChannel: Record<string, Message[]>
  /** Key: `${channelId}:${parentTs}`. Holds the parent at index 0 + replies. */
  repliesByThread: Record<string, Message[]>
  selectedChannel: string | null
  selectedThread: { channelId: string; parentTs: string } | null
  /** Workspace custom emoji map (from emoji.list). Keys override defaults. */
  customEmoji: Record<string, string>
  error: string | null
}

interface WorkspaceValue {
  state: WorkspaceState
  selectChannel(channelId: string): void
  openThread(channelId: string, parentTs: string): void
  closeThread(): void
  refresh(): Promise<void>
  mergeMessages(channelId: string, messages: Message[]): void
  mergeReplies(channelId: string, parentTs: string, messages: Message[]): void
}

const WorkspaceContext = createContext<WorkspaceValue>()

export const WorkspaceProvider: ParentComponent = (props) => {
  const [state, setState] = createStore<WorkspaceState>({
    loaded: false,
    team: null,
    users: [],
    usersById: {},
    channels: [],
    channelsById: {},
    messagesByChannel: {},
    repliesByThread: {},
    selectedChannel: null,
    selectedThread: null,
    customEmoji: {},
    error: null,
  })

  async function refresh(): Promise<void> {
    try {
      const summary = await getWorkspace()
      batch(() => {
        setState(
          produce((s) => {
            s.team = summary.team
            s.users = summary.users
            s.usersById = Object.fromEntries(summary.users.map((u) => [u.id, u]))
            s.channels = summary.channels
            s.channelsById = Object.fromEntries(summary.channels.map((c) => [c.id, c]))
            s.loaded = true
            s.error = null
            if (!s.selectedChannel && summary.channels.length > 0) {
              const firstChannel = summary.channels[0]
              if (firstChannel) s.selectedChannel = firstChannel.id
            }
          }),
        )
      })
    } catch (err) {
      setState("error", err instanceof Error ? err.message : String(err))
    }
  }

  const unsubscribe = subscribeEvents((evt) => applyEvent(setState, evt))
  onCleanup(() => unsubscribe())

  const value: WorkspaceValue = {
    state,
    selectChannel(channelId) {
      setState(produce((s) => {
        s.selectedChannel = channelId
        // Close any open thread when switching channels — avoids stale drawer.
        s.selectedThread = null
      }))
    },
    openThread(channelId, parentTs) {
      setState("selectedThread", { channelId, parentTs })
    },
    closeThread() { setState("selectedThread", null) },
    refresh,
    mergeMessages(channelId, messages) {
      setState(
        produce((s) => {
          const existing = s.messagesByChannel[channelId] ?? []
          const byTs = new Map<string, Message>()
          for (const m of existing) byTs.set(m.ts, m)
          for (const m of messages) byTs.set(m.ts, m)
          s.messagesByChannel[channelId] = Array.from(byTs.values()).sort((a, b) =>
            a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
          )
        }),
      )
    },
    mergeReplies(channelId, parentTs, messages) {
      const key = threadKey(channelId, parentTs)
      setState(
        produce((s) => {
          const existing = s.repliesByThread[key] ?? []
          const byTs = new Map<string, Message>()
          for (const m of existing) byTs.set(m.ts, m)
          for (const m of messages) byTs.set(m.ts, m)
          s.repliesByThread[key] = Array.from(byTs.values()).sort((a, b) =>
            a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
          )
        }),
      )
    },
  }

  refresh()
  // Fire-and-forget custom-emoji fetch. Empty on a no-emoji workspace.
  void (async () => {
    try {
      const res = await emojiList()
      setState("customEmoji", res.emoji ?? {})
    } catch {
      // No big deal — fall back to default set.
    }
  })()

  return <WorkspaceContext.Provider value={value}>{props.children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspace outside WorkspaceProvider")
  return ctx
}

// ---------------------------------------------------------------------------
// Event reducer — folds SlackEvents into the workspace store.
// ---------------------------------------------------------------------------

function applyEvent(setState: SetStoreFunction<WorkspaceState>, evt: SlackEvent): void {
  switch (evt.type) {
    case "message": {
      if (evt.subtype === "message_deleted") return
      // message_changed on a parent carries updated reply_count etc. — mirror
      // it onto the cached parent so the "N replies" indicator stays live.
      if (evt.subtype === "message_changed") {
        const outer = evt as unknown as {
          channel: string
          message: Message & {
            reply_count?: number
            reply_users?: string[]
            reply_users_count?: number
            latest_reply?: string
          }
        }
        const inner = outer.message
        if (!inner) return
        setState(
          produce((s) => {
            const list = s.messagesByChannel[outer.channel] ?? []
            const idx = list.findIndex((m) => m.ts === inner.ts)
            if (idx >= 0) {
              list[idx] = { ...list[idx]!, ...inner } as Message
              s.messagesByChannel[outer.channel] = list
            }
          }),
        )
        return
      }
      const msg = messageFromEvent(evt as MessageEvent)
      const isReply = !!msg.thread_ts && msg.thread_ts !== msg.ts
      setState(
        produce((s) => {
          if (isReply) {
            // Replies go into the thread bucket, NOT the main channel feed.
            const key = threadKey(evt.channel, msg.thread_ts!)
            const rlist = s.repliesByThread[key] ?? []
            const ridx = rlist.findIndex((m) => m.ts === msg.ts)
            if (ridx >= 0) rlist[ridx] = msg
            else rlist.push(msg)
            rlist.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
            s.repliesByThread[key] = rlist
            return
          }
          const list = s.messagesByChannel[evt.channel] ?? []
          const idx = list.findIndex((m) => m.ts === msg.ts)
          if (idx >= 0) list[idx] = msg
          else list.push(msg)
          list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
          s.messagesByChannel[evt.channel] = list
        }),
      )
      return
    }
    case "channel_created": {
      setState(
        produce((s) => {
          // Server-side type may include more fields; we merge what we got.
          const ch = evt.channel as unknown as Channel
          s.channelsById[ch.id] = ch
          if (!s.channels.find((c) => c.id === ch.id)) s.channels.push(ch)
        }),
      )
      return
    }
    case "reaction_added":
    case "reaction_removed": {
      const channel = evt.item.channel
      const ts = evt.item.ts
      setState(
        produce((s) => {
          // Update in both the channel feed and the thread bucket in case
          // the reacted message is a reply.
          const patch = (list: Message[] | undefined): Message[] | undefined => {
            if (!list) return list
            const idx = list.findIndex((m) => m.ts === ts)
            if (idx < 0) return list
            const m = list[idx]!
            const reactions = [...(m.reactions ?? [])]
            const rIdx = reactions.findIndex((r) => r.name === evt.reaction)
            if (evt.type === "reaction_added") {
              if (rIdx >= 0) {
                const r = reactions[rIdx]!
                if (!r.users.includes(evt.user)) {
                  reactions[rIdx] = { ...r, users: [...r.users, evt.user], count: r.count + 1 }
                }
              } else {
                reactions.push({ name: evt.reaction, count: 1, users: [evt.user] })
              }
            } else {
              if (rIdx >= 0) {
                const r = reactions[rIdx]!
                const users = r.users.filter((u) => u !== evt.user)
                if (users.length === 0) reactions.splice(rIdx, 1)
                else reactions[rIdx] = { ...r, users, count: users.length }
              }
            }
            list[idx] = { ...m, reactions }
            return list
          }
          const feed = s.messagesByChannel[channel]
          if (feed) s.messagesByChannel[channel] = patch(feed)!
          for (const key of Object.keys(s.repliesByThread)) {
            if (key.startsWith(`${channel}:`)) {
              s.repliesByThread[key] = patch(s.repliesByThread[key])!
            }
          }
        }),
      )
      return
    }
    case "member_joined_channel":
    case "member_left_channel":
    case "im_open":
    case "im_close":
    case "file_shared":
    case "app_mention":
    case "channel_rename":
      // Phase 4+ will flesh these out. v0 UI ignores safely.
      return
  }
}

function threadKey(channelId: string, parentTs: string): string {
  return `${channelId}:${parentTs}`
}

export function useThreadKey(channelId: string, parentTs: string): string {
  return threadKey(channelId, parentTs)
}

function messageFromEvent(evt: MessageEvent): Message {
  return {
    type: "message",
    ts: evt.ts,
    channel: evt.channel,
    user: evt.user,
    text: evt.text,
    ...(evt.bot_id ? { bot_id: evt.bot_id } : {}),
    ...(evt.app_id ? { app_id: evt.app_id } : {}),
    ...(evt.subtype ? { subtype: evt.subtype } : {}),
    ...(evt.thread_ts ? { thread_ts: evt.thread_ts } : {}),
    ...(evt.blocks ? { blocks: evt.blocks } : {}),
    ...(evt.attachments ? { attachments: evt.attachments } : {}),
    ...(evt.files ? { files: evt.files } : {}),
    ...(evt.client_msg_id ? { client_msg_id: evt.client_msg_id } : {}),
    ...(evt.reactions ? { reactions: evt.reactions } : {}),
  }
}
