import { describe, expect, it } from "bun:test"
import { createDedupCache } from "../../../../src/frontends/slack/inbox/dedup"
import { decideGate, isDm, mentionsBot, stripBotMention } from "../../../../src/frontends/slack/inbox/gate"
import { buildInboundTurn } from "../../../../src/frontends/slack/inbox/turn-builder"

describe("createDedupCache", () => {
  it("marks first sighting fresh, repeats stale", () => {
    const c = createDedupCache({ ttlMs: 1000, now: () => 0 })
    expect(c.markFresh("a")).toBe(true)
    expect(c.markFresh("a")).toBe(false)
    expect(c.markFresh("b")).toBe(true)
    expect(c.size()).toBe(2)
  })

  it("re-accepts a key after TTL", () => {
    let t = 0
    const c = createDedupCache({ ttlMs: 100, now: () => t })
    expect(c.markFresh("x")).toBe(true)
    t = 50
    expect(c.markFresh("x")).toBe(false)
    t = 200
    expect(c.markFresh("x")).toBe(true)
  })

  it("prune drops entries past TTL", () => {
    let t = 0
    const c = createDedupCache({ ttlMs: 100, now: () => t })
    c.markFresh("a")
    c.markFresh("b")
    t = 50
    c.markFresh("c")
    t = 120 // cutoff = 20 → entries at 0 drop, 50 survives
    c.prune()
    expect(c.size()).toBe(1)
    t = 200 // cutoff = 100 → 50 drops
    c.prune()
    expect(c.size()).toBe(0)
  })
})

describe("decideGate", () => {
  const botId = "UBOT"
  function base(overrides: Partial<Parameters<typeof decideGate>[0]> = {}) {
    return {
      channel: "C01",
      text: "hello",
      botUserId: botId,
      requireMention: true,
      autoJoinThreads: true,
      threadHasActiveSession: false,
      ...overrides,
    }
  }

  it("accepts every DM regardless of mention", () => {
    expect(decideGate(base({ channel: "D01", text: "hi" }))).toEqual({ accept: true, reason: "dm" })
    expect(decideGate(base({ channel: "D01", text: "<@UBOT> hi" }))).toEqual({ accept: true, reason: "dm" })
  })

  it("rejects empty text", () => {
    expect(decideGate(base({ text: "" }))).toEqual({ accept: false, reason: "empty-text" })
    expect(decideGate(base({ text: "   " }))).toEqual({ accept: false, reason: "empty-text" })
  })

  it("accepts a channel mention", () => {
    expect(decideGate(base({ text: "<@UBOT> run tests" }))).toEqual({ accept: true, reason: "mention" })
  })

  it("rejects a channel post without a mention when requireMention", () => {
    expect(decideGate(base({ text: "no mention here" }))).toEqual({
      accept: false,
      reason: "no-mention-in-channel",
    })
  })

  it("accepts when requireMention is off", () => {
    expect(decideGate(base({ requireMention: false, text: "ambient msg" }))).toEqual({
      accept: true,
      reason: "no-mention-required",
    })
  })

  it("auto-joins a thread that already has a live session", () => {
    expect(
      decideGate(
        base({
          text: "follow up",
          threadTs: "100.001",
          threadHasActiveSession: true,
        }),
      ),
    ).toEqual({ accept: true, reason: "thread-auto-join" })
  })

  it("does NOT auto-join a thread with no active session", () => {
    expect(
      decideGate(
        base({
          text: "first reply w/o mention",
          threadTs: "100.001",
          threadHasActiveSession: false,
        }),
      ),
    ).toEqual({ accept: false, reason: "no-mention-in-channel" })
  })

  it("does NOT auto-join when autoJoinThreads is disabled", () => {
    expect(
      decideGate(
        base({
          text: "follow up",
          threadTs: "100.001",
          threadHasActiveSession: true,
          autoJoinThreads: false,
        }),
      ),
    ).toEqual({ accept: false, reason: "no-mention-in-channel" })
  })
})

describe("mentionsBot + stripBotMention", () => {
  it("detects plain and handle-qualified mentions", () => {
    expect(mentionsBot("<@U123> hi", "U123")).toBe(true)
    expect(mentionsBot("<@U123|bantai> hi", "U123")).toBe(true)
    expect(mentionsBot("hi <@U999>", "U123")).toBe(false)
    expect(mentionsBot("no mention", "U123")).toBe(false)
  })

  it("strips all occurrences + normalises whitespace", () => {
    expect(stripBotMention("<@U123> run tests", "U123")).toBe("run tests")
    expect(stripBotMention("hey <@U123|bantai>   and <@U123>", "U123")).toBe("hey and")
  })
})

describe("isDm", () => {
  it("is true for channel ids starting with D", () => {
    expect(isDm("D01234")).toBe(true)
    expect(isDm("C01234")).toBe(false)
    expect(isDm("G12345")).toBe(false)
  })
})

describe("buildInboundTurn", () => {
  const botId = "UBOT"

  it("prefixes the author display name and strips the mention", () => {
    const turn = buildInboundTurn({
      text: "<@UBOT> run the tests",
      channel: "C01",
      ts: "100.001",
      userId: "UALICE",
      userDisplayName: "alice",
      botUserId: botId,
    })
    expect(turn.text).toBe("@alice: run the tests")
    expect(turn.channel).toBe("C01")
    expect(turn.triggerTs).toBe("100.001")
    expect(turn.parentTs).toBe("100.001") // top-level → anchor = triggerTs
    expect(turn.author).toEqual({ userId: "UALICE", displayName: "alice" })
  })

  it("uses thread_ts as parentTs for thread replies", () => {
    const turn = buildInboundTurn({
      text: "<@UBOT> reply",
      channel: "C01",
      ts: "200.002",
      threadTs: "100.001",
      userId: "UALICE",
      userDisplayName: "alice",
      botUserId: botId,
    })
    expect(turn.parentTs).toBe("100.001")
    expect(turn.triggerTs).toBe("200.002")
  })

  it("falls back to userId when no display name is known", () => {
    const turn = buildInboundTurn({
      text: "<@UBOT> hi",
      channel: "C01",
      ts: "100",
      userId: "UXYZ",
      botUserId: botId,
    })
    expect(turn.text).toBe("@UXYZ: hi")
  })

  it("emits a bare @name: prefix when the message is mention-only", () => {
    const turn = buildInboundTurn({
      text: "<@UBOT>",
      channel: "C01",
      ts: "100",
      userId: "UALICE",
      userDisplayName: "alice",
      botUserId: botId,
    })
    expect(turn.text).toBe("@alice:")
  })
})
