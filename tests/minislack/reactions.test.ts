import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { startMinislack, type MinislackHandle } from "../../src/minislack/testing/harness"
import { createPublicChannel } from "../../src/minislack/core/channels"
import { createUser } from "../../src/minislack/core/users"
import {
  addReaction,
  getReactions,
  removeReaction,
} from "../../src/minislack/core/reactions"
import {
  deleteMessage,
  editMessage,
  getMessage,
  postMessage,
} from "../../src/minislack/core/messages"
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

describe("core/reactions", () => {
  test("add records one reaction per user per emoji", () => {
    const ws = handle.workspace
    const alice = ws.users.get("U00000001")!
    const bob = ws.users.get("U00000002")!
    const msg = postMessage(ws, { channelId: "C00000001", userId: alice.id, text: "hi" })
    addReaction(ws, { channelId: "C00000001", ts: msg.ts, userId: alice.id, name: "eyes" })
    addReaction(ws, { channelId: "C00000001", ts: msg.ts, userId: bob.id, name: "eyes" })
    addReaction(ws, { channelId: "C00000001", ts: msg.ts, userId: alice.id, name: "eyes" }) // duplicate
    const reactions = getReactions(ws, { channelId: "C00000001", ts: msg.ts })
    expect(reactions).toHaveLength(1)
    expect(reactions[0]!.name).toBe("eyes")
    expect(reactions[0]!.count).toBe(2)
    expect(reactions[0]!.users).toEqual([alice.id, bob.id])
  })

  test("remove decrements; 0 users drops the Reaction entirely", () => {
    const ws = handle.workspace
    const alice = ws.users.get("U00000001")!
    const msg = postMessage(ws, { channelId: "C00000001", userId: alice.id, text: "hi" })
    addReaction(ws, { channelId: "C00000001", ts: msg.ts, userId: alice.id, name: "eyes" })
    removeReaction(ws, { channelId: "C00000001", ts: msg.ts, userId: alice.id, name: "eyes" })
    expect(getReactions(ws, { channelId: "C00000001", ts: msg.ts })).toEqual([])
  })
})

describe("core/messages edit + delete", () => {
  test("editMessage records edited marker; non-authors rejected", () => {
    const ws = handle.workspace
    const alice = ws.users.get("U00000001")!
    const bob = ws.users.get("U00000002")!
    const msg = postMessage(ws, { channelId: "C00000001", userId: alice.id, text: "typo" })
    const { message, previous } = editMessage(ws, {
      channelId: "C00000001",
      ts: msg.ts,
      userId: alice.id,
      text: "typo fixed",
    })
    expect(message.text).toBe("typo fixed")
    expect(message.edited?.user).toBe(alice.id)
    expect(previous.text).toBe("typo")
    expect(() =>
      editMessage(ws, {
        channelId: "C00000001",
        ts: msg.ts,
        userId: bob.id,
        text: "nope",
      }),
    ).toThrow(MinislackError)
  })

  test("deleteMessage tombstones; non-authors rejected", () => {
    const ws = handle.workspace
    const alice = ws.users.get("U00000001")!
    const bob = ws.users.get("U00000002")!
    const msg = postMessage(ws, { channelId: "C00000001", userId: alice.id, text: "oops" })
    expect(() =>
      deleteMessage(ws, { channelId: "C00000001", ts: msg.ts, userId: bob.id }),
    ).toThrow(MinislackError)
    deleteMessage(ws, { channelId: "C00000001", ts: msg.ts, userId: alice.id })
    const ch = ws.channels.get("C00000001")!
    expect(getMessage(ch, msg.ts)).toBeUndefined()
  })
})

