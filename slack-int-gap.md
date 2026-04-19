# Slack Integration — OpenClaw Gap Audit & Port Plan

## Purpose

Running doc tracking everywhere bantai's Slack frontend reinvented a wheel that OpenClaw already polished. OpenClaw (MIT) has a mature, battle-tested Slack plugin with ~120 source files, >30 test files, and years of production use. We should be porting from it wherever feasible instead of shipping our own half-baked versions.

**Goal:** resolve every gap below by either (a) direct code port with attribution, (b) vendoring the relevant OpenClaw SDK module, or (c) an explicit "we intentionally won't do this" note with reasoning.

**Not in scope:** capabilities OpenClaw doesn't have (e.g. the ACP backend, TUI-specific rendering, multi-frontend agent protocol). Those remain bantai-original.

## Reference codebases

- **bantai (this repo):** `src/frontends/slack/`
- **OpenClaw Slack plugin:** `/Users/odin/dev/repos/repos-agent-slack-integration/openclaw/extensions/slack/src/`
- **OpenClaw plugin SDK (utilities used by the plugin):** `/Users/odin/dev/repos/repos-agent-slack-integration/openclaw/src/plugin-sdk/`
- **OpenClaw Slack docs:** `/Users/odin/dev/repos/repos-agent-slack-integration/openclaw/docs/channels/slack.md`
- **OpenClaw high-level report:** `/Users/odin/dev/repos/repos-agent-slack-integration/report-openclaw.md`
- **License:** MIT (`openclaw/package.json`). Ports must retain the copyright notice and credit OpenClaw in the file header.

## Status legend

- `[ ]` not started
- `[~]` in progress / partial
- `[x]` done
- `[-]` intentionally skipped (with reason)

---

## Gap summary (priority-ordered)

| # | Gap | Priority | Status | Owner |
|---|---|---|---|---|
| 1 | Markdown → mrkdwn chunker uses IR-based splitter | P0 | `[~]` | — |
| 2 | Implicit thread mention via bot-participation cache | P0 | `[x]` | — |
| 3 | Interactive-reply DSL (`[[slack_buttons:…]]` / `[[slack_select:…]]`) | P0 | `[x]` | — |
| 4 | Native Slack streaming (`chat.startStream` / `appendStream` / `stopStream`) | P1 | `[x]` † | — |
| 5 | Block-kit size-limit fallback (truncate + drop blocks if over cap) | P1 | `[x]` | — |
| 6 | Inbound debouncer + app_mention vs message race handling | P1 | `[x]` | — |
| 7 | Sender-name + channel-name resolution cache | P2 | `[x]` | — |
| 8 | Thread-status "is typing…" (`assistant.threads.setStatus`) | P2 | `[x]` † | needs live-workspace validation |
| 9 | Inbound interaction payload sanitiser + compaction | P2 | `[x]` | — |
| 10 | Outbound identity override (`chat:write.customize`) | P2 | `[x]` † | needs live-workspace scope check |
| 11 | SSRF-guarded inbound file fetch | P2 | `[x]` | — |
| 12 | Socket-mode reconnect backoff + auth-error fast-fail | P2 | `[x]` | — |
| 13 | `thread.inheritParent` / configurable history scope | P3 | `[-]` | intentionally deferred |

---

## 1. Markdown → mrkdwn chunker

**P0. Direct port with vendored SDK helpers.**

### Current state (bantai)

`src/frontends/slack/view/format.ts:1-243`. Hand-rolled tokeniser. 243 lines. Splits around fences with a regex, placeholder-tokenises inline code and bold, regex-rewrites links/headings/lists, paragraph-aware chunker falls back to `hardSplit`. No table rendering. No blockquote escaping. Angle-bracket tokens (`<@U…>`, `<#C…|name>`, autolinks) are not preserved explicitly — a naive `markdownToSlackMrkdwn` over user-generated text will mangle them.

### OpenClaw approach

`openclaw/extensions/slack/src/format.ts:1-158` (only 158 lines because it delegates). Two-stage pipeline:

1. `markdownToIR(markdown, { headingStyle: "bold", blockquotePrefix: "> ", tableMode })` — CommonMark → IR (`openclaw/src/plugin-sdk/text-runtime/*`).
2. `renderMarkdownIRChunksWithinLimit({ ir, limit, renderChunk, measureRendered })` — emits `<= limit`-length rendered chunks, never tearing a code fence, table row, or list entry.

