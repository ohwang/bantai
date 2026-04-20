import { describe, expect, it } from "bun:test"
import { AcpAdapter } from "../../src/backends/acp/adapter"

// ---------------------------------------------------------------------------
// ACP adapter: tryLoadSession resilience
//
// Covers the white-box helper that wraps `session/load`. The key regression
// we're guarding against is Gemini returning JSON-RPC -32603 "Invalid session
// identifier" when the session file was recorded against a different backend
// or has been deleted. Before Commit 3 that error propagated out of
// initialize() and killed the thread with a "fatal" event; now the adapter
// must catch the failure and return null so the caller can fall through to a
// clean session/new.
// ---------------------------------------------------------------------------

function makeAdapter() {
  return new AcpAdapter({
    command: "echo",
    args: [],
    displayName: "Test Agent",
    presetName: "gemini",
  })
}

// Minimal transport stand-in. AcpAdapter.close() calls
// `this.transport.close()` during test cleanup, so any fake must carry that
// method even when the test only exercises `request()`.
function makeFakeTransport(handler: {
  request?: (method: string, params: unknown) => Promise<unknown>
  isAlive?: boolean
}) {
  return {
    isAlive: handler.isAlive ?? true,
    request: handler.request ?? (async () => null),
    close: () => {},
  }
}

describe("AcpAdapter.tryLoadSession", () => {
  it("returns the session result on a successful session/load", async () => {
    const adapter = makeAdapter()
    const fakeResult = {
      sessionId: "abc",
      models: { availableModels: [], currentModelId: null },
    }
    ;(adapter as any).transport = makeFakeTransport({
      async request(method, params) {
        expect(method).toBe("session/load")
        expect(params).toEqual({ sessionId: "abc", cwd: "/tmp", mcpServers: [] })
        return fakeResult
      },
    })

    const result = await (adapter as any).tryLoadSession("abc", "/tmp")
    expect(result).toBe(fakeResult)
    adapter.close()
  })

  it("returns null when session/load throws (any error)", async () => {
    const adapter = makeAdapter()
    ;(adapter as any).transport = makeFakeTransport({
      async request() {
        throw new Error("connection closed")
      },
    })

    const result = await (adapter as any).tryLoadSession("abc", "/tmp")
    expect(result).toBeNull()
    adapter.close()
  })

  it("returns null on JSON-RPC -32603 (Gemini's stale-session response)", async () => {
    const adapter = makeAdapter()
    ;(adapter as any).transport = makeFakeTransport({
      async request() {
        // Shape matches what AcpTransport surfaces — the message embeds the
        // JSON-RPC error code so the helper can classify it.
        throw new Error("-32603 Invalid session identifier")
      },
    })

    const result = await (adapter as any).tryLoadSession("bogus", "/tmp")
    expect(result).toBeNull()
    adapter.close()
  })

  it("returns null when transport is not connected", async () => {
    const adapter = makeAdapter()
    // transport is null by default before initialize()
    const result = await (adapter as any).tryLoadSession("abc", "/tmp")
    expect(result).toBeNull()
    adapter.close()
  })
})
