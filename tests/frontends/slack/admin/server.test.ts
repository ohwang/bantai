/**
 * Admin HTTP + WebSocket server tests.
 *
 * Boots a real `startAdminServer(...)` against `port: 0` (OS-assigned) so we
 * exercise the actual Bun.serve HTTP + WS paths, not a mocked request path.
 * Each test starts + stops its own server; nothing is shared across tests.
 *
 * Test doubles:
 *   - FakeRegistry + FakeApprovalCoordinator — minimal objects shaped to
 *     satisfy the admin server's dependency injection surface. They do NOT
 *     implement the full SessionRegistry / ApprovalCoordinator interface.
 *     We cast them at the `startAdminServer` boundary so the compiler lets
 *     us pass the stripped-down versions.
 *   - createAdminBus() + attachRingBuffer() — real production doubles,
 *     because fan-out correctness is the main thing this test is about.
 */

import { afterEach, describe, expect, it } from "bun:test"
import {
  startAdminServer,
  type AdminServer,
  type AdminServerOpts,
} from "../../../../src/frontends/slack/admin/server"
import {
  createAdminBus,
  type AdminBus,
} from "../../../../src/frontends/slack/admin/bus"
import {
  attachRingBuffer,
  type AttachedRingBuffer,
} from "../../../../src/frontends/slack/admin/ring"
import type {
  AdminFrame,
  PendingApproval,
  SessionSummary,
} from "../../../../src/frontends/slack/admin/protocol"
import type {
  SessionEntry,
  SessionRegistry,
} from "../../../../src/frontends/slack/router/registry"
import type {
  ApprovalCoordinator,
  AdminResolveInput,
  AdminResolveResult,
} from "../../../../src/frontends/slack/approvals/coordinator"
import type {
  ApprovalRegistry,
  PendingApprovalRecord,
} from "../../../../src/frontends/slack/view/approvals"
import type { AgentEvent } from "../../../../src/protocol/types"
import type { ResolvedSlackConfig } from "../../../../src/frontends/slack/config/schema"

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeEntryOpts {
  key?: string
  channelId?: string
  threadTs?: string
  backend?: string
  projectName?: string
  projectDir?: string
  model?: string
  permissionMode?: string
  turns?: number
  totalCostUsd?: number
  phase?: SessionSummary["phase"]
  resumed?: boolean
  openedAt?: number
  lastEventAt?: number
  onInterrupt?: () => void
}

function fakeEntry(opts: FakeEntryOpts = {}): SessionEntry {
  const key = opts.key ?? "slack:T1:C01:main"
  const onInterrupt = opts.onInterrupt ?? (() => {})
  const entry = {
    key,
    host: {
      backend: {
        interrupt: () => onInterrupt(),
      },
    },
    project: {
      channelId: opts.channelId ?? "C01",
      channelName: opts.projectName ?? "proj",
      projectDir: opts.projectDir ?? "/tmp/proj",
      backend: opts.backend ?? "mock",
      model: opts.model,
      permissionMode: opts.permissionMode ?? "default",
    },
    routing: { channel: opts.channelId ?? "C01", parentTs: opts.threadTs ?? "main" },
    resumed: opts.resumed ?? false,
    priorUsage: { turns: 0, totalCostUsd: 0 },
    turns: opts.turns ?? 0,
    totalCostUsd: opts.totalCostUsd ?? 0,
    lastEventAt: opts.lastEventAt ?? 0,
    openedAt: opts.openedAt ?? 1_700_000_000_000,
    phase: opts.phase ?? "IDLE",
    send: () => {},
    subscribe: () => () => {},
    close: () => {},
    reset: () => {},
  }
  // The FakeEntry intentionally omits internals of SessionEntry that the
  // admin server never touches. Cast at the boundary.
  return entry as unknown as SessionEntry
}

function fakeRegistry(entries: SessionEntry[]): SessionRegistry {
  const list = [...entries]
  return {
    getOrCreate: () => {
      throw new Error("fakeRegistry.getOrCreate: not implemented")
    },
    peek: () => undefined,
    close: () => {},
    closeAll: () => {},
    size: () => list.length,
    entries: () => list.slice(),
  }
}

interface FakePendingOpts {
  id?: string
  sessionKey?: string
  channel?: string
  threadTs?: string
  tool?: string
  input?: unknown
  title?: string
  description?: string
  approvers?: string[]
  createdAt?: number
  ttlMs?: number
}

