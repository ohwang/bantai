/**
 * End-to-end monitor context test — boots a real admin server, attaches
 * the monitor's AdminContext to it through the REST + WS transport, and
 * asserts the reactive store fills in correctly.
 *
 * We reuse the same fake registry / approvals doubles as the
 * `admin/server.test.ts` suite, but in minimal form inline here so this
 * test is self-contained (the server suite's doubles aren't exported).
 *
 * Bun ships a global `WebSocket` client, so the context's default ws
 * factory works without a stub. Reconnect timers are tuned short so the
 * reconnect assertion runs quickly.
 */

import { afterEach, describe, expect, it } from "bun:test"
import {
  startAdminServer,
  type AdminServer,
  type AdminServerOpts,
} from "../../../src/frontends/slack/admin/server"
import { createAdminBus } from "../../../src/frontends/slack/admin/bus"
import { attachRingBuffer } from "../../../src/frontends/slack/admin/ring"
import type {
  SessionEntry,
  SessionRegistry,
} from "../../../src/frontends/slack/router/registry"
import type {
  ApprovalCoordinator,
  AdminResolveInput,
  AdminResolveResult,
} from "../../../src/frontends/slack/approvals/coordinator"
import type {
  ApprovalRegistry,
  PendingApprovalRecord,
} from "../../../src/frontends/slack/view/approvals"
import type { ResolvedSlackConfig } from "../../../src/frontends/slack/config/schema"
import { createAdminContext } from "../../../src/frontends/slack-monitor/context/admin-context"

// ---------------------------------------------------------------------------
// Minimal test doubles — hand-rolled; same shape as server.test.ts.
// ---------------------------------------------------------------------------

function fakeEntry(): SessionEntry {
  return {
    key: "slack:T:C:main",
    host: { backend: { interrupt: () => {} } },
    project: {
      channelId: "C",
      channelName: "proj",
      projectDir: "/tmp/proj",
      backend: "mock",
      model: "claude-sonnet-4",
      permissionMode: "default",
    },
    routing: { channel: "C", parentTs: "main" },
    resumed: false,
    priorUsage: { turns: 0, totalCostUsd: 0 },
    turns: 0,
    totalCostUsd: 0,
    lastEventAt: 0,
    openedAt: 1_700_000_000_000,
    phase: "IDLE",
    send: () => {},
    subscribe: () => () => {},
    close: () => {},
    reset: () => {},
  } as unknown as SessionEntry
}

function fakeRegistry(entries: SessionEntry[]): SessionRegistry {
  const list = [...entries]
  return {
    getOrCreate: () => {
      throw new Error("not implemented")
    },
    peek: () => undefined,
    close: () => {},
    closeAll: () => {},
    size: () => list.length,
    entries: () => list.slice(),
  }
}

function fakeApprovalRecord(
  id: string,
  sessionKey = "slack:T:C:main",
): PendingApprovalRecord {
  return {
    request: { type: "permission_request", id, tool: "Bash", input: {} },
    channel: "C",
    threadTs: "100.1",
    messageTs: "101.0",
    sessionKey,
    approvers: ["U"],
    createdAt: 1_700_000_000_000,
    ttlMs: 60_000,
  }
}

function fakeApprovals(
  preseed: PendingApprovalRecord[] = [],
): ApprovalCoordinator {
  const pending = [...preseed]
  const reg: ApprovalRegistry = {
    track: () => {},
    peek: (id) => pending.find((r) => r.request.id === id),
    resolve: () => ({ ok: false, code: "unknown" }),
    size: () => pending.length,
    list: () => pending.slice(),
    take: (id) => {
      const i = pending.findIndex((r) => r.request.id === id)
      if (i < 0) return undefined
      const [t] = pending.splice(i, 1)
      return t
    },
    closeAll: () => pending.splice(0, pending.length),
  }
  const adminResolve = async (
    input: AdminResolveInput,
  ): Promise<AdminResolveResult> => {
    const taken = reg.take(input.id)
    if (!taken) return { kind: "unknown", permissionId: input.id }
    return { kind: "resolved", permissionId: input.id }
  }
  return {
    bindSession: () => ({ onRequest: () => {}, onCancel: () => {} }),
    handleBlockAction: async () => ({ kind: "unknown" }),
    adminResolve,
    registry: reg,
    closeAll: () => {},
  }
}

function fakeConfig(): ResolvedSlackConfig {
  return {
    workspace: { mode: "socket", webhookPath: "/slack/events" },
    defaults: {
      backend: "claude",
      permission_mode: "default",
      require_mention: true,
      trigger_name: "bantai",
      verbosity: "normal",
      control_prefix: "!b",
      session_banner: true,
      approvers: [],
      auto_join_threads: true,
      thread_require_explicit_mention: false,
      thread_history_limit: 0,
      interactive_replies: false,
      debounce_ms: 0,
      native_streaming: false,
      turn_timeout_s: 0,
      max_budget_usd: 0,
      env: {},
      show_cost: false,
    } as unknown as ResolvedSlackConfig["defaults"],
    channels: [
      {
        id: "C",
        name: "proj",
        backend: "claude",
        project_dir: "/tmp/proj",
      } as unknown as ResolvedSlackConfig["channels"][number],
    ],
    mcpServers: {},
    storePath: "",
    admin: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      tokenPath: "/tmp/tok",
      readOnly: false,
      sessionRingSize: 200,
    },
    source: "test",
  }
}

