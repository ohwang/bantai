/** @jsxImportSource solid-js */
/**
 * Reaction chips + picker popover. Shared by MessageRow (channel feed) and
 * ThreadMessage (thread drawer). Clicking a chip toggles the current user's
 * reaction; clicking the "+" opens a quick-pick grid.
 */

import { createSignal, For, Show, onCleanup, createMemo } from "solid-js"
import { useSession, useWorkspace } from "../state"
import { reactionsAdd, reactionsRemove } from "../api"
import { DEFAULT_EMOJI, QUICK_PICK, renderEmoji } from "../emoji"
import type { Message, Reaction } from "../../types/slack"

export function MessageReactions(props: { msg: Message }) {
  const session = useSession()
  const ws = useWorkspace()
  const reactions = () => props.msg.reactions ?? []
  const currentUserId = () => session.current()?.userId

  async function toggle(name: string) {
    const token = session.current()?.token
    if (!token) return
    const r = reactions().find((x) => x.name === name)
    const mine = r?.users.includes(currentUserId() ?? "")
    try {
      if (mine) {
        await reactionsRemove(token, props.msg.channel, props.msg.ts, name)
      } else {
        await reactionsAdd(token, props.msg.channel, props.msg.ts, name)
      }
    } catch {
      // SSE will correct if we're out of sync.
    }
  }

  const customEmoji = () => ws.state.customEmoji

  return (
    <div class="msg-reactions">
      <For each={reactions()}>
        {(r) => (
          <ReactionChip
            reaction={r}
            custom={customEmoji()}
            mine={r.users.includes(currentUserId() ?? "")}
            onToggle={() => toggle(r.name)}
          />
        )}
      </For>
      <ReactionAdd customEmoji={customEmoji()} onPick={(name) => toggle(name)} />
    </div>
  )
}

function ReactionChip(props: {
  reaction: Reaction
  custom: Record<string, string>
  mine: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      classList={{ "reaction-chip": true, "reaction-mine": props.mine }}
      onClick={props.onToggle}
      title={props.reaction.users.join(", ")}
    >
      <span class="reaction-glyph">{renderEmoji(props.reaction.name, props.custom)}</span>
      <span class="reaction-count">{props.reaction.count}</span>
    </button>
  )
}

function ReactionAdd(props: {
  customEmoji: Record<string, string>
  onPick: (name: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")

  // Close on outside click.
  let rootRef: HTMLSpanElement | undefined
  function onDocClick(e: MouseEvent) {
    if (!open()) return
    if (rootRef && e.target instanceof Node && rootRef.contains(e.target)) return
    setOpen(false)
  }
  document.addEventListener("click", onDocClick)
  onCleanup(() => document.removeEventListener("click", onDocClick))

  const combined = createMemo(() => {
    const custom = Object.keys(props.customEmoji)
    const standard = Object.keys(DEFAULT_EMOJI)
    return Array.from(new Set([...QUICK_PICK, ...custom, ...standard]))
  })
  const filtered = () => {
    const q = query().trim().toLowerCase()
    const names = combined()
    if (!q) return QUICK_PICK.filter((n) => names.includes(n))
    return names.filter((n) => n.toLowerCase().includes(q)).slice(0, 64)
  }

  function pick(name: string) {
    props.onPick(name)
    setOpen(false)
    setQuery("")
  }

  return (
    <span class="reaction-add-wrap" ref={(el) => (rootRef = el)}>
      <button
        type="button"
        class="reaction-add"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        title="Add reaction"
        aria-label="Add reaction"
      >
        +
      </button>
      <Show when={open()}>
        <div class="reaction-picker" onClick={(e) => e.stopPropagation()}>
          <input
            type="text"
            class="reaction-picker-search"
            placeholder="Search…"
            autofocus
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <div class="reaction-picker-grid">
            <For each={filtered()}>
              {(name) => (
                <button
                  type="button"
                  class="reaction-picker-cell"
                  onClick={() => pick(name)}
                  title={`:${name}:`}
                >
                  {renderEmoji(name, props.customEmoji)}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </span>
  )
}
