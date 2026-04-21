import { describe, expect, it } from "bun:test"
import {
  classifyVisibility,
  parseSlashText,
  requiresThread,
  THREAD_REQUIRED_HINT,
} from "../../../../src/frontends/slack/commands/slash-adapter"

describe("parseSlashText", () => {
  it("empty text → help", () => {
    expect(parseSlashText("")).toEqual({ cmd: "help", args: "" })
    expect(parseSlashText("   ")).toEqual({ cmd: "help", args: "" })
  })

  it("bare subcommand", () => {
    expect(parseSlashText("help")).toEqual({ cmd: "help", args: "" })
    expect(parseSlashText("status")).toEqual({ cmd: "status", args: "" })
  })

  it("extracts args after the command", () => {
    expect(parseSlashText("model claude-opus-4-7")).toEqual({
      cmd: "model",
      args: "claude-opus-4-7",
    })
    expect(parseSlashText("verbosity verbose")).toEqual({
      cmd: "verbosity",
      args: "verbose",
    })
  })

  it("case-normalises the command name, preserves arg casing", () => {
    expect(parseSlashText("HELP")).toEqual({ cmd: "help", args: "" })
    expect(parseSlashText("Model CLAUDE-OPUS-4-7")).toEqual({
      cmd: "model",
      args: "CLAUDE-OPUS-4-7",
    })
  })

  it("trims leading/trailing whitespace", () => {
    expect(parseSlashText("  stop  ")).toEqual({ cmd: "stop", args: "" })
    expect(parseSlashText("  model   claude-opus-4-7  ")).toEqual({
      cmd: "model",
      args: "claude-opus-4-7",
    })
  })
})

describe("classifyVisibility", () => {
  it("informational reads are ephemeral", () => {
    expect(classifyVisibility({ cmd: "help", args: "" })).toBe("ephemeral")
    expect(classifyVisibility({ cmd: "status", args: "" })).toBe("ephemeral")
    expect(classifyVisibility({ cmd: "settings", args: "" })).toBe("ephemeral")
    expect(classifyVisibility({ cmd: "cost", args: "" })).toBe("ephemeral")
  })

  it("state-changing commands are in_channel", () => {
    expect(classifyVisibility({ cmd: "stop", args: "" })).toBe("in_channel")
    expect(classifyVisibility({ cmd: "cancel", args: "" })).toBe("in_channel")
    expect(classifyVisibility({ cmd: "interrupt", args: "" })).toBe("in_channel")
    expect(classifyVisibility({ cmd: "new", args: "" })).toBe("in_channel")
    expect(classifyVisibility({ cmd: "reset", args: "" })).toBe("in_channel")
    expect(classifyVisibility({ cmd: "verbosity", args: "verbose" })).toBe(
      "in_channel",
    )
  })

  it("model list is ephemeral, model <id> is in_channel", () => {
    expect(classifyVisibility({ cmd: "model", args: "" })).toBe("ephemeral")
    expect(classifyVisibility({ cmd: "model", args: "claude-opus-4-7" })).toBe(
      "in_channel",
    )
  })

  it("unknown commands are ephemeral (typos don't shout at the channel)", () => {
    expect(classifyVisibility({ cmd: "bogus", args: "" })).toBe("ephemeral")
  })
})

describe("requiresThread", () => {
  it("channel-level reads do not require a thread", () => {
    expect(requiresThread({ cmd: "help", args: "" })).toBe(false)
    expect(requiresThread({ cmd: "status", args: "" })).toBe(false)
    expect(requiresThread({ cmd: "settings", args: "" })).toBe(false)
    expect(requiresThread({ cmd: "cost", args: "" })).toBe(false)
    expect(requiresThread({ cmd: "model", args: "" })).toBe(false)
  })

  it("thread-scoped commands require a thread", () => {
    expect(requiresThread({ cmd: "stop", args: "" })).toBe(true)
    expect(requiresThread({ cmd: "cancel", args: "" })).toBe(true)
    expect(requiresThread({ cmd: "interrupt", args: "" })).toBe(true)
    expect(requiresThread({ cmd: "new", args: "" })).toBe(true)
    expect(requiresThread({ cmd: "reset", args: "" })).toBe(true)
    expect(requiresThread({ cmd: "verbosity", args: "debug" })).toBe(true)
  })

  it("model <id> requires a thread (mutates the session); model alone does not", () => {
    expect(requiresThread({ cmd: "model", args: "" })).toBe(false)
    expect(requiresThread({ cmd: "model", args: "claude-opus-4-7" })).toBe(true)
  })

  it("unknown commands don't require a thread (they just error)", () => {
    expect(requiresThread({ cmd: "bogus", args: "" })).toBe(false)
  })
})

describe("THREAD_REQUIRED_HINT", () => {
  it("mentions /bantai and threads so the user knows what to do next", () => {
    expect(THREAD_REQUIRED_HINT).toContain("/bantai")
    expect(THREAD_REQUIRED_HINT.toLowerCase()).toContain("thread")
  })
})