function fakeApprovalRecord(opts: FakePendingOpts = {}): PendingApprovalRecord {
  const id = opts.id ?? "perm_1"
  const channel = opts.channel ?? "C01"
  const threadTs = opts.threadTs ?? "100.001"
  return {
    request: {
      type: "permission_request",
      id,
      tool: opts.tool ?? "Bash",
      input: opts.input ?? { command: "ls" },
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.description ? { description: opts.description } : {}),
    },
    channel,
    threadTs,
    messageTs: "9999.0001",
    sessionKey: opts.sessionKey ?? "slack:T1:C01:100.001",
    approvers: opts.approvers ?? [],
    createdAt: opts.createdAt ?? 1_700_000_000_000,
    ttlMs: opts.ttlMs ?? 15 * 60 * 1000,
  }
}

interface FakeApprovalsOpts {
  pending?: PendingApprovalRecord[]
  adminResolve?: (input: AdminResolveInput) => Promise<AdminResolveResult>
}

function fakeApprovals(opts: FakeApprovalsOpts = {}): ApprovalCoordinator {
  const pending = [...(opts.pending ?? [])]
  const registry: ApprovalRegistry = {
    track: () => {},
    peek: (id) => pending.find((r) => r.request.id === id),
    resolve: () => ({ ok: false, code: "unknown" }),
    size: () => pending.length,
    list: () => pending.slice(),
    take: (id) => {
      const idx = pending.findIndex((r) => r.request.id === id)
      if (idx < 0) return undefined
      const [taken] = pending.splice(idx, 1)
      return taken
    },
    closeAll: () => {
      const out = pending.splice(0, pending.length)
      return out
    },
  }
  return {
    bindSession: () => ({ onRequest: () => {}, onCancel: () => {} }),
    handleBlockAction: async () => ({ kind: "unknown" }),
    adminResolve:
      opts.adminResolve ??
      (async (input) => {
        const taken = registry.take(input.id)
        if (!taken) return { kind: "unknown", permissionId: input.id }
        return { kind: "resolved", permissionId: input.id }
      }),
    registry,
    closeAll: () => {},
  }
}