Also has `escapeSlackMrkdwnText` / `escapeSlackMrkdwnContent` that preserve allowed angle-bracket tokens (`<@…>`, `<#…>`, `<!…>`, `<mailto:…>`, `<tel:…>`, `<http…>`, `<slack://…>`) while HTML-escaping everything else — see `format.ts:15-60`. This is what keeps user mentions / channel links / autolinks from breaking when the bot echoes inbound text.

Dependencies live in `openclaw/src/plugin-sdk/text-runtime/`:
- `markdownToIR` + types (`MarkdownLinkSpan`, IR node types)
- `renderMarkdownWithMarkers`
- `renderMarkdownIRChunksWithinLimit`

### Why it matters

- **Table support.** We currently render markdown tables as raw pipes; OpenClaw's IR converts them to aligned mrkdwn.
- **Link safety.** Inbound user messages with `<@U123>` survive round-tripping through the renderer. Ours would HTML-escape them.
- **Chunk boundaries that respect block structure** — ours bisects paragraphs when they're oversized; OpenClaw also respects list-item, blockquote, and heading boundaries.
- **Less code to own.** 243 lines of hand-rolled regex → ~158 lines of thin glue + a vetted IR library.

### Port plan

- [ ] Vendor `openclaw/src/plugin-sdk/text-runtime/` into `src/vendor/openclaw-text-runtime/` (preserve MIT header + attribution). Keep only: `markdown-to-ir.ts`, `render-markdown.ts`, `chunk-within-limit.ts`, and their direct type deps.
- [ ] Rewrite `src/frontends/slack/view/format.ts` to use the vendored IR pipeline. Keep the existing `markdownToSlackMrkdwnChunks(input, { maxLen })` public signature so `view/outbox.ts` + `view/blocks/*` don't need to change.
- [ ] Port `escapeSlackMrkdwnContent` with the allowed-token allowlist verbatim.
- [ ] Port the tests from `openclaw/extensions/slack/src/format.test.ts` that cover: table rendering, blockquote prefix, preserved angle tokens, code-fence atomicity, oversized-fence splitting.
- [ ] Delete `convertNonCode`, `splitAroundCodeFences`, `hardSplit`, `splitFence` from our format.ts.

### Acceptance

- `bun test tests/frontends/slack/format.*` passes against ported test cases.
- A 40KB markdown document with tables + nested fences + mentions round-trips through `markdownToSlackMrkdwnChunks` with: zero torn fences, all `<@U…>` tokens preserved literally, every chunk `<= 2900` chars.

---

## 2. Implicit thread mention via bot-participation cache

**P0. Direct port. Small, self-contained.**

### Current state (bantai)

`src/frontends/slack/inbox/gate.ts:56-57`:

```ts
if (ctx.autoJoinThreads && ctx.threadTs && ctx.threadHasActiveSession) {
  return { accept: true, reason: "thread-auto-join" }
}
```

We auto-join a thread only if there's already a live `SessionEntry` in memory. **On process restart, all thread bindings are lost** and every user has to re-`@bantai` in every thread they were previously talking to us in. This is a major UX footgun — the bot silently stops responding and users can't tell why.

### OpenClaw approach

`openclaw/extensions/slack/src/sent-thread-cache.ts` (51 lines total):

```ts
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 5000;
const threadParticipation = resolveGlobalDedupeCache(SLACK_THREAD_PARTICIPATION_KEY, { ttlMs, maxSize });

export function recordSlackThreadParticipation(accountId, channelId, threadTs): void
export function hasSlackThreadParticipation(accountId, channelId, threadTs): boolean
export function clearSlackThreadParticipationCache(): void
```

A tiny LRU+TTL cache keyed on `accountId:channelId:threadTs`. Every time the bot **posts** in a thread, `recordSlackThreadParticipation` is called. The inbound gate then checks `hasSlackThreadParticipation` in addition to the live-session check. Survives session eviction, survives overlapping users in the same thread, bounded memory.

OpenClaw additionally persists this across process restarts because their session store holds thread session keys (`prepare.ts:263-322`), but the in-memory cache alone already solves the common case.

### Why it matters

- Without this, users experience silent drops every time bantai restarts. On our own dogfood channels that's already a daily annoyance.
- `thread.requireExplicitMention: true` in OpenClaw disables the implicit path — we should mirror that as a per-channel override.

### Port plan

- [ ] Create `src/frontends/slack/inbox/thread-participation.ts` mirroring `sent-thread-cache.ts`. Drop the `resolveGlobalDedupeCache` indirection — use a local `Map<string, number>` with TTL sweeps. Keyed on `${workspace}:${channel}:${threadTs}`.
- [ ] Call `recordThreadParticipation` in `view/event-renderer.ts` after every successful `postMessage` / `updateMessage` (draft seed + final send + tool card + plan + approval).
- [ ] In `inbox/gate.ts`, extend the auto-join branch:
  ```ts
  const hasBotHistory = threadTs && threadParticipation.has(workspace, channel, threadTs)
  if (ctx.autoJoinThreads && ctx.threadTs && (ctx.threadHasActiveSession || hasBotHistory)) { … }
  ```
