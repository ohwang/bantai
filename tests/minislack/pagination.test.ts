import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { startMinislack, type MinislackHandle } from "../../src/minislack/testing/harness"
import { createUser } from "../../src/minislack/core/users"
import { createPublicChannel } from "../../src/minislack/core/channels"

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

describe("pagination", () => {
  test("users.list round-trips via next_cursor until empty", async () => {
    for (let i = 0; i < 25; i++) createUser(handle.workspace, { name: `u${i}` })
    const alice = handle.asUser("u0")

    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    for (;;) {
      const res: any = await call(alice.token, "users.list", { limit: 10, cursor })
      expect(res.ok).toBe(true)
      pages++
      for (const u of res.members) seen.add(u.id)
      cursor = res.response_metadata.next_cursor
      if (!cursor) break
      if (pages > 10) throw new Error("cursor loop")
    }
    expect(seen.size).toBe(25)
    expect(pages).toBeGreaterThanOrEqual(3)
  })

  test("invalid cursor returns invalid_cursor", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const res = await call(alice.token, "users.list", { cursor: "not-base64-o-offset" })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("invalid_cursor")
  })

  test("invalid limit returns invalid_limit", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const res = await call(alice.token, "users.list", { limit: -5 })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("invalid_limit")
  })

  test("conversations.list + conversations.members both paginate", async () => {
    createUser(handle.workspace, { name: "alice" })
    for (let i = 0; i < 15; i++) {
      createPublicChannel(handle.workspace, { name: `ch${i}`, creator: "U00000001" })
    }
    const alice = handle.asUser("alice")

    const list1 = await call(alice.token, "conversations.list", { limit: 5 })
    expect(list1.channels).toHaveLength(5)
    expect(list1.response_metadata.next_cursor).not.toBe("")

    const list2 = await call(alice.token, "conversations.list", {
      limit: 5, cursor: list1.response_metadata.next_cursor,
    })
    expect(list2.channels).toHaveLength(5)
    expect(list2.channels[0].id).not.toBe(list1.channels[0].id)
  })
})

describe("form-body JSON coercion", () => {
  test("blocks sent as JSON string under application/x-www-form-urlencoded is parsed", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "blocks", creator: "U00000001" })
    const body = new URLSearchParams()
    body.set("channel", ch.id)
    body.set("text", "with blocks")
    body.set("blocks", JSON.stringify([{ type: "section", text: { type: "mrkdwn", text: "hi" } }]))
    const res = await fetch(`${handle.url}/api/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    })
    const parsed = (await res.json()) as { ok: boolean; message: { blocks: any[] } }
    expect(parsed.ok).toBe(true)
    expect(Array.isArray(parsed.message.blocks)).toBe(true)
    expect(parsed.message.blocks[0].type).toBe("section")
  })
})
