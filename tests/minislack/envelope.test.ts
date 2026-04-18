import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { startMinislack, type MinislackHandle } from "../../src/minislack/testing/harness"
import { createUser } from "../../src/minislack/core/users"
import { createPublicChannel, joinChannel } from "../../src/minislack/core/channels"
import { buildEventsApi, buildHello } from "../../src/minislack/server/envelope"

let handle: MinislackHandle

beforeEach(async () => {
  handle = await startMinislack({ port: 0, serveWeb: false })
})

afterEach(async () => {
  await handle.stop()
})

describe("envelope shape", () => {
  test("hello carries connection_info.app_id and debug_info", () => {
    const { app } = handle.registerApp({ name: "probe", subscribed_events: ["message"] })
    const env = buildHello(app.id)
    expect(env.type).toBe("hello")
    expect(env.accepts_response_payload).toBe(false)
    expect(env.payload.num_connections).toBe(1)
    expect(env.payload.connection_info.app_id).toBe(app.id)
    expect(typeof env.payload.debug_info.host).toBe("string")
    expect(typeof env.payload.debug_info.started).toBe("string")
    expect(typeof env.payload.debug_info.build_number).toBe("number")
    expect(typeof env.payload.debug_info.approximate_connection_time).toBe("number")
  })

  test("events_api payload includes token, authorizations, context fields", () => {
    const { app, botUser } = handle.registerApp({ name: "probe2", subscribed_events: ["message"] })
    const env = buildEventsApi(handle.workspace, app.id, {
      type: "message",
      event_ts: "1.000001",
      ts: "1.000001",
      channel: "C00000001",
      channel_type: "channel",
      user: botUser.id,
      text: "hi",
    })
    expect(env.type).toBe("events_api")
    expect(env.payload.token).toBeDefined()
    expect(env.payload.team_id).toBe(handle.workspace.team.id)
    expect(env.payload.api_app_id).toBe(app.id)
    expect(env.payload.type).toBe("event_callback")
    expect(env.payload.event_id).toMatch(/^Ev[A-Z0-9]{11}$/)
    expect(env.payload.authorizations).toHaveLength(1)
    expect(env.payload.authorizations[0]!.user_id).toBe(botUser.id)
    expect(env.payload.authorizations[0]!.team_id).toBe(handle.workspace.team.id)
    expect(env.payload.authorizations[0]!.is_bot).toBe(true)
    expect(env.payload.context_team_id).toBe(handle.workspace.team.id)
    expect(env.payload.is_ext_shared_channel).toBe(false)
    expect(env.payload.context_enterprise_id).toBe(null)
  })
})

describe("message event fidelity", () => {
  test("MessageEvent includes team and parent_user_id on thread replies", async () => {
    createUser(handle.workspace, { name: "alice" })
    createUser(handle.workspace, { name: "bob" })
    const ch = createPublicChannel(handle.workspace, { name: "general", creator: "USLACKBOT" })
    const alice = handle.asUser("alice")
    const bob = handle.asUser("bob")
    joinChannel(handle.workspace, ch.id, alice.user.id)
    joinChannel(handle.workspace, ch.id, bob.user.id)

    const seen: any[] = []
    handle.events.subscribe({ types: ["message"] }, (evt) => seen.push(evt))

    const parent = await alice.sendMessage(ch.id, "parent")
    const reply = await bob.sendMessage(ch.id, "child", { thread_ts: parent.ts })

    const parentEvt = seen.find((e) => e.ts === parent.ts)
    const replyEvt = seen.find((e) => e.ts === reply.ts)

    expect(parentEvt.team).toBe(handle.workspace.team.id)
    expect(parentEvt.parent_user_id).toBeUndefined()

    expect(replyEvt.team).toBe(handle.workspace.team.id)
    expect(replyEvt.parent_user_id).toBe(alice.user.id)
    expect(replyEvt.thread_ts).toBe(parent.ts)
  })

  test("file_share subtype on file-carrying message", async () => {
    createUser(handle.workspace, { name: "alice" })
    const ch = createPublicChannel(handle.workspace, { name: "pix", creator: "USLACKBOT" })
    const alice = handle.asUser("alice")
    joinChannel(handle.workspace, ch.id, alice.user.id)

    const fd = new FormData()
    fd.append("channels", ch.id)
    fd.append("filename", "x.png")
    fd.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "x.png")
    const up = await fetch(`${handle.url}/api/files.upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}` },
      body: fd,
    })
    const body = (await up.json()) as { ok: boolean; file: { id: string } }
    expect(body.ok).toBe(true)

    const msgs = Array.from(handle.workspace.channels.get(ch.id)!.messages.values())
    const carrier = msgs.find((m) => m.files && m.files.some((f) => f.id === body.file.id))
    expect(carrier?.subtype).toBe("file_share")
  })

  test("reply_broadcast stamps thread_broadcast subtype", async () => {
    createUser(handle.workspace, { name: "alice" })
    const ch = createPublicChannel(handle.workspace, { name: "bc", creator: "USLACKBOT" })
    const alice = handle.asUser("alice")
    joinChannel(handle.workspace, ch.id, alice.user.id)

    const parent = await alice.sendMessage(ch.id, "top")
    const res = await fetch(`${handle.url}/api/chat.postMessage`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: ch.id, text: "broadcast me", thread_ts: parent.ts, reply_broadcast: true }),
    })
    const body = (await res.json()) as { ok: boolean; message: { subtype?: string; thread_ts?: string } }
    expect(body.ok).toBe(true)
    expect(body.message.subtype).toBe("thread_broadcast")
    expect(body.message.thread_ts).toBe(parent.ts)
  })

  test("message_deleted event uses fresh event_ts, not the original", async () => {
    createUser(handle.workspace, { name: "alice" })
    const ch = createPublicChannel(handle.workspace, { name: "del", creator: "USLACKBOT" })
    const alice = handle.asUser("alice")
    joinChannel(handle.workspace, ch.id, alice.user.id)

    const posted = await alice.sendMessage(ch.id, "bye")
    const seen: any[] = []
    handle.events.subscribe({ types: ["message"] }, (evt) => {
      if ((evt as { subtype?: string }).subtype === "message_deleted") seen.push(evt)
    })
    await fetch(`${handle.url}/api/chat.delete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: ch.id, ts: posted.ts }),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].deleted_ts).toBe(posted.ts)
    expect(seen[0].event_ts).not.toBe(posted.ts)
    expect(seen[0].event_ts > posted.ts).toBe(true)
  })
})
