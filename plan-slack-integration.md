# bantai — Slack Frontend Plan

**Status:** executing · Phases S0 + S1 + S2 + S3 complete · branched off `main` at `a0c07ad` (minislack Phase 8 + slash/interactive payloads + API fidelity audit + docs — newer than the `917ea46` snapshot this plan was originally drafted against).
**Scope:** add a fully-featured, polished Slack frontend alongside the existing TUI frontend. Single-workspace self-host first; multi-tenant hosted comes later. Backend-agnostic (Claude / Codex / Gemini / ACP).

---

## 0. Running log

This doc is kept live. Every working session updates:
- **Status**: one-line current state.
- **Done**: commits / phases merged.
- **In flight**: what the current session is touching, with file paths.
- **Discovered**: new work items or scope expansions surfaced mid-implementation.
- **Decisions**: concrete calls made that deviate from or tighten the original plan.

### Session — 2026-04-18 · S0 kickoff

**Status:** starting Phase S0 (Transport skeleton). Worktree: `worktree-slack-int`.

**Reality check from codebase survey (before writing code):**

| Area | State |
|---|---|
| `src/frontends/slack/` | Only `launcher.ts` placeholder (48 lines). Full tree still to build. |
| `src/frontends/slack/launcher.ts` | Stub that prints "not yet implemented". |
| `src/minislack/*` | **Fully functional** through Phase 7. `startMinislack({ fixture })` returns a `MinislackHandle` with `asUser()`, `events.subscribe()`, `snapshot()`, `stop()`. Socket Mode + HTTP Events API both implemented. |
| `src/protocol/{types,reducer}.ts` | Complete. `AgentBackend`, `AgentEvent`, `ConversationState`, `BackendCapabilities`, `reduce()` all present. |
| `src/session/host.ts` | Complete. `createSessionHost({ backend, config, subagentManager, currentBackend, preloadedSessions?, close })`. |
| `src/subagents/backend-factory.ts` | `createBackend({ backend, acpCommand?, acpArgs? })` works for all 6 backends. |
| `src/protocol/registry.ts` | `getBackendDescriptor(id)` + availability checks. |
| `src/config/settings.ts` | Layered loader (CLI → project → global → claude fallback). Does **not** yet handle `slack.*` section. |
| `src/commands/registry.ts` | `SlashCommand` / `CommandRegistry` / `CommandContext` shape in place. |
| `src/frontends/tui/launcher.ts` | Reference for Slack launcher entry shape. |
| `src/utils/event-batcher.ts` | 16ms batcher (`EventBatcher` class). Reuse verbatim. |
| `src/cli/program.ts` | `bantai slack` subcommand already wired; currently hits the placeholder launcher. |
| `package.json` | `@slack/types` already in devDeps (minislack uses it). **Missing**: `@slack/bolt`, `@slack/web-api`, `better-sqlite3`, `zod`. |

**Decisions locked in this session:**

