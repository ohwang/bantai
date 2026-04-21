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

  it("upsert with a DIFFERENT backendId clears the stale backend_session_id", () => {
    // Regression: a channel whose backend flipped from codex → gemini used to
    // keep the codex-era sessionId, which Gemini's session/load rejects with
    // JSON-RPC -32603. Now an upsert that changes backend_id must drop the
    // foreign id so a clean session/new happens on the new backend.
    const s = mk()
    s.upsert({ key: "swap", workspace: "W", channelId: "C", threadTs: "t", backendId: "codex" })
    s.setBackendSessionId("swap", "codex-era-uuid")
    s.recordTurn("swap", 0.25)
    expect(s.get("swap")!.backendSessionId).toBe("codex-era-uuid")

    // Simulate channel config change: same key, new backendId.
    s.upsert({ key: "swap", workspace: "W", channelId: "C", threadTs: "t", backendId: "gemini" })
    const after = s.get("swap")!
    expect(after.backendId).toBe("gemini")
    expect(after.backendSessionId).toBeNull()
    // Counters are intentionally preserved — they represent thread usage,
    // not a particular backend's state.
    expect(after.turns).toBe(1)
    expect(after.totalCostUsd).toBeCloseTo(0.25, 5)
    s.close()
  })

  it("upsert with the SAME backendId preserves backend_session_id", () => {
    // Complement of the regression test above — a no-op re-upsert (common
    // every time we route a new inbound message to a live session) must not
    // accidentally drop the resume id. Otherwise every turn would restart
    // the backend session from scratch.
    const s = mk()
    s.upsert({ key: "noop", workspace: "W", channelId: "C", threadTs: "t", backendId: "claude" })
    s.setBackendSessionId("noop", "claude-sdk-abc")
    s.upsert({ key: "noop", workspace: "W", channelId: "C", threadTs: "t", backendId: "claude" })
    expect(s.get("noop")!.backendSessionId).toBe("claude-sdk-abc")
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

describe("createSessionStore — clearBackendSessionId", () => {
  it("drops backend_session_id without deleting the row", () => {
    // Used by the stale-resume coordinator's "Start fresh" path: the user
    // decided to abandon the prior backend session, but we still want to
    // keep turn/cost counters and the row itself so the next message reuses
    // the same row.
    const s = mk()
    s.upsert({
      key: "clear",
      workspace: "W",
      channelId: "C",
      threadTs: "t",
      backendId: "gemini",
    })
    s.setBackendSessionId("clear", "gemini-old")
    s.recordTurn("clear", 0.5)
    expect(s.get("clear")!.backendSessionId).toBe("gemini-old")

    s.clearBackendSessionId("clear")
    const row = s.get("clear")!
    expect(row.backendSessionId).toBeNull()
    // Row + counters preserved.
    expect(row.backendId).toBe("gemini")
    expect(row.turns).toBe(1)
    expect(row.totalCostUsd).toBeCloseTo(0.5, 5)
    s.close()
  })
})

describe("createSessionStore — pending_resume_prompts", () => {
  function samplePrompt(id: string): import(
    "../../../../src/frontends/slack/store/sessions"
  ).PendingResumePrompt {
    return {
      id,
      sessionKey: "slack:W1:C1:main",
      channelId: "C1",
      threadTs: "main",
      messageTs: "1234.5678",
      backendId: "gemini",
      staleBackendId: "codex",
      staleSessionId: "codex-thread-uuid",
      reason: "backend_mismatch",
      queuedTurnJson: JSON.stringify({
        channel: "C1",
        parentTs: "main",
        triggerTs: "1234.5678",
        text: "hello",
        author: { userId: "U1", displayName: "alice" },
      }),
      createdAt: Date.now(),
    }
  }

  it("put → get round-trip", () => {
    const s = mk()
    const p = samplePrompt("prompt-1")
    s.putPendingResumePrompt(p)
    const got = s.getPendingResumePrompt("prompt-1")
    expect(got).toEqual(p)
    s.close()
  })

  it("get returns undefined for unknown ids", () => {
    const s = mk()
    expect(s.getPendingResumePrompt("nope")).toBeUndefined()
    s.close()
  })

  it("delete removes the row", () => {
    const s = mk()
    s.putPendingResumePrompt(samplePrompt("x"))
    s.deletePendingResumePrompt("x")
    expect(s.getPendingResumePrompt("x")).toBeUndefined()
    s.close()
  })

  it("list returns prompts oldest-first", () => {
    const s = mk()
    const a = { ...samplePrompt("a"), createdAt: 1000 }
    const b = { ...samplePrompt("b"), createdAt: 2000 }
    const c = { ...samplePrompt("c"), createdAt: 3000 }
    // Insert out of order to verify ORDER BY created_at ASC, not insertion
    // order.
    s.putPendingResumePrompt(b)
    s.putPendingResumePrompt(a)
    s.putPendingResumePrompt(c)
    expect(s.listPendingResumePrompts().map((p) => p.id)).toEqual([
      "a",
      "b",
      "c",
    ])
    s.close()
  })

  it("re-putting the same id replaces the row (idempotent on retry)", () => {
    const s = mk()
    s.putPendingResumePrompt(samplePrompt("dup"))
    s.putPendingResumePrompt({ ...samplePrompt("dup"), messageTs: "9999.0" })
    const got = s.getPendingResumePrompt("dup")
    expect(got?.messageTs).toBe("9999.0")
    s.close()
  })

  it("persists across database reopens", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "bantai-pending-"))
    try {
      const dbPath = join(dir, "slack.db")
      const s1 = createSessionStore({ path: dbPath })
      s1.putPendingResumePrompt(samplePrompt("persist"))
      s1.close()

      const s2 = createSessionStore({ path: dbPath })
      const got = s2.getPendingResumePrompt("persist")
      expect(got?.id).toBe("persist")
      s2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("createSessionStore — thread_participation", () => {
  it("recordThreadPost + hasThreadPost round-trip", () => {
    const s = mk()
    s.recordThreadPost("C1", "t1")
    expect(s.hasThreadPost("C1", "t1")).toBe(true)
    // Different (channel, thread) → miss.
    expect(s.hasThreadPost("C1", "t2")).toBe(false)
    expect(s.hasThreadPost("C2", "t1")).toBe(false)
    s.close()
  })

  it("recordThreadPost is idempotent — same (channel, thread) doesn't error on re-record", () => {
    const s = mk()
    s.recordThreadPost("C1", "t1")
    s.recordThreadPost("C1", "t1")
    expect(s.hasThreadPost("C1", "t1")).toBe(true)
    s.close()
  })

  it("pruneThreadPosts deletes rows older than the cutoff and leaves fresh ones", () => {
    // Prune is an admin-tool hook — not invoked automatically — but still
    // exercised here so a future `/bantai prune-participation` command
    // doesn't silently break.
    const s = mk()
    s.recordThreadPost("C1", "old")
    const between = Date.now() + 1
    // Spin so 'new' lands at a strictly later timestamp.
    const spinUntil = Date.now() + 2
    while (Date.now() < spinUntil) {
      /* noop */
    }
    s.recordThreadPost("C1", "new")

    const removed = s.pruneThreadPosts(between)
    expect(removed).toBe(1)
    expect(s.hasThreadPost("C1", "old")).toBe(false)
    expect(s.hasThreadPost("C1", "new")).toBe(true)
    s.close()
  })

  it("silently skips empty channel / thread on record and has", () => {
    const s = mk()
    // No throws, no ill-formed rows.
    s.recordThreadPost("", "t1")
    s.recordThreadPost("C1", "")
    expect(s.hasThreadPost("", "t1")).toBe(false)
    expect(s.hasThreadPost("C1", "")).toBe(false)
    s.close()
  })

  it("survives close/reopen on the same on-disk path", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "bantai-thread-part-"))
    try {
      const dbPath = join(dir, "slack.db")
      const s1 = createSessionStore({ path: dbPath })
      s1.recordThreadPost("C1", "persist")
      s1.close()

      const s2 = createSessionStore({ path: dbPath })
      expect(s2.hasThreadPost("C1", "persist")).toBe(true)
      s2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("createNoopSessionStore — thread_participation", () => {
  it("record is a no-op, has returns false, prune returns 0", () => {
    const s = createNoopSessionStore()
    expect(() => s.recordThreadPost("C1", "t1")).not.toThrow()
    expect(s.hasThreadPost("C1", "t1")).toBe(false)
    expect(s.pruneThreadPosts(0)).toBe(0)
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