describe("reactions.* API", () => {
  test("reactions.add + reactions.get roundtrip via HTTP", async () => {
    const alice = handle.asUser("alice")
    const bob = handle.asUser("bob")
    const posted = await alice.sendMessage("general", "react to me")

    async function call(method: string, body: object) {
      const res = await fetch(`${handle.url}/api/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bob.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      return res.json()
    }

    const addRes = (await call("reactions.add", {
      channel: "general",
      timestamp: posted.ts,
      name: "rocket",
    })) as any
    expect(addRes.ok).toBe(true)

    const getRes = (await call("reactions.get", {
      channel: "general",
      timestamp: posted.ts,
    })) as any
    expect(getRes.message.reactions[0].name).toBe("rocket")
    expect(getRes.message.reactions[0].count).toBe(1)
    expect(getRes.message.reactions[0].users).toEqual([bob.user.id])
  })

  test("reactions.list returns items the caller reacted to, newest first", async () => {
    const alice = handle.asUser("alice")
    const bob = handle.asUser("bob")
    const first = await alice.sendMessage("general", "first")
    const second = await alice.sendMessage("general", "second")
    const third = await alice.sendMessage("general", "third")

    async function react(userToken: string, ts: string, name: string) {
      await fetch(`${handle.url}/api/reactions.add`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "general", timestamp: ts, name }),
      })
    }
    await react(bob.token, first.ts, "eyes")
    await react(bob.token, third.ts, "tada")
    // Alice reacts to `second` — excluded from bob's list.
    await react(alice.token, second.ts, "rocket")

    const res = await fetch(`${handle.url}/api/reactions.list`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bob.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.items).toHaveLength(2)
    expect(body.items[0].type).toBe("message")
    expect(body.items[0].message.ts).toBe(third.ts)
    expect(body.items[1].message.ts).toBe(first.ts)
    expect(body.response_metadata.next_cursor).toBe("")
  })

  test("reactions.list paginates + filters to the caller's reactions", async () => {
    const alice = handle.asUser("alice")
    const bob = handle.asUser("bob")
    const a = await alice.sendMessage("general", "a")
    const b = await alice.sendMessage("general", "b")
    const c = await alice.sendMessage("general", "c")
    for (const ts of [a.ts, b.ts, c.ts]) {
      await fetch(`${handle.url}/api/reactions.add`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bob.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "general", timestamp: ts, name: "eyes" }),
      })
    }
    const firstPage = (await (await fetch(`${handle.url}/api/reactions.list`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bob.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 2 }),
    })).json()) as any
    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.response_metadata.next_cursor).not.toBe("")

    const secondPage = (await (await fetch(`${handle.url}/api/reactions.list`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bob.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 2, cursor: firstPage.response_metadata.next_cursor }),
    })).json()) as any
    expect(secondPage.items).toHaveLength(1)
    expect(secondPage.response_metadata.next_cursor).toBe("")
  })

  test("reaction_added event is delivered to subscribers", async () => {
    const seen: any[] = []
    handle.events.subscribe({ types: ["reaction_added"] }, (evt) => seen.push(evt))
    const alice = handle.asUser("alice")
    const bob = handle.asUser("bob")
    const posted = await alice.sendMessage("general", "hi")
    await fetch(`${handle.url}/api/reactions.add`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bob.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general", timestamp: posted.ts, name: "tada" }),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].reaction).toBe("tada")
    expect(seen[0].user).toBe(bob.user.id)
    expect(seen[0].item.ts).toBe(posted.ts)
  })
})

describe("chat.update / chat.delete API", () => {
  test("chat.update edits the message in place", async () => {
    const alice = handle.asUser("alice")
    const posted = await alice.sendMessage("general", "original")
    const res = await fetch(`${handle.url}/api/chat.update`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general", ts: posted.ts, text: "edited" }),
    })
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.message.text).toBe("edited")
    expect(body.message.edited).toBeDefined()
    const history = await alice.history("general")
    expect(history[0]!.text).toBe("edited")
  })

  test("chat.delete removes message from history; deleted event fires", async () => {
    const alice = handle.asUser("alice")
    const seen: any[] = []
    handle.events.subscribe({ types: ["message"] }, (evt) => {
      if ((evt as any).subtype === "message_deleted") seen.push(evt)
    })
    const posted = await alice.sendMessage("general", "byebye")
    const res = await fetch(`${handle.url}/api/chat.delete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general", ts: posted.ts }),
    })
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect((await alice.history("general")).map((m) => m.text)).not.toContain("byebye")
    expect(seen).toHaveLength(1)
    expect(seen[0].deleted_ts).toBe(posted.ts)
  })
})