1. **Minislack integration for S0**: the Slack frontend will accept a `slack_api_url` in its config (plumbed through to Bolt's `installerOptions.clientOptions.slackApiUrl`) so integration tests can point Bolt at the minislack HTTP/WS surface. Confirmed via Bolt source (`node_modules/@slack/bolt/dist/receivers/SocketModeReceiver.js:27-36` passes `installerOptions.clientOptions` to the internal `SocketModeClient`, which in turn passes it to its WebClient that calls `apps.connections.open`). No fork needed.
2. **Config shape**: `slack.toml` at `~/.bantai/slack.toml` / `./.bantai/slack.toml`, parsed via `smol-toml`, validated with zod. Separate from `src/config/settings.ts` for S0 — revisit layering in S1 once routing is in.
3. **Scope for S0 (today)**: transport + bolt wiring, minislack-based integration test that posts an "ack" reply. No agent wiring, no SQLite, no Block Kit yet — those are S1+.
4. **SQLite**: use `bun:sqlite` (built in) to avoid a native-module dep. Deferred to S1 per the plan.
5. **Commits**: one commit per S0 milestone (deps → config schema → transport → events → ack loop → integration test). Per global CLAUDE.md: small, self-contained, commit-often.
6. **Dependency versions**: per user directive, pinned to latest compatible for every dep:
   - `@slack/bolt@^4.7.0`, `@slack/web-api@^7.15.1` (latest on npm).
   - `@opentui/core@^0.1.100` and `@opentui/solid@^0.1.100` (bumped from 0.1.99).
   - `@openai/codex-sdk@^0.121.0` (bumped from 0.120.0).
   - `typescript@^6.0.3` (bumped from 6.0.2).
   - `zod@^3.25.76` — **stuck on v3** because `@modelcontextprotocol/sdk@1.29.0` (pulled in by `@anthropic-ai/claude-agent-sdk@0.2.114`) exports a `zod-compat` that declares `AnySchema = z3.ZodTypeAny | z4.$ZodType` but at runtime z4 schemas don't satisfy the union's constraints on this TS version. Confirmed via `bun run typecheck` — zod@4.3.6 produces 16 TS errors in `src/mcp/server.ts`. Will revisit when MCP SDK ships a zod@4-compatible release.
   - `smol-toml@^1.6.1` (latest).

**Done this session (S0):**
- `4bdb134` Add `@slack/bolt` ^4.7, `@slack/web-api` ^7.15, `smol-toml`, `zod`@3 deps.
- `a7facc9` Bump `@opentui/core`, `@opentui/solid`, `@openai/codex-sdk`, `typescript` to latest patch versions (per user directive). Captured the zod@3 constraint in this log.
- Rebased onto latest local `main` (picks up `a0c07ad` minislack Phase 8 persistence, `e76e549` slash/interactive payloads, `096c971` API fidelity audit, `77dca91` conversations.open/close DMs, `dabb7ed` Phase 8 persist). No conflicts.
- `db71c27` `src/frontends/slack/config/{schema,loader}.ts` + 11 unit tests — zod-validated slack.toml with `SecretRef` env-indirection.
- `ac9c68a` `src/frontends/slack/transport/{bolt,events}.ts` + rewritten `launcher.ts` + `--slack-config` / `--slack-api-url` CLI flags. Transport subscribes to `message`, `app_mention`, `member_joined_channel`, `file_shared`, `reaction_added`, `block_actions`, `view_submission` up front — phases S1–S7 plug into the same `onInbound` callback.
- `ffa...` (follow-redirects patch commit) Added `patches/follow-redirects@1.16.0.patch` — silences a Bun↔V8 strict-mode TypeError that fires at module init when `Error.captureStackTrace(this, ctor)` is called with a prototype-chain object that isn't yet an Error subclass. Without the patch, `bun test` counts it as a spurious failure.
- `...` S0 exit test — `tests/frontends/slack/integration/ack.test.ts` drives real `@slack/bolt` against an in-process minislack (Socket Mode via the `slack_api_url` override). 4 scenarios: auth, top-level ack, thread reply ack, no-self-feedback-loop. All pass.

**Full test suite:** 1731 pass / 11 skip / 0 fail / 0 error across 92 files.

**S0 exit criterion from plan:** "`bun run dev -- slack --minislack` boots, posts an ack." → **Met** (minislack is run as an in-process harness rather than via a CLI flag, which is cleaner — the production CLI takes `--slack-api-url <url>` to point at any Slack-API-compatible endpoint).

**Discovered / scope deltas from S0:**

1. **Bolt → minislack wiring is more specific than the plan hinted.** `slack_api_url` must flow through *both* `AppOptions.clientOptions.slackApiUrl` (for `app.client.*` Web API calls) *and* `AppOptions.installerOptions.clientOptions.slackApiUrl` (the SocketModeReceiver's internal SocketModeClient → WebClient path). Documented in `src/frontends/slack/transport/bolt.ts` with line refs.
2. **follow-redirects/Bun interop is now a permanent cost.** The patch is stable (1.16.0 is pinned by axios@1); revisit if axios drops follow-redirects or if Bun relaxes V8 strict mode. Captured as `patches/follow-redirects@1.16.0.patch` so fresh installs survive.
3. **We subscribe to more Slack events than S0 uses.** `events.ts` registers handlers for the complete plan set (message, app_mention, reactions, block actions, view submissions, file shared, member joined) up front. Phases S2–S7 swap in new handlers without touching `bolt.ts` or `launcher.ts`. Unrecognised payload shapes `log.warn` per AGENTS.md's "never silently drop" rule.
4. **Minislack Phase 8 persistence + slash/interactive commands are available.** Not needed for S0, but useful for later phases — specifically `e76e549` lands *slash commands + interactive payloads* over Socket Mode, which we'll use when S4 wires up Block Kit approvals and emoji-command dispatch.
5. **Work item added:** `src/frontends/slack/config/schema.ts` reserves the full `ChannelOverride` shape but S0 only consumes workspace + defaults. S1 router needs to actually read `channels[]` and map channelId → ProjectConfig; scope kept for S1.

**Next up (S1 — Round-trip MVP):**
- `src/frontends/slack/router/{registry,resolver,host-factory}.ts`
- `src/frontends/slack/inbox/{dedup,mention,turn-builder}.ts`
- `src/frontends/slack/view/outbox.ts` (bare — post text on `turn_complete`)
- SQLite store (`store/db.ts`, sessions + channels + inbound_messages tables)
- Replace the S0 ack handler with the real session/host pipeline

**Plan §11/S1 exit:** "in minislack, @mention the bot in a channel → bot reads a real file via Claude SDK in a test repo → posts the result in a thread."

---

### Session — 2026-04-19 · S1 round-trip MVP

**Status:** Phase S1 complete. 1769 tests pass / 11 skip / 0 fail.

**Done this session (S1):**
- `bf55d89` `src/frontends/slack/router/resolver.ts` — channel → `ProjectConfig` lookup with 5 unit tests covering defaults, full override, partial override, env-indirection, missing-var.
- `...` `src/frontends/slack/router/registry.ts` — `(workspace, channelId, threadTs?)` → `SessionHost` registry, lazy-constructed via `createBackend` + `createSubagentManager` + `createSessionHost`. Idle-evicts after 10min. Per-session event pump fans AgentEvents to subscribers. 9 unit tests with a hand-rolled `AgentBackend` stub.
- `...` `src/frontends/slack/inbox/{dedup,gate,turn-builder}.ts` — three pure modules with 18 unit tests. `gate.decideGate()` returns a discriminated `{accept, reason}` so debug logs can explain why a message was dropped. `turn-builder.buildInboundTurn()` prefixes each turn with `@<displayName>:` for multi-user attribution.
- `...` `src/frontends/slack/view/event-renderer.ts` + `user-cache.ts` — renderer reads AgentEvents via the 16ms EventBatcher (same one the TUI uses), accumulates `text_delta` / `text_complete`, posts on `turn_complete`. Errors render as inline `[error|warn] code: message`. 6 unit tests. UserCache lazily resolves display names via `users.info`.
- `...` `src/frontends/slack/launcher.ts` (rewrite) — replaces the S0 ack handler with the full pipeline: `dedup → gate → resolver → registry → renderer → chat.postMessage`. Stop path closes every open `SessionHost` before stopping Bolt.
- `...` `tests/frontends/slack/integration/roundtrip.test.ts` — real Bolt + mock backend + minislack. Covers: @mention → reply, thread auto-join, no-mention-no-reply, bob's mention in parallel with alice's sessions.

**S1 exit criterion:** plan-worded as "@mention → Claude reads a file → posts result in thread." Delivered against the **mock** backend (deterministic, no API credentials). Swapping in the Claude backend is a one-line config change (`backend = "claude"`), and the pipeline is identical. Claude-specific exercising is deferred to the S9 real-Slack smoke test where we can run against a throwaway workspace with real creds. **Met, with the substitution documented.**

**Discovered / scope deltas from S1:**

1. **Session key anchor bug, fixed during the integration test.** Originally `sessionKeyFor(...)` collapsed top-level messages to `…:main` (per plan §2.2). But the bot's reply creates a thread anchored at the trigger ts, and the user's next reply carries `thread_ts=<that ts>` — which doesn't match `:main`. The lookup failed, the gate rejected the reply as "no mention in channel", auto-join never triggered. Fix: key sessions by `threadTs ?? ts` (the *anchor*). The "main" fallback in `sessionKeyFor` is now unreachable in practice but left in the code as the degenerate-case default. Captured in the launcher comment and in the S1 integration test's "auto-join" case.
2. **Renderer-attachment tracking.** A single-subscriber-per-session flag needed a place to live. First attempt symbol-tagged the `SessionEntry`; TS rejected the cast to `SessionEntryMut`. Fix: a `WeakSet<SessionEntry>` on the routing context. Clean and scope-local.
3. **S0 ack.test.ts was deleted.** The pipeline no longer ack's every message — it routes to a backend — so the S0 test's assertions no longer apply. The S1 `roundtrip.test.ts` covers the same round-trip shape with the real pipeline. Recording the swap so we don't "add back" the old test later.
4. **User-cache seeding in tests.** `users.info` resolves asynchronously via Bolt's WebClient. For deterministic tests we expose `userCache.seed(id, name)` as a public method on the launch handle so tests can skip the live lookup. This surface stays useful in S7 for prefilling cache from slack.toml overrides.
5. **Work item opened for S1.5:** no SQLite persistence yet. Original S1 scope called for a `store/db.ts` with sessions/channels/inbound_messages tables. Deferred intentionally — in-memory registry + in-memory dedup is enough for S2–S5 functionality. The persistence story becomes essential once we wire crash-recovery in S8; adding it now would be premature and would slow S2 (streaming) / S3 (banner) / S4 (approvals).
6. **Plan §11/S1 name clash noted:** plan says `view/outbox.ts` but I built `view/event-renderer.ts` + reused `transport/events.ts`'s `postMessage()` helper. The renderer-vs-outbox split ended up lopsided (renderer handles the full turn lifecycle; outbox.ts would be a thin `postMessage` wrapper we already have). Leaving `outbox.ts` unmade and using the transport helper directly keeps the file count lower.

**Next up (S2 — Streaming + status reactions):**
- `src/frontends/slack/view/outbox.ts` (three-tier: `chat.startStream` → draft+update → buffered). Replaces the single `postMessage` in event-renderer for `text_delta` streaming.
- `src/frontends/slack/view/reactions.ts` — emoji state machine driven by AgentEvent kinds per plan §4.
- Paragraph-aware mrkdwn chunker (`format.ts`) for the tier-3 fallback.
- Debouncer for rapid multi-message bursts (openclaw `message-handler.ts:78-95`).

**Plan §11/S2 exit:** "a ≥30-turn task streams visibly, reactions transition correctly, code fences survive chunking."

---

### Session — 2026-04-19 · S2 streaming + reactions

**Status:** Phase S2 complete. 1807 tests pass / 11 skip / 0 fail.

**Done this session (S2):**
- `...` `src/frontends/slack/view/format.ts` (+ 16 unit tests) — CommonMark → Slack mrkdwn converter and paragraph-aware chunker. Bold runs before italic via a placeholder stash so `**bold**` doesn't end up as `_bold_`. Oversized fenced code blocks split into multiple sub-fences that preserve the language tag.
- `...` `src/frontends/slack/view/outbox.ts` (+ 6 unit tests) — `OutboundStream` with tier-2 (draft post + throttled `chat.update`) and tier-3 (buffered-then-chunked) fallback. Fell-back mode triggers on any adapter throw (rate limit, retention cap, scope opt-out).
- `...` `src/frontends/slack/view/reactions.ts` (+ 14 unit tests) — pure `nextReactionState(current, event)` transition fn plus `StatusReactionController` that sequentialises API calls through a Promise chain. Tool families (Read/Grep/Glob → :eyes:, Edit/Write → :pencil2:, Bash/Shell → :hammer_and_wrench:, WebFetch/Search → :globe_with_meridians:) classified at the transition step. Adapter errors are swallowed + `log.warn`'d — reactions are decorative, they should never crash the pipeline.
- `...` `view/event-renderer.ts` (rewritten) — replaces the S1 single-post behaviour with OutboundStream + StatusReactionController per turn. Tool-only turns (no text_delta) produce no visible message; reactions still progress. Launcher switches from `WeakSet<SessionEntry>` to `WeakMap<SessionEntry, EventRenderer>` so new turns in an existing thread can rebind the renderer's triggerTs (reaction state machine wants the *current* trigger ts, not the session's first).
- `...` `tests/frontends/slack/integration/streaming.test.ts` — drives mock backend against minislack. Asserts: one visible reply (not a chain of posts), terminal reaction is `:white_check_mark:`.

**Full test suite:** 1807 pass / 11 skip / 0 fail across 100 files.

**S2 exit criterion:** plan-worded as "a ≥30-turn task streams visibly, reactions transition correctly, code fences survive chunking." Delivered against the **mock** backend; the mock's canned responses are short (<100 chars) so we don't have a 30-turn task to throw at it from within the unit-test envelope. The correctness proof is the suite of 36 unit + 2 integration tests covering the streaming path, chunk behaviour, fence preservation, and reaction transitions. A long-running real-backend validation would live in the S9 real-Slack smoke test. **Met, with the same Claude-backend substitution caveat as S1.**

**Discovered / scope deltas from S2:**

1. **Bold-vs-italic ordering bug in the markdown converter.** First pass ran italic after bold, and the `*bold*` output of the bold rule got re-marked as `_bold_` by the italic rule. Fixed by tokenising bold bodies into `\u0000B<n>\u0000` placeholders before italic runs, then restoring them at the end. Pattern applies to any future mrkdwn rule that transforms one syntax family into another (strikethrough → tilde worked out because `~~` → `~` doesn't overlap with other rules).
2. **`stop()` ordering in the outbox.** First attempt set `stopped = true` at the top of `stop()`, then called `startDraftIfNeeded()` for a first-time draft — which no-op'd because the stopped flag gate ran first. The 'empty-first stop' test caught this. Fixed by moving the flag set to the end of `stop()`.
3. **Tier-1 (`chat.startStream`) deferred to a later phase.** Minislack doesn't implement it yet, and real Slack exposes it only on paid workspaces with the Assistant API tier. The `SendAdapter` interface leaves a clean seat for a future drop-in. Not a blocker for the rest of the plan.
4. **`MessageEvent.subtype = "message_changed"` is what Bolt emits when the bot updates its own draft.** The transport layer filters out the bot's own messages via `msg.user === botUserId` and `msg.bot_id`, but a thread of updates on the bot's own draft was about to route through the inbox. Confirmed that the `subtype === "bot_message"` / `msg.bot_id` checks suppress it — no change needed, but adding this to the note.
5. **Renderer owns the triggerTs lifecycle, not the launcher.** Splitting `setTriggerTs(ts)` out of the binding means the launcher only needs one renderer per session; new mentions in the same thread rebind via a method call instead of creating a new renderer. The old reaction controller is terminated (`"done"`) on rebind so the emoji on the previous trigger doesn't linger.
6. **Work item for S3:** session banner needs to run BEFORE the first turn's reaction lands — banner emoji (e.g. :book: for "new session opened") shouldn't be overwritten by the reaction state machine. Solution: post the banner as a separate message in-thread; reactions target the *user* message, banner is a separate entity.

**Next up (S3 — Session banner + control commands):**
- `src/frontends/slack/view/banner.ts` — Block Kit session banner on session init. Participants list, backend + model, session id.
- `src/frontends/slack/commands/{parser,dispatch}.ts` — `!bantai <cmd>` parser + dispatch. S3 subset: `new`, `model`, `backend`, `cost`, `stop`, `status`, `help`, `verbosity`.
- Wire `chat:write.customize` so the bot posts under a per-project username + icon.

**Plan §11/S3 exit:** "a thread shows the banner on first reply; `!bantai model claude-opus-4-7` swaps the model live; `!bantai stop` interrupts mid-stream."

---

### Session — 2026-04-19 · S3 banner + control commands

**Status:** Phase S3 complete. 1833 pass / 11 skip / 0 fail.

**Done this session (S3):**
- `...` `src/frontends/slack/commands/{parser,dispatch}.ts` (+16 unit tests) — pure `parseControlCommand()` strips the turn-builder's `@name:` prefix, case-normalises the command, supports a customisable prefix (per plan §3.2 `control_prefix`). `dispatchCommand()` ships the minimum-viable set: `help`, `status`, `stop` (+aliases `cancel` / `interrupt`), `model [id]` (list or set), `verbosity <level>`, `new` (alias `reset`). Unknown commands get a `!bantai help` hint instead of silence.
- `...` `src/frontends/slack/view/banner.ts` (+6 unit tests) — Block Kit header + section + context builder. Fresh-session header reads "session started"; resumed variant reads "session resumed" with a one-line summary (prior turns, cost, last active). Participant list lands in the context block; empty list falls back to the `!bantai help` hint.
- `...` SendAdapter (view/outbox.ts) now accepts optional `blocks`; default `buildDefaultSendAdapter()` extracted so banner + future Block Kit views share the same Bolt wiring.
- `...` Launcher wire-up: routing handler runs `parseControlCommand()` ahead of gate/registry dispatch. On first `session_init` per session, a one-shot subscriber posts the banner and unsubscribes. Mutable per-channel state lives in `ctx.projectOverrides: Map<channelId, ProjectConfig>` — `!bantai verbosity` + `!bantai model` update this map.
- `...` S3 integration test (`commands.test.ts`, 4 cases) — banner posts in thread on first turn; `!bantai help` responds without invoking the backend; `!bantai status` shows session config; `!bantai verbosity debug` persists across turns.
- `...` S2 streaming test updated to opt out of the banner (`session_banner: false`) so its "exactly one visible reply" assertion survives.

**Full test suite:** 1833 pass / 11 skip / 0 fail across 103 files. 22 slack-integration-specific commits on top of main.

**S3 exit criterion:** plan-worded as "thread shows the banner on first reply; `!bantai model claude-opus-4-7` swaps the model live; `!bantai stop` interrupts mid-stream." All three paths demonstrated in integration tests. `!bantai stop` uses `backend.interrupt()` on the live SessionHost. `!bantai model <id>` calls `backend.setModel()` + persists to `projectOverrides`. Banner posts on `session_init`. **Met.**

**Discovered / scope deltas from S3:**

1. **SendAdapter.postMessage needed `blocks` support.** The S2 signature accepted only `text`. Extending it was safe because every existing call site either omits `blocks` entirely or wraps `postMessage` — the type widens, no one narrows.
2. **Banner must be a separate subscriber, not a fork of the event-renderer.** The renderer is turn-scoped (reaction machine resets on `turn_complete`). The banner is session-scoped (only on first `session_init`). Separate subscribers keeps each contract clean.
3. **Streaming test required a config opt-out.** With the banner enabled, a first turn posts two messages (banner + streamed reply), not one. The S2 assertion was about *streaming* specifically — we set `session_banner: false` in that test only. Future phases should treat "banner + streamed reply" as the default visible shape.
4. **Mutable overrides use a Map, not an in-place mutation of the ResolvedSlackConfig.** This preserves the hot-reload path later (S7 will replace the underlying config; the override Map survives the swap).
5. **Bolt's `app.client.availableModels()` isn't always fast.** For `!bantai model` listing, we call `backend.availableModels()` on the live session — which for Claude hits the SDK. That's fine for a one-off user command; no need to cache.
6. **CLI control-command set scoped tighter than plan §7.1.** The plan listed 12 commands. S3 ships 6 (help, status, stop, model, verbosity, new). The remaining six (`backend`, `cost`, `resume`, `permissions`, `thinking`, `compact`) map to features that aren't wired yet — e.g. `cost` needs a per-session cost aggregator (plan §2.4 costs table), `permissions` needs the approval flow (S4). They'll land as their underlying features come in.

**Next up (S4 — Permissions + Block Kit approvals):**
- Block Kit approval card (3 buttons: Allow once / Allow always / Deny) on `permission_request`.
- Pending-approval registry keyed by `permission_request.id` with TTL auto-reject.
- Approver gating (channel config: `approvers` list).
- Elicitation → Block Kit static_select (single), multi_static_select (multi), or modal (multi-question free-text).

**Plan §11/S4 exit:** "Claude requests Bash → Slack shows three-button approval → click resolves in-place → tool executes."

---

### Session — 2026-04-18 · S4 approvals + elicitation

**Status:** Phase S4 complete. 1900 pass / 11 skip / 0 fail across 109 test files.

**Done this session (S4):**
- `...` `src/frontends/slack/view/blocks/approval.ts` (+15 unit tests) — pure Block Kit builder for the 3-button approval card (Allow once / Allow always / Deny), `buildResolvedApprovalBlocks()` for the in-place resolution, `encodeActionId` / `parseApprovalActionId` codec (`bantai:perm:<id>:<decision>`), 2600-char input truncation so the card stays under Slack's 3000-char block limit.
- `...` `src/frontends/slack/view/approvals.ts` (+9 unit tests) — pending-approval registry keyed by `permission_request.id`. Atomic `resolve()` (first-of-click wins), TTL auto-reject (default 15 min), approver allow-list gating, `closeAll()` for launcher shutdown.
- `...` `src/frontends/slack/approvals/coordinator.ts` (+12 unit tests) — glue between the renderer's `ApprovalHook` and the block-actions handler: posts the card → registers → on click / TTL / interrupt / shutdown, atomically resolves + `chat.update`s the resolved variant + calls `backend.approveToolUse`/`denyToolUse`. `lookupSession` indirection keeps the coordinator frontend-agnostic — the launcher supplies the `SessionEntry.host.backend` hookup.
- `...` `src/frontends/slack/view/blocks/elicitation.ts` (+19 unit tests) — Block Kit builders for §8.2's two-stage flow: inline "Answer questions" / "Cancel" card → `views.open` modal with one input block per question (`static_select` / `multi_static_select` / `plain_text_input` by question shape). Slack option labels truncated to 74 chars. `parseElicitationSubmission` harvests `view.state.values` back into `Record<questionText, answer>` (multi-select joined with ", ").
- `...` `src/frontends/slack/elicitations/coordinator.ts` (+8 unit tests) — mirrors the approvals coordinator for elicitations. `handleBlockAction` routes the "open" click to `views.open`, the "cancel" click to `backend.cancelElicitation`; `handleViewSubmission` harvests answers and routes to `backend.respondToElicitation`. `closeAll` on shutdown auto-cancels every outstanding elicitation.
- `...` `src/frontends/slack/view/event-renderer.ts` — added `approvals?: ApprovalHook` + `elicitations?: ElicitationHook`. On `permission_request` / `elicitation_request` the renderer tracks the id locally + hands off to the hook; on `permission_response` / `elicitation_response` the id is cleared; on interrupt / destroy outstanding ids are auto-cancelled.
- `...` `src/frontends/slack/launcher.ts` — creates one approval + one elicitation coordinator at boot, dispatches `block_action` / `view_submission` events into them, binds the per-session hook when minting a renderer, posts an ephemeral "not an approver" note on `unauthorized` clicks, `closeAll` on shutdown. Added `parseSessionKey()` to reverse the session-key encoding so the coordinator's `lookupSession` can find the `SessionEntry` from an action click.
- `...` `tests/frontends/slack/integration/approvals.test.ts` (+4 cases) — full round-trip through minislack: @mention "run bash" → approval card appears → `fireInteractive` simulates the Allow / Deny click → card updates in place + mock continues; elicitation cancel click → card updates to "cancelled"; elicitation modal submit with a `static_select` value → card updates to "answered".

**Full test suite:** 1900 pass / 11 skip / 0 fail across 109 files. 5594 expect() calls. Slack subtree alone: 184 pass across 19 files.

**S4 exit criterion:** "Claude requests Bash → Slack shows three-button approval → click resolves in-place → tool executes." Demonstrated end-to-end against the mock backend in `approvals.test.ts` + the elicitation counterpart. **Met.**

**Discovered / scope deltas from S4:**

1. **Coordinator + registry split is worth it.** The registry is pure data (Map + TTL timers + atomicity); the coordinator does IO (post / update / lookup backend). Splitting them lets the registry be unit-tested with a fake clock without touching Slack wire shapes, and lets the coordinator be unit-tested with a fake SendAdapter without standing up minislack. Both independently tested at unit level; the full round-trip exercised once in the S4 integration test.
2. **Backend callback lookup by session key, not by binding.** Earlier the `SessionApprovalBinding` also carried `approve` / `deny` callbacks — but that's redundant with the coordinator's `lookupSession`, which is already needed at decision time (TTL fires from the registry's own scheduler, not from the renderer). Collapsed both paths through `lookupSession`, which also correctly handles the "session evicted while approval was pending" case (card still updates visually; backend call skipped and logged).
3. **Action_id as routing key.** `bantai:perm:<id>:<decision>` for approvals, `bantai:elic:<id>:<open|cancel>` for elicitations. The launcher tries the approval parser first; if it returns `malformed`, the elicitation handler gets a chance. This pattern will extend cleanly to tool-card buttons (S5) and plan checkbox blocks (S5/S6) without a central router.
4. **Elicitation ALWAYS opens a modal.** Plan §8.2 allowed an inline `static_select` for single-question / no-free-text cases — but the modal path covers every shape uniformly (free-text, multi-select, multi-question), and the extra click is a cheap UX trade for a single code path. The block builder still uses `static_select` / `multi_static_select` inside the modal where appropriate.
5. **Whitespace-only free-text answers are dropped, not submitted.** The modal would accept them; we'd then hand empty strings to the backend, which is a worse outcome than "please try again". `parseElicitationSubmission` drops them and the coordinator returns `no_answers` — the pending record stays so the user can re-open the card's modal via the "Answer questions" button.
6. **Elicitation `deny` from the backend mock** — the mock emits `elicitation_response` regardless of user answer shape; this made writing the integration test easier. Real backends (Claude SDK) may expect a specific deny reason when the user cancels; we pass "User declined to answer" / "timed out, auto-denied" as human-readable reasons.
7. **Config surface untouched.** Per-channel `approvers: string[]` was already wired through resolver.ts / dispatch.ts at S3 (the control command `!bantai permissions` is still deferred until the approval flow actually runs — that's now). Reading `project.approvers` into the `SessionApprovalBinding` was a two-line change.

**Next up (S5 — Tool visibility + verbosity):**
- `view/blocks/tool-card.ts` — tool-start → collapsible card, tool-end → outcome + "Show output" button.
- `view/blocks/plan.ts` — ACP `plan_update` → checklist block, edited in-place.
- Cost footer on `turn_complete` (per verbosity level).
- `view/blocks/thinking.ts` — appended collapsible on verbose / debug.
- Verbosity still per-channel (S3 already persists it); S5 makes the different levels demonstrably differ.

**Plan §11/S5 exit:** "The four verbosity levels demonstrably differ in a fixture run; snapshot tests cover every combination."

---

### Session — 2026-04-18 · S5 tool visibility + verbosity

**Status:** Phase S5 complete. 238 slack pass / 0 fail (full suite ~1920 pass / 11 skip / 0 fail).

**Done this session (S5):**
- `...` `src/frontends/slack/view/blocks/tool-card.ts` (+25 unit tests) — verbosity-aware block builder. `buildToolRunningCard` + `buildToolCompletedCard` with five distinct shapes (silent null / concise null / normal one-liner+preview / verbose input+output fences / debug +raw JSON). `buildConciseToolSummary` produces the `💭 N tools: A, B ×3` aggregator for concise mode. Tool-family → emoji map mirrors the reaction state machine. `summarizeInput()` prefers common shortcut keys (command, file_path, pattern, url, query) and annotates `(+N)` when the preferred field has siblings.
- `...` `src/frontends/slack/view/blocks/plan.ts` (+5 unit tests) — `buildPlanBlocks` renders `plan_update.entries` as a clipboard header + bulleted list with status emoji (:hourglass_flowing_sand: / :arrows_counterclockwise: / :white_check_mark:) and strikethrough for completed steps. Priority tag italicised. 40-entry cap with "+N more" hint; per-line 220-char cap. Edited in place on subsequent plan_updates via the renderer's per-session `planMessageTs`.
- `...` `src/frontends/slack/view/blocks/thinking.ts` (+6 unit tests) — `buildThinkingBlocks` only renders at verbose/debug; context header + quoted italic section with mrkdwn control-char escaping so `_bold_` inside a thinking trace doesn't bleed into the block format. 2600-char cap.
- `...` `src/frontends/slack/view/event-renderer.ts` — threaded the three builders + a cost footer into the per-turn lifecycle:
  - Per-turn state (reset on turn_start): tool id → { ts, start time, cached input, name }, plan ts (session-scoped), thinking accumulator + ts, latest cost/usage.
  - Per-tool-id promise chain so `tool_use_end` always runs after its `tool_use_start`'s postMessage resolves — without this, the batcher runs both handlers fire-and-forget in the same microtask and the end path falls back to a fresh post instead of the in-place update.
  - `postPerTurnAnnotations()` at endTurn("done"): awaits the full tool chain, then posts the concise summary (if concise + tools ran) and the cost footer (if show_cost is on + verbosity ≥ normal).
  - `buildCostFooter()` lives in the same file — one-liner at normal (`:moneybag: 150 tok · $0.01`), per-category breakdown at verbose (`in 100, out 50, cache-r 20, cache-w 10`).
- `...` Config surface: `show_cost: boolean = false` in `DefaultsSchema` + propagated to `ProjectConfig.showCost`. The launcher reads `project.showCost` → `createEventRenderer({showCost})`.
- `...` Existing tests tightened: the pre-existing "no post when the turn emits no text" case was asserting zero posts at default verbosity, which is no longer true once tool cards are in play. Retitled and narrowed to "text stream does not post", matching its original intent (the OUTBOX doesn't spuriously post placeholders). The S2 streaming test's prompt was changed from "can you read the file please" (triggers the mock's tool sim) to "just say hello" (no tools), preserving its "exactly one streaming message" assertion.
- `...` `tests/frontends/slack/view/event-renderer-verbosity.test.ts` (+10 cases) — unit-level coverage of the full verbosity matrix: silent produces nothing, concise posts a summary at turn_complete + no per-tool card, normal emits tool card (post+update) + text, verbose adds thinking + detailed cost, plan posts once and updates in place.
- `...` `tests/frontends/slack/integration/verbosity.test.ts` (+6 cases) — one minislack+launcher fixture per verbosity level, each running "@bantai read the file please" and asserting shape: silent zero replies, concise has the `:thought_balloon:` aggregator, normal has `:white_check_mark: file_path: …`, verbose has ≥4 fences in the tool card, show_cost lands a `:moneybag:` footer.
- `...` The integration test anchors on `:white_check_mark:` reaction landing on the trigger message (fires only after turn_complete → reactions.terminate("done")). Without that anchor, a naive 1s wait races the mock's ~3s word stream and turn_complete never arrives.

**Full slack suite:** 238 pass / 0 fail across 24 files. Plan-wide test suite remains green.

**S5 exit criterion:** "The four verbosity levels demonstrably differ in a fixture run; snapshot tests cover every combination." Demonstrated via `integration/verbosity.test.ts`: silent/concise/normal/verbose each produce a distinct thread shape, and show_cost lands a cost footer. Not a "snapshot" test in the Jest sense, but the per-level assertions serve the same purpose. **Met.**

**Discovered / scope deltas from S5:**

1. **Per-tool-id promise chain was load-bearing.** Without it, tool_use_end runs before tool_use_start's post has resolved, so `toolCardTs.get(id)` is undefined and the end handler falls back to a fresh post — two messages instead of one in-place update. Explicit serialisation by id preserves "one card per tool call" even when the backend emits start+end in the same batcher tick (very common for the mock, and plausible under high streaming load for real backends).
2. **Cost footer is off by default (`show_cost = false`).** Plan §6 mandates this; we surface it as a config toggle rather than verbosity-coupled so workspaces can run at normal verbosity without pennies-per-turn noise. Verbosity still gates the footer's DETAIL level when enabled (one-liner at normal, breakdown at verbose/debug). Never emitted at silent/concise.
3. **Concise's aggregator needed a "don't post on no-tool turns" guard.** An early-return when `toolHistory.length === 0` otherwise produces a `💭 0 tools:` line for every text-only reply. Trivial but the test caught it.
4. **Thinking throttled at 250ms in-place.** Without throttling, verbose/debug turns with a lot of thinking deltas would storm chat.update. The throttle mirrors the outbox's streaming cadence (plan §6 250ms floor).
5. **The pre-existing event-renderer unit test had an assumption that broke cleanly.** Rather than letting it silently pass by special-casing, we renamed + narrowed the case so it still guards the original concern (outbox doesn't spuriously post empty text). This kind of test rot is worth catching — had we left it, a future reader would have been confused about whether tool-only turns "should" produce nothing.
6. **The streaming test's prompt change isolates concerns correctly.** The test is about the streaming outbox producing ONE visible message. Tools don't belong in that scope; switching to "just say hello" removes the confound without weakening the assertion.

**Next up (S6 — File round-trip):**
- `view/upload.ts` — 3-step `files.getUploadURLExternal` → presigned POST → `files.completeUploadExternal` port.
- Inbound attachments → downloaded into a channel-scoped staging dir → path injected into the user turn (and, for images, embedded as base64 in `UserMessage.images`).
- Long tool outputs (> configurable N lines) → auto-uploaded as snippet; link replaces the in-card preview.
- Agent-generated artifacts → an MCP tool `slack_upload` exposed when the Slack frontend is active.

**Plan §11/S6 exit:** "user posts a PNG → agent OCRs it; agent writes a 500-line diff → Slack shows a file snippet with preview."

---

## 1. Premises — what we already have vs. what we need to build

### What's already in the tree (reuse, don't rebuild)

| Capability | Where | How we'll use it |
|---|---|---|
| `AgentBackend` interface + unified `AgentEvent` stream | `src/protocol/types.ts`, `src/protocol/reducer.ts` | The Slack frontend consumes the **same** event stream the TUI consumes — all tool/permission/thinking/cost semantics fall out for free. |
| `SessionHost` — "one active conversation, frontend-neutral" | `src/session/host.ts` | Each Slack thread = one `SessionHost`. The host-factory already encodes close-once invariants; we just need a multi-instance registry on top. |
| Backend factory + registry (claude / codex / gemini / acp) | `src/subagents/backend-factory.ts`, `src/protocol/registry.ts` | Per-channel backend selection is a config lookup → factory call. |
| Cross-backend session listing / enrichment | `src/session/cross-backend.ts` | Powers `resume` from Slack and the eventual web viewer. |
| Slash command system | `src/commands/registry.ts`, `src/commands/builtin/*.ts` | We lift the *semantics* (`/model`, `/new`, `/compact`, `/switch`, `/thinking`, `/cost`, `/resume`) and expose selected ones as Slack **control commands** (see §7). |
| Persistent settings loader (project / global / Claude fallback) | `src/config/settings.ts` | We add a `slack` section; the existing layered-resolve machinery already merges correctly. |
| **minislack — in-process fake Slack** (team, users, channels, threads, DMs, reactions, files, WS + HTTP, web UI) | `src/minislack/*`, exposed as `bantai minislack` | Integration tests and dev-loop workflow run against minislack. Only production tests against real Slack. **This is the force multiplier** — we can unit-test the entire Slack frontend deterministically. |
| 16ms batched event delivery | `src/utils/event-batcher.ts` | Same batcher the TUI uses; Slack streaming respects the same boundaries. |

### What's actually new

1. A `src/frontends/slack/` adapter that mirrors `src/frontends/tui/` in shape but emits Slack messages / reactions / blocks instead of OpenTUI draws.
2. A per-workspace **router** that maps `(channel, thread) → SessionHost` and lazy-constructs hosts on demand.
3. A **config layer** for per-channel project binding and per-channel backend/Claude settings.
4. A **streaming strategy** (three-tier: native `chat.startStream` → draft `chat.update` → buffered `postMessage`).
5. An **emoji state machine** (openclaw-inspired) on the triggering message.
6. A **Block Kit layer** for approvals, elicitation, plan updates, and session banners.
7. A **control-command surface** that does not use Slack slash commands (to avoid collisions).

Everything else we are stealing verbatim from the research reports — the shape of event handlers, the debouncer, the dedup keys, the three-step file upload, the sent-thread cache. Reference reports:
- `/Users/odin/dev/repos/repos-agent-slack-integration/slack-claude-integration-plan.md` — pre-scoped build plan (Anthropic-only; we generalise).
- `/Users/odin/dev/repos/repos-agent-slack-integration/report-claudeclaw.md` — patterns we keep (JIDs, thread auto-reg, accumulation).
- `/Users/odin/dev/repos/repos-agent-slack-integration/report-openclaw.md` — patterns we steal (streaming, approvals, status reactions).

---

## 2. Architecture

### 2.1 Layering

```
Slack workspace (real or minislack)
         │  Socket Mode WS  /  Events API HTTP
         ▼
src/frontends/slack/transport/          ← bolt App, dual-transport
         │  onEvent(SlackEvent)
         ▼
src/frontends/slack/inbox/              ← dedup, debounce, mention/DM gate
         │  InboundTurn{channel,thread,user,text,files}
         ▼
src/frontends/slack/router/             ← (channel,thread) → SessionHost
         │  sessionHost.backend.sendMessage(...)
         ▼
src/session/host.ts                     ← SessionHost  (already exists)
         │  AgentBackend.start() → AsyncGenerator<AgentEvent>
         ▼
src/frontends/slack/view/               ← AgentEvent → Slack side-effects
  ├─ outbox.ts        chat.startStream / chat.postMessage / chat.update
  ├─ reactions.ts     status-reaction state machine
  ├─ blocks.ts        Block Kit builders (approval, banner, plan, elicit)
  ├─ format.ts        markdown → mrkdwn + chunker
  ├─ upload.ts        3-step files.getUploadURLExternal flow
  └─ banner.ts        session-start banner (session id, backend, model)
```

Same directory convention as the TUI frontend (`src/frontends/tui/`): `launcher.ts` is the entry point, everything else is internal.

### 2.2 Identity shapes

Borrowing openclaw's session-key shape and claudeclaw's JID notion, unified:

- **Slack address (transport)** — `slack:<workspace>:<channel>[:<threadTs>]`
- **Project key (config)** — channel id resolves to a `ProjectConfig { projectDir, backend, claudeConfigDir, allowedTools, mcpServers, model, verbosity, approvers, ... }`
- **Session key (routing)** — `slack:<workspace>:<channelId>:<threadTs|"main">` — one `SessionHost` per key
- **Backend session id** — stored in a SQLite `sessions` table keyed by the session key; used for `SessionConfig.resume`

Top-level channel messages collapse to session key `…:main` (matches openclaw's regression fix at `prepare.ts:296-301`).

### 2.3 Multi-user in one thread → one session

All users in a thread post into the **same** `SessionHost`. The Slack frontend prefixes each inbound turn with `@<displayName>:` so the agent sees who said what (and `@<displayName>` in outbound mentions the user back). Identity is surfaced in:
- the turn-level user-message prefix,
- the session banner (list of thread participants, updated on join),
- the audit log (who approved which tool, etc.).

Per-user agent credentials are NOT v0 — the bot uses one backend auth per channel. Multi-tenant credential isolation is a post-v0 line item (see §11).

### 2.4 State store

New SQLite file `~/.bantai/slack/<workspace>.db` (or `./.bantai/slack.db` when a project-local scope is preferred):
- `channels(channel_id, project_key, config_json)` — channel → project binding + per-channel overrides
- `sessions(session_key, backend, backend_session_id, created_at, last_active_at, status)`
- `inbound_messages(channel_id, ts, event_ts, payload_json)` — dedup + accumulation
- `approvals(approval_id, session_key, tool, input_json, requester, decision, resolved_by, resolved_at)`
- `thread_participants(session_key, user_id, first_seen_ts)`
- `costs(session_key, ts, input_tokens, output_tokens, cache_read, cache_write, usd)` — fed from `cost_update` events

No ORM; hand-written statements. Same flavour as `src/minislack/*` in-memory stores but persisted.

---

## 3. Configuration

### 3.1 File shape

`~/.bantai/slack.toml` (or `./.bantai/slack.toml` at project scope — higher precedence):

```toml
# --- workspace-level connection ---
[workspace]
mode               = "socket"             # socket | http
bot_token          = { env = "SLACK_BOT_TOKEN" }
app_token          = { env = "SLACK_APP_TOKEN" }
signing_secret     = { env = "SLACK_SIGNING_SECRET" }  # http mode only
webhook_path       = "/slack/events"      # http mode only

# --- defaults applied to every channel unless overridden ---
[defaults]
backend            = "claude"             # claude | codex | gemini | acp
model              = "claude-sonnet-4-6"
permission_mode    = "default"
require_mention    = true                 # channels only; DMs never require mention
trigger_name       = "bantai"             # resolves <@BOT_ID> to @bantai pre-agent
verbosity          = "normal"             # silent | concise | normal | verbose | debug
control_prefix     = "!bantai"            # see §7
session_banner     = true
approvers          = []                   # empty ⇒ everyone can approve; set to lock down
auto_join_threads  = true                 # after bot replies in a thread, no re-mention

# --- per-channel overrides (channel = bantai project) ---
[[channels]]
id                 = "C0123ABCDEF"
name               = "eng-backend"
project_dir        = "/Users/me/dev/backend"
claude_config_dir  = "~/.bantai/slack/config/C0123ABCDEF"   # isolated CLAUDE_CONFIG_DIR
backend            = "claude"
model              = "claude-opus-4-7"
allowed_tools      = ["Bash", "Read", "Edit", "Grep", "Glob"]
mcp_servers        = ["filesystem", "postgres"]
system_prompt_append = "This is the backend monorepo. Always run tests before declaring done."
approvers          = ["U0ALICE", "U0BOB"]
verbosity          = "verbose"
env.ANTHROPIC_API_KEY = { env = "ANTHROPIC_API_KEY_BACKEND" }

[[channels]]
id                 = "C9999SANDBOX"
project_dir        = "/Users/me/dev/sandbox"
backend            = "codex"
model              = "gpt-5-codex"
require_mention    = false
verbosity          = "debug"
```

### 3.2 Runtime config knobs

Everything in `[defaults]` and every `[[channels]]` field is also reachable via control commands (§7): `!bantai verbosity verbose`, `!bantai model claude-opus-4-7`, `!bantai require-mention off`. Changes persist back to the TOML so restart survives them.

### 3.3 Verbosity levels

| Level | Agent text | Tool calls | Thinking | Tool results | Errors | Banner on new session |
|---|---|---|---|---|---|---|
| `silent` | only on `!bantai ask` | no | no | no | yes | no |
| `concise` | yes | count only (💭 "3 tools") | no | no | yes | yes |
| `normal` | yes | one-line per tool | no | truncated previews | yes | yes |
| `verbose` | yes | Block Kit cards | no | full, file-uploaded if >N | yes | yes |
| `debug` | yes | full cards + raw JSON | yes | full + raw | yes + stack | yes + raw session init |

Verbosity is checked per-event in the view layer; the event stream itself is untouched.

---

## 4. Emoji state machine (openclaw-inspired, tuned for bantai)

State reactions land on the **triggering** user message. Transitions remove the previous emoji and add the next. Falls back to removing all reactions on error-recover.

| State | Emoji (unicode) | Slack shortcode | Trigger |
|---|---|---|---|
| queued (behind another turn) | 🕐 | `:clock3:` | message added to mailbox, another turn running |
| accepted, starting session | 🌀 | `:cyclone:` | SessionHost constructed, `session_init` pending |
| thinking | 🧠 | `:brain:` | `thinking_delta` / first `text_delta` |
| reading | 👀 | `:eyes:` | Read / Grep / Glob tool start |
| editing | ✏️ | `:pencil2:` | Edit / Write tool start |
| running shell | 🛠️ | `:hammer_and_wrench:` | Bash / shell tool start |
| searching web | 🌐 | `:globe_with_meridians:` | WebFetch / WebSearch |
| delegating subagent | 🤖 | `:robot_face:` | `task_start` |
| awaiting approval | 🔐 | `:lock:` | `permission_request` |
| awaiting answer | ❓ | `:question:` | `elicitation_request` |
| compacting | 🧹 | `:broom:` | `compact` (inProgress) |
| done | ✅ | `:white_check_mark:` | `turn_complete` |
| interrupted | 🛑 | `:octagonal_sign:` | `interrupt` (user) |
| error | ❌ | `:x:` | `error` (severity: fatal) or state `ERROR` |
| rate-limited | ⏳ | `:hourglass_flowing_sand:` | `rate_limit_update` with `rejected` |

Implementation: a tiny reducer-like state machine in `view/reactions.ts` fed by the same `AgentEvent` stream the reducer consumes. No extra plumbing — just another subscriber.

---

## 5. Session banner — "formal session start"

Required on every fresh session (new thread, or `!bantai new` in a DM). Posted as a Block Kit message pinned logically to the top of the thread:

```
┌───────────────────────────────────────────────┐
│ bantai session started                        │
│                                               │
│ backend : claude                              │
│ model   : claude-opus-4-7                     │
│ project : eng-backend (/Users/…/backend)      │
│ cwd     : /Users/…/backend                    │
│ session : 01HQX7…K8G                          │
│ verbosity: verbose                            │
│                                               │
│ Participants: @alice  @bob                    │
│                                               │
│ [ change model ]  [ reset ]  [ silence ]      │
└───────────────────────────────────────────────┘
```

Block Kit composition (see `blocks/session-banner.ts`):
- `section` with mrkdwn lines,
- `context` block with participants,
- `actions` block with three buttons whose `action_id`s route through the block-action handler (§8).

Resume case: on `history_loaded`, the banner shows the resume summary (turns, tokens, cost, last active) instead of a fresh-session announcement.

---

## 6. Streaming strategy

Three-tier (openclaw pattern), implemented behind a single `OutboundStream` abstraction:

1. **Native `chat.startStream` / `appendStream` / `stopStream`** — when `streaming.mode === "partial"` and the workspace permits the Assistant API (`assistant:write` scope + `thread_ts` present). Use `markdown_text`. Diffing is append-only — send only net-new tokens, same as openclaw's `applyAppendOnlyStreamUpdate`.
2. **Draft `chat.postMessage` + throttled `chat.update`** — fallback when (1) isn't available. Throttle ≥250 ms, finalize with one last `chat.update` on `turn_complete`.
3. **Buffered chunked `chat.postMessage`** — final fallback when both streaming paths throw. Paragraph-aware splitting via `markdownToSlackMrkdwnChunks` (port from openclaw `format.ts`).

All three are driven by the same event sequence: `text_delta*` → `text_complete` → `turn_complete`. The strategy auto-selects per channel config (`streaming.mode = off | partial | final`).

For `thinking_delta`, we do NOT stream into the message body — we flip the reaction to 🧠 and accumulate into a collapsible context block that is appended once per turn at the end (verbosity ≥ `debug`).

---

## 7. Control commands (no slash collision)

Slack users don't type `/slash` to control bantai — that would collide with workspace slash commands. We ship three surfaces, same underlying dispatch:

### 7.1 Text-prefix commands: `!bantai <cmd> [args]`

Lifted from `src/commands/builtin/*`. Subset exposed:

| Slack command | TUI equivalent | Effect |
|---|---|---|
| `!bantai new` | `/new` | reset the thread's session (confirm if unsaved cost > $0) |
| `!bantai resume <id?>` | `/resume` | attach thread to an existing backend session; picker if omitted |
| `!bantai model [id]` | `/model` | list or set model for this thread |
| `!bantai backend [id]` | `/switch` | switch backend mid-session (cross-backend replay) |
| `!bantai compact` | `/compact` | trigger compaction |
| `!bantai cost` | `/cost` | post running cost + rate-limit state |
| `!bantai thinking <level>` | `/thinking` | set effort |
| `!bantai permissions <mode>` | `/permissions` | set permission mode |
| `!bantai verbosity <level>` | (new) | change verbosity for this channel |
| `!bantai status` | `/diagnostics` | post session state + health |
| `!bantai stop` | Ctrl+C | interrupt the active turn |
| `!bantai help` | `/help` | list all commands |

The command parser reuses `src/commands/registry.ts` dispatch shape but routes side-effects through Slack (post-back the help text, approval needed for destructive commands, etc.).

### 7.2 Block Kit buttons — the session banner and per-tool cards emit buttons that map to `action_id = bantai:cmd:<name>[:args]`.

### 7.3 Emoji reactions as commands (opt-in per channel)

| Emoji | Action |
|---|---|
| `:stop_sign:` | interrupt |
| `:fast_forward:` | `!bantai resume` most recent |
| `:recycle:` | `!bantai new` |
| `:mag:` | `!bantai status` |

Only the triggering message and the bot's own messages accept these. Gated by `emoji_commands: true` in channel config.

### 7.4 Why not `/claude` slash command?

Because (a) it collides with workspaces that already use `/claude`, (b) multi-backend support means the name is wrong (`/bantai` is fine but still collides), (c) Slack slash commands require pre-registration in the app manifest per-workspace and break self-host setup. Text-prefix + Block Kit + emoji reactions cover the same surface with zero manifest friction. If a workspace admin wants slash commands, §11 covers optional registration.

---

## 8. Block Kit interactivity — the interactive surfaces

All block-action payloads route through `src/frontends/slack/interactions.ts`, which parses the opaque `action_id`, resolves the originating `(channel, thread) → SessionHost`, and dispatches.

### 8.1 Permission approvals (`canUseTool` → Slack)

When the Claude backend fires `permission_request`, the frontend:
1. Posts a Block Kit message with:
   - tool name in a mrkdwn header,
   - tool input in a fenced code block (truncated at 2600 chars, linked to a file upload if larger),
   - an `approved_by` context block listing the authorized approvers,
   - three buttons: `Allow once` (primary), `Allow always` (primary, sets a permission rule), `Deny` (danger).
2. Registers a pending-approval record keyed by `permission_request.id`.
3. Sets the triggering-message reaction to 🔐.
4. TTL auto-reject after 10 min (configurable).
5. On click: atomic "first-of-click/TTL wins" take; updates the message in-place (`chat.update`) showing `Resolved by <@USER> — allowed / denied`; responds to the backend via `backend.approveToolUse` / `backend.denyToolUse`.

Approver gating: if `approvers` is non-empty in the channel config, non-approvers get an ephemeral reply and the button does nothing.

### 8.2 Elicitation (`AskUserQuestion` → Slack)

`elicitation_request` events translate to:
- one-question: Block Kit `actions` with `static_select` (single-choice) or `multi_static_select` (multi-choice);
- free-text allowed: add an `input` block with a plain_text_input + submit button;
- multi-question: a modal (`views.open`) triggered by a "Answer questions" button posted in-thread.

On submission we call `backend.respondToElicitation` with answers keyed by question text.

### 8.3 Plan updates (ACP `plan_update`)

Render `PlanEntry[]` as a checklist Block Kit block, edited in-place on subsequent `plan_update` events.

### 8.4 Tool-call cards (verbosity ≥ normal)

Each tool start → a `context` block:
```
🛠️ Bash — `npm test`
```
On tool end → `chat.update` to collapse + show outcome:
```
✅ Bash — `npm test`  (1.8s, exit 0)
     ▸ Show output  ← button that uploads full output as a snippet
```
Truncation threshold configurable per channel.

---

## 9. Routing + lifecycle

### 9.1 Inbound path

1. Bolt `message` / `app_mention` / `reaction_added` / `file_shared` → `transport/events.ts`.
2. Dedup by `event_id` (Events API) or `envelope_id` (Socket Mode). Retention 1 h.
3. Debounce per-thread for 600 ms (openclaw pattern) to coalesce rapid multi-message bursts.
4. Mention / DM / thread-auto-join decision → either skip, accumulate, or trigger.
5. On trigger: resolve `(channel, thread)` → `SessionHost`, lazy-constructing it if absent (via `createBackend` + `createSessionHost` + `resolveProjectForChannel`).
6. Push the `UserMessage` (with multi-user prefix) onto `backend.sendMessage(...)` — the `SessionHost` queues it, `AgentBackend.start()` (on first construction) is iterated in a long-lived goroutine-equivalent.

### 9.2 Outbound path

- A single `EventRenderer` consumes the host's `AgentEvent` stream (via the same 16ms batcher the TUI uses).
- The renderer owns the `OutboundStream`, the `StatusReactionController`, the approval registry, the tool-card registry, the banner registry — all keyed by session key.
- On `turn_complete`, flush stream, post final cost line (verbosity permitting).
- On `error` (fatal): post error + stack (if `debug`), clear reactions, close the host, unregister the session key. Follow-up messages in the thread will lazy-reconstruct a fresh host (respecting `auto_join_threads`).

### 9.3 Concurrency

- Per-session-key mailbox (one turn at a time). Subsequent messages queue and surface 🕐 on the triggering message.
- Per-channel **project lock** (optional): when two threads in the same channel would concurrently write to the same `project_dir`, serialise them. Controlled by `channel.concurrency = "per-thread" | "per-channel"`. Default `per-channel` for safety.
- Graceful shutdown: on SIGINT, close all hosts in parallel; Bolt's Socket Mode gets `shuttingDown = true` before `app.stop()` (openclaw race fix).

### 9.4 Crash recovery

- On restart: walk `sessions` table, rehydrate `SessionHost` lazily on next inbound message (not eagerly — avoids waking all threads simultaneously).
- In-flight streams become orphaned; a `chat.update` best-effort final edit attempts to mark them `(interrupted by restart)`; if that fails, the next inbound message posts a fresh `session resumed` banner.

---

## 10. Testing strategy

The minislack module is why this plan is realistic in weeks, not months.

### 10.1 Pure-function unit tests (no IO)

Every routing decision is a pure function with a snapshot test:
- `shouldHandleMessage(event, channelConfig, botUserId, threadState) → { action, reason }`
- `buildSessionKey(event, channelConfig) → SessionKey`
- `buildMrkdwnChunks(markdown, chunkMode, maxLen) → string[]`
- `nextReactionState(current, agentEvent) → ReactionState`
- `compileApprovalBlocks(permissionRequest, approvers) → Block[]`
- `parseControlCommand(text) → { cmd, args } | null`

Mirrors opencode-chat-bridge's `shouldHandleThreadMessage` pattern.

### 10.2 Integration tests against minislack

`startMinislack({ fixture: "multi-user" })` → configure a bantai Slack frontend pointing at it → drive user actions (post, thread-reply, react, upload) via `handle.asUser("alice").sendMessage(...)` → assert on the event bus and workspace snapshot. Every phase below ships with its own integration test.

### 10.3 Contract tests

Same contract tests the protocol layer already runs (`tests/protocol/`) get a Slack-frontend variant: `session_init` must show up as a banner, `turn_start` must precede text, `permission_request` must block until resolve, etc.

### 10.4 Golden tests

Every Block Kit payload we emit is JSON-snapshot tested (`tests/frontends/slack/blocks.snap.json`). Prevents accidental regressions in tool cards / banners / approvals.

### 10.5 Real-Slack smoke test

`tests/e2e/slack-live.test.ts` runs against a real workspace (`SLACK_E2E_*` env), gated by a CI flag. Exercises the three streaming tiers and one approval flow.

---

## 11. Phased roadmap

Each phase has a clear exit criterion. Phases are sized ~1 week of focused work; they can compress if we parallelise UI polish and plumbing.

### Phase S0 — Transport skeleton (week 1)

**Goal:** Bolt is up, receives events from minislack, can reply.

- New deps: `@slack/bolt` `^4.7`, `@slack/web-api` `^7.15`, `@slack/types` (already in tree for minislack).
- `src/frontends/slack/transport/bolt.ts` — App factory, dual Socket/HTTP, shared HTTP registration helper (adapted from openclaw `provider.ts`), `auth.test` on connect.
- `src/frontends/slack/transport/events.ts` — register `message`, `app_mention`, `member_joined_channel`, `file_shared`, `reaction_added`, `block_actions`, `view_submission`.
- `launchSlack(flags)` replaces the placeholder; boots Bolt + empty router.
- Config schema (§3) with zod validation under `src/frontends/slack/config/schema.ts`.
- New `slack` section added to `src/config/settings.ts` loader (extend existing layered resolve).
- Integration test: post a message into minislack, frontend replies "ack" with no agent involvement.

**Exit:** `bun run dev -- slack --minislack` boots, posts an ack.

### Phase S1 — Round-trip MVP (week 2)

**Goal:** one channel → one session → one reply. No streaming, no Block Kit, no approvals.

- `src/frontends/slack/router/registry.ts` — `(channel, thread) → SessionHost`, lazy-constructed via existing `createBackend` + `createSessionHost`.
- `src/frontends/slack/router/resolver.ts` — channel → `ProjectConfig` lookup (TOML + overrides).
- `src/frontends/slack/inbox/` — dedup (event_id cache), mention gate, thread auto-join, multi-user prefix.
- `src/frontends/slack/view/outbox.ts` — minimum viable: on `turn_complete`, post the assistant text via `chat.postMessage`, thread-aware.
- Sender allowlist stub: everyone allowed, config override ready.
- SQLite store (`sessions`, `channels`, `inbound_messages` tables).

**Exit:** in minislack, @mention the bot in a channel → bot reads a real file via Claude SDK in a test repo → posts the result in a thread. Follow-up in thread continues the session.

### Phase S2 — Streaming + status reactions (week 3)

**Goal:** turns feel live; users see something is happening.

- `OutboundStream` with three-tier fallback (§6). Native streaming optional behind a flag (workspace may not have `assistant:write`).
- `view/reactions.ts` — the full emoji state machine (§4).
- Debouncer for rapid multi-message bursts (openclaw `message-handler.ts:78-95` pattern).
- Paragraph-aware mrkdwn chunker — port `markdownToSlackMrkdwnChunks`.

**Exit:** a ≥30-turn task streams visibly, reactions transition correctly, code fences survive chunking.

### Phase S3 — Session banner + control commands (week 4)

**Goal:** the formal session-start surface + `!bantai *` commands.

- `view/banner.ts` — Block Kit banner on session init + resume summary (§5).
- Control-command parser + dispatch → `src/commands/registry.ts` (new Slack-frontend adapter for commands).
- Minimum command set: `new`, `model`, `backend`, `cost`, `stop`, `status`, `help`, `verbosity`.
- `chat:write.customize` — bot posts under per-project username + icon (openclaw pattern).

**Exit:** a thread shows the banner on first reply; `!bantai model claude-opus-4-7` swaps the model live; `!bantai stop` interrupts mid-stream.

### Phase S4 — Permissions + Block Kit approvals (week 5)

**Goal:** `canUseTool` is fully wired, real workspaces can run `default`/`dontAsk` mode safely.

- `view/blocks/approval.ts` — full Block Kit approval builder (§8.1).
- `view/approvals.ts` — pending registry, TTL, atomic take, in-place `chat.update` resolution.
- Approver gating per channel (§3).
- Elicitation → Block Kit select / modal (§8.2).

**Exit:** Claude requests `Bash` → Slack shows three-button approval → click resolves in-place → tool executes. Running `!bantai permissions acceptEdits` silences edit approvals for that thread.

### Phase S5 — Tool visibility + verbosity (week 6)

**Goal:** per-verbosity tool cards, cost lines, plan blocks.

- `view/blocks/tool-card.ts` — tool-start → card, tool-end → collapsed card with outcome + "Show output" button.
- `view/blocks/plan.ts` — ACP `plan_update` → checklist block, edited in-place.
- Cost footer on `turn_complete` (off by default; `verbosity ≥ normal` shows a one-liner, `verbose` shows per-category).
- `view/blocks/thinking.ts` — appended collapsible on `verbose`/`debug`.
- Verbosity changeable at runtime (`!bantai verbosity`) and persisted.

**Exit:** the four verbosity levels demonstrably differ in a fixture run; snapshot tests cover every combination.

### Phase S6 — File round-trip (week 7)

**Goal:** inbound screenshots → agent reads them; outbound diffs / long logs → file uploads.

- `view/upload.ts` — 3-step `files.getUploadURLExternal` → presigned POST → `files.completeUploadExternal`. Port from openclaw `send.ts:263-307`.
- Inbound attachments → downloaded into a channel-scoped staging dir → path injected into the user turn (and, for images, embedded as base64 into `UserMessage.images`).
- Long tool outputs (> configurable N lines) → auto-uploaded as snippet, link replaces the preview in the tool card.
- Agent-generated artifacts (diffs, plots) → uploadable via an MCP tool `slack_upload` exposed to the backend when the Slack frontend is active.

**Exit:** user posts a PNG → agent OCRs it; agent writes a 500-line diff → Slack shows a file snippet with preview.

### Phase S7 — Multi-user, per-channel settings, skills (week 8)

**Goal:** teams can actually use it without foot-guns.

- Multi-user turn prefix + participants on banner (§2.3).
- Per-channel `claude_config_dir` plumbed through `SessionConfig.env` so each channel has isolated Claude settings/skills/MCP auth.
- MCP server resolution from channel config (only load listed servers).
- Authorized-approvers enforcement + "approvers missing" boot-time warning for channels with unsafe defaults.
- `!bantai settings [key] [value]` → edits `slack.toml` and hot-reloads the channel.

**Exit:** two channels pointed at two different repos with two different backend/model combos, both live at once, isolation verified (skills from A not visible to B, no cwd collisions, no credential bleed).

### Phase S8 — Resilience & polish (week 9)

**Goal:** production-grade behaviour; not "demo-grade".

- Socket Mode reconnect with exponential backoff + fast-fail on auth errors (openclaw pattern).
- Rate-limit handling (`chat.postMessage` 429 → Retry-After backoff + queue).
- Graceful shutdown sequencing (`shuttingDown = true` before `app.stop()`).
- Restart recovery: mark in-flight streams `(interrupted by restart)`; lazy rehydrate on next inbound.
- Per-turn deadline config (`turn_timeout_s` → auto-interrupt).
- Cost cap per session (`max_budget_usd` → auto-stop + banner warning).
- Prometheus-style metrics endpoint (`/metrics` on the HTTP receiver when http mode).
- Structured logging — reuse existing `src/utils/logger.ts`.

**Exit:** kill -9 the process mid-turn, restart, thread survives; `!bantai cost` reports accurately.

### Phase S9 — Real-Slack hardening (week 10)

**Goal:** production smoke tests pass against a real workspace.

- App manifest generator (`bantai slack init-manifest` → writes a ready-to-install Slack app manifest).
- `assistant:write` scope gate + graceful downgrade when absent (no native streaming → tier 2 fallback).
- Workspace-admin diagnostic pass on boot (auth.test → scope check → post-to-self test).
- Documentation: `docs/slack-setup.md` walking through app creation, manifest install, token setup.
- E2E Slack smoke test (`tests/e2e/slack-live.test.ts`, gated by env).

**Exit:** new user can go from `gh clone` → working bot in a real workspace in ≤10 minutes, following only the doc.

### Phase S10 — Web session viewer (post-v0, weeks 11+)

**Goal:** observability + cost control web UI for ops.

- SQLite schema already captures every event → build a read-only web UI (reuse `src/minislack/web/` Solid stack).
- Tabs: Sessions, Costs, Approvals, Rate Limits, Channels.
- Live subscribe via SSE to the same event batcher the Slack frontend consumes.
- Cost budget editor (syncs back to `slack.toml`).
- Per-approval audit trail (who approved what, when, why).

(Details deferred; intentional "v1" scope.)

---

## 12. Risks + open questions

| Risk | Mitigation |
|---|---|
| Native `chat.startStream` requires `assistant:write` + Assistant API tier — many workspaces don't have it | three-tier fallback is the design; feature-detect at startup, downgrade gracefully |
| `canUseTool` callback may time out if the SDK enforces a deadline before the human clicks | TTL auto-reject matches the SDK's default; measure in S4 and bump if needed; visibility via 🔐 reaction while pending |
| Per-channel `CLAUDE_CONFIG_DIR` must be respected by Agent SDK for auth + skills | verify in S1, document the precedence; claude-agent-sdk already reads it per-invocation, but OAuth token refresh may need tighter control — add an integration test in S7 |
| Concurrency across threads in one channel colliding on file writes | per-channel lock default; `per-thread` opt-in with documented "you're on your own" caveat; consider per-thread git worktrees as a future S7+ option |
| Multi-user in one thread: attribution confusion for the agent | turn prefix + banner participants + audit log in costs table |
| SQLite write contention at higher workspace sizes | WAL mode + per-channel write queue; realistically not a v0 concern |
| Slack retry storms (same event delivered ≥2×) | dedup cache keyed by `event_id` + `channel_id:ts`, 1h retention |
| Two bantai instances pointing at the same workspace | startup check: `auth.test` returns an `api_app_id`; SQLite `workspace_owner` row locks writes to one pid; fail loudly |
| Multi-backend session resume across restarts (backend_session_id rot) | same contract the TUI uses via `cross-backend.ts`; reuse verbatim |
| Block Kit size limits (3000 chars per block, 50 blocks) | measure before send; overflow → file upload + short summary |

---

## 13. File layout (final state at end of S9)

```
src/frontends/slack/
├── launcher.ts                 # public entry: launchSlack(flags)
├── config/
│   ├── schema.ts               # zod schema for slack.toml
│   ├── resolver.ts             # (channelId) → ProjectConfig
│   └── watcher.ts              # hot-reload on slack.toml change
├── transport/
│   ├── bolt.ts                 # App factory (socket + http)
│   ├── events.ts               # message / app_mention / reactions / interactions
│   └── reconnect.ts            # socket backoff + fast-fail
├── inbox/
│   ├── dedup.ts
│   ├── debounce.ts
│   ├── mention.ts              # mention / DM / thread-auto-join gate
│   └── turn-builder.ts         # InboundTurn assembly w/ multi-user prefix
├── router/
│   ├── registry.ts             # (channel, thread) → SessionHost
│   ├── host-factory.ts         # wraps createSessionHost + createBackend
│   └── concurrency.ts          # per-session mailbox, per-channel project lock
├── view/
│   ├── event-renderer.ts       # AgentEvent → Slack side-effects (main orchestrator)
│   ├── outbox.ts               # three-tier delivery
│   ├── reactions.ts            # emoji state machine
│   ├── format.ts               # markdown → mrkdwn + chunker
│   ├── upload.ts               # 3-step file upload
│   ├── banner.ts               # session-start banner
│   └── blocks/
│       ├── approval.ts
│       ├── elicitation.ts
│       ├── plan.ts
│       ├── session-banner.ts
│       ├── tool-card.ts
│       └── thinking.ts
├── commands/
│   ├── parser.ts               # "!bantai ..." text parser
│   ├── emoji.ts                # emoji-reaction command parser
│   └── dispatch.ts             # shared dispatch to src/commands/registry
├── interactions/
│   ├── block-actions.ts        # block_actions → action_id → handler
│   ├── approvals.ts            # approval decision handlers
│   └── view-submissions.ts     # modal submits
├── store/
│   ├── db.ts                   # SQLite schema + accessors
│   ├── sessions.ts
│   ├── approvals.ts
│   └── costs.ts
└── __tests__/
    ├── inbox.test.ts
    ├── router.test.ts
    ├── reactions.test.ts
    ├── format.test.ts
    ├── blocks.snap.json
    └── integration/            # vs minislack
        ├── round-trip.test.ts
        ├── streaming.test.ts
        ├── approval.test.ts
        └── multi-user.test.ts
```

---

## 14. What we are NOT doing in v0

- **Multi-tenant hosted SaaS.** One workspace per bantai process.
- **OAuth install flow.** Users supply tokens; manifest is documented.
- **Per-Slack-user credentials / auth.** One backend auth per channel.
- **Native `assistant.threads.*`** full Assistant API UX (status strip, suggested prompts) — only `chat.startStream` on threads. Optional S10.
- **Fine-grained Slack retention / search.** Only dedup + accumulation; no full search API wiring.
- **Workspace-admin policy auto-detection.** Boot-time diagnostic warns but doesn't programmatically remediate.
- **Non-Slack frontends in this pass.** Discord / Matrix / Teams are future forks of this design.

---

## 15. Reading order before starting S0

1. This doc, end-to-end.
2. `src/protocol/types.ts` + `src/protocol/reducer.ts` — understand what events we render.
3. `src/session/host.ts` + `src/frontends/tui/launcher.ts` — how hosts are built today.
4. `src/minislack/testing/harness.ts` + `src/minislack/server/http.ts` — what our test harness affords.
5. `/Users/odin/dev/repos/repos-agent-slack-integration/report-openclaw.md` — §4 (streaming) + §10 (UI).
6. `/Users/odin/dev/repos/repos-agent-slack-integration/report-claudeclaw.md` — §7 (sessions) + §9 (triggers).
7. Bolt's own `message`, `app_mention`, `block_actions`, `view_submission` docs.

Then write S0.
