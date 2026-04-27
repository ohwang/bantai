import { describe, expect, it } from "bun:test"
import { buildSessionBanner } from "../../../../src/frontends/slack/view/banner"
import type { ProjectConfig } from "../../../../src/frontends/slack/router/resolver"

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    channelId: "C01",
    projectDir: "/home/me/proj",
    backend: "claude",
    model: "claude-opus-4-7",
    approvers: [],
    verbosity: "normal",
    requireMention: true,
    permissionMode: "default",
    triggerName: "bantai",
    sessionBanner: true,
    showCost: false,
    autoJoinThreads: true,
    threadRequireExplicitMention: false,
    threadHistoryLimit: 0,
    interactiveReplies: false,
    debounceMs: 0,
    nativeStreaming: false,
    turnTimeoutS: 0,
    maxBudgetUsd: 0,
    env: {},
    ...overrides,
  }
}

describe("buildSessionBanner", () => {
  it("produces a single light context block", () => {
    const { blocks, text } = buildSessionBanner({
      project: project(),
      sessionId: "01HQX7K8G",
    })
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.type).toBe("context")
    expect(text).toContain("bantai started")
  })

  it("fresh-session banner leads with 'bantai session started' (no rocket)", () => {
    const { blocks } = buildSessionBanner({ project: project() })
    const context = blocks[0] as { elements: Array<{ text: string }> }
    const body = context.elements[0]!.text
    expect(body).toContain("bantai session started")
    expect(body).not.toContain(":rocket:")
    expect(body).not.toMatch(/^🚀/)
  })

  it("session id lives on its own line for easy copy", () => {
    const { blocks } = buildSessionBanner({
      project: project(),
      sessionId: "474aaf92-fb19-43a9-b487-0b39c4c74fd5",
    })
    const body = (blocks[0] as { elements: Array<{ text: string }> }).elements[0]!.text
    expect(body).toMatch(/\nsession 474aaf92-fb19-43a9-b487-0b39c4c74fd5(\n|$)/)
  })

  it("project line is just the folder — no channel name prefix", () => {
    const { blocks } = buildSessionBanner({
      project: project({ channelName: "proj-bantai", projectDir: "/home/me/proj" }),
    })
    const body = (blocks[0] as { elements: Array<{ text: string }> }).elements[0]!.text
    expect(body).toContain("project /home/me/proj")
    expect(body).not.toContain("proj-bantai")
  })

  it("does not wrap values in backticks (no inline code highlight)", () => {
    const { blocks } = buildSessionBanner({
      project: project(),
      sessionId: "abc-123",
    })
    const body = (blocks[0] as { elements: Array<{ text: string }> }).elements[0]!.text
    expect(body).not.toContain("`")
  })

  it("resumed variant includes the prior-turns + cost summary", () => {
    const { blocks } = buildSessionBanner({
      project: project(),
      sessionId: "abc",
      resumed: { priorTurns: 12, priorCostUsd: 0.345, lastActive: "3 days ago" },
    })
    const body = (blocks[0] as { elements: Array<{ text: string }> }).elements[0]!.text
    expect(body).toContain("bantai session resumed")
    expect(body).toContain("resume")
    expect(body).toContain("12 prior turns")
    expect(body).toContain("cost ~ $0.345")
    expect(body).toContain("3 days ago")
  })

  it("participant list replaces the help hint in the banner body", () => {
    const { blocks } = buildSessionBanner({
      project: project(),
      participants: ["alice", "bob"],
    })
    const body = (blocks[0] as { elements: Array<{ text: string }> }).elements[0]!.text
    expect(body).toContain("@alice")
    expect(body).toContain("@bob")
    expect(body).not.toContain("/bantai help")
  })

  it("no participants → banner ends with help-command hint", () => {
    const { blocks } = buildSessionBanner({ project: project() })
    const body = (blocks[0] as { elements: Array<{ text: string }> }).elements[0]!.text
    expect(body).toContain("type /bantai help for control commands")
  })

  it("falls back to <default> model + <pending> session id", () => {
    const { blocks } = buildSessionBanner({ project: project({ model: undefined }) })
    const body = (blocks[0] as { elements: Array<{ text: string }> }).elements[0]!.text
    expect(body).toContain("<default>")
    expect(body).toContain("<pending>")
  })

  it("shows the routing emoji + label when the session was emoji-routed", () => {
    // Mirrors the EmojiRoute the parser produces for `:claude:` — we
    // construct it by hand here to keep the banner test independent of
    // the rule table's keyword choice.
    const { blocks } = buildSessionBanner({
      project: project(),
      sessionId: "abc-123",
      emojiRoute: {
        backend: "claude",
        matchedEmoji: ":claude:",
        matchedKeyword: "claude",
        label: "Claude",
      },
    })
    const body = (blocks[0] as { elements: Array<{ text: string }> }).elements[0]!.text
    expect(body).toContain("routed via :claude: → Claude")
    // Without a model in the route, the banner doesn't append a paren.
    expect(body).not.toMatch(/routed via :claude: → Claude \(/)
  })

  it("appends the model in parens when the emoji route carries one", () => {
    const { blocks } = buildSessionBanner({
      project: project({ model: "claude-opus-4-7" }),
      sessionId: "abc-123",
      emojiRoute: {
        backend: "claude",
        model: "claude-opus-4-7",
        matchedEmoji: ":opus:",
        matchedKeyword: "opus",
        label: "Claude Opus 4.7",
      },
    })
    const body = (blocks[0] as { elements: Array<{ text: string }> }).elements[0]!.text
    expect(body).toContain("routed via :opus: → Claude Opus 4.7 (claude-opus-4-7)")
  })

  it("omits the routing line when no emoji route is supplied", () => {
    const { blocks } = buildSessionBanner({
      project: project(),
      sessionId: "abc-123",
    })
    const body = (blocks[0] as { elements: Array<{ text: string }> }).elements[0]!.text
    expect(body).not.toContain("routed via")
  })
})
