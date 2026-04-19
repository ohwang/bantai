/**
 * Phase 7 — files upload (v1 multipart + v2 external) + serving.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { startMinislack, type MinislackHandle } from "../../src/minislack/testing/harness"
import { createPublicChannel } from "../../src/minislack/core/channels"
import { createUser } from "../../src/minislack/core/workspace"

let handle: MinislackHandle

beforeEach(async () => {
  handle = await startMinislack({ port: 0, serveWeb: false })
  const alice = createUser(handle.workspace, { name: "alice", real_name: "Alice" })
  createPublicChannel(handle.workspace, {
    name: "general",
    creator: alice.id,
    is_general: true,
    members: [alice.id],
  })
})

afterEach(async () => {
  await handle.stop()
})

// Tiny PNG byte source — not a real PNG, but mimetype-tagged so the server
// doesn't second-guess us. url_private serving is mimetype-driven.
function fakePng(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04])
}

describe("files.upload v1 (multipart)", () => {
  test("upload bytes, receive file record, /files/:id serves them back", async () => {
    const alice = handle.asUser("alice")
    const bytes = fakePng()
    const fd = new FormData()
    fd.append("channels", "general")
    fd.append("filename", "pic.png")
    fd.append("initial_comment", "look at this")
    fd.append("file", new Blob([bytes], { type: "image/png" }), "pic.png")

    const res = await fetch(`${handle.url}/api/files.upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}` },
      body: fd,
    })
    const body = (await res.json()) as { ok: boolean; file: { id: string; url_private: string; mimetype: string; name: string; size: number } }
    expect(body.ok).toBe(true)
    expect(body.file.mimetype).toBe("image/png")
    expect(body.file.name).toBe("pic.png")
    expect(body.file.size).toBe(bytes.byteLength)
    expect(body.file.id.startsWith("F")).toBe(true)
    expect(body.file.url_private).toContain("/files/")

    // Fetch the bytes back by public URL — any MIME the server stored must
    // round-trip.
    const getRes = await fetch(body.file.url_private)
    expect(getRes.status).toBe(200)
    expect(getRes.headers.get("content-type")).toBe("image/png")
    const served = new Uint8Array(await getRes.arrayBuffer())
    expect(served.byteLength).toBe(bytes.byteLength)
    for (let i = 0; i < bytes.byteLength; i++) {
      expect(served[i]).toBe(bytes[i]!)
    }

    // The initial_comment became a message with the file attached.
    const history = await alice.history("general")
    expect(history.length).toBe(1)
    const m = history[0]!
    expect(m.text).toBe("look at this")
    expect((m.files ?? []).length).toBe(1)
    expect(m.files?.[0]?.id).toBe(body.file.id)
  })

  test("non-image file mimetype round-trips", async () => {
    const alice = handle.asUser("alice")
    const bytes = new TextEncoder().encode("hello, world")
    const fd = new FormData()
    fd.append("channels", "general")
    fd.append("filename", "greeting.txt")
    fd.append("file", new Blob([bytes], { type: "text/plain" }), "greeting.txt")

    const res = await fetch(`${handle.url}/api/files.upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}` },
      body: fd,
    })
    const body = (await res.json()) as { ok: boolean; file: { url_private: string; filetype: string; pretty_type: string } }
    expect(body.ok).toBe(true)
    expect(body.file.filetype).toBe("txt")
    expect(body.file.pretty_type).toBe("Plain Text")

    const got = await fetch(body.file.url_private)
    expect(got.status).toBe(200)
    // Bun's Blob constructor may tack on ";charset=utf-8" to text/* types —
    // accept either form as long as it starts with "text/plain".
    expect((got.headers.get("content-type") ?? "").startsWith("text/plain")).toBe(true)
    expect(await got.text()).toBe("hello, world")
  })

  test("404 for an unknown file id", async () => {
    const res = await fetch(`${handle.url}/files/F99999999`)
    expect(res.status).toBe(404)
  })

  test("content-inline body (form-urlencoded) uploads as a text file", async () => {
    const alice = handle.asUser("alice")
    const body = new URLSearchParams({
      channels: "general",
      filename: "note.md",
      filetype: "md",
      content: "# hello\n\ninline body",
      initial_comment: "see attached",
    })
    const res = await fetch(`${handle.url}/api/files.upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    })
    const out = (await res.json()) as {
      ok: boolean
      file: { name: string; mimetype: string; size: number; url_private: string }
    }
    expect(out.ok).toBe(true)
    expect(out.file.name).toBe("note.md")
    expect(out.file.mimetype).toBe("text/markdown")
    expect(out.file.size).toBe(
      new TextEncoder().encode("# hello\n\ninline body").byteLength,
    )
    const served = await fetch(out.file.url_private)
    expect(await served.text()).toBe("# hello\n\ninline body")

    const history = await alice.history("general")
    expect(history[0]?.text).toBe("see attached")
  })

  test("content-inline body (JSON) defaults filename + mimetype", async () => {
    const alice = handle.asUser("alice")
    const res = await fetch(`${handle.url}/api/files.upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channels: "general",
        content: "plain-text-body",
      }),
    })
    const out = (await res.json()) as {
      ok: boolean
      file: { name: string; mimetype: string }
    }
    expect(out.ok).toBe(true)
    expect(out.file.name).toBe("upload.txt")
    expect(out.file.mimetype).toBe("text/plain")
  })

  test("no file part and no content → no_file_data", async () => {
    const alice = handle.asUser("alice")
    const body = new URLSearchParams({ channels: "general", filename: "empty.txt" })
    const res = await fetch(`${handle.url}/api/files.upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    })
    const out = (await res.json()) as { ok: boolean; error?: string }
    expect(out.ok).toBe(false)
    expect(out.error).toBe("no_file_data")
  })
})

describe("files v2 (getUploadURLExternal + completeUploadExternal)", () => {
  test("reserve → PUT bytes → complete → attached to channel", async () => {
    const alice = handle.asUser("alice")
    const bytes = fakePng()

    // 1. Reserve
    const reserveRes = await fetch(`${handle.url}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filename: "pic.png", length: bytes.byteLength }),
    })
    const reserved = (await reserveRes.json()) as { ok: boolean; upload_url: string; file_id: string }
    expect(reserved.ok).toBe(true)
    expect(reserved.upload_url).toContain("/_files/upload/")
    expect(reserved.file_id.startsWith("F")).toBe(true)

    // 2. PUT bytes
    const putRes = await fetch(reserved.upload_url, {
      method: "PUT",
      body: bytes,
    })
    expect(putRes.status).toBe(200)

    // 3. Complete
    const completeRes = await fetch(`${handle.url}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: [{ id: reserved.file_id, title: "cool pic" }],
        channel_id: "general",
        initial_comment: "v2 upload",
      }),
    })
    const done = (await completeRes.json()) as { ok: boolean; files: Array<{ id: string; url_private: string; mimetype: string }> }
    expect(done.ok).toBe(true)
    expect(done.files.length).toBe(1)
    expect(done.files[0]!.id).toBe(reserved.file_id)
    expect(done.files[0]!.mimetype).toBe("image/png")

    // 4. File appears in the channel history with the message
    const history = await alice.history("general")
    expect(history.length).toBe(1)
    const m = history[0]!
    expect(m.text).toBe("v2 upload")
    expect((m.files ?? [])[0]?.id).toBe(reserved.file_id)

    // 5. /files/:id serves them back
    const getRes = await fetch(done.files[0]!.url_private)
    expect(getRes.status).toBe(200)
    const served = new Uint8Array(await getRes.arrayBuffer())
    expect(served.byteLength).toBe(bytes.byteLength)
  })

  test("unknown token PUT returns 404", async () => {
    const res = await fetch(`${handle.url}/_files/upload/F99999999`, {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
    })
    expect(res.status).toBe(404)
  })
})

describe("file_shared event + registered app subscription", () => {
  test("app subscribed to file_shared receives an events_api envelope", async () => {
    // Register an app subscribed to file_shared.
    const app = handle.registerApp({
      name: "file-watcher",
      scopes: ["files:read"],
      subscribed_events: ["file_shared", "message"],
    })
    // The bot must be a channel member to receive messages; file_shared fans
    // out to all subscribed sockets so channel membership doesn't gate it.
    const general = handle.workspace.channels.get("C00000001")!
    general.members.push(app.botUser.id)

    // Open the Socket Mode connection.
    const openRes = await fetch(`${handle.url}/api/apps.connections.open`, {
      method: "POST",
      headers: { Authorization: `Bearer ${app.appToken}`, "Content-Type": "application/json" },
      body: "{}",
    })
    const openBody = (await openRes.json()) as { ok: boolean; url: string }
    expect(openBody.ok).toBe(true)

    const sock = new WebSocket(openBody.url)
    const received: Array<{ type: string; payload?: any }> = []
    const helloReceived = new Promise<void>((resolve) => {
      sock.addEventListener("message", (msg) => {
        const ev = JSON.parse(String(msg.data)) as { type: string; payload?: any }
        received.push(ev)
        if (ev.type === "hello") resolve()
      })
    })
    await new Promise<void>((resolve, reject) => {
      sock.addEventListener("open", () => resolve())
      sock.addEventListener("error", (e) => reject(e))
    })
    await helloReceived

    // Upload a file (triggers file_shared and a message).
    const alice = handle.asUser("alice")
    const bytes = fakePng()
    const fd = new FormData()
    fd.append("channels", "general")
    fd.append("filename", "pic.png")
    fd.append("file", new Blob([bytes], { type: "image/png" }), "pic.png")
    const upRes = await fetch(`${handle.url}/api/files.upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}` },
      body: fd,
    })
    const up = (await upRes.json()) as { ok: boolean; file: { id: string } }
    expect(up.ok).toBe(true)

    await waitFor(
      () => received.some((e) => e.type === "events_api" && e.payload?.event?.type === "file_shared"),
      1000,
    )
    const evt = received.find((e) => e.type === "events_api" && e.payload?.event?.type === "file_shared")!
    expect(evt.payload.event.file_id).toBe(up.file.id)
    expect(evt.payload.event.channel_id).toBe("C00000001")
    expect(evt.payload.event.user_id).toBe(alice.user.id)

    sock.close()
  })
})

describe("files.info", () => {
  test("returns the stored file record; 404-like for unknowns", async () => {
    const alice = handle.asUser("alice")
    const bytes = fakePng()
    const fd = new FormData()
    fd.append("channels", "general")
    fd.append("filename", "pic.png")
    fd.append("file", new Blob([bytes], { type: "image/png" }), "pic.png")
    const res = await fetch(`${handle.url}/api/files.upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}` },
      body: fd,
    })
    const up = (await res.json()) as { ok: boolean; file: { id: string } }

    const infoRes = await fetch(`${handle.url}/api/files.info`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ file: up.file.id }),
    })
    const infoBody = (await infoRes.json()) as { ok: boolean; file: { id: string; name: string } }
    expect(infoBody.ok).toBe(true)
    expect(infoBody.file.id).toBe(up.file.id)
    expect(infoBody.file.name).toBe("pic.png")

    const missingRes = await fetch(`${handle.url}/api/files.info`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ file: "F99999999" }),
    })
    const missingBody = (await missingRes.json()) as { ok: boolean; error?: string }
    expect(missingBody.ok).toBe(false)
    expect(missingBody.error).toBe("file_not_found")
  })
})

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 10))
  }
}