- [ ] Add per-channel `thread_require_explicit_mention: boolean` to `src/frontends/slack/config/schema.ts` (optional, default `false`). Gate both branches on it.
- [ ] Consider persisting the cache to `~/.bantai/slack-threads.json` on shutdown. Defer to a follow-up if the in-memory version proves enough.

### Acceptance

- Restart bantai with a thread that had a bot reply in the last 24h → first user message in that thread (no `@bantai`) is still picked up.
- `thread_require_explicit_mention: true` on a channel → the same scenario falls through to the `no-mention-in-channel` reject path.
- Cache bounded: after 10k distinct thread IDs, size stays `<= 5000` with oldest evicted.

---

## 3. Interactive-reply DSL (`[[slack_buttons:…]]` / `[[slack_select:…]]`)

**P0. Direct port. High product value.**

### Current state (bantai)

Not implemented. Agents cannot author interactive buttons / selects. Block Kit is used only for approval prompts, elicitations, tool cards, plans, thinking — all renderer-authored. Users asking "ship or hold?" get text, not buttons.

### OpenClaw approach

`openclaw/extensions/slack/src/interactive-replies.ts` (284 lines). A tiny DSL that parses the agent's outbound text for directives:

```
Ship or hold?

[[slack_buttons: Ship:ship:primary, Hold:hold, Abort:abort:danger]]
```

becomes a Block Kit `actions` block with three buttons. Format:
- `[[slack_buttons: Label:value[:style], …]]` — up to 5 items, styles `primary | secondary | success | danger`.
- `[[slack_select: Placeholder | Option1:value1, Option2:value2, …]]` — up to 100 items.
- Bonus: `parseSlackOptionsLine` — trailing "Options: a, b, c." auto-promoted to a select when ≤12 simple options. See `interactive-replies.ts:232-284`.

Click round-trip: `registerSlackInteractionEvents` catches `block_actions` with action IDs prefixed `openclaw:reply_button:` / `openclaw:reply_select:` → synthesises a pseudo-user message with the clicked value and re-dispatches through the inbound path. See `events/interactions.ts:178-220` + `interactive-dispatch.ts`.

Capability gating via `channels.slack.capabilities.interactiveReplies: true` in config.

### Why it matters

- Agents can request structured input without a modal. For confirm/deny, ship/hold, pick-an-env, this is the ergonomic surface on Slack.
- Falls back to plain text on other channels — so an agent prompt can remain portable; we don't have other channels yet but it doesn't cost us anything.

### Port plan

- [ ] Port `interactive-replies.ts` to `src/frontends/slack/view/interactive-replies.ts`. Strip the `ReplyPayload.channelData.slack.blocks` fast-exit check — we don't have that payload shape; substitute a simple "blocks already present" guard.
- [ ] Port `blocks-render.ts` block compiler (`buildSlackInteractiveBlocks`): `{type:"buttons", buttons:[…]}` / `{type:"select", options:[…]}` → `KnownBlock[]` with `actions` elements and action IDs prefixed `bantai:reply_button:<n>:<m>` / `bantai:reply_select:<n>`. Reuse the `resolveSlackButtonStyle` helper (`blocks-render.ts:22-32`) that maps `success → primary` and drops `secondary`.
- [ ] In `view/event-renderer.ts`, after `text_complete`, run the final text through `compileSlackInteractiveReplies` before the tier-2 final `chat.update`. If directives found, replace `text` with the cleaned text and attach `blocks`.
- [ ] In `transport/events.ts` (or wherever we handle `block_actions`), detect the new action-ID prefixes, synthesise an inbound text turn with the clicked `value`, and re-dispatch through the normal inbox.
- [ ] Add `defaults.interactive_replies: boolean` (default `true`) + per-channel override to the slack config schema.
- [ ] Port the test from `interactive-replies.test.ts` (Options-line auto-select, button style parsing, size-limit truncation).

### Acceptance

- An agent reply containing `[[slack_buttons: Ship:ship:primary, Hold:hold]]` renders as two buttons; clicking "Ship" feeds a new turn with text `ship`.
- An agent reply ending with `Options: canary, production, rollback.` auto-promotes to a select.
- Reply with a broken directive (`[[slack_buttons: ]]`) falls back to plain text, no crash.
- `interactive_replies: false` on a channel → directives are stripped from text but no blocks emitted.

