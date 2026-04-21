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

async function openSocket(appToken: string): Promise<WebSocket> {
  const res = await fetch(`${handle.url}/api/apps.connections.open`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appToken}` },
  })
  const body = (await res.json()) as { ok: boolean; url: string }
  expect(body.ok).toBe(true)
  const socket = new WebSocket(body.url)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", (e) => reject(e), { once: true })
  })
  return socket
}

function nextEnvelopeOfType(
  socket: WebSocket,
  type: string,
  timeoutMs = 2000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMsg)
      reject(new Error(`timeout waiting for envelope type=${type}`))
    }, timeoutMs)
    function onMsg(ev: MessageEvent) {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data)
      try {
        const parsed = JSON.parse(data)
        if (parsed.type === type) {
          clearTimeout(timer)
          socket.removeEventListener("message", onMsg)
          resolve(parsed)
        }
      } catch {
        // non-JSON keepalive
      }
    }
    socket.addEventListener("message", onMsg)
  })
}

describe("slash commands via Socket Mode", () => {
  test("fireSlashCommand reaches the connected app with full payload", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "ops", creator: alice.user.id })
    joinChannel(handle.workspace, ch.id, alice.user.id)
    const { app, appToken } = handle.registerApp({ name: "opsbot" })

    const socket = await openSocket(appToken)
    try {
      // Drain the `hello` envelope first.
      await nextEnvelopeOfType(socket, "hello")

      const cmdP = nextEnvelopeOfType(socket, "slash_commands")
      const fired = await handle.fireSlashCommand(app.id, {
        userId: alice.user.id,
        channelId: ch.id,
        command: "/deploy",
        text: "production",
      })
      const cmd = await cmdP

      expect(cmd.type).toBe("slash_commands")
      expect(cmd.envelope_id).toBe(fired.envelope_id)
      expect(cmd.accepts_response_payload).toBe(true)
      expect(cmd.payload.command).toBe("/deploy")
      expect(cmd.payload.text).toBe("production")
      expect(cmd.payload.user_id).toBe(alice.user.id)
      expect(cmd.payload.channel_id).toBe(ch.id)
      expect(cmd.payload.team_id).toBe(handle.workspace.team.id)
      expect(cmd.payload.api_app_id).toBe(app.id)
      expect(cmd.payload.response_url).toMatch(/^http:\/\/.+\/_minislack\/response\//)
    } finally {
      socket.close()
    }
  })

  test("thread_ts is carried on the payload when provided", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "threads", creator: alice.user.id })
    joinChannel(handle.workspace, ch.id, alice.user.id)
    const { app, appToken } = handle.registerApp({ name: "threadbot" })

    const socket = await openSocket(appToken)
    try {
      await nextEnvelopeOfType(socket, "hello")
      const cmdP = nextEnvelopeOfType(socket, "slash_commands")
      await handle.fireSlashCommand(app.id, {
        userId: alice.user.id,
        channelId: ch.id,
        command: "/bantai",
        text: "new",
        threadTs: "1700000000.123456",
      })
      const cmd = await cmdP
      expect(cmd.payload.thread_ts).toBe("1700000000.123456")
    } finally {
      socket.close()
    }
  })

  test("thread_ts is absent when invoked from channel root", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "noroot", creator: alice.user.id })
    joinChannel(handle.workspace, ch.id, alice.user.id)
    const { app, appToken } = handle.registerApp({ name: "rootbot" })

    const socket = await openSocket(appToken)
    try {
      await nextEnvelopeOfType(socket, "hello")
      const cmdP = nextEnvelopeOfType(socket, "slash_commands")
      await handle.fireSlashCommand(app.id, {
        userId: alice.user.id,
        channelId: ch.id,
        command: "/bantai",
        text: "help",
      })
      const cmd = await cmdP
      expect(cmd.payload.thread_ts).toBeUndefined()
    } finally {
      socket.close()
    }
  })

  test("ack payload round-trips via awaitAckMs", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const ch = createPublicChannel(handle.workspace, { name: "ack", creator: alice.user.id })
    const { app, appToken } = handle.registerApp({ name: "ackbot" })

    const socket = await openSocket(appToken)
    try {
      await nextEnvelopeOfType(socket, "hello")

      // The bot echoes back an ack with a response payload.
      socket.addEventListener("message", (ev) => {
        const data = typeof ev.data === "string" ? ev.data : String(ev.data)
        const parsed = JSON.parse(data)
        if (parsed.type === "slash_commands") {
          socket.send(JSON.stringify({
            envelope_id: parsed.envelope_id,
            payload: { text: "deploying to " + parsed.payload.text, response_type: "in_channel" },
          }))
        }
      })

      const result = await handle.fireSlashCommand(app.id, {
        userId: alice.user.id,
        channelId: ch.id,
        command: "/deploy",
        text: "staging",
        awaitAckMs: 1000,
      })
      expect(result.ack).toEqual({ text: "deploying to staging", response_type: "in_channel" })
    } finally {
      socket.close()
    }
  })
})

describe("interactive (block_actions) via Socket Mode", () => {
  test("fireInteractive delivers a block_actions envelope", async () => {
    createUser(handle.workspace, { name: "alice" })
    const alice = handle.asUser("alice")
    const { app, appToken } = handle.registerApp({ name: "btnbot" })

    const socket = await openSocket(appToken)
    try {
      await nextEnvelopeOfType(socket, "hello")

      const interP = nextEnvelopeOfType(socket, "interactive")
      const fired = await handle.fireInteractive(app.id, {
        type: "block_actions",
        team: { id: handle.workspace.team.id, domain: handle.workspace.team.domain },
        user: {
          id: alice.user.id,
          username: alice.user.name,
          name: alice.user.real_name,
          team_id: handle.workspace.team.id,
        },
        api_app_id: app.id,
        token: "minislack-legacy-token",
        container: { type: "message", message_ts: "1.000001", channel_id: "C00000001" },
        trigger_id: "1.abc",
        response_url: `${handle.url}/_minislack/response/xyz`,
        actions: [
          {
            action_id: "click_me",
            block_id: "b1",
            type: "button",
            text: { type: "plain_text", text: "Click" },
            value: "v1",
            action_ts: "1.000001",
          },
        ],
        is_enterprise_install: false,
        enterprise: null,
      })
      const env = await interP
      expect(env.type).toBe("interactive")
      expect(env.envelope_id).toBe(fired.envelope_id)
      expect(env.payload.type).toBe("block_actions")
      expect(env.payload.actions[0].action_id).toBe("click_me")
      expect(env.payload.user.id).toBe(alice.user.id)
    } finally {
      socket.close()
    }
  })
})
