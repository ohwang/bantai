/**
 * Tests for the monitor's admin HTTP + WS client.
 *
 * Split in half:
 *  - REST: stub `fetch`, verify auth header attaches + error shape maps.
 *  - WebSocket: hand-rolled in-process WebSocket double (just enough of
 *    the DOM contract — `onopen`/`onmessage`/`onclose`/`onerror`/`send`/
 *    `close`/`readyState`) so we can drive the client deterministically
 *    without binding a real port.
 *
 * The tests focus on the client's invariants: Bearer token attaches to
 * every request, non-2xx response raises `AdminClientError` with `code`
 * + `status`, `onFrame` gets typed frames only, unparseable frames are
 * dropped (not thrown), and the reconnect machinery fires on unexpected
 * close but stops after `close()`.
 */

import { beforeEach, describe, expect, it } from "bun:test"
import {
  connectAdminWs,
  createRestClient,
  type AdminClientError,
  type AdminWsState,
} from "../../../src/frontends/slack-monitor/transport/client"
import type {
  AdminFrame,
  AdminHealthResponse,
} from "../../../src/frontends/slack/admin/protocol"

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

describe("createRestClient — HTTP surface", () => {
  function makeFetch(
    route: (url: string, init: RequestInit) => Response | Promise<Response>,
  ): typeof fetch {
    return (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input)
      return await route(url, init ?? {})
    }) as typeof fetch
  }

  it("attaches the bearer token on every request", async () => {
    const seen: Array<{ url: string; auth?: string }> = []
    const client = createRestClient({
      baseUrl: "http://127.0.0.1:1/",
      token: "tok-123",
      fetch: makeFetch((url, init) => {
        const headers = init.headers as Record<string, string> | undefined
        seen.push({ url, ...(headers?.authorization ? { auth: headers.authorization } : {}) })
        return new Response(
          JSON.stringify({ ok: true, mode: "socket", botUserId: "B", workspaceId: "T" }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }),
    })
    const h = await client.getHealth()
    expect(h.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.auth).toBe("Bearer tok-123")
    // baseUrl's trailing slash is normalised.
    expect(seen[0]!.url).toBe("http://127.0.0.1:1/admin/health")
  })

  it("POSTs with JSON content-type when a body is given, omits it when not", async () => {
    const seen: Array<{ url: string; method: string; ct?: string; body?: string }> = []
    const client = createRestClient({
      baseUrl: "http://h",
      token: "t",
      fetch: makeFetch((url, init) => {
        const headers = init.headers as Record<string, string> | undefined
        seen.push({
          url,
          method: init.method ?? "GET",
          ...(headers?.["content-type"] ? { ct: headers["content-type"] } : {}),
          ...(init.body ? { body: String(init.body) } : {}),
        })
        return new Response(null, { status: 202 })
      }),
    })
    await client.interrupt("slack:W:C:main")
    await client.approve("id-1", { alwaysAllow: true })
    expect(seen[0]).toEqual({
      url: "http://h/admin/sessions/slack%3AW%3AC%3Amain/interrupt",
      method: "POST",
    })
    expect(seen[1]!.ct).toBe("application/json")
    expect(seen[1]!.body).toBe(JSON.stringify({ alwaysAllow: true }))
  })

  it("converts non-2xx into AdminClientError with code + status", async () => {
    const client = createRestClient({
      baseUrl: "http://h",
      token: "t",
      fetch: makeFetch(() => {
        return new Response(
          JSON.stringify({ error: { code: "read_only", message: "server is read-only" } }),
          { status: 403, headers: { "content-type": "application/json" } },
        )
      }),
    })
    try {
      await client.interrupt("k")
      throw new Error("expected throw")
    } catch (err) {
      const e = err as AdminClientError
      expect(e.status).toBe(403)
      expect(e.code).toBe("read_only")
      expect(e.message).toMatch(/read-only/)
    }
  })

  it("still raises when the server's error body is non-JSON", async () => {
    const client = createRestClient({
      baseUrl: "http://h",
      token: "t",
      fetch: makeFetch(() => new Response("<html>500</html>", { status: 500 })),
    })
    try {
      await client.listSessions()
      throw new Error("expected throw")
    } catch (err) {
      const e = err as AdminClientError
      expect(e.status).toBe(500)
      expect(e.code).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// WebSocket double
// ---------------------------------------------------------------------------

/**
 * Minimal hand-rolled WebSocket that matches what the client touches. We
 * keep references inside a module-level queue so individual tests can
 * reach in and drive events.
 */
class FakeWebSocket {
  static READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }
  readyState = FakeWebSocket.READY_STATE.CONNECTING
  url: string
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  sent: string[] = []
  constructor(url: string) {
    this.url = url
    fakeWsQueue.push(this)
  }
  send(raw: string): void {
    if (this.readyState !== FakeWebSocket.READY_STATE.OPEN) {
      throw new Error("send on non-open socket")
    }
    this.sent.push(raw)
  }
  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.READY_STATE.CLOSED
    const ev = { code, reason } as unknown as CloseEvent
    this.onclose?.(ev)
  }
  // Helpers the test uses to drive the double.
  fireOpen(): void {
    this.readyState = FakeWebSocket.READY_STATE.OPEN
    this.onopen?.({} as Event)
  }
  fireMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent)
  }
  fireServerClose(code: number, reason: string): void {
    this.readyState = FakeWebSocket.READY_STATE.CLOSED
    this.onclose?.({ code, reason } as unknown as CloseEvent)
  }
  fireError(message: string): void {
    this.onerror?.({ type: "error", message } as unknown as Event)
  }
}

let fakeWsQueue: FakeWebSocket[] = []

function makeFactory(): (url: string) => WebSocket {
  return (url: string) => new FakeWebSocket(url) as unknown as WebSocket
}

beforeEach(() => {
  fakeWsQueue = []
})

describe("connectAdminWs — WebSocket surface", () => {
  it("builds the ws URL with ?token= and transitions connecting → open", () => {
    const states: AdminWsState[] = []
    const client = connectAdminWs({
      baseUrl: "http://host:123",
      token: "abc xyz", // space forces URL-encoding
      wsFactory: makeFactory(),
      pingIntervalMs: 0,
      events: {
        onFrame: () => {},
        onState: (s) => states.push(s),
      },
    })
    const sock = fakeWsQueue[0]!
    expect(sock.url).toBe("ws://host:123/admin/ws?token=abc%20xyz")
    expect(states).toEqual(["connecting"])
    sock.fireOpen()
    expect(states).toContain("open")
    client.close()
  })

  it("delivers parsed frames to onFrame and drops malformed frames with a warn", () => {
    const frames: AdminFrame[] = []
    const client = connectAdminWs({
      baseUrl: "http://h",
      token: "t",
      wsFactory: makeFactory(),
      pingIntervalMs: 0,
      events: { onFrame: (f) => frames.push(f) },
    })
    const sock = fakeWsQueue[0]!
    sock.fireOpen()
    sock.fireMessage(JSON.stringify({ type: "pong", at: 42 } satisfies AdminFrame))
    sock.fireMessage("not-json-at-all")
    sock.fireMessage(JSON.stringify({ type: "session_closed", key: "k", reason: "idle" }))
    expect(frames).toHaveLength(2)
    expect(frames[0]!.type).toBe("pong")
    expect(frames[1]!.type).toBe("session_closed")
    client.close()
  })

  it("reconnects on unexpected close with exponential backoff, not on caller close", async () => {
    const states: AdminWsState[] = []
    const client = connectAdminWs({
      baseUrl: "http://h",
      token: "t",
      wsFactory: makeFactory(),
      initialReconnectMs: 5,
      maxReconnectMs: 50,
      pingIntervalMs: 0,
      events: { onFrame: () => {}, onState: (s) => states.push(s) },
    })
    const first = fakeWsQueue[0]!
    first.fireOpen()
    first.fireServerClose(1006, "abnormal")
    // Give the reconnect timer a tick.
    await new Promise((r) => setTimeout(r, 30))
    expect(fakeWsQueue.length).toBeGreaterThanOrEqual(2)
    const second = fakeWsQueue[1]!
    second.fireOpen()
    // Now close from the caller — no further sockets should appear.
    client.close()
    await new Promise((r) => setTimeout(r, 30))
    expect(fakeWsQueue.length).toBe(2)
    expect(states).toContain("reconnecting")
    expect(states[states.length - 1]).toBe("closed")
  })

  it("sends subscribe / ping commands as JSON only when open", () => {
    const client = connectAdminWs({
      baseUrl: "http://h",
      token: "t",
      wsFactory: makeFactory(),
      pingIntervalMs: 0,
      events: { onFrame: () => {} },
    })
    const sock = fakeWsQueue[0]!
    // Before open — send is dropped silently (readyState !== OPEN).
    client.send({ op: "subscribe", keys: ["a"] })
    expect(sock.sent).toHaveLength(0)
    sock.fireOpen()
    client.send({ op: "subscribe", keys: ["a", "b"] })
    client.send({ op: "ping", at: 1 })
    expect(sock.sent).toHaveLength(2)
    expect(JSON.parse(sock.sent[0]!)).toEqual({ op: "subscribe", keys: ["a", "b"] })
    expect(JSON.parse(sock.sent[1]!)).toEqual({ op: "ping", at: 1 })
    client.close()
  })

  it("surfaces error state on onerror and still reconnects via close", async () => {
    const states: AdminWsState[] = []
    const client = connectAdminWs({
      baseUrl: "http://h",
      token: "t",
      wsFactory: makeFactory(),
      initialReconnectMs: 5,
      pingIntervalMs: 0,
      events: { onFrame: () => {}, onState: (s) => states.push(s) },
    })
    const sock = fakeWsQueue[0]!
    sock.fireError("boom")
    sock.fireServerClose(1011, "server error")
    await new Promise((r) => setTimeout(r, 30))
    expect(states).toContain("error")
    expect(states).toContain("reconnecting")
    expect(fakeWsQueue.length).toBeGreaterThanOrEqual(2)
    client.close()
  })
})

// Satisfy the `AdminHealthResponse` import; the type is re-exported by
// the client but tsc trims unused imports otherwise.
function _typeCheckOnly(): AdminHealthResponse {
  return { ok: true, mode: "socket", botUserId: "", workspaceId: "" }
}
void _typeCheckOnly
