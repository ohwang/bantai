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
  text?: string
  markdown_text?: string
  thread_ts?: string
  username?: string
  icon_url?: string
  icon_emoji?: string
  blocks?: unknown[]
}

interface UpdateCall {
  channel: string
  ts: string
  text?: string
  markdown_text?: string
  blocks?: unknown[]
}

function makeStubApp(opts: {
  failFirstWith?: string
  throwNotOk?: boolean
} = {}): { app: App; posts: PostCall[]; updates: UpdateCall[] } {
  const posts: PostCall[] = []
  const updates: UpdateCall[] = []
  let n = 0
  const app = {
    client: {
      chat: {
        async postMessage(args: PostCall) {
          n++
          if (n === 1 && opts.failFirstWith) {
            throw new Error(opts.failFirstWith)
          }
          posts.push({
            channel: args.channel,
            ...(args.text !== undefined ? { text: args.text } : {}),
            ...(args.markdown_text !== undefined ? { markdown_text: args.markdown_text } : {}),
            ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
            ...(args.username ? { username: args.username } : {}),
            ...(args.icon_url ? { icon_url: args.icon_url } : {}),
            ...(args.icon_emoji ? { icon_emoji: args.icon_emoji } : {}),
            ...(args.blocks ? { blocks: args.blocks } : {}),
          })
          if (opts.throwNotOk) return { ok: false, error: "not_allowed_token_type" }
          return { ok: true, ts: `ts${n}`, channel: args.channel }
        },
        async update(args: UpdateCall) {
          updates.push({
            channel: args.channel,
            ts: args.ts,
            ...(args.text !== undefined ? { text: args.text } : {}),
            ...(args.markdown_text !== undefined ? { markdown_text: args.markdown_text } : {}),
            ...(args.blocks ? { blocks: args.blocks } : {}),
          })
          return { ok: true }
        },
      },
    },
  } as unknown as App
  return { app, posts, updates }
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

describe("buildDefaultSendAdapter — markdown_text wire mapping", () => {
  // Locks in the text ↔ markdown_text split documented in
  // send-adapter.ts's module docstring. Slack rejects sends that carry
  // both fields (`markdown_text_conflict`), so the adapter must pick one
  // per call. The body of an agent reply goes through `markdownText`
  // so GFM tables / fences / task lists render natively.

  it("sends markdown_text as top-level arg when no blocks are attached", async () => {
    const { app, posts } = makeStubApp()
    const adapter = buildDefaultSendAdapter(app)
    const body = [
      "| col a | col b |",
      "| --- | --- |",
      "| 1 | 2 |",
    ].join("\n")
    await adapter.postMessage({
      channel: "C1",
      markdownText: body,
    })
    expect(posts).toHaveLength(1)
    expect(posts[0]!.markdown_text).toBe(body)
    // No `text` field — Slack rejects the combination.
    expect(posts[0]!.text).toBeUndefined()
  })

  it("wraps markdownText in a leading MarkdownBlock when blocks are supplied", async () => {
    const { app, posts } = makeStubApp()
    const adapter = buildDefaultSendAdapter(app)
    const body = "# Heading\n\nSome *markdown* body."
    await adapter.postMessage({
      channel: "C1",
      markdownText: body,
      blocks: [
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Go" },
              action_id: "go",
            },
          ],
        },
      ],
    })
    expect(posts).toHaveLength(1)
    const p = posts[0]!
    // markdown_text must NOT appear on the wire when blocks are present —
    // Slack only accepts top-level markdown_text when there are no blocks.
    expect(p.markdown_text).toBeUndefined()
    // Instead the body rides in the first block as a MarkdownBlock.
    expect(Array.isArray(p.blocks)).toBe(true)
    const firstBlock = (p.blocks as Array<{ type: string; text?: string }>)[0]!
    expect(firstBlock.type).toBe("markdown")
    expect(firstBlock.text).toBe(body)
    // And `text` carries a short notification preview (not the full body).
    expect(typeof p.text).toBe("string")
    expect(p.text!.length).toBeLessThanOrEqual(100)
    expect(p.text!.length).toBeGreaterThan(0)
  })

  it("preserves markdown_text identity (no mrkdwn conversion)", async () => {
    // Regression guard: previously we ran agent text through the mrkdwn
    // converter, which turned `**bold**` into `*bold*` and destroyed
    // tables. On the markdown_text path the body must arrive byte-for-byte.
    const { app, posts } = makeStubApp()
    const adapter = buildDefaultSendAdapter(app)
    const body = "**bold**, _italic_, and `code` with a [link](https://example.com)"
    await adapter.postMessage({ channel: "C1", markdownText: body })
    expect(posts[0]!.markdown_text).toBe(body)
  })

  it("update path also uses markdown_text when markdownText is supplied", async () => {
    const { app, updates } = makeStubApp()
    const adapter = buildDefaultSendAdapter(app)
    await adapter.updateMessage({
      channel: "C1",
      ts: "123.456",
      markdownText: "updated **body**",
    })
    expect(updates).toHaveLength(1)
    expect(updates[0]!.markdown_text).toBe("updated **body**")
    expect(updates[0]!.text).toBeUndefined()
  })

  it("text path (mrkdwn) continues to send `text` top-level (banners, approvals)", async () => {
    // Short mrkdwn strings (banners, approvals, elicitation copy) stay
    // on the `text` path so they can use Slack's mrkdwn affordances
    // like `<@U…>` mentions and `<!date^…>` formatting.
    const { app, posts } = makeStubApp()
    const adapter = buildDefaultSendAdapter(app)
    await adapter.postMessage({
      channel: "C1",
      text: "Hello <@U123>, your approval is requested.",
    })
    expect(posts[0]!.text).toBe("Hello <@U123>, your approval is requested.")
    expect(posts[0]!.markdown_text).toBeUndefined()
  })
})
