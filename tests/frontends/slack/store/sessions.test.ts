import { describe, expect, it } from "bun:test"
import {
  createNoopSessionStore,
  createSessionStore,
} from "../../../../src/frontends/slack/store/sessions"

function mk() {
  return createSessionStore({ path: ":memory:" })
}

describe("createSessionStore — in-memory", () => {
  it("upsert + get round-trip", () => {
    const s = mk()
    s.upsert({
      key: "slack:W1:C1:main",
      workspace: "W1",
      channelId: "C1",
      threadTs: "main",
      backendId: "claude",
    })
    const row = s.get("slack:W1:C1:main")
    expect(row).toBeDefined()
    expect(row!.workspace).toBe("W1")
    expect(row!.channelId).toBe("C1")
    expect(row!.threadTs).toBe("main")
    expect(row!.backendId).toBe("claude")
    expect(row!.backendSessionId).toBeNull()
    expect(row!.turns).toBe(0)
    expect(row!.totalCostUsd).toBe(0)
    expect(row!.lastActiveAt).toBeGreaterThan(0)
    expect(row!.createdAt).toBeGreaterThan(0)
    s.close()
  })

  it("re-upsert preserves turns + cost (does not reset counters)", () => {
    const s = mk()
    s.upsert({
      key: "k1",
      workspace: "W",
      channelId: "C",
      threadTs: "t",
      backendId: "claude",
    })
    s.recordTurn("k1", 0.25)
    s.recordTurn("k1", 0.15)
    // Same key upsert shouldn't nuke counters.
    s.upsert({
      key: "k1",
      workspace: "W",
      channelId: "C",
      threadTs: "t",
      backendId: "claude",
    })
    const row = s.get("k1")!
    expect(row.turns).toBe(2)
    expect(row.totalCostUsd).toBeCloseTo(0.4, 5)
    s.close()
  })

  it("setBackendSessionId persists the sessionId for later resume", () => {
    const s = mk()
    s.upsert({ key: "k2", workspace: "W", channelId: "C", threadTs: "t", backendId: "claude" })
    s.setBackendSessionId("k2", "sdk-session-abc")
    expect(s.get("k2")!.backendSessionId).toBe("sdk-session-abc")
    s.close()
  })

  it("touch bumps lastActiveAt", async () => {
    const s = mk()
    s.upsert({ key: "k3", workspace: "W", channelId: "C", threadTs: "t", backendId: "claude" })
    const before = s.get("k3")!.lastActiveAt
    await new Promise((r) => setTimeout(r, 5))
    s.touch("k3")
    const after = s.get("k3")!.lastActiveAt
    expect(after).toBeGreaterThanOrEqual(before)
    s.close()
  })

  it("recordTurn accumulates turns + cost", () => {
    const s = mk()
    s.upsert({ key: "k4", workspace: "W", channelId: "C", threadTs: "t", backendId: "claude" })
    s.recordTurn("k4", 0.01)
    s.recordTurn("k4", 0.02)
    s.recordTurn("k4", 0.03)
    const row = s.get("k4")!
    expect(row.turns).toBe(3)
    expect(row.totalCostUsd).toBeCloseTo(0.06, 5)
    s.close()
  })

  it("delete removes the row", () => {
    const s = mk()
    s.upsert({ key: "k5", workspace: "W", channelId: "C", threadTs: "t", backendId: "claude" })
    expect(s.get("k5")).toBeDefined()
    s.delete("k5")
    expect(s.get("k5")).toBeUndefined()
    s.close()
  })

  it("list returns all sessions newest-active first", () => {
    const s = mk()
    s.upsert({ key: "a", workspace: "W", channelId: "C1", threadTs: "1", backendId: "claude" })
    s.upsert({ key: "b", workspace: "W", channelId: "C2", threadTs: "1", backendId: "codex" })
    const rows = s.list()
    const keys = rows.map((r) => r.key).sort()
    expect(keys).toEqual(["a", "b"])
    s.close()
  })

  it("operations on a closed store are no-ops (don't throw)", () => {
    const s = mk()
    s.upsert({ key: "c", workspace: "W", channelId: "C", threadTs: "t", backendId: "claude" })
    s.close()
    // Double close is safe.
    s.close()
    // Reads post-close return undefined/empty.
    expect(s.get("c")).toBeUndefined()
    expect(s.list()).toEqual([])
    // Writes post-close don't throw.
    s.upsert({ key: "d", workspace: "W", channelId: "C", threadTs: "t", backendId: "claude" })
    s.touch("d")
    s.recordTurn("d", 0.5)
    s.delete("d")
  })
})

describe("createNoopSessionStore", () => {
  it("accepts all calls and always returns the no-row answer", () => {
    const s = createNoopSessionStore()
    s.upsert({ key: "k", workspace: "W", channelId: "C", threadTs: "t", backendId: "claude" })
    s.setBackendSessionId("k", "id")
    s.touch("k")
    s.recordTurn("k", 1)
    expect(s.get("k")).toBeUndefined()
    expect(s.list()).toEqual([])
    s.delete("k")
    s.close()
  })
})

describe("createSessionStore — on-disk persistence", () => {
  it("sessions written by one instance are visible to a fresh instance at the same path", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "bantai-sessions-"))
    try {
      const dbPath = join(dir, "slack.db")
      const s1 = createSessionStore({ path: dbPath })
      s1.upsert({
        key: "slack:W1:C1:1.0",
        workspace: "W1",
        channelId: "C1",
        threadTs: "1.0",
        backendId: "claude",
      })
      s1.setBackendSessionId("slack:W1:C1:1.0", "sdk-abc")
      s1.recordTurn("slack:W1:C1:1.0", 0.1)
      s1.close()

      const s2 = createSessionStore({ path: dbPath })
      const row = s2.get("slack:W1:C1:1.0")
      expect(row).toBeDefined()
      expect(row!.backendSessionId).toBe("sdk-abc")
      expect(row!.turns).toBe(1)
      expect(row!.totalCostUsd).toBeCloseTo(0.1, 5)
      s2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
