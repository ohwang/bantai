import { describe, expect, it } from "bun:test"
import type { App } from "@slack/bolt"
import {
  fetchThreadHistory,
  formatThreadHistory,
} from "../../../../src/frontends/slack/inbox/thread-history"
import type { UserCache } from "../../../../src/frontends/slack/view/user-cache"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface RepliesPage {
  ok?: boolean
  error?: string
  messages?: Array<{
    text?: string
    user?: string
    bot_id?: string
    ts?: string
    files?: Array<{ id?: string; name?: string }>
  }>
  response_metadata?: { next_cursor?: string }
}

function makeApp(pages: RepliesPage[]): {
  app: App
  calls: Array<{ channel?: string; ts?: string; cursor?: string; limit?: number }>
} {
  const calls: Array<{
    channel?: string
    ts?: string
    cursor?: string
    limit?: number
  }> = []
  let idx = 0
  const replies = async (args: {
    channel?: string
    ts?: string
    cursor?: string
    limit?: number
  }): Promise<RepliesPage> => {
    calls.push(args)
    const page = pages[idx] ?? pages[pages.length - 1]!
    idx = Math.min(idx + 1, pages.length)
    return page
  }
  const app = {
    client: {
      conversations: { replies },
    },
  } as unknown as App
  return { app, calls }
}

function makeUserCache(seed: Record<string, string>): UserCache {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    async displayName(userId) {
      return map.get(userId)
    },
    async channelName() {
      return undefined
    },
    seed(userId, name) {
      map.set(userId, name)
    },
    seedChannel() {},
    clear() {
      map.clear()
    },
    size() {
      return map.size
    },
  }
}

// ---------------------------------------------------------------------------
// fetchThreadHistory
// ---------------------------------------------------------------------------