interface Harness {
  server: AdminServer
  base: string
  token: string
  stop: () => Promise<void>
  publish: (frame: import("../../../src/frontends/slack/admin/protocol").AdminFrame) => void
}

async function boot(overrides: Partial<AdminServerOpts> = {}): Promise<Harness> {
  const bus = createAdminBus()
  const ring = attachRingBuffer(bus, { capacity: 50 })
  const token = overrides.token ?? "monitor-test-token"
  const opts: AdminServerOpts = {
    bus,
    ring,
    registry: fakeRegistry([fakeEntry()]),
    approvals: fakeApprovals([fakeApprovalRecord("p1")]),
    config: fakeConfig(),
    token,
    serverVersion: "0.0.0-test",
    botUserId: "U_BOT",
    workspaceId: "T_WS",
    host: "127.0.0.1",
    port: 0,
    readOnly: false,
    ...overrides,
  }
  const server = startAdminServer(opts)
  return {
    server,
    base: `http://${server.hostname()}:${server.port()}`,
    token,
    publish: (f) => bus.publish(f),
    async stop() {
      ring.dispose()
      await server.stop()
    },
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out")
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAdminContext — end-to-end against a real admin server", () => {
  const harnesses: Harness[] = []
  afterEach(async () => {
    for (const h of harnesses) await h.stop().catch(() => {})
    harnesses.length = 0
  })

  it("bootstraps REST + WS and fills the store from snapshot + live frames", async () => {
    const h = await boot()
    harnesses.push(h)
    const ctx = createAdminContext({
      baseUrl: h.base,
      token: h.token,
      pingIntervalMs: 0,
      initialReconnectMs: 0, // don't auto-reconnect — we control lifecycle
    })

    // Kick off REST bootstrap — resolves after /sessions + /approvals land.
    await ctx.bootstrap()
    expect(ctx.store.state.loaded).toBe(true)
    expect(Object.keys(ctx.store.state.sessions)).toContain("slack:T:C:main")
    expect(ctx.store.state.approvals["p1"]).toBeDefined()
    // /admin/config populates too.
    expect(ctx.store.state.config?.mode).toBe("socket")

    // WS has already opened by now (hello + snapshot). Publish a live
    // frame and watch the reducer pick it up.
    await waitFor(() => ctx.state() === "open")
    h.publish({
      type: "session_phase",
      key: "slack:T:C:main",
      phase: "RUNNING",
    })
    await waitFor(
      () => ctx.store.state.sessions["slack:T:C:main"]?.phase === "RUNNING",
    )

    // Approval resolution removes from the map.
    h.publish({
      type: "approval_resolved",
      id: "p1",
      decision: "allow",
      by: "admin",
    })
    await waitFor(() => ctx.store.state.approvals["p1"] === undefined)

    ctx.close()
  })

  it("interrupt / approve / deny drive REST calls against the live server", async () => {
    let interrupts = 0
    const bus = createAdminBus()
    const ring = attachRingBuffer(bus, { capacity: 10 })
    // Build a custom registry whose entry counts interrupts.
    const entry: SessionEntry = {
      key: "slack:T:C:main",
      host: { backend: { interrupt: () => interrupts++ } },
      project: {
        channelId: "C",
        channelName: "p",
        projectDir: "/tmp",
        backend: "mock",
        permissionMode: "default",
      },
      routing: { channel: "C", parentTs: "main" },
      resumed: false,
      priorUsage: { turns: 0, totalCostUsd: 0 },
      turns: 0,
      totalCostUsd: 0,
      lastEventAt: 0,
      openedAt: 0,
      phase: "IDLE",
      send: () => {},
      subscribe: () => () => {},
      close: () => {},
      reset: () => {},
    } as unknown as SessionEntry
    const registry: SessionRegistry = {
      getOrCreate: () => {
        throw new Error("n/i")
      },
      peek: () => entry,
      close: () => {},
      closeAll: () => {},
      size: () => 1,
      entries: () => [entry],
    }
    const approvalCalls: AdminResolveInput[] = []
    const approvals = fakeApprovals([
      fakeApprovalRecord("a1"),
      fakeApprovalRecord("a2"),
    ])
    const origResolve = approvals.adminResolve.bind(approvals)
    approvals.adminResolve = async (input) => {
      approvalCalls.push(input)
      return await origResolve(input)
    }

    const server = startAdminServer({
      bus,
      ring,
      registry,
      approvals,
      config: fakeConfig(),
      token: "t",
      serverVersion: "0.0.0-test",
      botUserId: "U",
      workspaceId: "W",
      host: "127.0.0.1",
      port: 0,
      readOnly: false,
    })
    harnesses.push({
      server,
      base: `http://${server.hostname()}:${server.port()}`,
      token: "t",
      publish: (f) => bus.publish(f),
      async stop() {
        ring.dispose()
        await server.stop()
      },
    })
    const ctx = createAdminContext({
      baseUrl: `http://${server.hostname()}:${server.port()}`,
      token: "t",
      pingIntervalMs: 0,
      initialReconnectMs: 0,
    })
    await ctx.bootstrap()

    await ctx.interrupt("slack:T:C:main")
    expect(interrupts).toBe(1)

    await ctx.approve("a1", true)
    await ctx.deny("a2", "nope")
    expect(approvalCalls).toHaveLength(2)
    expect(approvalCalls[0]!.decision).toBe("allow")
    expect(approvalCalls[0]!.alwaysAllow).toBe(true)
    expect(approvalCalls[1]!.decision).toBe("deny")
    expect(approvalCalls[1]!.denyReason).toBe("nope")
    ctx.close()
  })
})
