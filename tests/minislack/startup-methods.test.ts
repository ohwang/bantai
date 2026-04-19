import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { startMinislack, type MinislackHandle } from "../../src/minislack/testing/harness"
import { createUser } from "../../src/minislack/core/users"
import { createPublicChannel, joinChannel } from "../../src/minislack/core/channels"

let handle: MinislackHandle

beforeEach(async () => {
  handle = await startMinislack({ port: 0, serveWeb: false })
})

afterEach(async () => {
  await handle.stop()
})

async function call(token: string, method: string, body: object = {}): Promise<any> {
  const res = await fetch(`${handle.url}/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return res.json()
}

describe("team.info", () => {
  test("returns the Team shape with icon + email_domain", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const res = await call(alice.token, "team.info", {})
    expect(res.ok).toBe(true)
    expect(res.team.id).toBe(handle.workspace.team.id)
    expect(res.team.name).toBe("Minislack")
    expect(res.team.icon.image_default).toBe(true)
    expect(res.team.email_domain).toBe("minislack.minislack.local")
    expect(res.team.enterprise_id).toBe(null)
  })
})

describe("bots.info", () => {
  test("resolves a registered app's bot", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const { bot, app } = handle.registerApp({ name: "zapbot" })
    const res = await call(alice.token, "bots.info", { bot: bot.id })
    expect(res.ok).toBe(true)
    expect(res.bot.id).toBe(bot.id)
    expect(res.bot.app_id).toBe(app.id)
    expect(res.bot.name).toBe("zapbot")
  })

  test("missing bot id returns bot_not_found", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const res = await call(alice.token, "bots.info", { bot: "BNOPE" })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("bot_not_found")
  })
})

describe("conversations.members", () => {
  test("returns members list", async () => {
    createUser(handle.workspace, { name: "alice" })
    createUser(handle.workspace, { name: "bob" })
    const alice = handle.asUser("alice")
    const bob = handle.asUser("bob")
    const ch = createPublicChannel(handle.workspace, { name: "general", creator: alice.user.id })
    joinChannel(handle.workspace, ch.id, bob.user.id)
    const res = await call(alice.token, "conversations.members", { channel: ch.id })
    expect(res.ok).toBe(true)
    expect(res.members).toEqual(expect.arrayContaining([alice.user.id, bob.user.id]))
  })
})

describe("conversations.join / .leave", () => {
  test("joining emits member_joined_channel + synthetic channel_join message", async () => {
    createUser(handle.workspace, { name: "alice" })
    createUser(handle.workspace, { name: "bob" })
    const alice = handle.asUser("alice")
    const bob = handle.asUser("bob")
    const ch = createPublicChannel(handle.workspace, { name: "room", creator: alice.user.id })

    const joinEvts: any[] = []
    const msgEvts: any[] = []
    handle.events.subscribe({ types: ["member_joined_channel"] }, (e) => joinEvts.push(e))
    handle.events.subscribe({ types: ["message"] }, (e) => msgEvts.push(e))

    const res = await call(bob.token, "conversations.join", { channel: ch.id })
    expect(res.ok).toBe(true)
    expect(res.already_in_channel).toBe(false)
    expect(joinEvts).toHaveLength(1)
    expect(joinEvts[0].user).toBe(bob.user.id)
    const joinMsg = msgEvts.find((m) => m.subtype === "channel_join")
    expect(joinMsg).toBeDefined()
    expect(joinMsg.user).toBe(bob.user.id)

    // Idempotent re-join
    const again = await call(bob.token, "conversations.join", { channel: ch.id })
    expect(again.already_in_channel).toBe(true)
    expect(joinEvts).toHaveLength(1)
  })

  test("leaving emits member_left_channel", async () => {
    createUser(handle.workspace, { name: "alice" })
    createUser(handle.workspace, { name: "bob" })
    const alice = handle.asUser("alice")
    const bob = handle.asUser("bob")
    const ch = createPublicChannel(handle.workspace, { name: "exit", creator: alice.user.id })
    joinChannel(handle.workspace, ch.id, bob.user.id)

    const leftEvts: any[] = []
    handle.events.subscribe({ types: ["member_left_channel"] }, (e) => leftEvts.push(e))
    const res = await call(bob.token, "conversations.leave", { channel: ch.id })
    expect(res.ok).toBe(true)
    expect(leftEvts).toHaveLength(1)
  })
})

describe("conversations.create", () => {
  test("creates a public channel and emits channel_created", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const seen: any[] = []
    handle.events.subscribe({ types: ["channel_created"] }, (e) => seen.push(e))
    const res = await call(alice.token, "conversations.create", { name: "newroom" })
    expect(res.ok).toBe(true)
    expect(res.channel.name).toBe("newroom")
    expect(seen).toHaveLength(1)
    expect(seen[0].channel.name).toBe("newroom")
  })
})

describe("users.lookupByEmail", () => {
  test("finds by email, returns not_found otherwise", async () => {
    createUser(handle.workspace, { name: "alice", email: "alice@example.com" })
    const alice = handle.asUser("alice")
    const hit = await call(alice.token, "users.lookupByEmail", { email: "alice@example.com" })
    expect(hit.ok).toBe(true)
    expect(hit.user.profile.email).toBe("alice@example.com")
    const miss = await call(alice.token, "users.lookupByEmail", { email: "ghost@example.com" })
    expect(miss.ok).toBe(false)
    expect(miss.error).toBe("users_not_found")
  })
})

describe("chat.postEphemeral + chat.meMessage", () => {
  test("postEphemeral delivers into the ephemeral log and publishes an event", async () => {
    createUser(handle.workspace, { name: "alice" })
    const bob = createUser(handle.workspace, { name: "bob" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "eph", creator: alice.user.id })
    const received: any[] = []
    handle.events.subscribe({ types: ["ephemeral_message"] }, (e) => received.push(e))
    const before = handle.workspace.channels.get(ch.id)!.messages.size
    const res = await call(alice.token, "chat.postEphemeral", {
      channel: ch.id,
      user: bob.id,
      text: "hello just you",
    })
    expect(res.ok).toBe(true)
    expect(res.message_ts).toMatch(/^\d+\.\d{6}$/)
    // Not written into the channel log (matches real Slack: ephemerals don't persist).
    expect(handle.workspace.channels.get(ch.id)!.messages.size).toBe(before)
    // But recorded on the workspace so tests + the web SPA can see them.
    expect(handle.workspace.ephemerals).toHaveLength(1)
    expect(handle.workspace.ephemerals[0]).toMatchObject({
      channel: ch.id,
      user: bob.id,
      posted_by: alice.user.id,
      text: "hello just you",
      ts: res.message_ts,
    })
    // And published on the bus so the SPA's SSE stream shows it in real time.
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      type: "ephemeral_message",
      channel: ch.id,
      user: bob.id,
      posted_by: alice.user.id,
    })
  })

  test("postEphemeral rejects an empty body", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "empty", creator: alice.user.id })
    const res = await call(alice.token, "chat.postEphemeral", {
      channel: ch.id,
      user: alice.user.id,
      text: "",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("no_text")
  })

  test("postEphemeral rejects an unknown target user", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "ghost", creator: alice.user.id })
    const res = await call(alice.token, "chat.postEphemeral", {
      channel: ch.id,
      user: "U_NOT_REAL",
      text: "hi",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("user_not_in_channel")
  })

  test("meMessage stamps me_message subtype", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "me", creator: alice.user.id })
    const res = await call(alice.token, "chat.meMessage", { channel: ch.id, text: "shrugs" })
    expect(res.ok).toBe(true)
    expect(res.message.subtype).toBe("me_message")
  })
})

describe("reactions.get full=true", () => {
  test("full=true returns the complete message object", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "r", creator: alice.user.id })
    const posted = await alice.sendMessage(ch.id, "react to me")
    await call(alice.token, "reactions.add", {
      channel: ch.id, timestamp: posted.ts, name: "thumbsup",
    })
    const res = await call(alice.token, "reactions.get", {
      channel: ch.id, timestamp: posted.ts, full: true,
    })
    expect(res.ok).toBe(true)
    expect(res.message.text).toBe("react to me")
    expect(res.message.reactions).toHaveLength(1)
    expect(res.message.reactions[0].name).toBe("thumbsup")
  })
})