describe("fetchThreadHistory", () => {
  it("returns [] when limit is 0 or negative", async () => {
    const { app, calls } = makeApp([{ ok: true, messages: [] }])
    expect(
      await fetchThreadHistory({
        app,
        channelId: "C1",
        threadTs: "100.000",
        limit: 0,
      }),
    ).toEqual([])
    expect(calls).toEqual([])

    expect(
      await fetchThreadHistory({
        app,
        channelId: "C1",
        threadTs: "100.000",
        limit: -5,
      }),
    ).toEqual([])
    expect(calls).toEqual([])
  })

  it("fetches prior thread messages and excludes the current trigger", async () => {
    const { app, calls } = makeApp([
      {
        ok: true,
        messages: [
          { text: "starter", user: "U1", ts: "100.000" },
          { text: "follow-up", user: "U2", ts: "101.000" },
          { text: "current message", user: "U3", ts: "102.000" },
        ],
        response_metadata: { next_cursor: "" },
      },
    ])
    const out = await fetchThreadHistory({
      app,
      channelId: "C1",
      threadTs: "100.000",
      currentMessageTs: "102.000",
      limit: 20,
    })
    expect(out.map((m) => m.text)).toEqual(["starter", "follow-up"])
    expect(out.map((m) => m.userId)).toEqual(["U1", "U2"])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      channel: "C1",
      ts: "100.000",
      limit: 200,
      inclusive: true,
    })
  })

  it("follows the cursor across multiple pages", async () => {
    const { app, calls } = makeApp([
      {
        ok: true,
        messages: [
          { text: "m1", user: "U1", ts: "100.000" },
          { text: "m2", user: "U1", ts: "101.000" },
        ],
        response_metadata: { next_cursor: "cursor-2" },
      },
      {
        ok: true,
        messages: [
          { text: "m3", user: "U2", ts: "102.000" },
          { text: "m4", user: "U2", ts: "103.000" },
        ],
        response_metadata: { next_cursor: "" },
      },
    ])
    const out = await fetchThreadHistory({
      app,
      channelId: "C1",
      threadTs: "100.000",
      limit: 20,
    })
    expect(out.map((m) => m.text)).toEqual(["m1", "m2", "m3", "m4"])
    expect(calls).toHaveLength(2)
    expect(calls[1]!.cursor).toBe("cursor-2")
  })

  it("keeps only the latest `limit` messages when threads exceed it", async () => {
    const { app } = makeApp([
      {
        ok: true,
        messages: Array.from({ length: 10 }, (_, i) => ({
          text: `m${i}`,
          user: "U1",
          ts: `${100 + i}.000`,
        })),
        response_metadata: { next_cursor: "" },
      },
    ])
    const out = await fetchThreadHistory({
      app,
      channelId: "C1",
      threadTs: "100.000",
      limit: 3,
    })
    expect(out.map((m) => m.text)).toEqual(["m7", "m8", "m9"])
  })

  it("represents file-only messages with an `[attached: …]` placeholder", async () => {
    const { app } = makeApp([
      {
        ok: true,
        messages: [
          {
            text: "",
            user: "U1",
            ts: "100.000",
            files: [{ id: "F1", name: "report.pdf" }],
          },
          {
            text: "with caption",
            user: "U1",
            ts: "101.000",
            files: [
              { id: "F2", name: "a.png" },
              { id: "F3", name: "b.png" },
            ],
          },
        ],
        response_metadata: { next_cursor: "" },
      },
    ])
    const out = await fetchThreadHistory({
      app,
      channelId: "C1",
      threadTs: "100.000",
      limit: 20,
    })
    expect(out[0]!.text).toBe("[attached: report.pdf]")
    expect(out[0]!.filenames).toEqual(["report.pdf"])
    expect(out[1]!.text).toBe("with caption")
    expect(out[1]!.filenames).toEqual(["a.png", "b.png"])
  })

  it("drops empty messages (no text, no files)", async () => {
    const { app } = makeApp([
      {
        ok: true,
        messages: [
          { text: "real", user: "U1", ts: "100.000" },
          { text: "   ", user: "U1", ts: "100.500" },
          { text: "", user: "U1", ts: "100.700" },
        ],
        response_metadata: { next_cursor: "" },
      },
    ])
    const out = await fetchThreadHistory({
      app,
      channelId: "C1",
      threadTs: "100.000",
      limit: 20,
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toBe("real")
  })

  it("returns [] on API error (non-fatal)", async () => {
    const { app } = makeApp([
      { ok: false, error: "missing_scope" },
    ])
    const out = await fetchThreadHistory({
      app,
      channelId: "C1",
      threadTs: "100.000",
      limit: 20,
    })
    expect(out).toEqual([])
  })

  it("returns [] when the underlying client throws", async () => {
    const app = {
      client: {
        conversations: {
          async replies() {
            throw new Error("network down")
          },
        },
      },
    } as unknown as App
    const out = await fetchThreadHistory({
      app,
      channelId: "C1",
      threadTs: "100.000",
      limit: 20,
    })
    expect(out).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// formatThreadHistory
// ---------------------------------------------------------------------------

describe("formatThreadHistory", () => {
  it("returns undefined for empty history", async () => {
    const out = await formatThreadHistory({
      messages: [],
      botUserId: "UBOT",
      userCache: makeUserCache({}),
    })
    expect(out).toBeUndefined()
  })

  it("renders human messages with display name + role=user", async () => {
    const out = await formatThreadHistory({
      messages: [{ text: "hello thread", userId: "U1", ts: "1713484800.000" }],
      botUserId: "UBOT",
      userCache: makeUserCache({ U1: "alice" }),
    })
    expect(out).toContain("<slack_thread_history>")
    expect(out).toContain("</slack_thread_history>")
    expect(out).toContain("alice (user): hello thread")
    // ts 1713484800 = 2024-04-19 00:00:00 UTC
    expect(out).toMatch(/\[2024-04-19 00:00 UTC\]/)
  })

  it("labels bot_id messages as assistant", async () => {
    const out = await formatThreadHistory({
      messages: [{ text: "bot reply", botId: "B1", ts: "1713484800.000" }],
      botUserId: "UBOT",
      userCache: makeUserCache({}),
    })
    expect(out).toContain("(assistant): bot reply")
  })

  it("labels messages authored by botUserId as assistant even without bot_id", async () => {
    const out = await formatThreadHistory({
      messages: [
        {
          text: "bot reply via bot user id",
          userId: "UBOT",
          ts: "1713484800.000",
        },
      ],
      botUserId: "UBOT",
      userCache: makeUserCache({ UBOT: "bantai" }),
    })
    expect(out).toContain("bantai (assistant): bot reply via bot user id")
  })

  it("falls back to userId when displayName is not cached", async () => {
    const out = await formatThreadHistory({
      messages: [{ text: "hi", userId: "UZZZ", ts: "1713484800.000" }],
      botUserId: "UBOT",
      userCache: makeUserCache({}),
    })
    expect(out).toContain("UZZZ (user): hi")
  })

  it("appends `[attached: …]` suffix when filenames are present", async () => {
    const out = await formatThreadHistory({
      messages: [
        {
          text: "see screenshot",
          userId: "U1",
          ts: "1713484800.000",
          filenames: ["one.png", "two.png"],
        },
      ],
      botUserId: "UBOT",
      userCache: makeUserCache({ U1: "alice" }),
    })
    expect(out).toContain(
      "alice (user): see screenshot [attached: one.png, two.png]",
    )
  })

  it("collapses multi-line message bodies onto a single line", async () => {
    const out = await formatThreadHistory({
      messages: [
        {
          text: "line one\n\n   line two   \n\t\tline three",
          userId: "U1",
          ts: "1713484800.000",
        },
      ],
      botUserId: "UBOT",
      userCache: makeUserCache({ U1: "alice" }),
    })
    expect(out).toContain("alice (user): line one line two line three")
    // Ensure no embedded newlines in the message body (only the header + wrapper ones).
    const body = out!
      .split("\n")
      .filter((l) => l.includes("alice (user):"))
      .join("\n")
    expect(body.split("\n")).toHaveLength(1)
  })

  it("preserves chronological order as given", async () => {
    const out = await formatThreadHistory({
      messages: [
        { text: "first", userId: "U1", ts: "1713484800.000" },
        { text: "second", botId: "B1", ts: "1713484860.000" },
        { text: "third", userId: "U2", ts: "1713484920.000" },
      ],
      botUserId: "UBOT",
      userCache: makeUserCache({ U1: "alice", U2: "bob" }),
    })
    const lines = out!.split("\n")
    const firstIdx = lines.findIndex((l) => l.includes("first"))
    const secondIdx = lines.findIndex((l) => l.includes("second"))
    const thirdIdx = lines.findIndex((l) => l.includes("third"))
    expect(firstIdx).toBeGreaterThan(-1)
    expect(secondIdx).toBeGreaterThan(firstIdx)
    expect(thirdIdx).toBeGreaterThan(secondIdx)
  })
})
