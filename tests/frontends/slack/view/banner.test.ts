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
    controlPrefix: "!bantai",
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
  it("produces header + section + context blocks", () => {
    const { blocks, text } = buildSessionBanner({
      project: project(),
      sessionId: "01HQX7K8G",
    })
    expect(blocks.length).toBe(3)
    expect(blocks[0]!.type).toBe("header")
    expect(blocks[1]!.type).toBe("section")
    expect(blocks[2]!.type).toBe("context")
    expect(text).toContain("bantai started")
  })

  it("fresh-session header reads 'session started'", () => {
    const { blocks } = buildSessionBanner({ project: project() })
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text.toLowerCase()).toContain("session started")
  })

  it("resumed variant includes the prior-turns + cost summary", () => {
    const { blocks } = buildSessionBanner({
      project: project(),
      sessionId: "abc",
      resumed: { priorTurns: 12, priorCostUsd: 0.345, lastActive: "3 days ago" },
    })
    const section = blocks[1] as { text: { text: string } }
    expect(section.text.text).toContain("resume")
    expect(section.text.text).toContain("12 prior turns")
    expect(section.text.text).toContain("cost ~ $0.345")
    expect(section.text.text).toContain("3 days ago")
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text.toLowerCase()).toContain("resumed")
  })

  it("participant list lands in the context block", () => {
    const { blocks } = buildSessionBanner({
      project: project(),
      participants: ["alice", "bob"],
    })
    const context = blocks[2] as { elements: Array<{ text: string }> }
    expect(context.elements[0]!.text).toContain("@alice")
    expect(context.elements[0]!.text).toContain("@bob")
  })

  it("no participants → context block hints at help command", () => {
    const { blocks } = buildSessionBanner({ project: project() })
    const context = blocks[2] as { elements: Array<{ text: string }> }
    expect(context.elements[0]!.text).toContain("!bantai help")
  })

  it("falls back to <default> model + <pending> session id", () => {
    const { blocks } = buildSessionBanner({ project: project({ model: undefined }) })
    const section = blocks[1] as { text: { text: string } }
    expect(section.text.text).toContain("<default>")
    expect(section.text.text).toContain("<pending>")
  })
})
