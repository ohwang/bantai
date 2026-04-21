/**
 * Tests for the pure frame reducer + reactive monitor store.
 *
 * The reducer is the heart of the live-update path — every branch of
 * `applyFrame` has a matching case here. The reactive store wrapper has
 * a smaller surface and mostly delegates to the reducer, so a couple
 * tests suffice there.
 */

import { describe, expect, it } from "bun:test"
import {
  applyFrame,
  createMonitorStore,
  sortSessionsByActivity,
  type MonitorStoreState,
} from "../../../src/frontends/slack-monitor/context/store"
import type {
  AdminFrame,
  PendingApproval,
  SessionSummary,
} from "../../../src/frontends/slack/admin/protocol"

function emptyState(): MonitorStoreState {
  return {
    loaded: false,
    protocol: "",
    serverVersion: "",
    banner: null,
    sessions: {},
    sessionOrder: [],
    events: {},
    approvals: {},
    approvalOrder: [],
    config: null,
    selectedSessionKey: null,
  }
}

function summary(key: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    key,
    channelId: "C1",
    threadTs: "main",
    backend: "mock",
    projectName: "proj",
    phase: "UNKNOWN",
    turns: 0,
    totalCostUsd: 0,
    lastEventAt: 0,
    resumed: false,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0,
    },
    ...extra,
  }
}

function approval(id: string, sessionKey = "slack:W:C:main"): PendingApproval {
  return {
    id,
    sessionKey,
    channelId: "C",
    threadTs: "main",
    tool: "Bash",
    input: {},
    approvers: ["U"],
    requestedAt: 1,
    ttlMs: 60_000,
  }
}

describe("applyFrame reducer", () => {
  it("hello sets protocol + serverVersion", () => {
    const s = emptyState()
    applyFrame(s, { type: "hello", protocol: "1", serverVersion: "9.9.9" }, 100)
    expect(s.protocol).toBe("1")
    expect(s.serverVersion).toBe("9.9.9")
  })

  it("snapshot replaces sessions + approvals + sets loaded", () => {
    const s = emptyState()
    // Pre-populate some stale state to prove the snapshot replaces, not merges.
    s.sessions["old"] = summary("old")
    s.sessionOrder = ["old"]
    s.approvals["old-a"] = approval("old-a")
    s.approvalOrder = ["old-a"]

    applyFrame(
      s,
      {
        type: "snapshot",
        sessions: [summary("k1"), summary("k2")],
        pendingApprovals: [approval("a1")],
      },
      100,
    )
    expect(Object.keys(s.sessions)).toEqual(["k1", "k2"])
    expect(s.sessionOrder).toEqual(["k1", "k2"])
    expect(Object.keys(s.approvals)).toEqual(["a1"])
    expect(s.approvalOrder).toEqual(["a1"])
    expect(s.loaded).toBe(true)
  })

  it("session_opened appends + auto-selects when nothing selected", () => {
    const s = emptyState()
    applyFrame(s, { type: "session_opened", summary: summary("k1") }, 100)
    expect(s.sessionOrder).toEqual(["k1"])
    expect(s.selectedSessionKey).toBe("k1")
    // Second session doesn't steal the selection.
    applyFrame(s, { type: "session_opened", summary: summary("k2") }, 100)
    expect(s.selectedSessionKey).toBe("k1")
    expect(s.sessionOrder).toEqual(["k1", "k2"])
  })

  it("session_closed removes the key + reselects newest", () => {
    const s = emptyState()
    applyFrame(s, { type: "session_opened", summary: summary("k1") }, 100)
    applyFrame(s, { type: "session_opened", summary: summary("k2") }, 100)
    // User-style selection.
    s.selectedSessionKey = "k1"
    applyFrame(s, { type: "session_closed", key: "k1", reason: "idle" }, 100)
    expect(s.sessionOrder).toEqual(["k2"])
    expect(s.selectedSessionKey).toBe("k2")
    applyFrame(s, { type: "session_closed", key: "k2", reason: "shutdown" }, 100)
    expect(s.selectedSessionKey).toBeNull()
  })

  it("session_phase updates the summary, ignores unknown keys gracefully", () => {
    const s = emptyState()
    applyFrame(s, { type: "session_opened", summary: summary("k1") }, 100)
    applyFrame(s, { type: "session_phase", key: "k1", phase: "RUNNING" }, 100)
    expect(s.sessions["k1"]!.phase).toBe("RUNNING")
    // Unknown key: no crash, no phantom summary created.
    applyFrame(s, { type: "session_phase", key: "missing", phase: "IDLE" }, 100)
    expect(s.sessions["missing"]).toBeUndefined()
  })

  it("session_event appends per-key + caps tail at maxEvents", () => {
    const s = emptyState()
    applyFrame(s, { type: "session_opened", summary: summary("k1") }, 100)
    for (let i = 0; i < 5; i++) {
      applyFrame(
        s,
        {
          type: "session_event",
          key: "k1",
          event: {
            type: "text_delta",
            turnId: "t",
            text: String(i),
          } as unknown as import("../../../src/protocol/types").AgentEvent,
        },
        3,
      )
    }
    // Cap = 3 → oldest (0, 1) evicted.
    const tail = s.events["k1"]!
    expect(tail).toHaveLength(3)
    expect(
      tail.map((e) => (e as unknown as { text: string }).text),
    ).toEqual(["2", "3", "4"])
  })

  it("approval_requested + approval_resolved keep approvalOrder in sync", () => {
    const s = emptyState()
    applyFrame(s, { type: "approval_requested", approval: approval("a1") }, 100)
    applyFrame(s, { type: "approval_requested", approval: approval("a2") }, 100)
    expect(s.approvalOrder).toEqual(["a1", "a2"])
    applyFrame(
      s,
      { type: "approval_resolved", id: "a1", decision: "allow", by: "admin" },
      100,
    )
    expect(s.approvalOrder).toEqual(["a2"])
    expect(s.approvals["a1"]).toBeUndefined()
  })

  it("config_changed replaces the config, error frame sets banner", () => {
    const s = emptyState()
    applyFrame(
      s,
      {
        type: "config_changed",
        config: {
          mode: "socket",
          storePath: "",
          admin: { host: "h", port: 1, readOnly: false, sessionRingSize: 10 },
          projects: [],
        },
      },
      100,
    )
    expect(s.config?.admin.port).toBe(1)
    applyFrame(s, { type: "error", code: "oops", message: "it broke" }, 100)
    expect(s.banner?.tone).toBe("error")
    expect(s.banner?.message).toBe("oops: it broke")
  })

  it("pong is a no-op; an unknown frame type logs but doesn't throw", () => {
    const s = emptyState()
    applyFrame(s, { type: "pong", at: 1 }, 100)
    expect(s).toEqual(emptyState())
    // Synthetic unknown frame — cast through unknown so TS lets us exercise
    // the default branch. The reducer must NOT throw; the log.warn is the
    // signal.
    applyFrame(s, { type: "future_frame" } as unknown as AdminFrame, 100)
    expect(s).toEqual(emptyState())
  })
})

