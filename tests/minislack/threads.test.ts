import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { startMinislack, type MinislackHandle } from "../../src/minislack/testing/harness"
import { createPublicChannel } from "../../src/minislack/core/channels"
import { createUser } from "../../src/minislack/core/users"
import { postMessage, postMessageDetailed, listReplies } from "../../src/minislack/core/messages"
import { MinislackError } from "../../src/minislack/core/channels"

let handle: MinislackHandle

beforeEach(async () => {
  handle = await startMinislack({ port: 0, serveWeb: false })
  const alice = createUser(handle.workspace, { name: "alice" })
  const bob = createUser(handle.workspace, { name: "bob" })
  createPublicChannel(handle.workspace, {
    name: "general",
    creator: alice.id,
    is_general: true,
    members: [alice.id, bob.id],
  })
})

afterEach(async () => {
  await handle.stop()
})

describe("core/messages threads", () => {
  test("posting with thread_ts increments parent.reply_count and reply_users", () => {
    const ws = handle.workspace
    const alice = ws.users.get("U00000001")!
    const bob = ws.users.get("U00000002")!
    const chId = "C00000001"

    const parent = postMessage(ws, { channelId: chId, userId: alice.id, text: "parent" })
    const r1 = postMessage(ws, { channelId: chId, userId: bob.id, text: "reply 1", thread_ts: parent.ts })
    const r2 = postMessage(ws, { channelId: chId, userId: alice.id, text: "reply 2", thread_ts: parent.ts })

    const updated = ws.channels.get(chId)!.messages.get(parent.ts)!
    expect(updated.is_thread_parent).toBe(true)
    expect(updated.reply_count).toBe(2)
    expect(updated.reply_users).toEqual([bob.id, alice.id])
    expect(updated.reply_users_count).toBe(2)
    expect(updated.latest_reply).toBe(r2.ts)
    expect(r1.thread_ts).toBe(parent.ts)
    expect(r2.thread_ts).toBe(parent.ts)
  })

  test("reply to a reply is hoisted to the top-level parent (Slack flattens threads)", () => {
    const ws = handle.workspace
    const alice = ws.users.get("U00000001")!
    const bob = ws.users.get("U00000002")!
    const chId = "C00000001"
    const parent = postMessage(ws, { channelId: chId, userId: alice.id, text: "parent" })
    const r1 = postMessage(ws, { channelId: chId, userId: bob.id, text: "r1", thread_ts: parent.ts })
    const r2 = postMessage(ws, { channelId: chId, userId: alice.id, text: "r2", thread_ts: r1.ts })
    expect(r2.thread_ts).toBe(parent.ts)
  })

  test("posting with an unknown thread_ts throws message_not_found", () => {
    const ws = handle.workspace
    const alice = ws.users.get("U00000001")!
    expect(() =>
      postMessage(ws, {
        channelId: "C00000001",
        userId: alice.id,
        text: "hi",
        thread_ts: "9999999999.999999",
      }),
    ).toThrow(MinislackError)
  })

  test("listReplies returns parent first, replies oldest-first", () => {
    const ws = handle.workspace
    const alice = ws.users.get("U00000001")!
    const bob = ws.users.get("U00000002")!
    const chId = "C00000001"
    const ch = ws.channels.get(chId)!
    let t = 1_700_000_000_000
    const parent = postMessage(ws, { channelId: chId, userId: alice.id, text: "parent", now: () => t })
    t += 1000
    postMessage(ws, { channelId: chId, userId: bob.id, text: "r1", thread_ts: parent.ts, now: () => t })
    t += 1000
    postMessage(ws, { channelId: chId, userId: alice.id, text: "r2", thread_ts: parent.ts, now: () => t })

    const { messages, has_more } = listReplies(ch, parent.ts)
    expect(messages.map((m) => m.text)).toEqual(["parent", "r1", "r2"])
    expect(has_more).toBe(false)
  })

  test("postMessageDetailed returns threadParent when a reply is posted", () => {
    const ws = handle.workspace
    const alice = ws.users.get("U00000001")!
    const bob = ws.users.get("U00000002")!
    const chId = "C00000001"
    const parent = postMessage(ws, { channelId: chId, userId: alice.id, text: "parent" })
    const { message, threadParent } = postMessageDetailed(ws, {
      channelId: chId,
      userId: bob.id,
      text: "reply",
      thread_ts: parent.ts,
    })
    expect(message.thread_ts).toBe(parent.ts)
    expect(threadParent?.ts).toBe(parent.ts)
    expect(threadParent?.reply_count).toBe(1)
  })

  test("thread replies do not appear in conversations.history (top-level only)", async () => {
    const alice = handle.asUser("alice")
    const bob = handle.asUser("bob")
    const parent = await alice.sendMessage("general", "top-level")
    await bob.sendMessage("general", "reply", { thread_ts: parent.ts })
    const top = await alice.history("general")
    expect(top.map((m) => m.text)).toEqual(["top-level"])
  })
})

describe("conversations.replies API", () => {
  test("returns parent + replies over HTTP", async () => {
    const alice = handle.asUser("alice")
    const bob = handle.asUser("bob")
    const parent = await alice.sendMessage("general", "root")
    await bob.sendMessage("general", "r1", { thread_ts: parent.ts })
    await alice.sendMessage("general", "r2", { thread_ts: parent.ts })

    const res = await fetch(`${handle.url}/api/conversations.replies`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general", ts: parent.ts }),
    })
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.messages.map((m: any) => m.text)).toEqual(["root", "r1", "r2"])
    expect(body.has_more).toBe(false)
  })

  test("emits a message_changed event for the parent when replies arrive", async () => {
    const alice = handle.asUser("alice")
    const bob = handle.asUser("bob")
    const seen: any[] = []
    handle.events.subscribe({ types: ["message"] }, (evt) => seen.push(evt))
    const parent = await alice.sendMessage("general", "root")
    await bob.sendMessage("general", "r1", { thread_ts: parent.ts })

    const changed = seen.find((e) => e.subtype === "message_changed")
    expect(changed).toBeDefined()
    expect(changed.message.ts).toBe(parent.ts)
    expect(changed.message.reply_count).toBe(1)
    expect(changed.message.latest_reply).toBeDefined()
  })
})
