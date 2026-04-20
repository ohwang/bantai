# bantai

Multi-surface UI for agentic coding backends. Decoupled from any single coding agent (Claude Code, Codex, ACP, …) from any single surface — today the same agent runs in a local TUI and in a Slack workspace, driven by the same protocol and event stream.

## Quick Start

```bash
bun install

# TUI
bun run dev                       # default backend (claude)
bun test                          # run all tests

# Slack
bun run ./src/index.ts slack init-manifest > slack-manifest.yaml   # create app
bun run ./src/index.ts slack doctor                                # verify config
bun run ./src/index.ts slack                                       # start server
bun run ./src/index.ts slack monitor                               # observability TUI over the admin API

# Dev-only fake Slack (integration tests + local Slack dev)
bun run ./src/index.ts minislack --fixture basic
```

See `docs/slack-setup.md` for the real-workspace walkthrough and `docs/minislack.md` for the fake Slack server.

## Build Requirements

- Bun ≥ 1.3.11 (OpenTUI's Zig FFI bindings require Bun; no Node.js support).
- `bunfig.toml` must include `preload = ["@opentui/solid/preload"]` (Babel plugin for SolidJS JSX).
- Run with `--conditions=browser` (already set in every `package.json` script and in `bin/bantai` / `bin/bantai-slack`).

## Tech Stack

- Bun + TypeScript (strict, `tsc --noEmit` must pass.
- **TUI frontend:** OpenTUI + SolidJS via `@opentui/solid` (NOT React).
- **Slack frontend:** `@slack/bolt` (Socket Mode) + `@slack/web-api`.
- **Backends:** `@anthropic-ai/claude-agent-sdk` (track latest), `@openai/codex-sdk`, ACP over JSON-RPC, and an in-process mock.
- **Everything else:** `commander` (CLI), `zod` (config schemas), `fuzzysort` (file/session search), `jsonc-parser` (configs with comments).

## Architecture

Three layers, strictly ordered:

1. **CLI Entry Point** (`src/index.ts`, `src/cli/`) — Commander-based subcommand dispatch.
   - `bantai [prompt]` → TUI (default backend)
   - `bantai claude|codex|gemini [prompt]` → TUI with a specific backend
   - `bantai run <message…>` → headless one-shot
   - `bantai resume [id]` / `bantai continue` → session resume
   - `bantai slack` / `bantai slack doctor` / `bantai slack init-manifest` → Slack server
   - `bantai minislack` → local fake Slack
2. **Frontends** (`src/frontends/<name>/`) — each owns its own presentation + transport and exposes a `launch<Name>(flags)` entry point. Today: `tui/` (interactive terminal, default) and `slack/` (bot/server). Nothing in the protocol or backend layer depends on a specific frontend.
3. **Agent Protocol Layer** (`src/protocol/`) — unified `AgentBackend` interface, `AgentEvent` stream, `ConversationState`, and the `reduce(state, event) -> newState` reducer. Backends (`src/backends/{claude,codex,acp,mock}/`) implement this; frontends consume it.

The protocol layer is the load-bearing abstraction: **adding a frontend or backend means implementing the relevant side of this contract — never forking reducer or event semantics.**

## Key Conventions

### Cross-cutting (apply everywhere)

- **`tsc --noEmit` must pass.** Never commit code that adds new TypeScript errors.
- **Types as documentation.** `src/protocol/types.ts` IS the spec.
- **Test contracts, not implementations.** Adapter contract tests validate event ordering and lifecycle rules (see §Testing).
- **One concern per file.** Size is a proxy for cohesion, not a rule. Target ~800 lines, hard cap ~1200; past that, justify in a top-of-file comment or split. Exempt: type/schema specs, vendored code, generated code.
- **No Effect.js, no metaprogramming, no deep inheritance.** Plain TypeScript; factory functions for service construction; explicit over clever.
- **Never silently drop data from an external source.** SDK events, session JSONL, MCP payloads, ACP notifications, Slack events, user config — every skip path MUST log, every unrecognised shape MUST `log.warn`. A bare `break` / `continue` / `return []` / `if (!expected) break` on external data is a bug. Concretely:
  - **Event mappers** (`src/backends/*/event-mapper.ts`): every SDK/ACP message branch either maps to an `AgentEvent` or logs. Intentional suppressions (per-delta items whose content arrives via `*_delta` events) use `log.debug`. Unknown types/subtypes and "expected field missing" cases use `log.warn` — these are the signals that a provider's protocol drifted.
  - **Session-file parsers** (`src/backends/claude/session-reader.ts`, `src/session/cross-backend.ts`): the SDK types `MessageParam.content` as `string | Array<ContentBlockParam>`, and both forms appear in real JSONL. Handle both; when neither, `log.warn` with a snippet. Synthetic SDK-injected turns (compaction summaries, `<command-name>` slash markers, `<local-command-*>` wrappers, `isMeta: true`) are suppressed with `log.debug` that names the reason — not bare-drops. The "user messages vanish on resume" regression was exactly this bug. When in doubt, normalise the shape (e.g. upgrade a string to `[{ type: "text", text }]`) before the main loop rather than branching mid-loop.
  - **`as any` / `unknown` escape hatches**: if you reach for `as any`, you owe either a runtime check (with a log on the unexpected branch) or a tight narrowed type. "It's probably fine" is how this class of bug ships.
- **Prefer framework primitives over custom logic.** Use OpenTUI / SolidJS / SDK / Bolt built-ins before writing manual workarounds. E.g. `stickyScroll={true}` + `stickyStart="bottom"` on `<scrollbox>` replaces 80+ lines of timer-based nudging; Bolt's built-in ack+respond pattern replaces hand-rolled event ordering.
- **Cleanup must survive deletion.** When removing a variable/timer, grep for ALL references including `onCleanup`, Bolt `app.stop()`, and server shutdown hooks. A dangling reference there prevents `process.exit()` and silently breaks exit.

### TUI frontend (SolidJS + OpenTUI)

- **SolidJS, not React.** Use `createSignal`, `createStore`, `createMemo`, `batch()`. No `useEffect`, `useState`, `useRef`.
- **Context-based DI.** One `AppContext` created at startup via factories. `<AppContext.Provider>` wraps root. Components use `useApp()`.
- **Event-sourced state.** The TUI renders from `ConversationState`, never raw events.
- **16ms event batching.** Wrap signal updates from high-frequency sources in Solid's `batch()`.
- **Runtime-mutable values must be SolidJS signals or stores.** Plain objects / module-level constants are for truly immutable data only (string enums, static config). Theme colors (`colors` in `tokens.ts`) are a store — never snapshot them into a `const`; read inline in JSX or via `() =>` accessor.
- **Cross-cutting keyboard shortcuts run FIRST in the root handler, not in overlays.** Any `useKeyboard` intercept that does blanket `event.preventDefault()` on non-whitelist keys (the usual "overlay is open — eat everything" pattern) silently swallows global shortcuts like Cmd+C copy. Centralise them as small helpers at the top of the root `useKeyboard` in `src/frontends/tui/app.tsx` (e.g. `tryHandleCopyShortcut`) and invoke them before any overlay branch.

### Slack frontend (`@slack/bolt` + Web API)

- **The pipeline is fixed; add to it, don't bypass it.** Round trip is: `transport/events` → `inbox/{dedup,gate,debouncer,turn-builder}` → `routing.ts` → `router/{resolver,registry}` → `SessionHost.send` → backend `AgentEvent` stream → `view/event-renderer` → Slack Web API. New features slot into one of these stages; don't post to Slack from anywhere else.
- **All tier-2 outbox paths must run outbound text through `view/format.ts`'s markdown→mrkdwn conversion.** Slack's mrkdwn dialect is not standard Markdown (single-`*` bold, no `**`, no fenced-inline code, bracket-style links). Skipping the conversion sends visually broken messages — and it's easy to skip when adding a new send site, because plain strings look fine in tests.
- **Coalesce rapid Slack API calls.** Reactions, status updates, and debounced input all have existing coalescers (`view/reactions.ts`, `view/thread-status.ts`, `inbox/debouncer.ts`) — reuse them. A naive "one API call per event" loop will hit rate limits and cost real money.
- **Never call `chat.postMessage` directly from view code.** Go through `view/outbox.ts` or `view/send-adapter.ts` so message tracking, edit-vs-append, and mrkdwn conversion stay consistent.
- **Slack config (`slack.json`) is validated by zod (`config/schema.ts`)**; never read fields off the raw JSON. Run `bantai slack doctor` before deploying config changes — it catches missing scopes, bad channels, and broken workspace auth up front.
- **Persistence is real.** `store/sessions.ts` writes an on-disk registry so the bot survives restarts without losing in-flight threads. Tests cover this (`tests/frontends/slack/integration/persistence.test.ts`) — don't regress it.

## TUI — OpenTUI Prop Rules (CRITICAL)

These prevent silent rendering failures and Zig FFI crashes. Run `bun run lint:opentui` to check for violations.

1. **`fg=` not `color=`** — `<text color="red">` is silently ignored. Use `<text fg="red">`.
2. **`attributes=` not `bold`/`dimmed`/`italic`** — Boolean styling props are ignored. Use `attributes={TextAttributes.BOLD}` from `@opentui/core`. Combine with `|`: `attributes={TextAttributes.DIM | TextAttributes.ITALIC}`.
3. **Hex strings, not numbers, for colors** — `fg={174}` crashes the Zig FFI. Use `fg="#d78787"`.
4. **Never `await render()`** — it resolves immediately; awaiting causes `main()` to return and the process to exit. Call without `await`; add `.catch()`.
5. **`dims()?.width` not `dims()?.columns`** — `useTerminalDimensions()` returns `{ width, height }`.
6. **No `borderTop`/`borderBottom` on a box containing a textarea** — segfaults. Use a `<text>` dash line instead.
7. **`scrollBy()` / `scrollTo()`, not `scrollToEnd()`** — the latter doesn't exist on `ScrollBoxRenderable`.
8. **Keyed `<Show>` + `&&`: object must be last** — `<Show when={obj() && bool}>{(v) => v().prop}</Show>` crashes because `&&` returns the boolean. Always: `<Show when={bool && obj()}>`.
9. **`backgroundColor=` not `bg=` on box** — `<box bg="…">` is silently ignored. `bg` only works on `<text>`.
10. **Render callbacks must be pure functions of their item** — Never read the list source, store, or unrelated signals inside a `<For>`/`<Index>` callback. OpenTUI's Zig engine sorts children by cached position — stale positions from re-created elements cause visual reordering. Derive all view state in a `createMemo` chain *before* the list (`filtered → grouped → flat → render-ready`). For selection highlighting, read a *scalar* signal (e.g. `selected()`) via a per-item `createMemo` inside the callback. Use `<For>` for stable object lists, `<Index>` for lists that recompute on every update.

## Project Structure

```
src/
  index.ts                  # CLI entry (registers SIGINT guard, dispatches)
  cli/
    program.ts              # Commander program + all subcommands
    options.ts              # Flag definitions (global + TUI + Slack)
    commands/run.ts         # Headless `bantai run`
  protocol/
    types.ts                # AgentEvent, AgentBackend, ConversationState, …
    reducer.ts              # reduce(state, event) -> newState
    registry.ts             # Backend registry + selection
    lifecycle.ts            # Session lifecycle helpers
    models.ts               # Model metadata
  backends/
    claude/                 # Claude Agent SDK (default)
    codex/                  # OpenAI Codex SDK
    acp/                    # Agent Client Protocol over JSON-RPC
    mock/                   # Deterministic in-process backend for tests
    shared/                 # base-adapter + cross-backend glue
  session/
    cross-backend.ts        # Session file parsing + resume across backends
    host.ts                 # SessionHost — the unit consumed by frontends
  frontends/
    tui/
      launcher.ts           # launchTui(flags)
      app.tsx               # Root SolidJS component
      components/           # One UI component per file (conversation, input,
                            # permission-dialog, session-picker, …)
      panels/               # Help / hotkeys / about / A-B overlay panels
      context/              # SolidJS reactive stores (sessions, messages, sync, …)
      theme/ hooks/ utils/
    slack/
      launcher.ts           # launchSlack(flags) — boots Bolt, wires pipeline
      routing.ts            # Per-event dispatch (split out of launcher)
      transport/            # Bolt app + raw events + interaction sanitizer
      inbox/                # dedup, gate, debouncer, turn-builder, attachments
      router/               # resolver (channel → project), registry (sessions),
                            # audit (config sanity)
      view/                 # event-renderer, outbox, format (mrkdwn),
                            # reactions, approvals, banner, uploads, …
      approvals/            # Interactive permission dialog coordinator
      elicitations/         # Interactive input coordinator
      store/sessions.ts     # Persistent session registry (crash recovery)
      config/{loader,schema}.ts
      commands/             # Slash commands (/new, /reset, …)
      mcp/                  # Slack-specific MCP servers (e.g. file upload)
      metrics/              # Prometheus-style counters (for HTTP mode)
      doctor.ts             # `bantai slack doctor` diagnostic
      manifest.ts           # `bantai slack init-manifest` generator
      admin/                # HTTP + WebSocket admin surface (bus, ring,
                            # server, protocol schemas) — feeds `slack-monitor/`
    slack-monitor/
      launcher.tsx          # launchSlackMonitor(flags) — resolves URL+token,
                            # bootstraps context, mounts the OpenTUI app
      app.tsx               # Root SolidJS component (panes + keybinds)
      context/              # Monitor store (reactive) + admin-context glue
      transport/            # Typed REST + WebSocket client (token-auth,
                            # reconnect w/ exponential backoff)
      panes/                # session-list, event-stream, metadata, approvals
      theme.ts              # Self-contained hex palette (Zig-FFI safe)
  minislack/                # Dev/test-only fake Slack server + web UI
  commands/                 # Slash-command registry + built-ins
  mcp/                      # Built-in MCP servers (state-bridge, tools)
  subagents/                # Sub-agent orchestration (A/B, judge, combine)
  config/settings.ts        # User settings
  utils/logger.ts           # File-based session logger (singleton `log`)
tests/
  protocol/                 # Contract + reducer tests (written FIRST)
  backends/                 # Adapter tests per backend
  tui/                      # Component tests
  frontends/slack/          # Slack pipeline + integration tests (incl.
                            # persistence, multi-channel, approvals, …)
  minislack/                # minislack server tests
  e2e/                      # End-to-end smoke tests
```

## State Machine

7 states: `INITIALIZING` → `IDLE` → `RUNNING` → `WAITING_FOR_PERM` / `WAITING_FOR_ELIC` → `INTERRUPTING` → `ERROR` / `SHUTTING_DOWN`.

Rules:

- `sendMessage()` queues everywhere, never blocks.
- `interrupt()` in `WAITING_FOR_PERM` must auto-deny first (or the SDK hangs).
- `interrupt()` in `WAITING_FOR_ELIC` must auto-respond first.
- Error transitions must `close()` the active generator (prevents zombie processes).

## Testing

```bash
bun test                          # All tests
bun test tests/protocol/          # Protocol + contract tests
bun test tests/backends/          # Adapter tests per backend
bun test tests/tui/               # TUI component tests
bun test tests/frontends/slack/   # Slack pipeline + integration tests
bun test tests/minislack/         # Fake Slack server
bun test --watch                  # Watch mode
```

**Contract tests** (`tests/protocol/contract.test.ts`) validate:

- `session_init` must be the first event.
- `turn_start` must precede `text_delta`.
- `turn_complete` must follow every turn.
- `permission_request` must block until approve/deny.
- No events after `close()`.

**Slack integration tests** run the real launcher against an in-process minislack, so any regression in the end-to-end pipeline (dedup → routing → outbox → mrkdwn) is caught there.

## Logging

Session logs live at `~/.bantai/logs/<session-id>.log`. Each run gets a unique file; the session ID and log path are printed on exit. Use `--debug` for event-level logging; default is `info`. Import the singleton via `import { log } from "./utils/logger"`.

## OpenTUI JSX Elements (TUI only)

From `@opentui/solid`: `<box>` (flexbox), `<text>`, `<scrollbox>` (`stickyScroll`, `stickyStart`), `<textarea>`, `<markdown>`, `<code>` (tree-sitter), `<diff>` (unified diff).

Key APIs: `render()`, `useKeyboard()`, `useRenderer()`, `useTerminalDimensions()`.
