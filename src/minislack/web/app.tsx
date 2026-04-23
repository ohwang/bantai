/** @jsxImportSource solid-js */

import { Show } from "solid-js"
import { SessionProvider, useSession, WorkspaceProvider, useWorkspace } from "./state"
import { Login } from "./components/login"
import { Sidebar } from "./components/sidebar"
import { ChannelView } from "./components/channel-view"
import { ThreadDrawer } from "./components/thread-drawer"

export function App() {
  return (
    <WorkspaceProvider>
      <SessionProvider>
        <AppGate />
      </SessionProvider>
    </WorkspaceProvider>
  )
}

function AppGate() {
  const session = useSession()
  const ws = useWorkspace()
  return (
    <Show when={ws.state.loaded} fallback={<div style="padding: 20px;">Loading…</div>}>
      <Show when={session.current()} fallback={<Login />}>
        <Shell />
      </Show>
    </Show>
  )
}

function Shell() {
  const session = useSession()
  const ws = useWorkspace()
  const currentUser = () => {
    const s = session.current()
    return s ? ws.state.usersById[s.userId] : undefined
  }
  return (
    <div classList={{ shell: true, "shell-with-thread": !!ws.state.selectedThread }}>
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">m/</div>
        </div>
        <div class="top-center">
          <span class="team">
            <span class="dot" aria-hidden="true" />
            {ws.state.team?.name ?? "minislack"}
          </span>
        </div>
        <div class="top-right">
          <span class="who">{currentUser()?.real_name || currentUser()?.name || ""}</span>
          <button class="logout" type="button" onClick={() => session.logout()}>Log out</button>
        </div>
      </header>
      <nav class="rail" aria-label="Primary">
        <button type="button" class="on" aria-label="Home" title="Home">⌂</button>
      </nav>
      <Sidebar />
      <ChannelView />
      <Show when={ws.state.selectedThread}>
        <ThreadDrawer />
      </Show>
    </div>
  )
}
