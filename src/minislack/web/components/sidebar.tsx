/** @jsxImportSource solid-js */

import { createSignal, For, Show } from "solid-js"
import { useSession, useWorkspace } from "../state"
import { openConversation } from "../api"
import type { Channel, DirectMessage, MultiPartyIm, User } from "../../types/slack"

export function Sidebar() {
  const ws = useWorkspace()
  const session = useSession()
  const [picking, setPicking] = createSignal(false)

  const publicChannels = () =>
    ws.state.channels.filter((c) => c.is_channel)
  const privateGroups = () =>
    ws.state.channels.filter((c) => "is_group" in c && c.is_group && !c.is_im && !c.is_mpim)
  const directMessages = () =>
    ws.state.channels.filter(
      (c): c is DirectMessage | MultiPartyIm =>
        (c.is_im || c.is_mpim) && (c as DirectMessage | MultiPartyIm).is_open !== false,
    )

  async function startDm(userId: string): Promise<void> {
    const s = session.current()
    if (!s) return
    const ch = await openConversation(s.token, { users: userId })
    await ws.refresh()
    ws.selectChannel(ch.id)
    setPicking(false)
  }

  return (
    <aside class="sidebar">
      <div class="sidebar-section">Channels</div>
      <ul>
        <For each={publicChannels()}>
          {(ch) => <SidebarRow channel={ch} prefix="#" />}
        </For>
      </ul>
      <Show when={privateGroups().length > 0}>
        <div class="sidebar-section">Private</div>
        <ul>
          <For each={privateGroups()}>
            {(ch) => <SidebarRow channel={ch} prefix="🔒 " />}
          </For>
        </ul>
      </Show>
      <div class="sidebar-section sidebar-dm-header">
        <span>Direct Messages</span>
        <button
          type="button"
          class="sidebar-dm-add"
          aria-label="Start a direct message"
          onClick={() => setPicking((v) => !v)}
        >
          {picking() ? "×" : "+"}
        </button>
      </div>
      <Show when={picking()}>
        <UserPicker onPick={startDm} onCancel={() => setPicking(false)} />
      </Show>
      <ul>
        <For each={directMessages()}>
          {(ch) => <DmSidebarRow channel={ch} />}
        </For>
      </ul>
    </aside>
  )
}

function SidebarRow(props: { channel: Channel; prefix: string }) {
  const ws = useWorkspace()
  const isActive = () => ws.state.selectedChannel === props.channel.id
  const label = () =>
    "name" in props.channel ? props.channel.name : props.channel.id
  return (
    <li classList={{ active: isActive() }}>
      <button type="button" onClick={() => ws.selectChannel(props.channel.id)}>
        <span>{props.prefix}{label()}</span>
      </button>
    </li>
  )
}

function DmSidebarRow(props: { channel: DirectMessage | MultiPartyIm }) {
  const ws = useWorkspace()
  const session = useSession()
  const isActive = () => ws.state.selectedChannel === props.channel.id
  const label = () => {
    const s = session.current()
    if (props.channel.is_im) {
      const otherId = props.channel.members.find((m) => m !== s?.userId) ?? props.channel.user
      const other = ws.state.usersById[otherId]
      return other?.real_name || other?.name || otherId
    }
    // mpim: show the other members' handles joined
    const others = props.channel.members.filter((m) => m !== s?.userId)
    return others
      .map((uid) => ws.state.usersById[uid]?.name ?? uid)
      .join(", ")
  }
  return (
    <li classList={{ active: isActive() }}>
      <button type="button" onClick={() => ws.selectChannel(props.channel.id)}>
        <span>● {label()}</span>
      </button>
    </li>
  )
}

function UserPicker(props: { onPick: (userId: string) => void; onCancel: () => void }) {
  const ws = useWorkspace()
  const session = useSession()
  const [query, setQuery] = createSignal("")
  const candidates = () => {
    const s = session.current()
    const q = query().toLowerCase().trim()
    return ws.state.users.filter((u: User) => {
      if (u.deleted) return false
      if (u.id === s?.userId) return false
      if (!q) return true
      return (
        u.name.toLowerCase().includes(q) ||
        (u.real_name ?? "").toLowerCase().includes(q)
      )
    })
  }
  return (
    <div class="user-picker">
      <input
        type="text"
        placeholder="Search users..."
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
        autofocus
      />
      <ul>
        <For each={candidates()}>
          {(u) => (
            <li>
              <button type="button" onClick={() => props.onPick(u.id)}>
                {u.is_bot ? "🤖" : "●"} {u.real_name || u.name}{" "}
                <span class="user-picker-handle">@{u.name}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}
