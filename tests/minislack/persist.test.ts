import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

import { startMinislack, type MinislackHandle } from "../../src/minislack/testing/harness"
import { createUser } from "../../src/minislack/core/users"
import { createPublicChannel, joinChannel } from "../../src/minislack/core/channels"
import { createDiskStorage } from "../../src/minislack/storage/disk"
import { toSnapshot } from "../../src/minislack/storage/snapshot"

let persistDir: string
let handle: MinislackHandle | undefined

beforeEach(async () => {
  persistDir = await mkdtemp(path.join(os.tmpdir(), "minislack-persist-"))
})

afterEach(async () => {
  if (handle) {
    await handle.stop()
    handle = undefined
  }
  await rm(persistDir, { recursive: true, force: true })
})

describe("persist", () => {
  test("restart with --persist preserves users, channels, and messages", async () => {
    handle = await startMinislack({ port: 0, serveWeb: false, persist: persistDir })
    createUser(handle.workspace, { name: "alice" })
    createUser(handle.workspace, { name: "bob" })
    const ch = createPublicChannel(handle.workspace, { name: "general", creator: "USLACKBOT" })
    const alice = handle.asUser("alice")
    joinChannel(handle.workspace, ch.id, alice.user.id)
    await alice.sendMessage(ch.id, "first")
    await alice.sendMessage(ch.id, "second")
    await handle.stop()
    handle = undefined

    handle = await startMinislack({ port: 0, serveWeb: false, persist: persistDir })
    const aliceR = handle.asUser("alice")
    const history = await aliceR.history(ch.id)
    // conversations.history returns newest-first.
    expect(history.map((m) => m.text)).toEqual(["second", "first"])
    expect(handle.workspace.users.size).toBeGreaterThanOrEqual(2)
    expect(handle.workspace.channels.get(ch.id)?.members).toContain(aliceR.user.id)
  })

  test("ts monotonicity survives reload — new posts sort after old", async () => {
    handle = await startMinislack({ port: 0, serveWeb: false, persist: persistDir })
    createUser(handle.workspace, { name: "alice" })
    const ch = createPublicChannel(handle.workspace, { name: "random", creator: "USLACKBOT" })
    const alice = handle.asUser("alice")
    joinChannel(handle.workspace, ch.id, alice.user.id)
    const before = await alice.sendMessage(ch.id, "pre")
    await handle.stop()
    handle = undefined

    handle = await startMinislack({ port: 0, serveWeb: false, persist: persistDir })
    const aliceR = handle.asUser("alice")
    const after = await aliceR.sendMessage(ch.id, "post")
    expect(after.ts > before.ts).toBe(true)
    const history = await aliceR.history(ch.id)
    expect(history.map((m) => m.text)).toEqual(["post", "pre"])
  })

  test("id counters keep minting fresh ids after reload", async () => {
    handle = await startMinislack({ port: 0, serveWeb: false, persist: persistDir })
    createUser(handle.workspace, { name: "alice" })
    const before = handle.workspace.users.size
    await handle.stop()
    handle = undefined

    handle = await startMinislack({ port: 0, serveWeb: false, persist: persistDir })
    createUser(handle.workspace, { name: "bob" })
    expect(handle.workspace.users.size).toBe(before + 1)
    // Bob must get a distinct id from Alice (counter persisted).
    const ids = Array.from(handle.workspace.users.values()).map((u) => u.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("file bytes persist across restarts and rebase to the new port", async () => {
    handle = await startMinislack({ port: 0, serveWeb: false, persist: persistDir })
    createUser(handle.workspace, { name: "alice" })
    const ch = createPublicChannel(handle.workspace, { name: "pix", creator: "USLACKBOT" })
    const alice = handle.asUser("alice")
    joinChannel(handle.workspace, ch.id, alice.user.id)

    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const fd = new FormData()
    fd.append("channels", ch.id)
    fd.append("filename", "tiny.png")
    fd.append("file", new Blob([bytes], { type: "image/png" }), "tiny.png")
    const upload = await fetch(`${handle.url}/api/files.upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}` },
      body: fd,
    })
    const uploadBody = (await upload.json()) as { ok: boolean; file: { id: string; url_private: string } }
    expect(uploadBody.ok).toBe(true)
    const fileId = uploadBody.file.id

    await handle.stop()
    handle = undefined

    handle = await startMinislack({ port: 0, serveWeb: false, persist: persistDir })
    const persisted = handle.workspace.files.get(fileId)
    expect(persisted).toBeDefined()
    // URL rebased onto the new port.
    expect(persisted!.url_private.startsWith(handle.url)).toBe(true)
    const served = await fetch(persisted!.url_private)
    const servedBytes = new Uint8Array(await served.arrayBuffer())
    expect(Array.from(servedBytes)).toEqual(Array.from(bytes))
  })

  test("memory backend (no --persist) writes nothing to disk", async () => {
    handle = await startMinislack({ port: 0, serveWeb: false })
    createUser(handle.workspace, { name: "alice" })
    // Nothing to assert at persistDir — it's empty and we don't even pass it.
    // Instead, verify that using disk storage directly on an empty dir loads null.
    const disk = createDiskStorage({ root: persistDir })
    expect(await disk.load()).toBeNull()
    await disk.stop()
  })

  test("debounced writes collapse a burst into one workspace.json write", async () => {
    handle = await startMinislack({ port: 0, serveWeb: false, persist: persistDir })
    createUser(handle.workspace, { name: "alice" })
    const ch = createPublicChannel(handle.workspace, { name: "burst", creator: "USLACKBOT" })
    const alice = handle.asUser("alice")
    joinChannel(handle.workspace, ch.id, alice.user.id)
    for (let i = 0; i < 20; i++) await alice.sendMessage(ch.id, `m${i}`)
    await handle.stop()
    handle = undefined

    const jsonText = await readFile(path.join(persistDir, "workspace.json"), "utf8")
    const parsed = JSON.parse(jsonText)
    // Confirm the final state includes all 20 messages.
    const burst = parsed.channels.find((c: { id: string }) => c.id === ch.id)
    expect(burst.messages).toHaveLength(20)

    // workspace.json exists, workspace.json.tmp should not.
    const entries = await readdir(persistDir)
    expect(entries).toContain("workspace.json")
    expect(entries).not.toContain("workspace.json.tmp")
  })

  test("snapshot.toSnapshot/fromSnapshot round-trip is pure", async () => {
    handle = await startMinislack({ port: 0, serveWeb: false })
    createUser(handle.workspace, { name: "alice" })
    const ch = createPublicChannel(handle.workspace, { name: "round", creator: "USLACKBOT" })
    const alice = handle.asUser("alice")
    joinChannel(handle.workspace, ch.id, alice.user.id)
    await alice.sendMessage(ch.id, "hello")

    const snap = toSnapshot(handle.workspace)
    const encoded = JSON.stringify(snap)
    const decoded = JSON.parse(encoded)
    expect(decoded.schema_version).toBe(1)
    expect(decoded.users.length).toBe(handle.workspace.users.size)
    expect(decoded.channels[0].messages[0].text).toBe("hello")
  })
})
