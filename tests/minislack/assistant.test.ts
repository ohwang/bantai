import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { startMinislack, type MinislackHandle } from "../../src/minislack/testing/harness"
import { createPublicChannel } from "../../src/minislack/core/channels"
import { createUser } from "../../src/minislack/core/users"
import { postMessage } from "../../src/minislack/core/messages"

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

describe("assistant.threads.setStatus", () => {
  test("writes status onto the thread parent and publishes an SSE event", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "status", creator: alice.user.id })
    const parent = postMessage(handle.workspace, {
      channelId: ch.id,
      userId: alice.user.id,
      text: "top-level",
    })

    const received: any[] = []
    handle.events.subscribe(
      { types: ["assistant_thread_status_changed"] },
      (e) => received.push(e),
    )

    const res = await call(alice.token, "assistant.threads.setStatus", {
      channel_id: ch.id,
      thread_ts: parent.ts,
      status: "is thinking…",
    })
    expect(res.ok).toBe(true)

    const stored = handle.workspace.channels.get(ch.id)!.messages.get(parent.ts)!
    expect(stored.assistant_state?.status).toBe("is thinking…")

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      type: "assistant_thread_status_changed",
      channel: ch.id,
      thread_ts: parent.ts,
      status: "is thinking…",
    })
  })

  test("hoists replies to the top-level parent (Slack flattens threads)", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "hoist", creator: alice.user.id })
    const parent = postMessage(handle.workspace, {
      channelId: ch.id,
      userId: alice.user.id,
      text: "parent",
    })
    const reply = postMessage(handle.workspace, {
      channelId: ch.id,
      userId: alice.user.id,
      text: "reply",
      thread_ts: parent.ts,
    })

    const res = await call(alice.token, "assistant.threads.setStatus", {
      channel_id: ch.id,
      thread_ts: reply.ts,
      status: "working",
    })
    expect(res.ok).toBe(true)

    // State lands on the parent, not the reply.
    const storedParent = handle.workspace.channels.get(ch.id)!.messages.get(parent.ts)!
    const storedReply = handle.workspace.channels.get(ch.id)!.messages.get(reply.ts)!
    expect(storedParent.assistant_state?.status).toBe("working")
    expect(storedReply.assistant_state).toBeUndefined()
  })

  test("rejects an unknown thread_ts", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "missing", creator: alice.user.id })
    const res = await call(alice.token, "assistant.threads.setStatus", {
      channel_id: ch.id,
      thread_ts: "1700000000.000001",
      status: "x",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("message_not_found")
  })
})

describe("assistant.threads.setSuggestedPrompts", () => {
  test("stores prompts with optional title and publishes an event", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "prompts", creator: alice.user.id })
    const parent = postMessage(handle.workspace, {
      channelId: ch.id,
      userId: alice.user.id,
      text: "parent",
    })

    const received: any[] = []
    handle.events.subscribe(
      { types: ["assistant_thread_suggested_prompts_changed"] },
      (e) => received.push(e),
    )

    const res = await call(alice.token, "assistant.threads.setSuggestedPrompts", {
      channel_id: ch.id,
      thread_ts: parent.ts,
      title: "Try one of these",
      prompts: [
        { title: "Explain diffs", message: "Explain the diff in detail" },
        { title: "Write tests", message: "Write unit tests for this code" },
      ],
    })
    expect(res.ok).toBe(true)

    const stored = handle.workspace.channels.get(ch.id)!.messages.get(parent.ts)!
    expect(stored.assistant_state?.suggested_prompts?.prompts).toHaveLength(2)
    expect(stored.assistant_state?.suggested_prompts?.title).toBe("Try one of these")
    expect(received).toHaveLength(1)
    expect(received[0].prompts).toHaveLength(2)
  })

  test("rejects an empty prompts array", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "empty", creator: alice.user.id })
    const parent = postMessage(handle.workspace, {
      channelId: ch.id,
      userId: alice.user.id,
      text: "parent",
    })
    const res = await call(alice.token, "assistant.threads.setSuggestedPrompts", {
      channel_id: ch.id,
      thread_ts: parent.ts,
      prompts: [],
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("invalid_arguments")
  })
})

describe("assistant.threads.setTitle", () => {
  test("stores title and publishes an event", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "title", creator: alice.user.id })
    const parent = postMessage(handle.workspace, {
      channelId: ch.id,
      userId: alice.user.id,
      text: "parent",
    })

    const received: any[] = []
    handle.events.subscribe(
      { types: ["assistant_thread_title_changed"] },
      (e) => received.push(e),
    )

    const res = await call(alice.token, "assistant.threads.setTitle", {
      channel_id: ch.id,
      thread_ts: parent.ts,
      title: "Migration plan review",
    })
    expect(res.ok).toBe(true)

    const stored = handle.workspace.channels.get(ch.id)!.messages.get(parent.ts)!
    expect(stored.assistant_state?.title).toBe("Migration plan review")
    expect(received).toHaveLength(1)
    expect(received[0].title).toBe("Migration plan review")
  })

  test("rejects an empty title", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "notitle", creator: alice.user.id })
    const parent = postMessage(handle.workspace, {
      channelId: ch.id,
      userId: alice.user.id,
      text: "parent",
    })
    const res = await call(alice.token, "assistant.threads.setTitle", {
      channel_id: ch.id,
      thread_ts: parent.ts,
      title: "",
    })
    expect(res.ok).toBe(false)
    // str() rejects empty strings with invalid_arguments before we reach the method.
    expect(res.error).toBe("invalid_arguments")
  })
})
