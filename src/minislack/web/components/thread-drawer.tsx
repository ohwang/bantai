/** @jsxImportSource solid-js */

import { createEffect, createSignal, For, Show } from "solid-js"
import { useSession, useWorkspace } from "../state"
import { conversationsReplies, postMessage } from "../api"
import { MessageReactions } from "./reactions"
import type { Message } from "../../types/slack"

export function ThreadDrawer() {
  const ws = useWorkspace()
  const session = useSession()
  const [posting, setPosting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let scrollRef: HTMLDivElement | undefined

  // Fetch the thread whenever the selection changes.
  createEffect(() => {
    const sel = ws.state.selectedThread
    const current = session.current()
    if (!sel || !current) return
    void (async () => {
      try {
        const res = await conversationsReplies(current.token, sel.channelId, sel.parentTs, 500)
        ws.mergeReplies(sel.channelId, sel.parentTs, res.messages)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  })

  // Auto-scroll to latest on any change.
  createEffect(() => {
    const sel = ws.state.selectedThread
    if (!sel) return
    ws.state.repliesByThread[`${sel.channelId}:${sel.parentTs}`]
    queueMicrotask(() => {
      if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight
    })
  })

  const thread = () => {
    const sel = ws.state.selectedThread
    if (!sel) return []
    return ws.state.repliesByThread[`${sel.channelId}:${sel.parentTs}`] ?? []
  }
  const parent = () => {
    const t = thread()
    return t[0]
  }
  const replies = () => {
    const t = thread()
    return t.length > 1 ? t.slice(1) : []
  }

  async function onSubmit(text: string) {
    const sel = ws.state.selectedThread
    const current = session.current()
    if (!sel || !current) return
    setPosting(true)
    setError(null)
    try {
      await postMessage(current.token, sel.channelId, text, sel.parentTs)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPosting(false)
    }
  }

  return (
    <aside class="thread-drawer">
      <header class="thread-header">
        <h3>Thread</h3>
        <button
          class="thread-close"
          type="button"
          onClick={() => ws.closeThread()}
          aria-label="Close thread"
        >
          ×
        </button>
      </header>
      <div class="thread-body" ref={(el) => (scrollRef = el)}>
        <Show when={parent()} fallback={<div class="messages-empty">Loading thread…</div>}>
          {(p) => (
            <>
              <ThreadMessage msg={p()} />
              <div class="thread-divider">
                <span>{replies().length} {replies().length === 1 ? "reply" : "replies"}</span>
              </div>
              <For each={replies()}>{(m) => <ThreadMessage msg={m} />}</For>
            </>
          )}
        </Show>
      </div>
      <ThreadComposer onSubmit={onSubmit} disabled={posting()} />
      <Show when={error()}>
        <div class="toast">{error()}</div>
      </Show>
    </aside>
  )
}

function ThreadMessage(props: { msg: Message }) {
  const ws = useWorkspace()
  const author = () => ws.state.usersById[props.msg.user]
  const displayName = () => author()?.real_name || author()?.name || props.msg.user
  const when = () => {
    const [secs] = props.msg.ts.split(".")
    const d = new Date(Number(secs) * 1000)
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
  return (
    <div class="msg">
      <div class="avatar">{initials(displayName())}</div>
      <div>
        <div class="msg-head">
          <span class="msg-author">{displayName()}</span>
          <span class="msg-time">{when()}</span>
        </div>
        <Show when={props.msg.text}>
          <div class="msg-text">{props.msg.text}</div>
        </Show>
        <MessageReactions msg={props.msg} />
      </div>
    </div>
  )
}

function ThreadComposer(props: { onSubmit: (text: string) => void; disabled?: boolean }) {
  const [value, setValue] = createSignal("")
  function submit(e: Event) {
    e.preventDefault()
    const text = value().trim()
    if (!text || props.disabled) return
    props.onSubmit(text)
    setValue("")
  }
  return (
    <div class="composer">
      <form onSubmit={submit}>
        <input
          type="text"
          placeholder="Reply…"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          disabled={props.disabled}
        />
        <button type="submit" disabled={props.disabled || value().trim().length === 0}>
          Send
        </button>
      </form>
    </div>
  )
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return (parts[0]?.[0] ?? "?").toUpperCase()
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase()
}
