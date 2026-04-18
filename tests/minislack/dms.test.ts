import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { startMinislack, type MinislackHandle } from "../../src/minislack/testing/harness"
import { createUser } from "../../src/minislack/core/users"

let handle: MinislackHandle

beforeEach(async () => {
  handle = await startMinislack({ port: 0, serveWeb: false })
  createUser(handle.workspace, { name: "alice" })
  createUser(handle.workspace, { name: "bob" })
  createUser(handle.workspace, { name: "carol" })
})

afterEach(async () => {
  await handle.stop()
})

async function call(token: string, method: string, body: object): Promise<any> {
  const res = await fetch(`${handle.url}/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return res.json()
}

describe("conversations.open (DMs)", () => {
  test("opens a 1:1 DM and makes it reachable via conversations.list", async () => {
    const alice = handle.asUser("alice")
    const bob = ensureUser("bob")

    const res = await call(alice.token, "conversations.open", { users: bob.id })
    expect(res.ok).toBe(true)
    expect(res.channel.is_im).toBe(true)
    expect(res.channel.user).toBe(bob.id)

    const list = await call(alice.token, "conversations.list", { types: "im" })
    expect(list.channels.map((c: any) => c.id)).toContain(res.channel.id)
  })

  test("opening the same DM twice returns the same channel (idempotent)", async () => {
    const alice = handle.asUser("alice")
    const bob = ensureUser("bob")
    const first = await call(alice.token, "conversations.open", { users: bob.id })
    const second = await call(alice.token, "conversations.open", { users: bob.id })
    expect(second.channel.id).toBe(first.channel.id)
  })

  test("opening with 2+ users creates an mpim", async () => {
    const alice = handle.asUser("alice")
    const bob = ensureUser("bob")
    const carol = ensureUser("carol")
    const res = await call(alice.token, "conversations.open", {
      users: [bob.id, carol.id].join(","),
    })
    expect(res.ok).toBe(true)
    expect(res.channel.is_mpim).toBe(true)
    expect(res.channel.members).toEqual(
      expect.arrayContaining([alice.user.id, bob.id, carol.id]),
    )
  })

  test("emits im_open event when a new DM is opened", async () => {
    const alice = handle.asUser("alice")
    const bob = ensureUser("bob")
    const seen: any[] = []
    handle.events.subscribe({ types: ["im_open"] }, (evt) => seen.push(evt))
    await call(alice.token, "conversations.open", { users: bob.id })
    expect(seen).toHaveLength(1)
    expect(seen[0].user).toBe(alice.user.id)
  })

  test("conversations.close toggles is_open and emits im_close", async () => {
    const alice = handle.asUser("alice")
    const bob = ensureUser("bob")
    const closed: any[] = []
    handle.events.subscribe({ types: ["im_close"] }, (evt) => closed.push(evt))
    const { channel } = await call(alice.token, "conversations.open", { users: bob.id })
    const closeRes = await call(alice.token, "conversations.close", { channel: channel.id })
    expect(closeRes.ok).toBe(true)
    const stored = handle.workspace.channels.get(channel.id)
    expect(stored && (stored.is_im || stored.is_mpim) ? (stored as any).is_open : undefined).toBe(false)
    expect(closed).toHaveLength(1)
    expect(closed[0].channel).toBe(channel.id)
  })

  test("bad user id returns user_not_found", async () => {
    const alice = handle.asUser("alice")
    const res = await call(alice.token, "conversations.open", { users: "UXXXXXX" })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("user_not_found")
  })
})

describe("DM messaging", () => {
  test("alice sends DM; bob sees it in conversations.history", async () => {
    const alice = handle.asUser("alice")
    const bob = handle.asUser("bob")
    const { channel } = await call(alice.token, "conversations.open", { users: bob.user.id })
    await call(alice.token, "chat.postMessage", { channel: channel.id, text: "hey bob" })
    const history = await call(bob.token, "conversations.history", { channel: channel.id })
    expect(history.messages.map((m: any) => m.text)).toEqual(["hey bob"])
  })
})

// ---------------------------------------------------------------------------

function ensureUser(name: string): { id: string } {
  for (const u of handle.workspace.users.values()) {
    if (u.name === name) return u
  }
  throw new Error(`user ${name} missing`)
}
