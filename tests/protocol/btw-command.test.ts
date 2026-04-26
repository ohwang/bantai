import { describe, expect, it, mock } from "bun:test"
import { btwCommand } from "../../src/commands/builtin/btw"
import type { CommandContext } from "../../src/commands/registry"
import type { AgentBackend } from "../../src/protocol/types"

/**
 * /btw slash-command tests.
 *
 * Pins the MVP behavior of the /btw command:
 *   - empty `/btw` shows help (no openSideChat call)
 *   - `/btw <question>` calls frontend.openSideChat(backend, question)
 *   - missing backend.sideQuery → ephemeral system_message error, no
 *     openSideChat call
 *   - missing frontend.openSideChat → ephemeral system_message error
 *
 * Argument capture is checked verbatim because the question string
 * MUST be passed through unchanged to the fork — any sanitisation /
 * trimming beyond a leading-trailing strip would silently corrupt the
 * user's prompt.
 */

function makeBackend(opts: { withSideQuery: boolean }): AgentBackend {
  const sideQueryFn = mock(async function* () {
    /* never yields in these tests */
  })
  return {
    capabilities: () => ({
      name: "claude",
      supportsThinking: true,
      supportsToolApproval: true,
      supportsResume: true,
      supportsContinue: true,
      supportsFork: true,
      supportsStreaming: true,
      supportsSubagents: true,
      supportsCompact: true,
      supportedPermissionModes: ["default"],
    }),
    start: () => {
      throw new Error("not used in test")
    },
    sendMessage: () => {},
    interrupt: () => {},
    resume: () => {
      throw new Error("not used in test")
    },
    listSessions: async () => [],
    forkSession: async () => "noop",
    approveToolUse: () => {},
    denyToolUse: () => {},
    respondToElicitation: () => {},
    cancelElicitation: () => {},
    setModel: async () => {},
    setPermissionMode: async () => {},
    setEffort: async () => {},
    availableModels: async () => [],
    close: () => {},
    ...(opts.withSideQuery ? { sideQuery: sideQueryFn as any } : {}),
  } as unknown as AgentBackend
}

function makeCtx(overrides?: Partial<CommandContext>): {
  ctx: CommandContext
  pushed: any[]
  openSideChat: ReturnType<typeof mock>
} {
  const pushed: any[] = []
  const openSideChat = mock(() => true)
  const ctx = {
    backend: makeBackend({ withSideQuery: true }),
    pushEvent: (e: any) => {
      pushed.push(e)
    },
    clearConversation: () => {},
    resetCost: () => {},
    resetSession: async () => {},
    setModel: async () => {},
    frontend: { openSideChat: openSideChat as any },
    ...overrides,
  } as CommandContext
  return { ctx, pushed, openSideChat }
}

describe("/btw command", () => {
  it("name and arg hint", () => {
    expect(btwCommand.name).toBe("btw")
    expect(btwCommand.argumentHint).toBe("<question>")
  })

  it("empty args pushes help text and does not open the overlay", async () => {
    const { ctx, pushed, openSideChat } = makeCtx()
    await btwCommand.execute("", ctx)
    expect(openSideChat).not.toHaveBeenCalled()
    expect(pushed.length).toBe(1)
    expect(pushed[0].type).toBe("system_message")
    expect(pushed[0].ephemeral).toBe(true)
    expect(pushed[0].text).toContain("/btw")
  })

  it("whitespace-only args treated as empty", async () => {
    const { ctx, pushed, openSideChat } = makeCtx()
    await btwCommand.execute("   \t  ", ctx)
    expect(openSideChat).not.toHaveBeenCalled()
    expect(pushed.length).toBe(1)
    expect(pushed[0].type).toBe("system_message")
  })

  it("opens the overlay with the trimmed question", async () => {
    const { ctx, pushed, openSideChat } = makeCtx()
    await btwCommand.execute(
      "what was that config file again?",
      ctx,
    )
    expect(openSideChat).toHaveBeenCalledTimes(1)
    const [, question] = openSideChat.mock.calls[0]!
    expect(question).toBe("what was that config file again?")
    expect(pushed.length).toBe(0)
  })

  it("preserves multi-word questions verbatim (no sanitisation)", async () => {
    const { ctx, openSideChat } = makeCtx()
    await btwCommand.execute(
      "is `useState` idiomatic in Solid?",
      ctx,
    )
    const [, question] = openSideChat.mock.calls[0]!
    expect(question).toBe("is `useState` idiomatic in Solid?")
  })

  it("trims surrounding whitespace from the question", async () => {
    const { ctx, openSideChat } = makeCtx()
    await btwCommand.execute("   what time is it?  ", ctx)
    const [, question] = openSideChat.mock.calls[0]!
    expect(question).toBe("what time is it?")
  })

  it("errors cleanly when backend lacks sideQuery", async () => {
    const noFork = makeBackend({ withSideQuery: false })
    const { ctx, pushed, openSideChat } = makeCtx({ backend: noFork })
    await btwCommand.execute("hello?", ctx)
    expect(openSideChat).not.toHaveBeenCalled()
    expect(pushed.length).toBe(1)
    expect(pushed[0].type).toBe("system_message")
    expect(pushed[0].text).toContain("session forking")
    expect(pushed[0].ephemeral).toBe(true)
  })

  it("errors cleanly when frontend has no openSideChat hook", async () => {
    const { ctx, pushed } = makeCtx({ frontend: {} })
    await btwCommand.execute("hello?", ctx)
    expect(pushed.length).toBe(1)
    expect(pushed[0].type).toBe("system_message")
    expect(pushed[0].text).toContain("not available in this frontend")
  })

  it("errors when openSideChat returns false (frontend declined)", async () => {
    const declining = mock(() => false)
    const { ctx, pushed } = makeCtx({
      frontend: { openSideChat: declining as any },
    })
    await btwCommand.execute("hello?", ctx)
    expect(declining).toHaveBeenCalledTimes(1)
    expect(pushed.length).toBe(1)
    expect(pushed[0].type).toBe("system_message")
  })
})