---

## 4. Native Slack streaming

**P1. Port the `streaming.ts` wrapper; wire as tier-1 in the outbox.**

### Current state (bantai)

`src/frontends/slack/view/outbox.ts` implements tier-2 (draft `postMessage` → throttled `chat.update`) + tier-3 (chunked buffered send). The file header (`outbox.ts:17-21`) is explicit:

> Tier 1 (`chat.startStream`) is plan §6's native path — minislack doesn't implement it yet, and real Slack only exposes it on paid workspaces with the Assistant API. Adding it is a drop-in for the `SendAdapter` interface below; deferred to a later phase.

The hook is literally in place. We just haven't wired tier-1.

### OpenClaw approach

`openclaw/extensions/slack/src/streaming.ts:1-154`. Thin wrapper over `WebClient.chatStream()`:

```ts
const streamer = client.chatStream({ channel, thread_ts, recipient_team_id, recipient_user_id });
await streamer.append({ markdown_text: text });
await streamer.stop({ markdown_text: finalText });
```

Three functions: `startSlackStream`, `appendSlackStream`, `stopSlackStream`. `SlackStreamSession` tracks `{ streamer, channel, threadTs, stopped }`. Slack's Assistant API streams word-by-word with no throttling on our side — the SDK handles it.

Prereqs captured by the types (`streaming.ts:33-51`): requires `thread_ts`; `teamId` needed for `chat.stopStream`; `userId` required for DM streaming (else `missing_recipient_user_id`).

### Why it matters

- Assistant/AI-App UX in Slack lights up — users see the bot "typing" with live token stream, not batch updates.
- Fewer `chat.update` calls → fewer rate-limit hits on chatty channels.
- Gated on thread target, which we always have for mention-bound sessions.

### Port plan

