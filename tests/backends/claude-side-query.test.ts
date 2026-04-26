import { describe, expect, it, mock } from "bun:test"
import { ClaudeAdapter } from "../../src/backends/claude/adapter"
import type { AgentEvent } from "../../src/protocol/types"

/**
 * Claude adapter — sideQuery() tests.
 *
 * Asserts the contract pieces that matter for the /btw MVP:
 *   1. Forks via the SDK's forkSession (not transcript replay).
 *   2. Spawns the side query into the fork with mcpServers={}, allowedTools=[],
 *      and permissionMode="dontAsk" (the SDK's closest equivalent to "deny";
 *      empty allowlist + dontAsk means every tool_use is denied).
 *   3. Does NOT inject systemPrompt / appendSystemPrompt — cache-key integrity
 *      requires the fork to inherit the parent's prompt prefix verbatim.
 *   4. Discards the fork on completion via deleteSession() — no leaked JSONL.
 *   5. Errors cleanly when there is no live session id yet.
 *   6. Yields ONLY the side-chat subset of AgentEvent (no permission_request,
 *      no tool_use_*); foreign events from a misbehaving fork are dropped.
 */

function fakeSideStream(messages: any[]): any {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m
    },
    close: mock(() => {}),
    interrupt: mock(() => {}),
    setModel: mock(async () => {}),
    setPermissionMode: mock(async () => {}),
    applyFlagSettings: mock(async () => {}),
    supportedModels: mock(async () => []),
  }
}

describe("ClaudeAdapter.sideQuery", () => {
  it("errors cleanly when there is no live session yet", async () => {
    const adapter = new ClaudeAdapter()
    const events: AgentEvent[] = []
    for await (const ev of adapter.sideQuery!("hello?", {
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }
    expect(events.length).toBe(1)
    expect(events[0]?.type).toBe("error")
    expect((events[0] as any).code).toBe("side_chat_no_session")
    adapter.close()
  })

  it("forks the live session and runs the side query with tools disabled", async () => {
    const forkSession = mock(async (_id: string, _opts: any) => ({
      sessionId: "forked-session-uuid",
    }))
    const deleteSession = mock(async (_id: string, _opts: any) => undefined)

    // Side query streams a tool-less Q&A turn, then ends.
    const sideQueryFn = mock(() =>
      fakeSideStream([
        {
          type: "system",
          subtype: "init",
          tools: [],
          model: "claude-sonnet-4-6",
          cwd: process.cwd(),
          session_id: "forked-session-uuid",
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "the answer" },
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "forked-session-uuid",
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0.0001,
          duration_ms: 100,
        },
      ]),
    )

    const adapter = new ClaudeAdapter({
      query: sideQueryFn as any,
      startup: mock(async () => {
        throw new Error("no warm path in this test")
      }) as any,
      listSessions: mock(async () => []) as any,
      forkSession: forkSession as any,
      deleteSession: deleteSession as any,
    } as any)

    // Seed a live session id (would normally come from session_init event).
    ;(adapter as any).liveSessionId = "live-session-uuid"
    ;(adapter as any).sessionCwd = "/some/project"

    const events: AgentEvent[] = []
    for await (const ev of adapter.sideQuery!("what is 6 * 7?", {
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    // Forked from the live session id, scoped to its cwd.
    expect(forkSession).toHaveBeenCalledTimes(1)
    const [forkSrc, forkOpts] = forkSession.mock.calls[0]!
    expect(forkSrc).toBe("live-session-uuid")
    expect(forkOpts.dir).toBe("/some/project")

    // The actual query was launched against the forked session id with the
    // tool-less options.
    expect(sideQueryFn).toHaveBeenCalledTimes(1)
    const calls = sideQueryFn.mock.calls as unknown as Array<[{ prompt: string; options: any }]>
    const queryArgs = calls[0]![0]
    const { prompt, options } = queryArgs
    expect(prompt).toBe("what is 6 * 7?")
    expect(options.resume).toBe("forked-session-uuid")
    expect(options.mcpServers).toEqual({})
    expect(options.allowedTools).toEqual([])
    expect(options.permissionMode).toBe("dontAsk")
    // Cache-key integrity: NO systemPrompt / appendSystemPrompt steering.
    expect(options.systemPrompt).toBeUndefined()
    expect(options.appendSystemPrompt).toBeUndefined()

    // The fork is deleted afterwards so we don't leak JSONL files.
    expect(deleteSession).toHaveBeenCalledTimes(1)
    const [delId, delOpts] = deleteSession.mock.calls[0]!
    expect(delId).toBe("forked-session-uuid")
    expect(delOpts.dir).toBe("/some/project")

    // Yielded events: at minimum a turn_complete; text_delta arrives via
    // mapStreamEvent. No tool/permission events.
    const types = events.map((e) => e.type)
    expect(types).toContain("text_delta")
    expect(types).toContain("turn_complete")
    expect(types).not.toContain("permission_request")
    expect(types).not.toContain("tool_use_start")
    expect(types).not.toContain("session_init")

    adapter.close()
  })

  it("aborts in-flight stream when the signal fires", async () => {
    const forkSession = mock(async () => ({ sessionId: "fork-2" }))
    const deleteSession = mock(async () => undefined)

    // Stream that never ends until close() is called.
    let closed = false
    const sideQuery = {
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          await new Promise((r) => setTimeout(r, 5))
        }
      },
      close: mock(() => {
        closed = true
      }),
      interrupt: mock(() => {}),
      setModel: mock(async () => {}),
      setPermissionMode: mock(async () => {}),
      applyFlagSettings: mock(async () => {}),
      supportedModels: mock(async () => []),
    }

    const adapter = new ClaudeAdapter({
      query: mock(() => sideQuery) as any,
      startup: mock(async () => {
        throw new Error("no warm")
      }) as any,
      listSessions: mock(async () => []) as any,
      forkSession: forkSession as any,
      deleteSession: deleteSession as any,
    } as any)
    ;(adapter as any).liveSessionId = "live-3"
    ;(adapter as any).sessionCwd = "/p"

    const ctrl = new AbortController()
    const eventsP = (async () => {
      const out: AgentEvent[] = []
      for await (const ev of adapter.sideQuery!("hold", { signal: ctrl.signal })) {
        out.push(ev)
      }
      return out
    })()

    // Let the fork get created and streaming start, then abort.
    await new Promise((r) => setTimeout(r, 30))
    ctrl.abort()
    const events = await eventsP

    // Either we exited cleanly (no error) or saw the soft "aborted" path —
    // the load-bearing check is that deleteSession() ran so the JSONL is
    // unlinked.
    expect(deleteSession).toHaveBeenCalledTimes(1)
    expect(events.find((e) => e.type === "permission_request")).toBeUndefined()

    adapter.close()
  })
})
