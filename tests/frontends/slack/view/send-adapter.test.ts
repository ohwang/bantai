/**
 * Tests for `buildDefaultSendAdapter` — focuses on the identity-override
 * path (Gap 10): identity fields land on the wire for bots with
 * `chat:write.customize`, and for bots without the scope the adapter
 * retries once without the fields so the post still goes out.
 */

import { describe, expect, it } from "bun:test"
import type { App } from "@slack/bolt"
import { buildDefaultSendAdapter } from "../../../../src/frontends/slack/view/send-adapter"

interface PostCall {
  channel: string
  text: string
  thread_ts?: string
  username?: string
  icon_url?: string
  icon_emoji?: string
}

function makeStubApp(opts: {
  failFirstWith?: string
  throwNotOk?: boolean
} = {}): { app: App; posts: PostCall[] } {
  const posts: PostCall[] = []
  let n = 0
  const app = {
    client: {
      chat: {
        async postMessage(args: PostCall & { blocks?: unknown }) {
          n++
          if (n === 1 && opts.failFirstWith) {
            throw new Error(opts.failFirstWith)
          }
          posts.push({
            channel: args.channel,
            text: args.text,
            ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
            ...(args.username ? { username: args.username } : {}),
            ...(args.icon_url ? { icon_url: args.icon_url } : {}),
            ...(args.icon_emoji ? { icon_emoji: args.icon_emoji } : {}),
          })
          if (opts.throwNotOk) return { ok: false, error: "not_allowed_token_type" }
          return { ok: true, ts: `ts${n}`, channel: args.channel }
        },
      },
    },
  } as unknown as App
  return { app, posts }
}

describe("buildDefaultSendAdapter — identity override", () => {
  it("passes through username + icon_emoji when identity is supplied", async () => {
    const { app, posts } = makeStubApp()
    const adapter = buildDefaultSendAdapter(app)
    await adapter.postMessage({
      channel: "C1",
      text: "hi",
      threadTs: "100.0",
      identity: { username: "Reviewer", iconEmoji: ":robot_face:" },
    })
    expect(posts).toHaveLength(1)
    expect(posts[0]!.username).toBe("Reviewer")
    expect(posts[0]!.icon_emoji).toBe(":robot_face:")
    expect(posts[0]!.thread_ts).toBe("100.0")
  })

  it("passes icon_url in addition to username when supplied", async () => {
    const { app, posts } = makeStubApp()
    const adapter = buildDefaultSendAdapter(app)
    await adapter.postMessage({
      channel: "C1",
      text: "hi",
      identity: { username: "Refactor-bot", iconUrl: "https://example.com/icon.png" },
    })
    expect(posts[0]!.username).toBe("Refactor-bot")
    expect(posts[0]!.icon_url).toBe("https://example.com/icon.png")
    expect(posts[0]!.icon_emoji).toBeUndefined()
  })

  it("omits identity fields entirely when identity is undefined", async () => {
    const { app, posts } = makeStubApp()
    const adapter = buildDefaultSendAdapter(app)
    await adapter.postMessage({ channel: "C1", text: "hi" })
    expect(posts[0]!.username).toBeUndefined()
    expect(posts[0]!.icon_url).toBeUndefined()
    expect(posts[0]!.icon_emoji).toBeUndefined()
  })

  it("retries without identity when the bot lacks chat:write.customize", async () => {
    // First call throws `not_allowed_token_type` (Slack's response when
    // the token can't set identity); adapter retries once without the
    // identity fields.
    const { app, posts } = makeStubApp({ failFirstWith: "not_allowed_token_type" })
    const adapter = buildDefaultSendAdapter(app)
    const res = await adapter.postMessage({
      channel: "C1",
      text: "hi",
      identity: { username: "Reviewer" },
    })
    // Only the retry landed — and it carried no identity fields.
    expect(posts).toHaveLength(1)
    expect(posts[0]!.username).toBeUndefined()
    expect(res.ts).toBe("ts2")
  })

  it("re-throws non-scope errors instead of retrying", async () => {
    const { app } = makeStubApp({ failFirstWith: "rate_limited" })
    const adapter = buildDefaultSendAdapter(app)
    await expect(
      adapter.postMessage({
        channel: "C1",
        text: "hi",
        identity: { username: "Reviewer" },
      }),
    ).rejects.toThrow(/rate_limited/)
  })

  it("doesn't retry when no identity was present in the first place", async () => {
    // If the call didn't carry identity, a `not_allowed_token_type` error
    // is a real error (not our fault) — don't swallow it.
    const { app } = makeStubApp({ failFirstWith: "not_allowed_token_type" })
    const adapter = buildDefaultSendAdapter(app)
    await expect(
      adapter.postMessage({ channel: "C1", text: "hi" }),
    ).rejects.toThrow(/not_allowed_token_type/)
  })
})
