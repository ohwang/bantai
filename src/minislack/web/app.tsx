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
        <span class="team">{ws.state.team?.name ?? "minislack"}</span>
        <span class="who">{currentUser()?.real_name || currentUser()?.name || ""}</span>
        <button class="logout" type="button" onClick={() => session.logout()}>Log out</button>
      </header>
      <Sidebar />
      <ChannelView />
      <Show when={ws.state.selectedThread}>
        <ThreadDrawer />
      </Show>
    </div>
  )
}