describe("sortSessionsByActivity", () => {
  it("sorts newest-activity first, tie-breaks alphabetically", () => {
    const s = emptyState()
    s.sessionOrder = ["a", "b", "c"]
    s.sessions["a"] = summary("a", { lastEventAt: 100 })
    s.sessions["b"] = summary("b", { lastEventAt: 200 })
    s.sessions["c"] = summary("c", { lastEventAt: 100 })
    const out = sortSessionsByActivity(s)
    expect(out.map((x) => x.key)).toEqual(["b", "a", "c"])
  })
})

describe("createMonitorStore — reactive wrapper", () => {
  it("applyFrame delegates through produce() + reactivity stays intact", () => {
    const store = createMonitorStore({ maxEventsPerSession: 50 })
    store.applyFrame({ type: "hello", protocol: "1", serverVersion: "9" })
    expect(store.state.protocol).toBe("1")
    store.applySnapshot({
      sessions: [summary("k1")],
      approvals: [approval("a1")],
      config: null,
    })
    expect(store.state.loaded).toBe(true)
    expect(store.state.selectedSessionKey).toBe("k1")
    expect(store.state.approvals["a1"]).toBeDefined()
    store.selectSession("k1")
    expect(store.state.selectedSessionKey).toBe("k1")
    store.setSessionEvents("k1", [
      {
        type: "text_complete",
        turnId: "t",
        text: "done",
      } as unknown as import("../../../src/protocol/types").AgentEvent,
    ])
    expect(store.state.events["k1"]).toHaveLength(1)
    store.setBanner({ tone: "info", message: "hi" })
    expect(store.state.banner?.message).toBe("hi")
  })
})
