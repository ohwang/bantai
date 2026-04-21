import { describe, expect, it } from "bun:test"
import { createHistoryInjectionProvider } from "../../../../src/frontends/slack/recovery/history-provider"

/**
 * Narrow test scope: we're exercising the provider's decision logic
 * (canInject, null-vs-context return), not the upstream cross-backend
 * parsers — those are covered by tests/session/cross-backend.test.ts.
 * The `loader` override lets us pin the module surface to a deterministic
 * stub.
 */

function stubModule(overrides: {
  readForeignSession?: (sessionId: string, origin: string, cwd: string) => unknown[]
  formatFullHistory?: (blocks: unknown[], origin: string) => {
    contextText: string
    toolCallCount: number
    turnCount: number
  }
  listCodexSessionsFromDisk?: () => Array<{ id: string }>
  listGeminiSessionsFromDisk?: (cwd: string) => Array<{ id: string }>
  listClaudeSessionsFromDisk?: (cwd: string) => Array<{ id: string }>
} = {}) {
  return {
    readForeignSession:
      overrides.readForeignSession ?? (() => [{ type: "user", text: "hello" }]),
    formatFullHistory:
      overrides.formatFullHistory ??
      (() => ({ contextText: "history blob", toolCallCount: 0, turnCount: 1 })),
    listCodexSessionsFromDisk:
      overrides.listCodexSessionsFromDisk ?? (() => []),
    listGeminiSessionsFromDisk:
      overrides.listGeminiSessionsFromDisk ?? (() => []),
    listClaudeSessionsFromDisk:
      overrides.listClaudeSessionsFromDisk ?? (() => []),
  }
}

describe("createHistoryInjectionProvider", () => {
  it("returns null when the cross-backend loader fails", () => {
    const provider = createHistoryInjectionProvider({ loader: () => null })
    expect(provider).toBeNull()
  })

  it("canInject is true for supported backends", () => {
    const provider = createHistoryInjectionProvider({ loader: () => stubModule() })!
    expect(provider).not.toBeNull()
    expect(
      provider.canInject({ fromBackend: "codex", toBackend: "gemini", sessionId: "s1" }),
    ).toBe(true)
    expect(
      provider.canInject({ fromBackend: "gemini", toBackend: "claude", sessionId: "s2" }),
    ).toBe(true)
    expect(
      provider.canInject({ fromBackend: "claude", toBackend: "gemini", sessionId: "s3" }),
    ).toBe(true)
  })

  it("canInject is false for unknown backend ids (mock/new/etc.)", () => {
    const provider = createHistoryInjectionProvider({ loader: () => stubModule() })!
    expect(
      provider.canInject({ fromBackend: "mock", toBackend: "gemini", sessionId: "s1" }),
    ).toBe(false)
    expect(
      provider.canInject({ fromBackend: "", toBackend: "gemini", sessionId: "s1" }),
    ).toBe(false)
  })

  it("canInject treats acp as an alias for gemini", () => {
    const provider = createHistoryInjectionProvider({ loader: () => stubModule() })!
    expect(
      provider.canInject({ fromBackend: "acp", toBackend: "claude", sessionId: "s1" }),
    ).toBe(true)
  })

  it("buildReplayContext returns null when session isn't on disk", async () => {
    const provider = createHistoryInjectionProvider({
      loader: () =>
        stubModule({
          listGeminiSessionsFromDisk: () => [{ id: "other" }],
        }),
    })!
    const res = await provider.buildReplayContext({
      fromBackend: "gemini",
      toBackend: "codex",
      sessionId: "missing",
      cwd: "/tmp/does-not-matter",
    })
    expect(res).toBeNull()
  })

  it("buildReplayContext returns null when readForeignSession yields no blocks", async () => {
    const provider = createHistoryInjectionProvider({
      loader: () =>
        stubModule({
          listCodexSessionsFromDisk: () => [{ id: "present" }],
          readForeignSession: () => [],
        }),
    })!
    const res = await provider.buildReplayContext({
      fromBackend: "codex",
      toBackend: "gemini",
      sessionId: "present",
      cwd: "/tmp",
    })
    expect(res).toBeNull()
  })

  it("buildReplayContext returns the formatted contextText on success", async () => {
    const provider = createHistoryInjectionProvider({
      loader: () =>
        stubModule({
          listCodexSessionsFromDisk: () => [{ id: "abc" }],
          readForeignSession: () => [
            { type: "user", text: "hello" },
            { type: "assistant", text: "world" },
          ],
          formatFullHistory: () => ({
            contextText: "[Previous conversation]\n\nUser: hi\nAssistant: bye",
            turnCount: 1,
            toolCallCount: 0,
          }),
        }),
    })!
    const res = await provider.buildReplayContext({
      fromBackend: "codex",
      toBackend: "gemini",
      sessionId: "abc",
      cwd: "/tmp",
    })
    expect(res).toContain("[Previous conversation]")
    expect(res).toContain("User: hi")
  })

  it("buildReplayContext returns null when readForeignSession throws", async () => {
    const provider = createHistoryInjectionProvider({
      loader: () =>
        stubModule({
          listGeminiSessionsFromDisk: () => [{ id: "boom" }],
          readForeignSession: () => {
            throw new Error("parse failure")
          },
        }),
    })!
    const res = await provider.buildReplayContext({
      fromBackend: "gemini",
      toBackend: "codex",
      sessionId: "boom",
      cwd: "/tmp",
    })
    expect(res).toBeNull()
  })

  it("buildReplayContext returns null for an unknown backend id", async () => {
    const provider = createHistoryInjectionProvider({ loader: () => stubModule() })!
    const res = await provider.buildReplayContext({
      fromBackend: "mock",
      toBackend: "gemini",
      sessionId: "x",
      cwd: "/tmp",
    })
    expect(res).toBeNull()
  })

  it("buildReplayContext picks the right lister for each origin", async () => {
    const claudeIds: string[] = []
    const codexIds: string[] = []
    const geminiIds: string[] = []
    const provider = createHistoryInjectionProvider({
      loader: () =>
        stubModule({
          listClaudeSessionsFromDisk: () => {
            claudeIds.push("called")
            return [{ id: "c1" }]
          },
          listCodexSessionsFromDisk: () => {
            codexIds.push("called")
            return [{ id: "c2" }]
          },
          listGeminiSessionsFromDisk: () => {
            geminiIds.push("called")
            return [{ id: "g1" }]
          },
        }),
    })!
    await provider.buildReplayContext({
      fromBackend: "claude",
      toBackend: "gemini",
      sessionId: "c1",
      cwd: "/tmp",
    })
    await provider.buildReplayContext({
      fromBackend: "codex",
      toBackend: "gemini",
      sessionId: "c2",
      cwd: "/tmp",
    })
    await provider.buildReplayContext({
      fromBackend: "gemini",
      toBackend: "claude",
      sessionId: "g1",
      cwd: "/tmp",
    })
    expect(claudeIds).toEqual(["called"])
    expect(codexIds).toEqual(["called"])
    expect(geminiIds).toEqual(["called"])
  })
})
