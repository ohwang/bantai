# Slack outbound: `text` vs `markdownText`

This is the deeper dive behind the **"agent reply bodies go through
`markdownText`, not `text`"** rule in `AGENTS.md` (§ Slack frontend). Read
that rule first; this document explains the why and the failure modes.

## The rule, restated

`OutboundPostArgs` / `OutboundUpdateArgs` are a **discriminated union** — a
single send carries EITHER Slack mrkdwn (`text`) or raw GitHub-flavoured
markdown (`markdownText`), never both. Sending both fails with
`markdown_text_conflict` from Slack.

| Surface | Field | Why |
|---|---|---|
| Agent reply bodies (long markdown — tables, fenced code, headers, task lists) | `markdownText` | Slack's `markdown_text` wire field renders GFM natively. 12k-char limit. |
| Short system copy (banners, approval prompts, elicitation prompts, config-reload notices) | `text` | Keeps `<@U…>`, `<!date^…>`, `<#C…>` Slack affordances rendering correctly. 3k-char limit. |

## Why two paths exist

Slack supports two rendering modes for message text:

- **mrkdwn** (`text:` field): Slack's own dialect. Renders `<@U…>` user
  mentions, `<#C…>` channel links, `<!date^…>` time tokens, etc. Does **not**
  render GitHub-flavoured tables, fenced code with language hints, headers, or
  task lists.
- **markdown_text** (`markdownText:` field): Newer Slack feature. Renders GFM
  natively. Does **not** post-process Slack tokens — `<@U…>` shows up as
  literal text.

Agent replies are GFM (the SDK emits markdown). Short system copy uses Slack
affordances. So we need both; we just can't mix them in a single payload.

## Where the rule is enforced

- **`view/outbox.ts`** sends `markdownText` for agent reply bodies. This is
  the only place that should choose between the two paths for streaming
  output.
- **`view/send-adapter.ts`** is the discriminated-union normaliser. When
  `blocks` are attached alongside `markdownText`, it prepends a leading
  `{ type: "markdown" }` block so a single payload carries both the rich body
  and the interactive actions.
- **`view/format.ts`** still owns mrkdwn conversion for the short-copy path
  (banners, approvals, elicitations, reload notices). Its
  `markdownToSlackMrkdwn`, `markdownToSlackMrkdwnChunks`, and
  `normalizeSlackOutboundText` are now `@deprecated` for agent reply bodies —
  they exist for system copy only.
- **`view/markdown-chunk.ts → chunkRawMarkdown`** is the fence-safe chunker
  for raw GFM. It closes and reopens triple-backtick fences across chunk
  boundaries so a code block split across two Slack messages still renders
  correctly.

## Failure modes that motivated the rule

- **`markdown_text_conflict`**: send a payload with both `text` and
  `markdownText`. Slack rejects it. Originally happened when a code path that
  wanted to add a small mention to an existing reply set `text` directly.
- **3k-char truncation on long agent output**: the original code path used
  `text:` everywhere, hit the 3k Slack mrkdwn cap mid-table, and posted half
  a row. Switching agent bodies to `markdownText` raised the cap to 12k and
  fixed the rendering.
- **GFM tables rendered as ASCII**: mrkdwn doesn't recognise pipe tables.
  Agent output that included a table got converted to an ugly ASCII grid by
  `markdownToSlackMrkdwn`. `markdownText` lets Slack render the table
  natively.

## Never call `chat.postMessage` directly from view code

Always go through `view/outbox.ts` or `view/send-adapter.ts`. Direct calls
bypass message tracking, edit-vs-append logic, and the text-vs-markdown_text
choice — that's how we accidentally re-introduce the conflict.

## See also

- `AGENTS.md` § Slack frontend — the one-line rule.
- `src/frontends/slack/view/outbox.ts` — owner of the agent-body send path.
- `src/frontends/slack/view/send-adapter.ts` — discriminated-union
  normaliser; the place that adds the `{ type: "markdown" }` leading block
  when `blocks` accompany a `markdownText` payload.
- `src/frontends/slack/view/markdown-chunk.ts` — `chunkRawMarkdown` for
  fence-safe splitting across the 12k boundary.