- [ ] Copy `streaming.ts` → `src/frontends/slack/view/native-stream.ts`, swap `logVerbose` → `log.debug`.
- [ ] Extend `SendAdapter` in `outbox.ts` with optional `streaming?: { start, append, stop }` methods. Keep existing methods unchanged.
- [ ] In `createOutboundStream`, prefer tier-1 when (a) adapter exposes streaming methods, (b) `threadTs` is set, (c) channel config has `native_streaming: true`. Fall back to tier-2 on any throw mid-stream (mirror OpenClaw `dispatch.ts:557-567`).
- [ ] Wire `teamId` from startup `auth.test` (we already call it in `transport/bolt.ts`) into the adapter.
- [ ] Add `defaults.native_streaming: boolean` (default `false` — opt-in until we've tested it against paid workspaces) + per-channel override.
- [ ] Port the fallback-on-throw logic: if `appendSlackStream` raises, mark stream stopped, post accumulator via tier-2 or tier-3, continue the turn.

### Acceptance

- With `native_streaming: true` on a thread-bound channel, a multi-sentence agent reply renders as a single stream message with word-by-word updates.
- Streaming failure mid-reply → tier-2 takes over, no duplicated or torn message.
- DM-to-bot with `native_streaming: true` uses `recipient_user_id` correctly; no `missing_recipient_user_id` errors.

---

## 5. Block Kit size-limit fallback

**P1. Small port.**

### Current state (bantai)

Block builders in `view/blocks/*.ts` return `{ text, blocks }` unconditionally. No check against Slack's hard limits (50 blocks per message; 3000-char text-section; 75-char button labels; 150-char action-id). A tool card with a huge arg string or a plan with 60 entries will either error at send time or render truncated by Slack's server-side enforcement (which sometimes drops the whole message).

### OpenClaw approach

`openclaw/extensions/slack/src/blocks-fallback.ts` (85 lines). When the compiled block payload exceeds Slack's limits, falls back to a plain-text reply (emits `text` only, no `blocks`). See also `blocks-input.ts` (validation) and `truncate.ts` (mrkdwn-safe truncation primitive that respects code fences).

### Port plan

- [ ] Port `truncate.ts` → `src/frontends/slack/view/blocks/truncate.ts`. Exports `truncateSlackMrkdwn(text, maxChars)` that trims to a safe boundary and adds `…`.
- [ ] Port `blocks-fallback.ts` → `src/frontends/slack/view/blocks/fallback.ts`. Exports `withBlockKitFallback({ text, blocks })` that returns `{ text: fallbackText }` when blocks are over-limit.
- [ ] Use it in every block builder return path and in `event-renderer.ts` before each `postMessage` / `updateMessage`.
- [ ] Apply `truncateSlackMrkdwn` inside tool-card arg rendering (currently `truncate(arg, MAX_ONE_LINER_ARG)` at `blocks/tool-card.ts`) so we don't tear code fences in fenced args.

### Acceptance

- A tool card for a `Bash` invocation with a 50KB argument renders as a plain-text fallback, no Slack API error.
- Truncated mrkdwn never leaves a dangling `\`\`\`` fence or unbalanced `*`.

---

## 6. Inbound debouncer + app_mention ↔ message race

**P1. Partial today; port the race handler.**

### Current state (bantai)

`src/frontends/slack/inbox/dedup.ts` (52 lines): plain TTL map keyed `channel:ts`. No debouncer — every message is dispatched immediately, so a user typing three lines in quick succession gets three agent turns. `transport/events.ts` handles `message` + `app_mention` separately; **there's no de-dup of the same ts arriving on both paths** (DM + channel — though we may accidentally be safe because Bolt filters DMs before app_mention; need to verify).

### OpenClaw approach

`openclaw/extensions/slack/src/monitor/message-handler.ts:97-276`. Two-layer protection:

1. **Per-thread debouncer** via `createChannelInboundDebouncer` (SDK) with key builder:
   ```ts
   buildSlackDebounceKey(message, accountId) →
     `slack:<acc>:<channel>:<thread_ts or ts>:<sender>`
   ```
   (`message-handler.ts:78-95`). Rapid-fire messages in the same thread merge into one turn, preserving each ts for logging.

2. **app_mention retry race handler** (`message-handler.ts:197-227`). Slack sometimes sends both `message` and `app_mention` for the same ts; the handler maintains two in-memory maps (`appMentionDispatchedKeys`, `appMentionRetryKeys`) with 60s TTL. If `app_mention` wins first, drop the later `message` dispatch; if `message` drops silently (no mention detected), allow exactly one `app_mention` retry.

Also: `channel-inbound` SDK has built-in `shouldDebounceTextInbound` that gates debouncing by message shape (no debounce on media-only or command messages). See `openclaw/src/plugin-sdk/channel-inbound/`.

### Port plan

- [ ] Port the SDK debouncer (`openclaw/src/plugin-sdk/channel-inbound/*`) into `src/vendor/openclaw-channel-inbound/` or reimplement the 80-line `createChannelInboundDebouncer` + `shouldDebounceTextInbound` in bantai directly. It's small enough that reimplementing may be cleaner than vendoring the SDK.
- [ ] Rewrite `inbox/turn-builder.ts` to funnel through the debouncer before calling `SessionHost.send`. Key builder mirrors `buildSlackDebounceKey`.
- [ ] Port the app_mention race handler verbatim (two maps + TTL sweep + retry-allowance logic). These lines (`message-handler.ts:197-254`) have comments calling out past regressions — worth copying the comments too.
- [ ] Add `defaults.debounce_ms: number` (default `1500`) + per-channel override.
- [ ] Port the test file `message-handler.app-mention-race.test.ts` (230 lines — validates the race paths).

### Acceptance

- Three rapid messages in a thread → one combined agent turn with all three ts preserved in the turn metadata.
- Simultaneous `message` + `app_mention` events for the same ts → exactly one dispatch.
- Media-only (file upload, no text) inbound is not debounced.

---

## 7. Sender-name + channel-name resolution cache

**P2. Shipped.**

### Current state (bantai)

`src/frontends/slack/view/user-cache.ts` now covers users **and** channels with TTL + LRU eviction. The existing user-display-name path is unchanged for callers; channel-name lookup is new and exposed via `userCache.channelName(channelId)` for future consumers (e.g. enrichment of the `!bantai settings` dump when a channel isn't declared in config).

Approval / elicitation surfaces still render resolvers as `<@Uxxx>` — that's deliberate: Slack's client renders native user mentions as `@display-name` for us without a round-trip to `users.info`. The cache is for surfaces that can't rely on Slack's native rendering (plain-text inbox prefixes, audit logs).

### OpenClaw approach

`dispatch.ts:192-204` resolves names via `users.info` / `conversations.info` with an in-memory cache. Also `send.ts:32-200` has an LRU `slackDmChannelCache` for `conversations.open` results (user id → DM channel id) so we don't re-open DMs on every outbound.

### Port plan

- [x] Extended `user-cache.ts` with TTL (default 15 min) + maxSize (default 1000) + oldest-first eviction; each lookup bumps the entry for LRU recency.
- [x] Added `channelName(channelId)` lazy lookup via `conversations.info` with in-flight coalescing (same as users). DMs + named-less groups return undefined, not the id — callers decide how to display.
- [x] Added `seedChannel()` / `size()` test hooks so unit tests can simulate state without mocking Bolt.
- [ ] Bounded DM-open cache keyed `token:userId → channelId` — deferred; bantai doesn't open DMs outbound today. Re-open this bullet when DM delivery lands.
- [ ] Wire `channelName()` into `!bantai settings` fallback when `project.channelName` is unset — trivial follow-up, low priority because operators typically declare channels in slack.json.

### Acceptance

- `userCache.displayName(...)` still returns the resolved display name and caches on first hit (existing behaviour preserved).
- A 1000-entry cap evicts oldest; a 15-minute TTL refetches on next lookup (`tests/frontends/slack/view/user-cache.test.ts`).
- `channelName("C1")` returns the channel's name, caches, coalesces concurrent lookups.

---

## 8. Thread-status "is typing…"

**P2. Shipped. Plumbing proven with unit tests; real assistant-thread channel still needs live validation.**

### OpenClaw approach

`assistant.threads.setStatus` via `ctx.setSlackThreadStatus` (`dispatch.ts:341-369`). Shows "is typing…" / "running {tool}" banner inside the Slack assistant-thread UI while a turn runs.

### Port plan

- [x] `view/thread-status.ts`: `nextThreadStatus(event)` mapper + `createThreadStatusController({ adapter, channel, threadTs })` — debounces transitions, dedupes unchanged states, auto-clears on terminate().
- [x] Gate on channel capability via **graceful self-disable**: on the first error that matches `method_not_supported_for_channel_type` / `channel_not_found` / `missing_scope` / `not_allowed_token_type` / `invalid_arguments`, the controller flips itself off for the session and logs once. No per-event error spam in regular channels.
- [x] `event-renderer` drives the thread-status controller side-by-side with the reactions state machine — same lifecycle, different API surface. `endTurn()` always calls `terminate()` so crashed / interrupted turns don't leave a stale "thinking…" banner.
- [x] Launcher wraps `app.client.assistant.threads.setStatus` into the `ThreadStatusAdapter` shape and threads it through `RoutingCtx`. `assistant:write` scope is inferred from the error-driven self-disable — installs without the scope still boot and just skip the banner.

### Acceptance

- Transitions are posted via the adapter with the correct status strings (`tests/frontends/slack/view/thread-status.test.ts` — "posts transitions through the adapter").
- Regular (non-assistant) channels self-disable on first error (same file — "disables itself on…").
- Crashed / timed-out turns clear the banner via `terminate()` (same file — "clears the banner after a live session").

### Live validation (requires real workspace)

- [ ] Install the app with the AI-apps / Assistant API capability enabled, open an assistant thread, send a message that triggers a multi-tool turn, verify the "thinking…" / "running Bash…" banner tracks turn progress and clears on completion.
- [ ] Send the same message in a regular public channel, verify no errors and no banner (self-disable path).

---

## 9. Inbound interaction payload sanitiser

**P2. Shipped as defensive library. Consumer wiring deferred — see below.**

### OpenClaw approach

`events/interactions.ts:15-152`. All `block_actions` / `view_submission` / `view_closed` payloads are compressed into a structured `Slack interaction: {json}` system event for the agent. Sanitisation:
- Truncate strings to 160 chars
- Truncate arrays to 64 items
- **Redact** `triggerId`, `responseUrl`, `workflowTriggerUrl`, `privateMetadata`, `viewHash` (these are short-lived secrets / PII)
- Compact mode when payload > 2400 chars

### Why it matters

- Agents can react to button clicks, modal submissions, date-picker selections without us hand-writing a handler per surface.
- Redaction prevents leaked `response_url`s (which can be used to post as the bot for up to 30 min).

### Port plan

- [x] `transport/interaction-sanitizer.ts`: `sanitizeSlackInteractionPayload(payload, opts?)` + `renderSlackInteractionMessage(payload)` — recursive redact of the short-lived credential keys, string truncation (maxStringLen=160), array truncation (maxArrayLen=64), depth-limited walk (MAX_DEPTH=8), compact fallback when the serialised payload exceeds 2400 chars.
- [x] Redact list: `trigger_id`, `response_url`, `response_urls`, `workflow_trigger_url`, `private_metadata`, `view_hash` / `viewHash` / `hash`, `bot_access_token`, `app_installed_team`. Caller-overridable via `opts.redactKeys`.
- [x] Test coverage: redaction (shallow + deeply nested), string/array truncation + overflow markers, compact-form trigger, primitives passthrough, depth-limit cycle safety.
- [ ] **Consumer wiring deferred.** Bantai's current block_action / view_submission handlers route to purpose-built coordinators (approvals, elicitations, interactive-replies) — none forward raw payloads to the agent as text today, so nothing leaks. The sanitiser is ready for the future \"forward unknown interactions to the agent\" path; plumb it in alongside the feature that needs it. Future consumers should call `renderSlackInteractionMessage(body)` rather than JSON.stringify'ing `body` directly.

### Acceptance

- A payload containing `trigger_id` / `response_url` / `private_metadata` — even in deeply nested positions — comes out with each of those fields replaced by `"[redacted]"` (`tests/frontends/slack/transport/interaction-sanitizer.test.ts` — "redacts trigger_id / response_url / private_metadata").
- A modal submission with 50 input blocks × 200-char values over the 2400-char budget is compact-formed down to `{ type, callback_id, actions, view.state.values, user.id, channel.id, _compacted: true }` (same file — "compact-forms when serialised payload exceeds compactBudget").

---

## 10. Outbound identity override

**P2. Small port. Shipped. Identity plumbing proven with unit tests; real `chat:write.customize` round-trip still needs a live workspace (see "Live validation" below).**

### OpenClaw approach

`send.ts:100-143` — uses `chat:write.customize` scope to post under per-agent `username` + `icon_url` / `icon_emoji`. Best-effort retry drops custom identity if scope missing.

### Port plan

- [x] Add `agent_username`, `agent_icon_url`, `agent_icon_emoji` to per-channel config schema + `defaults` block (`config/schema.ts`).
- [x] Resolve into `ProjectConfig.agentIdentity` with field-by-field override precedence (`router/resolver.ts`).
- [x] Thread identity into the outbox (`view/outbox.ts` — draft, tier-3 chunked, native block-kit follow-up) and wrap the renderer's `SendAdapter` so every tool card, thinking / plan breakout, error inline, cost + budget notice rides with the same identity (`view/event-renderer.ts`).
- [x] Forward to `chat.postMessage` in `view/send-adapter.ts` as `username` / `icon_url` / `icon_emoji`.
- [x] Retry-without-customize on `not_allowed_token_type` / `missing_scope` / `invalid_arguments` — one warn per process.

### Acceptance

- `agent_icon_emoji: ":robot_face:"` on a channel → the bot posts with that emoji, not the default workspace icon.
- Missing scope → posts still land, with default identity, warn-log once.

### Live validation (requires real workspace)

- [ ] On a workspace where the bot token has `chat:write.customize`, set `agent_username: "Reviewer"` + `agent_icon_emoji: ":robot_face:"` on a channel and confirm posts (stream, tool cards, approvals, elicitations, cost footer) render with the override.
- [ ] Remove the scope, restart, confirm posts still land with the default identity + exactly one "falling back to default workspace identity" warning in the session log.

---

## 11. SSRF-guarded inbound file fetch

**P2. Small port. Shipped.**

### OpenClaw approach

`send.ts:28-30` — `fetch` to Slack-hosted URLs is locked to the allowlist `*.slack.com, *.slack-edge.com, *.slack-files.com`. Blocks exfil + redirect attacks via user-uploaded file metadata.

### Port plan

- [x] Added `DEFAULT_ALLOWED_HOST_SUFFIXES = [".slack.com", ".slack-edge.com", ".slack-files.com"]` + `isAllowedHost()` gate in `inbox/attachments.ts`. Every `url_private` / `url_private_download` is checked before the authenticated `fetch` that would attach the bot token.
- [x] Exposed `extraAllowedHosts` + `disableSsrfGuard` opts so minislack tests (and the `rewriteUrl` redirect) can loop back to localhost without opening the production path.
- [x] Launcher auto-extends `extraAllowedHosts` with the host portion of `slackApiUrl` when it's configured — minislack self-hosts work out of the box, real Slack keeps the lockdown.
- [x] Blocked URLs short-circuit with a `log.warn("blocked by SSRF guard")` so operators see why a file didn't land.

### Acceptance

- A crafted file with `url_private` pointing at `http://169.254.169.254/…` is rejected before fetch (`tests/frontends/slack/inbox/attachments.test.ts` — "SSRF guard blocks non-Slack hosts").
- `*.slack.com` round-trips unchanged (same file — "SSRF guard accepts *.slack.com by default").

---

## 12. Socket-mode reconnect backoff

**P2. Shipped.**

### OpenClaw approach

`monitor/provider.ts:581-659`. Exponential backoff on socket disconnect; fast-fail on non-recoverable auth errors (invalid token → exit, don't reconnect-loop). Reconnect policy pluggable (`reconnect-policy.ts`).

### Port plan

- [x] Reconnect backoff is Bolt's default — `@slack/bolt` + its embedded `@slack/socket-mode` client already exponential-backoff on socket disconnects and retry transient web API errors via `retryPolicies.tenRetriesInAboutThirtyMinutes` (already in `transport/bolt.ts`).
- [x] Fast-fail guard: added `attachFatalAuthGuard(app, { onFatal })` in `transport/bolt.ts`. Hooks `app.error()` and detects the fatal auth codes (`invalid_auth`, `not_authed`, `account_inactive`, `token_revoked`, `token_expired`) across every shape Slack clients surface them in (`data.error`, `original.data.error`, `code`, `message`). Launcher passes `onFatal: () => process.exit(1)` after a beat so the error log flushes; tests that construct the launcher with `returnHandle: true` skip the exit so integration harnesses own shutdown.
- [x] Non-fatal errors rethrow so Bolt's default logging + reconnect stay intact — missing-scope, rate-limited, and network blips are transient and shouldn't kill the process.

### Acceptance

- Revoking the bot token mid-run surfaces a clear fatal error (`slack: non-recoverable auth error — token is invalid / revoked / deactivated. Refusing to reconnect-loop; shutting down.`) and exits with code 1 (`tests/frontends/slack/transport/fatal-auth-guard.test.ts`).
- Transient errors (`rate_limited`, `ECONNRESET`, `missing_scope`) do NOT fire the fatal path — Bolt's existing handling kicks in.

### Live validation (requires real workspace)

- [ ] Install the app, start bantai, revoke the token from Slack admin, confirm the process exits with code 1 rather than looping.
- [ ] Temporarily block network egress to slack.com, confirm bantai keeps retrying (no fatal exit).

---

## 13. `thread.inheritParent` / configurable history scope

**P3. Intentionally deferred — design decision not to port yet.**

### OpenClaw approach

Docs `slack.md:690-698`. `thread.inheritParent` (default false) controls whether a thread session inherits the channel's main session transcript. `thread.historyScope` (default `"thread"`) controls whether channel history is visible to the thread agent.

Bantai currently hard-codes thread-only history (session-per-thread). Some users may want "thread inherits channel context" — e.g. for a support bot where prior channel discussion matters.

### Decision

**Skip for now.** Rationale:

- The session-per-thread isolation is load-bearing for bantai's model: each agent sees a clean context, no cross-thread leakage, simple cost + context accounting. Weakening that invariant touches the session registry, the reducer, persistence (SQLite schema stores thread-scoped state), and every backend adapter.
- The two use cases that justify inheritance in OpenClaw — support-bot reading prior channel discussion, AI-apps "continue this conversation" — don't have demand signal on bantai today. If a user needs them, reopen this entry with the concrete workflow.
- OpenClaw's implementation is conditional history injection at turn-build time, not a structural change to session identity. If we port this later, the shape is: `project.threadHistoryScope: "thread" | "channel-plus-thread"` + a history-injector in the inbox turn-builder. No schema migration needed.

### Reopen when

- A user files an issue requesting channel-inherited thread context, with a concrete scenario (e.g., "my support bot needs the last N messages of the channel as prologue").
- Or: we ship a multi-agent workflow where one agent's channel-level context needs to bleed into a child thread session.

Until then, the current thread-isolated behaviour is the intentional default and this gap stays `[-]`.

---

## Tracking

### Running log

- `2026-04-19` — Doc created. Gaps 1-13 enumerated based on side-by-side audit of bantai `src/frontends/slack/` vs. openclaw `extensions/slack/`. Top-3 priorities (markdown IR, thread-participation cache, interactive DSL) identified as highest ROI.
- `2026-04-19` — Gaps 1-12 shipped. Gap 13 deferred as a design decision (see §13). Gaps marked `[x] †` need live-workspace validation before defaults flip on: §4 (native streaming / `chat.startStream`), §8 (assistant-thread status banner), §10 (per-agent `chat:write.customize` identity). Full test suite: 477 pass, 0 fail across 50 slack test files.

### Notes for contributors

- When porting a file, keep the OpenClaw copyright header + add a "Ported from OpenClaw `<path>` (commit `<sha>`)" line. Their license is MIT — attribution is the only requirement.
- Prefer **vendoring SDK modules** (`src/vendor/openclaw-*`) over reaching into the openclaw repo at build time. We do not want a cross-repo build dependency.
- When a port adds a new config option, document it inline in `.bantai/slack.json` so dogfooding defaults stay readable.
- Each port should land with its OpenClaw test file ported too. Their test suite is the best documentation of edge cases we don't yet know about.
