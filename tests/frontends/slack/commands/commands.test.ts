import { describe, expect, it } from "bun:test"
import { parseControlCommand } from "../../../../src/frontends/slack/commands/parser"
import {
  dispatchCommand,
  type CommandContext,
} from "../../../../src/frontends/slack/commands/dispatch"
import type { ProjectConfig } from "../../../../src/frontends/slack/router/resolver"

describe("parseControlCommand", () => {
  it("returns null when the text has no prefix", () => {
    expect(parseControlCommand("hello world")).toBeNull()
  })

  it("parses '!bantai help'", () => {
    expect(parseControlCommand("!bantai help")).toEqual({ cmd: "help", args: "" })
  })

  it("bare '!bantai' → help", () => {
    expect(parseControlCommand("!bantai")).toEqual({ cmd: "help", args: "" })
  })

  it("extracts args after the command", () => {
    expect(parseControlCommand("!bantai model claude-opus-4-6")).toEqual({
      cmd: "model",
      args: "claude-opus-4-6",
    })
    expect(parseControlCommand("!bantai verbosity verbose")).toEqual({
      cmd: "verbosity",
      args: "verbose",
    })
  })

  it("case-normalises the command name but preserves args", () => {
    expect(parseControlCommand("!bantai HELP")).toEqual({ cmd: "help", args: "" })
    expect(parseControlCommand("!bantai Model CLAUDE-OPUS-4-6")).toEqual({
      cmd: "model",
      args: "CLAUDE-OPUS-4-6",
    })
  })

  it("skips the turn-builder's '@name:' prefix", () => {
    expect(parseControlCommand("@alice: !bantai stop")).toEqual({ cmd: "stop", args: "" })
  })

  it("respects a custom prefix", () => {
    expect(parseControlCommand("!jarvis status", { prefix: "!jarvis" })).toEqual({
      cmd: "status",
      args: "",
    })
    expect(parseControlCommand("!bantai status", { prefix: "!jarvis" })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// dispatchCommand
// ---------------------------------------------------------------------------

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    channelId: "C0T",
    projectDir: "/tmp/project",
    backend: "mock",
    model: "mock-sonnet",
    approvers: [],
    verbosity: "normal",
    requireMention: true,
    triggerName: "bantai",
    controlPrefix: "!bantai",
    sessionBanner: true,
    autoJoinThreads: true,
    env: {},
    ...overrides,
  }
}

function harness(overrides: Partial<CommandContext> = {}) {
  const replies: string[] = []
  let interrupted = 0
  let modelCall: string | undefined
  let reset = 0
  let verbosity: string | undefined
  const ctx: CommandContext = {
    sendReply: async (t) => { replies.push(t) },
    interrupt: () => { interrupted++ },
    setModel: async (m) => { modelCall = m },
    resetSession: async () => { reset++ },
    setVerbosity: (l) => { verbosity = l },
    project: project(),
    workspace: "W1",
    channel: "C1",
    threadTs: "100.0",
    availableModels: async () => ["mock-sonnet", "mock-opus"],
    ...overrides,
  }
  return {
    ctx,
    get replies() { return replies },
    get interrupted() { return interrupted },
    get modelCall() { return modelCall },
    get reset() { return reset },
    get verbosity() { return verbosity },
  }
}

describe("dispatchCommand", () => {
  it("help → posts help text", async () => {
    const h = harness()
    const res = await dispatchCommand({ cmd: "help", args: "" }, h.ctx)
    expect(res.kind).toBe("handled")
    expect(h.replies[0]).toMatch(/bantai control commands/)
  })

  it("status → posts backend + model + cwd", async () => {
    const h = harness()
    await dispatchCommand({ cmd: "status", args: "" }, h.ctx)
    const body = h.replies[0] ?? ""
    expect(body).toContain("backend")
    expect(body).toContain("model")
    expect(body).toContain("mock-sonnet")
    expect(body).toContain("/tmp/project")
  })

  it("stop → interrupts + acks", async () => {
    const h = harness()
    await dispatchCommand({ cmd: "stop", args: "" }, h.ctx)
    expect(h.interrupted).toBe(1)
    expect(h.replies[0]).toContain("interrupted")
  })

  it("model (no args) → lists models", async () => {
    const h = harness()
    await dispatchCommand({ cmd: "model", args: "" }, h.ctx)
    expect(h.replies[0]).toContain("mock-sonnet")
    expect(h.replies[0]).toContain("mock-opus")
  })

  it("model <id> → sets model", async () => {
    const h = harness()
    await dispatchCommand({ cmd: "model", args: "mock-opus" }, h.ctx)
    expect(h.modelCall).toBe("mock-opus")
    expect(h.replies[0]).toContain("model set to")
  })

  it("verbosity <valid> → applies", async () => {
    const h = harness()
    await dispatchCommand({ cmd: "verbosity", args: "verbose" }, h.ctx)
    expect(h.verbosity).toBe("verbose")
    expect(h.replies[0]).toContain("verbosity set to")
  })

  it("verbosity <invalid> → usage hint", async () => {
    const h = harness()
    const r = await dispatchCommand({ cmd: "verbosity", args: "loud" }, h.ctx)
    expect(r.kind).toBe("invalid")
    expect(h.replies[0]).toContain("usage")
    expect(h.verbosity).toBeUndefined()
  })

  it("new → resets session", async () => {
    const h = harness()
    await dispatchCommand({ cmd: "new", args: "" }, h.ctx)
    expect(h.reset).toBe(1)
  })

  it("unknown cmd → hint", async () => {
    const h = harness()
    const r = await dispatchCommand({ cmd: "bogus", args: "" }, h.ctx)
    expect(r.kind).toBe("unknown")
    expect(h.replies[0]).toContain("!bantai help")
  })
})