function fakeConfig(): ResolvedSlackConfig {
  return {
    workspace: {
      mode: "socket",
      webhookPath: "/slack/events",
    },
    defaults: {
      backend: "claude",
      permission_mode: "default",
      require_mention: true,
      trigger_name: "bantai",
      verbosity: "normal",
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
        id: "C01",
        name: "proj",
        backend: "claude",
        project_dir: "/tmp/proj",
      },
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
  bus: AdminBus
  ring: AttachedRingBuffer
  token: string
  base: string
  stop: () => Promise<void>
}

async function boot(
  overrides: Partial<AdminServerOpts> = {},
): Promise<Harness> {
  const bus = createAdminBus()
  const ring = attachRingBuffer(bus, { capacity: 50 })
  const token = overrides.token ?? "test-token-abc"
  const opts: AdminServerOpts = {
    bus,
    ring,
    registry: fakeRegistry([]),
    approvals: fakeApprovals(),
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
  const base = `http://${server.hostname()}:${server.port()}`
  return {
    server,
    bus,
    ring,
    token,
    base,
    async stop() {
      ring.dispose()
      await server.stop()
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin server — auth", () => {
  const harnesses: Harness[] = []
  afterEach(async () => {
    for (const h of harnesses) await h.stop().catch(() => {})
    harnesses.length = 0
  })

  it("rejects unauthenticated REST with 401 + structured error", async () => {
    const h = await boot()
    harnesses.push(h)
    const res = await fetch(`${h.base}/admin/sessions`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("unauthorized")
  })

  it("accepts a correct Bearer token", async () => {
    const h = await boot()
    harnesses.push(h)
    const res = await fetch(`${h.base}/admin/version`, {
      headers: { authorization: `Bearer ${h.token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { protocol: string; server: string }
    expect(body.protocol).toBe("1")
    expect(body.server).toBe("0.0.0-test")
  })

  it("rejects a wrong Bearer token (constant-time check)", async () => {
    const h = await boot()
    harnesses.push(h)
    const res = await fetch(`${h.base}/admin/version`, {
      headers: { authorization: "Bearer totally-wrong" },
    })
    expect(res.status).toBe(401)
  })
})

describe("admin server — GET routes", () => {
  const harnesses: Harness[] = []
  afterEach(async () => {
    for (const h of harnesses) await h.stop().catch(() => {})
    harnesses.length = 0
  })

  function authed(h: Harness): RequestInit {
    return { headers: { authorization: `Bearer ${h.token}` } }
  }

  it("GET /admin/health reports mode + bot + workspace ids", async () => {
    const h = await boot()
    harnesses.push(h)
    const res = await fetch(`${h.base}/admin/health`, authed(h))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      mode: string
      botUserId: string
      workspaceId: string
    }
    expect(body).toEqual({
      ok: true,
      mode: "socket",
      botUserId: "U_BOT",
      workspaceId: "T_WS",
    })
  })

  it("GET /admin/config returns the scrubbed config (no secrets)", async () => {
    const h = await boot()
    harnesses.push(h)
    const res = await fetch(`${h.base}/admin/config`, authed(h))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      mode: string
      admin: { host: string; readOnly: boolean; sessionRingSize: number }
      projects: Array<{
        channelId: string
        name?: string
        backend?: string
        projectDir?: string
      }>
    }
    expect(body.mode).toBe("socket")
    expect(body.admin.host).toBe("127.0.0.1")
    expect(body.admin.readOnly).toBe(false)
    expect(body.projects).toEqual([
      { channelId: "C01", name: "proj", backend: "claude", projectDir: "/tmp/proj" },
    ])
    // Scrubbed fields must NOT appear.
    expect(JSON.stringify(body)).not.toMatch(/token|signing|secret/i)
  })

  it("GET /admin/sessions lists registry entries as summaries", async () => {
    const h = await boot({
      registry: fakeRegistry([
        fakeEntry({ key: "slack:T1:C01:main", channelId: "C01", turns: 2 }),
        fakeEntry({ key: "slack:T1:C02:9.9", channelId: "C02", threadTs: "9.9" }),
      ]),
    })
    harnesses.push(h)
    const res = await fetch(`${h.base}/admin/sessions`, authed(h))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessions: SessionSummary[] }
    expect(body.sessions.map((s) => s.key).sort()).toEqual([
      "slack:T1:C01:main",
      "slack:T1:C02:9.9",
    ])
    expect(body.sessions.find((s) => s.key === "slack:T1:C01:main")!.turns).toBe(2)
  })

  it("GET /admin/sessions/:key returns a SessionDetail (includes cwd + model)", async () => {
    const h = await boot({
      registry: fakeRegistry([
        fakeEntry({
          key: "slack:T1:C01:main",
          projectDir: "/tmp/special",
          model: "claude-sonnet-4",
        }),
      ]),
    })
    harnesses.push(h)
    const res = await fetch(
      `${h.base}/admin/sessions/${encodeURIComponent("slack:T1:C01:main")}`,
      authed(h),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      key: string
      cwd: string
      model?: string
      permissionMode?: string
    }
    expect(body.key).toBe("slack:T1:C01:main")
    expect(body.cwd).toBe("/tmp/special")
    expect(body.model).toBe("claude-sonnet-4")
    expect(body.permissionMode).toBe("default")
  })

  it("GET /admin/sessions/:key returns 404 for unknown key", async () => {
    const h = await boot({ registry: fakeRegistry([]) })
    harnesses.push(h)
    const res = await fetch(`${h.base}/admin/sessions/nope`, authed(h))
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("session_not_found")
  })

  it("GET /admin/sessions/:key/events returns the ring buffer snapshot", async () => {
    const h = await boot()
    harnesses.push(h)
    const key = "slack:T1:C01:main"
    const ev1: AgentEvent = { type: "turn_start" }
    const ev2: AgentEvent = { type: "text_delta", text: "hi" }
    h.bus.publish({ type: "session_event", key, event: ev1 })
    h.bus.publish({ type: "session_event", key, event: ev2 })
    const res = await fetch(
      `${h.base}/admin/sessions/${encodeURIComponent(key)}/events`,
      authed(h),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: AgentEvent[] }
    expect(body.events).toEqual([ev1, ev2])
  })

  it("GET /admin/approvals returns a list of pending approvals", async () => {
    const r1 = fakeApprovalRecord({ id: "p1", approvers: ["U_a"] })
    const r2 = fakeApprovalRecord({ id: "p2", approvers: ["U_b"] })
    const h = await boot({ approvals: fakeApprovals({ pending: [r1, r2] }) })
    harnesses.push(h)
    const res = await fetch(`${h.base}/admin/approvals`, authed(h))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pending: PendingApproval[] }
    expect(body.pending.map((p) => p.id).sort()).toEqual(["p1", "p2"])
    const got = body.pending.find((p) => p.id === "p1")!
    expect(got.approvers).toEqual(["U_a"])
    expect(got.requestedAt).toBe(1_700_000_000_000)
    expect(got.ttlMs).toBeGreaterThan(0)
  })
})

describe("admin server — POST routes", () => {
  const harnesses: Harness[] = []
  afterEach(async () => {
    for (const h of harnesses) await h.stop().catch(() => {})
    harnesses.length = 0
  })

  function authedJson(h: Harness, body: unknown): RequestInit {
    return {
      method: "POST",
      headers: {
        authorization: `Bearer ${h.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  }

  it("POST /admin/sessions/:key/interrupt calls backend.interrupt() and returns 202", async () => {
    let called = 0
    const h = await boot({
      registry: fakeRegistry([
        fakeEntry({ key: "slack:T1:C01:main", onInterrupt: () => called++ }),
      ]),
    })
    harnesses.push(h)
    const res = await fetch(
      `${h.base}/admin/sessions/${encodeURIComponent("slack:T1:C01:main")}/interrupt`,
      authedJson(h, {}),
    )
    expect(res.status).toBe(202)
    expect(called).toBe(1)
  })

  it("POST /admin/approvals/:id/approve routes to adminResolve(allow)", async () => {
    const calls: AdminResolveInput[] = []
    const h = await boot({
      approvals: fakeApprovals({
        pending: [fakeApprovalRecord({ id: "adm1" })],
        adminResolve: async (input) => {
          calls.push(input)
          return { kind: "resolved", permissionId: input.id }
        },
      }),
    })
    harnesses.push(h)
    const res = await fetch(
      `${h.base}/admin/approvals/adm1/approve`,
      authedJson(h, { alwaysAllow: true }),
    )
    expect(res.status).toBe(200)
    expect(calls).toEqual([{ id: "adm1", decision: "allow", alwaysAllow: true }])
  })

  it("POST /admin/approvals/:id/deny forwards the reason", async () => {
    const calls: AdminResolveInput[] = []
    const h = await boot({
      approvals: fakeApprovals({
        pending: [fakeApprovalRecord({ id: "adm2" })],
        adminResolve: async (input) => {
          calls.push(input)
          return { kind: "resolved", permissionId: input.id }
        },
      }),
    })
    harnesses.push(h)
    const res = await fetch(
      `${h.base}/admin/approvals/adm2/deny`,
      authedJson(h, { reason: "not on my watch" }),
    )
    expect(res.status).toBe(200)
    expect(calls).toEqual([
      { id: "adm2", decision: "deny", denyReason: "not on my watch" },
    ])
  })

  it("POST /admin/approvals/:id/approve returns 404 when unknown", async () => {
    const h = await boot({
      approvals: fakeApprovals({
        adminResolve: async (input) => ({ kind: "unknown", permissionId: input.id }),
      }),
    })
    harnesses.push(h)
    const res = await fetch(
      `${h.base}/admin/approvals/nope/approve`,
      authedJson(h, {}),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("approval_not_found")
  })

  it("POST /admin/approvals/:id/deny rejects extraneous body fields", async () => {
    const h = await boot()
    harnesses.push(h)
    const res = await fetch(
      `${h.base}/admin/approvals/x/deny`,
      authedJson(h, { reason: "ok", surprise: true }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("bad_body")
  })
})

describe("admin server — read-only gating", () => {
  const harnesses: Harness[] = []
  afterEach(async () => {
    for (const h of harnesses) await h.stop().catch(() => {})
    harnesses.length = 0
  })

  it("returns 403 read_only on every mutating route when readOnly=true", async () => {
    const h = await boot({
      readOnly: true,
      registry: fakeRegistry([fakeEntry()]),
      approvals: fakeApprovals({
        pending: [fakeApprovalRecord({ id: "p1" })],
      }),
    })
    harnesses.push(h)
    const authed: Record<string, string> = { authorization: `Bearer ${h.token}` }
    const routes: Array<[string, string]> = [
      ["POST", `/admin/sessions/${encodeURIComponent("slack:T1:C01:main")}/interrupt`],
      ["POST", "/admin/approvals/p1/approve"],
      ["POST", "/admin/approvals/p1/deny"],
    ]
    for (const [method, path] of routes) {
      const res = await fetch(`${h.base}${path}`, {
        method,
        headers: { ...authed, "content-type": "application/json" },
        body: "{}",
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe("read_only")
    }
  })

  it("read-only mode still allows every GET", async () => {
    const h = await boot({ readOnly: true, registry: fakeRegistry([fakeEntry()]) })
    harnesses.push(h)
    const authed: Record<string, string> = { authorization: `Bearer ${h.token}` }
    const paths = [
      "/admin/version",
      "/admin/health",
      "/admin/config",
      "/admin/sessions",
      "/admin/approvals",
    ]
    for (const p of paths) {
      const res = await fetch(`${h.base}${p}`, { headers: authed })
      expect([200, 204]).toContain(res.status)
    }
  })
})

// ---------------------------------------------------------------------------
// WebSocket tests
// ---------------------------------------------------------------------------

function openWs(base: string, token: string, viaQuery = false): Promise<WebSocket> {
  const url = base.replace(/^http/, "ws") + "/admin/ws" + (viaQuery ? `?token=${token}` : "")
  return new Promise((resolve, reject) => {
    const ws = viaQuery
      ? new WebSocket(url)
      : new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string)
    ws.addEventListener("open", () => resolve(ws), { once: true })
    ws.addEventListener("error", (e) => reject(e), { once: true })
  })
}

function collectFrames(ws: WebSocket, count: number, timeoutMs = 1000): Promise<AdminFrame[]> {
  return new Promise((resolve, reject) => {
    const out: AdminFrame[] = []
    const t = setTimeout(() => reject(new Error(`ws: timed out waiting for ${count} frames (got ${out.length})`)), timeoutMs)
    ws.addEventListener("message", (e) => {
      try {
        out.push(JSON.parse(e.data as string) as AdminFrame)
        if (out.length >= count) {
          clearTimeout(t)
          resolve(out)
        }
      } catch (err) {
        clearTimeout(t)
        reject(err)
      }
    })
  })
}

describe("admin server — WebSocket", () => {
  const harnesses: Harness[] = []
  const sockets: WebSocket[] = []
  afterEach(async () => {
    for (const ws of sockets) {
      try { ws.close() } catch { /* ignore */ }
    }
    sockets.length = 0
    for (const h of harnesses) await h.stop().catch(() => {})
    harnesses.length = 0
  })

  it("sends hello + snapshot on connect", async () => {
    const h = await boot({
      registry: fakeRegistry([fakeEntry({ key: "slack:T1:C01:main" })]),
      approvals: fakeApprovals({ pending: [fakeApprovalRecord({ id: "p1" })] }),
    })
    harnesses.push(h)
    const ws = await openWs(h.base, h.token)
    sockets.push(ws)
    const frames = await collectFrames(ws, 2)
    const hello = frames[0]!
    const snap = frames[1]!
    expect(hello.type).toBe("hello")
    if (hello.type !== "hello") throw new Error("type narrowing")
    expect(hello.protocol).toBe("1")
    expect(snap.type).toBe("snapshot")
    if (snap.type !== "snapshot") throw new Error("type narrowing")
    expect(snap.sessions.map((s) => s.key)).toEqual(["slack:T1:C01:main"])
    expect(snap.pendingApprovals.map((p) => p.id)).toEqual(["p1"])
  })

  it("authorizes WS via ?token= query fallback", async () => {
    const h = await boot()
    harnesses.push(h)
    const ws = await openWs(h.base, h.token, /*viaQuery*/ true)
    sockets.push(ws)
    const hello = (await collectFrames(ws, 1))[0]!
    expect(hello.type).toBe("hello")
  })

  it("rejects WS upgrade without a token (401)", async () => {
    const h = await boot()
    harnesses.push(h)
    const res = await fetch(`${h.base}/admin/ws`)
    expect(res.status).toBe(401)
  })

  it("ping command returns a matching pong frame", async () => {
    const h = await boot()
    harnesses.push(h)
    const ws = await openWs(h.base, h.token)
    sockets.push(ws)
    // Drain hello + snapshot first.
    await collectFrames(ws, 2)
    ws.send(JSON.stringify({ op: "ping", at: 42 }))
    const pong = (await collectFrames(ws, 1))[0]!
    expect(pong.type).toBe("pong")
    if (pong.type !== "pong") throw new Error("type narrowing")
    expect(pong.at).toBe(42)
  })

  it("bus → WS fan-out: published frames reach connected clients in order", async () => {
    const h = await boot()
    harnesses.push(h)
    const ws = await openWs(h.base, h.token)
    sockets.push(ws)
    await collectFrames(ws, 2) // hello + snapshot

    const key = "slack:T1:C01:main"
    const ev1: AgentEvent = { type: "turn_start" }
    const ev2: AgentEvent = { type: "text_delta", text: "x" }
    // Publishing before the listener is set up is racey; attach first,
    // then publish, then wait.
    const recv = collectFrames(ws, 2)
    h.bus.publish({ type: "session_event", key, event: ev1 })
    h.bus.publish({ type: "session_event", key, event: ev2 })
    const frames = await recv
    expect(frames.map((f) => f.type)).toEqual(["session_event", "session_event"])
    const e0 = frames[0]!
    const e1 = frames[1]!
    if (e0.type !== "session_event" || e1.type !== "session_event") {
      throw new Error("type narrowing")
    }
    expect(e0.event).toEqual(ev1)
    expect(e1.event).toEqual(ev2)
  })

  it("subscribe command filters session_event by key", async () => {
    const h = await boot()
    harnesses.push(h)
    const ws = await openWs(h.base, h.token)
    sockets.push(ws)
    await collectFrames(ws, 2) // hello + snapshot

    ws.send(JSON.stringify({ op: "subscribe", keys: ["slack:T1:C01:main"] }))
    // subscribe triggers a fresh snapshot reply.
    await collectFrames(ws, 1)

    // Events for the NOT-subscribed key are dropped; the subscribed one
    // lands. Wait for exactly one session_event frame before teardown.
    const recv = collectFrames(ws, 1)
    h.bus.publish({
      type: "session_event",
      key: "slack:T1:C99:other",
      event: { type: "turn_start" },
    })
    h.bus.publish({
      type: "session_event",
      key: "slack:T1:C01:main",
      event: { type: "turn_complete" },
    })
    const frame = (await recv)[0]!
    expect(frame.type).toBe("session_event")
    if (frame.type !== "session_event") throw new Error("type narrowing")
    expect(frame.key).toBe("slack:T1:C01:main")
    expect(frame.event.type).toBe("turn_complete")
  })

  it("subscribe with eventTypes filter only passes named AgentEvent types", async () => {
    const h = await boot()
    harnesses.push(h)
    const ws = await openWs(h.base, h.token)
    sockets.push(ws)
    await collectFrames(ws, 2)

    ws.send(JSON.stringify({ op: "subscribe", eventTypes: ["turn_complete"] }))
    await collectFrames(ws, 1) // refresh snapshot

    const recv = collectFrames(ws, 1)
    h.bus.publish({
      type: "session_event",
      key: "slack:T1:C01:main",
      event: { type: "text_delta", text: "x" },
    })
    h.bus.publish({
      type: "session_event",
      key: "slack:T1:C01:main",
      event: { type: "turn_complete" },
    })
    const frame = (await recv)[0]!
    if (frame.type !== "session_event") throw new Error("type narrowing")
    expect(frame.event.type).toBe("turn_complete")
  })

  it("global frames (approval_resolved) ignore the keys filter", async () => {
    const h = await boot()
    harnesses.push(h)
    const ws = await openWs(h.base, h.token)
    sockets.push(ws)
    await collectFrames(ws, 2)

    // Narrow the filter to a key we'll never publish on.
    ws.send(JSON.stringify({ op: "subscribe", keys: ["slack:T1:UNSEEN:main"] }))
    await collectFrames(ws, 1)

    const recv = collectFrames(ws, 1)
    h.bus.publish({
      type: "approval_resolved",
      id: "p1",
      decision: "allow",
      by: "admin",
    })
    const frame = (await recv)[0]!
    expect(frame.type).toBe("approval_resolved")
  })

  it("malformed JSON command produces an error frame but keeps the socket alive", async () => {
    const h = await boot()
    harnesses.push(h)
    const ws = await openWs(h.base, h.token)
    sockets.push(ws)
    await collectFrames(ws, 2)

    ws.send("definitely not json")
    const frame = (await collectFrames(ws, 1))[0]!
    expect(frame.type).toBe("error")
    if (frame.type !== "error") throw new Error("type narrowing")
    expect(frame.code).toBe("bad_json")
    // Socket must still be open.
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })
})
