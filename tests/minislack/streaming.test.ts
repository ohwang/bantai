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

describe("chat.startStream", () => {
  test("creates a placeholder message with streaming=true and publishes a message event", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "stream", creator: alice.user.id })
    const received: any[] = []
    handle.events.subscribe({ types: ["message"] }, (e) => received.push(e))

    const res = await call(alice.token, "chat.startStream", { channel: ch.id })
    expect(res.ok).toBe(true)
    expect(res.channel).toBe(ch.id)
    expect(res.ts).toMatch(/^\d+\.\d{6}$/)

    const msg = handle.workspace.channels.get(ch.id)!.messages.get(res.ts)!
    expect(msg.streaming).toBe(true)
    expect(msg.text).toBe("")
    expect(msg.user).toBe(alice.user.id)

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: "message", channel: ch.id, ts: res.ts })
  })

  test("thread_ts bumps the parent's reply counters and publishes message_changed", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "threadstream", creator: alice.user.id })
    const parent = postMessage(handle.workspace, {
      channelId: ch.id,
      userId: alice.user.id,
      text: "parent",
    })
    const received: any[] = []
    handle.events.subscribe({ types: ["message"] }, (e) => received.push(e))

    const res = await call(alice.token, "chat.startStream", {
      channel: ch.id,
      thread_ts: parent.ts,
    })
    expect(res.ok).toBe(true)

    const updatedParent = handle.workspace.channels.get(ch.id)!.messages.get(parent.ts)!
    expect(updatedParent.reply_count).toBe(1)
    expect(updatedParent.latest_reply).toBe(res.ts)

    const changed = received.find((e) => e.subtype === "message_changed")
    expect(changed).toBeDefined()
    expect(changed.message.ts).toBe(parent.ts)
    expect(changed.message.reply_count).toBe(1)
  })

  test("stores streaming_recipient when Assistant API args are supplied", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "assistant", creator: alice.user.id })
    const res = await call(alice.token, "chat.startStream", {
      channel: ch.id,
      recipient_team_id: "T_FOREIGN",
      recipient_user_id: "U_FOREIGN",
    })
    expect(res.ok).toBe(true)
    const msg = handle.workspace.channels.get(ch.id)!.messages.get(res.ts)!
    expect(msg.streaming_recipient).toEqual({ team_id: "T_FOREIGN", user_id: "U_FOREIGN" })
  })

  test("rejects app-only tokens", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "apponly", creator: alice.user.id })
    const app = handle.registerApp({ name: "botless", scopes: ["chat:write"] })
    const res = (await fetch(`${handle.url}/api/chat.startStream`, {
      method: "POST",
      headers: { Authorization: `Bearer ${app.appToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: ch.id }),
    }).then((r) => r.json())) as any
    expect(res.ok).toBe(false)
    expect(res.error).toBe("not_authed")
  })
})

describe("chat.appendStream", () => {
  test("appends and publishes message_changed events", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "append", creator: alice.user.id })
    const start = await call(alice.token, "chat.startStream", { channel: ch.id })

    const received: any[] = []
    handle.events.subscribe({ types: ["message"] }, (e) => {
      if ("subtype" in e && e.subtype === "message_changed") received.push(e)
    })

    await call(alice.token, "chat.appendStream", { channel: ch.id, ts: start.ts, markdown_text: "Hello" })
    await call(alice.token, "chat.appendStream", { channel: ch.id, ts: start.ts, markdown_text: ", world" })

    const msg = handle.workspace.channels.get(ch.id)!.messages.get(start.ts)!
    expect(msg.text).toBe("Hello, world")
    expect(msg.streaming).toBe(true)
    expect(received).toHaveLength(2)
    expect(received[0].message.text).toBe("Hello")
    expect(received[1].message.text).toBe("Hello, world")
  })

  test("rejects append on a non-streaming message", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "finished", creator: alice.user.id })
    const normal = postMessage(handle.workspace, {
      channelId: ch.id,
      userId: alice.user.id,
      text: "not streaming",
    })
    const res = await call(alice.token, "chat.appendStream", {
      channel: ch.id,
      ts: normal.ts,
      markdown_text: "oops",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("message_not_streaming")
  })

  test("rejects append from a user who is not the streaming author", async () => {
    createUser(handle.workspace, { name: "alice" })
    const bob = createUser(handle.workspace, { name: "bob" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, {
      name: "shared",
      creator: alice.user.id,
      members: [alice.user.id, bob.id],
    })
    const start = await call(alice.token, "chat.startStream", { channel: ch.id })
    const bobClient = handle.asUser("bob")
    const res = await call(bobClient.token, "chat.appendStream", {
      channel: ch.id,
      ts: start.ts,
      markdown_text: "hijack",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("cant_update_message")
  })

  test("rejects append on an unknown ts", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "empty", creator: alice.user.id })
    const res = await call(alice.token, "chat.appendStream", {
      channel: ch.id,
      ts: "1700000000.000001",
      markdown_text: "ghost",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("message_not_found")
  })
})

describe("chat.stopStream", () => {
  test("clears streaming and optionally overwrites the body", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "stop", creator: alice.user.id })
    const start = await call(alice.token, "chat.startStream", { channel: ch.id })
    await call(alice.token, "chat.appendStream", { channel: ch.id, ts: start.ts, markdown_text: "draft" })

    const received: any[] = []
    handle.events.subscribe({ types: ["message"] }, (e) => {
      if ("subtype" in e && e.subtype === "message_changed") received.push(e)
    })

    const res = await call(alice.token, "chat.stopStream", {
      channel: ch.id,
      ts: start.ts,
      text: "canonical final body",
    })
    expect(res.ok).toBe(true)
    const msg = handle.workspace.channels.get(ch.id)!.messages.get(start.ts)!
    expect(msg.streaming).toBe(false)
    expect(msg.text).toBe("canonical final body")
    expect(received).toHaveLength(1)
    expect(received[0].message.text).toBe("canonical final body")
  })

  test("double-stop returns message_not_streaming", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "double", creator: alice.user.id })
    const start = await call(alice.token, "chat.startStream", { channel: ch.id })
    await call(alice.token, "chat.stopStream", { channel: ch.id, ts: start.ts })
    const second = await call(alice.token, "chat.stopStream", { channel: ch.id, ts: start.ts })
    expect(second.ok).toBe(false)
    expect(second.error).toBe("message_not_streaming")
  })

  test("stop without text preserves the accumulator", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "preserve", creator: alice.user.id })
    const start = await call(alice.token, "chat.startStream", { channel: ch.id })
    await call(alice.token, "chat.appendStream", { channel: ch.id, ts: start.ts, markdown_text: "streamed body" })
    const res = await call(alice.token, "chat.stopStream", { channel: ch.id, ts: start.ts })
    expect(res.ok).toBe(true)
    const msg = handle.workspace.channels.get(ch.id)!.messages.get(start.ts)!
    expect(msg.streaming).toBe(false)
    expect(msg.text).toBe("streamed body")
  })

  test("stop accepts blocks and persists them", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "blocks", creator: alice.user.id })
    const start = await call(alice.token, "chat.startStream", { channel: ch.id })
    await call(alice.token, "chat.appendStream", { channel: ch.id, ts: start.ts, markdown_text: "draft" })
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "final" } }]
    const res = await call(alice.token, "chat.stopStream", {
      channel: ch.id,
      ts: start.ts,
      text: "final",
      blocks,
    })
    expect(res.ok).toBe(true)
    const msg = handle.workspace.channels.get(ch.id)!.messages.get(start.ts)!
    expect(msg.blocks).toEqual(blocks as never)
  })
})

// Bolt's @slack/web-api ChatStreamer never calls startStream/appendStream with
// `markdown_text`; it always emits `chunks: [{ type: "markdown_text", text }]`.
// These tests wire that exact shape end-to-end so main's native-stream tier-1
// path works against minislack instead of falling through to the draft+update
// fallback.
describe("chunks-format (Bolt ChatStreamer shape)", () => {
  test("startStream seeds the placeholder from a markdown_text chunk", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "bolt-start", creator: alice.user.id })
    const res = await call(alice.token, "chat.startStream", {
      channel: ch.id,
      chunks: [{ type: "markdown_text", text: "hello " }],
    })
    expect(res.ok).toBe(true)
    const msg = handle.workspace.channels.get(ch.id)!.messages.get(res.ts)!
    expect(msg.streaming).toBe(true)
    expect(msg.text).toBe("hello ")
  })

  test("appendStream accumulates across multiple chunks payloads", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "bolt-append", creator: alice.user.id })
    const start = await call(alice.token, "chat.startStream", {
      channel: ch.id,
      chunks: [{ type: "markdown_text", text: "Hello" }],
    })
    await call(alice.token, "chat.appendStream", {
      channel: ch.id,
      ts: start.ts,
      chunks: [{ type: "markdown_text", text: ", " }],
    })
    await call(alice.token, "chat.appendStream", {
      channel: ch.id,
      ts: start.ts,
      chunks: [
        { type: "markdown_text", text: "world" },
        { type: "markdown_text", text: "!" },
      ],
    })
    const msg = handle.workspace.channels.get(ch.id)!.messages.get(start.ts)!
    expect(msg.text).toBe("Hello, world!")
    expect(msg.streaming).toBe(true)
  })

  test("stopStream finalises from chunks when no text is supplied", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "bolt-stop", creator: alice.user.id })
    const start = await call(alice.token, "chat.startStream", {
      channel: ch.id,
      chunks: [{ type: "markdown_text", text: "draft" }],
    })
    const res = await call(alice.token, "chat.stopStream", {
      channel: ch.id,
      ts: start.ts,
      chunks: [{ type: "markdown_text", text: "final answer" }],
    })
    expect(res.ok).toBe(true)
    const msg = handle.workspace.channels.get(ch.id)!.messages.get(start.ts)!
    expect(msg.streaming).toBe(false)
    expect(msg.text).toBe("final answer")
  })

  test("explicit text overrides chunks on stopStream", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "bolt-override", creator: alice.user.id })
    const start = await call(alice.token, "chat.startStream", { channel: ch.id })
    await call(alice.token, "chat.appendStream", {
      channel: ch.id,
      ts: start.ts,
      chunks: [{ type: "markdown_text", text: "accumulated" }],
    })
    const res = await call(alice.token, "chat.stopStream", {
      channel: ch.id,
      ts: start.ts,
      text: "canonical",
      chunks: [{ type: "markdown_text", text: "ignored" }],
    })
    expect(res.ok).toBe(true)
    const msg = handle.workspace.channels.get(ch.id)!.messages.get(start.ts)!
    expect(msg.text).toBe("canonical")
  })

  test("plan_update and task_update chunks are ignored without breaking", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "bolt-mixed", creator: alice.user.id })
    const start = await call(alice.token, "chat.startStream", {
      channel: ch.id,
      chunks: [
        { type: "markdown_text", text: "body " },
        { type: "plan_update", plan: { id: "p1", title: "x", tasks: [] } },
        { type: "markdown_text", text: "continues" },
        { type: "task_update", task: { id: "t1", title: "y", status: "in_progress" } },
      ],
    })
    expect(start.ok).toBe(true)
    const msg = handle.workspace.channels.get(ch.id)!.messages.get(start.ts)!
    expect(msg.text).toBe("body continues")
  })

  test("appendStream with empty chunks array errors cleanly", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "bolt-empty", creator: alice.user.id })
    const start = await call(alice.token, "chat.startStream", { channel: ch.id })
    const res = await call(alice.token, "chat.appendStream", {
      channel: ch.id,
      ts: start.ts,
      chunks: [],
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("invalid_arguments")
  })
})
