<!--
  AGENTS.md is the canonical project doc; CLAUDE.md is a symlink to it.

  Sections marked DERIVED are facts mirrored from code or descriptor
  registries. When you add or remove an entry in the underlying source,
  update the doc to match (or, better, replace the hand-list with a link to
  the helper). `bun run docs:check` grep-asserts the highest-risk facts.

  Sections marked PROSE are rules and postmortems. Edit freely; just keep
  rules one sentence, with deeper-dive prose linked into `docs/` rather than
  inlined.

  | Section                            | Kind    | Source of truth                                  |
  | ---------------------------------- | ------- | ------------------------------------------------ |
  | Quick Start                        | PROSE   | -                                                |
  | Build Requirements                 | PROSE   | -                                                |
  | Tech Stack                         | PROSE   | `package.json`                                   |
  | Architecture                       | DERIVED | `src/protocol/registry.ts` + the layout on disk  |
  | Cross-cutting / TUI rules          | PROSE   | -                                                |
  | The drift-contract recipe          | PROSE   | -                                                |
  | TUI — OpenTUI Prop Rules           | PROSE   | `scripts/lint-opentui.sh` enforces a subset      |
  | Project Structure                  | DERIVED | the actual layout on disk                        |
  | State Machine                      | DERIVED | `src/protocol/session-state.ts` (`SESSION_STATES`) |
  | Testing                            | PROSE   | -                                                |
  | Logging                            | PROSE   | `src/utils/logger.ts`                            |
-->

# bantai

Multi-surface UI for agentic coding backends. Decoupled from any single coding agent (Claude Code, Codex, ACP, …) and from any single surface — the agent protocol layer here is consumed today by a local TUI and (in a separate companion repo, [bantai-slack](https://github.com/ohwxyz/bantai-slack)) by a Slack frontend, both driven by the same event stream.

## Quick Start

```bash
bun install

# TUI
bun run dev                       # default backend (claude)
bun test                          # run all tests
```

The Slack frontend lives in [bantai-slack](https://github.com/ohwxyz/bantai-slack) and ships its own `bantai-slack` bin. It is NOT a subcommand of `bantai` — install bantai-slack globally and invoke it directly (`bantai-slack`, `bantai-slack doctor`, `bantai-slack minislack`, …).

## Build Requirements

- Bun ≥ 1.3.11 (OpenTUI's Zig FFI bindings require Bun; no Node.js support).
- `bunfig.toml` must include `preload = ["@opentui/solid/preload"]` (Babel plugin for SolidJS JSX).
- Run with `--conditions=browser` (already set in every `package.json` script and in `bin/bantai` / `bin/bantai-storybook`).

## Tech Stack

- Bun + TypeScript (strict; `tsc --noEmit` must pass).
- **TUI frontend:** OpenTUI + SolidJS via `@opentui/solid` (NOT React).
- **Slack frontend:** lives in [bantai-slack](https://github.com/ohwxyz/bantai-slack); imports this package's protocol/session/backends layer via a path-dep.
- **Backends:** `@anthropic-ai/claude-agent-sdk` (track latest), `@openai/codex-sdk`, ACP over JSON-RPC (Gemini, Qwen, GitHub Copilot, generic), and an in-process mock. Authoritative list: `BACKEND_REGISTRY` in `src/protocol/registry.ts`.
- **Everything else:** `commander` (CLI), `zod` (config schemas), `fuzzysort` (file/session search), `jsonc-parser` (configs with comments).

## Architecture

Three layers, strictly ordered:

1. **CLI Entry Point** (`src/index.ts`, `src/cli/`) — Commander-based subcommand dispatch.
   - `bantai [prompt]` → TUI (default backend)
   - `bantai <id> [prompt]` → TUI with a specific backend, where `<id>` is any backend with `exposeAsCliSubcommand: true` in `BACKEND_REGISTRY` (today: `claude`, `codex`, `gemini`, `qwen`). `bantai --help` prints the live list.
   - `bantai run <message…>` → headless one-shot
   - `bantai resume [id]` / `bantai continue` → session resume

   The Slack frontend ships as a separate bin (`bantai-slack`) in the [bantai-slack](https://github.com/ohwxyz/bantai-slack) companion repo and is NOT exposed under `bantai`. Install bantai-slack globally and invoke it directly.
2. **Frontends** (`src/frontends/<name>/`) — each owns its own presentation + transport and exposes a `launch<Name>(flags)` entry point. In this repo: `tui/` (interactive terminal, default). The Slack frontend (`slack/`, `slack-monitor/`) lives in the [bantai-slack](https://github.com/ohwxyz/bantai-slack) companion repo. Nothing in the protocol or backend layer depends on a specific frontend.
3. **Agent Protocol Layer** (`src/protocol/`) — unified `AgentBackend` interface, `AgentEvent` stream, `ConversationState`, the `reduce(state, event) -> newState` reducer, plus the descriptor registries for backends, permission modes, effort levels, session states, rate-limit buckets, and capabilities. Backend adapters live under `src/backends/{acp,claude,codex,follow,mock,shared}/`; `follow/` is the read-only adapter that tails an existing session file, `shared/` holds the cross-backend base adapter.

The protocol layer is the load-bearing abstraction: **adding a frontend or backend means implementing the relevant side of this contract — never forking reducer or event semantics.**

## Key Conventions

### Cross-cutting (apply everywhere)

- **`tsc --noEmit` must pass.** Never commit code that adds new TypeScript errors.
- **Types as documentation.** `src/protocol/types.ts` IS the spec.
- **Test contracts, not implementations.** Adapter contract tests validate event ordering and lifecycle rules (see §Testing).
- **One concern per file.** Size is a proxy for cohesion, not a rule. Target ~800 lines, hard cap ~1200; past that, justify in a top-of-file comment or split. Exempt: type/schema specs, vendored code, generated code.
- **No Effect.js, no metaprogramming, no deep inheritance.** Plain TypeScript; factory functions for service construction; explicit over clever.
- **Never silently drop data from an external source.** SDK events, session JSONL, MCP payloads, ACP notifications, user config — every skip path MUST log; unrecognised shapes use `log.warn`, intentional suppressions use `log.debug` with a named reason. A bare `break` / `continue` / `return []` / `if (!expected) break` on external data is a bug. Deep dive + postmortems: [`docs/external-data-handling.md`](docs/external-data-handling.md).
- **Prefer framework primitives over custom logic.** Use OpenTUI / SolidJS / SDK built-ins before writing manual workarounds. E.g. `stickyScroll={true}` + `stickyStart="bottom"` on `<scrollbox>` replaces 80+ lines of timer-based nudging.
- **Cleanup must survive deletion.** When removing a variable/timer, grep for ALL references including `onCleanup` and server shutdown hooks. A dangling reference there prevents `process.exit()` and silently breaks exit.

### The drift-contract recipe (closed enumerations)

A closed enumeration of values — backends, permission modes, effort levels, session states, output formats, rate-limit buckets — gets stored exactly **once**, in a typed array of descriptors next to the helpers that consume it. Anything else (a second `Set` "for validation", a comma-typed help string, a hand-rolled switch in some component) is drift. The qwen integration shipped with five live regressions of exactly this class; the anti-drift sprint (Sprint 1, commits `d08cfdd` → `9fda075`) collapsed them onto this recipe and you should keep using it.

**The recipe:**

1. **Source of truth = a typed array of descriptors** in one file. Not a union, not a `Set`. An array because you can iterate it; descriptors because you can attach behavior alongside the id.
2. **Type derived from the array**: `type X = typeof X_REGISTRY[number]["id"]`. Removes the "two declarations" failure mode entirely.
3. **Helpers next to the array**: `isKnownX(id)`, `knownXIds()`, `getXDescriptor(id)`, `listXForCli()`. Consumers import these — never the array directly, never a fresh literal.
4. **Help text built at call-site**: `` `Choices: ${knownXIds().join(", ")}` `` rather than a string constant. Adding an entry updates every help message automatically.
5. **Validators delegate**: zod becomes `z.string().refine(isKnownX)`; switches over the enum become `Record<X, V>` to get exhaustiveness from TS. The exhaustive-Record pattern is load-bearing — it's what catches missing cases at compile time so they can't ship as silent rendering bugs (live bug L5 was exactly this — a `switch (state)` that silently dropped two states into `default`).

**Existing registries that follow the recipe** (use them as templates):

| Concept | File | Live bug it caught |
|---|---|---|
| Backend ids | `src/protocol/registry.ts` (`BACKEND_REGISTRY`) | qwen integration — silent rejections in 3 files |
| Permission modes | `src/protocol/permission-modes.ts` (`PERMISSION_MODES`, `cyclerPermissionModeIds()`) | TUI Shift-Tab cycler missing `dontAsk` (L3) |
| Effort levels | `src/protocol/effort-levels.ts` (`EFFORT_LEVELS`, `RUNTIME_EFFORT_LEVELS`) | `/thinking max` accepted by validator while help said no (L6 / Codex caps) |
| Session states | `src/protocol/session-state.ts` (`SESSION_STATES`, `STATE_LABELS`, `STATE_GLYPHS`, `STATE_SEVERITIES`) | Diagnostics panel rendering wrong color for INITIALIZING/SHUTTING_DOWN (L5) |
| Rate-limit buckets | `src/protocol/rate-limits.ts` (`RATE_LIMIT_BUCKETS`) | — |
| Output formats | `src/cli/options.ts` (`OUTPUT_FORMATS`) | — |
| Backend session storage | `BackendDescriptor.sessionFile` (`listFromDisk`, `parseSummary`, `readBlocks`) | Multi-backend picker silently dropped qwen (L1) |
| User JSONL parsing | `src/backends/claude/jsonl-shapes.ts` (`detectSyntheticReason`, `extractUserMessageText`) | `<command-name>` markers / compaction summaries leaked into live stream (L2) |

**When a closed enumeration is genuinely a subset of a wider registry** (canonical example: a frontend that supports a strict subset of `BACKEND_REGISTRY` — say `claude` / `codex` / `gemini` only), the same recipe applies one level out: define an explicit allowlist array, validate it against `isKnownX` at module-load time, and have the subset-aware code consume that allowlist.

**When you reach for a hand-rolled `Set`, switch, or string literal of enum values, ask first:** is there a registry already? If yes, import the helper. If no, and the enumeration is closed, file it as a registry following this recipe before you write the second copy.

### TUI frontend (SolidJS + OpenTUI)

- **SolidJS, not React.** Use `createSignal`, `createStore`, `createMemo`, `batch()`. No `useEffect`, `useState`, `useRef`.
- **Context-based DI.** One `AppContext` created at startup via factories. `<AppContext.Provider>` wraps root. Components use `useApp()`.
- **Event-sourced state.** The TUI renders from `ConversationState`, never raw events.
- **16ms event batching.** Wrap signal updates from high-frequency sources in Solid's `batch()`.
- **Runtime-mutable values must be SolidJS signals or stores.** Plain objects / module-level constants are for truly immutable data only (string enums, static config). Theme colors (`colors` in `tokens.ts`) are a store — never snapshot them into a `const`; read inline in JSX or via `() =>` accessor.
- **Cross-cutting keyboard shortcuts run FIRST in the root handler, not in overlays.** Any `useKeyboard` intercept that does blanket `event.preventDefault()` on non-whitelist keys (the usual "overlay is open — eat everything" pattern) silently swallows global shortcuts like Cmd+C copy. Centralise them as small helpers at the top of the root `useKeyboard` in `src/frontends/tui/app.tsx` (e.g. `tryHandleCopyShortcut`) and invoke them before any overlay branch.

### Slack frontend

The Slack frontend (Bolt server, pipeline, doctor, admin API, observability TUI, fake-Slack server) lives in the [bantai-slack](https://github.com/ohwxyz/bantai-slack) companion repo. Its rules — pipeline ordering, `markdownText` vs `text`, API-call coalescing, persistence semantics — live there too. When a Slack-shape concern affects the protocol layer in this repo (e.g. an event semantics change), update both repos in lockstep.

## TUI — OpenTUI cheatsheet

`bun run lint:opentui` enforces the subset of these the script can detect.

### Prop rules (CRITICAL — silent rendering failures + Zig FFI crashes)

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

### JSX elements + APIs

From `@opentui/solid`: `<box>` (flexbox), `<text>`, `<scrollbox>` (`stickyScroll`, `stickyStart`), `<textarea>`, `<markdown>`, `<code>` (tree-sitter), `<diff>` (unified diff). Key APIs: `render()`, `useKeyboard()`, `useRenderer()`, `useTerminalDimensions()`.

## Project Structure

One-liner per top-level dir; deeper layout is intentionally left to `ls` so the doc can't drift on every refactor. The directories whose *purpose* you can't infer from the filename are the ones called out below.

```
src/
  index.ts            # CLI entry: registers SIGINT guard, dispatches to a frontend launcher
  cli/                # Commander program + flag definitions + headless `run` command
  protocol/           # AgentBackend interface, AgentEvent, reducer, descriptor registries
  backends/           # Adapters: claude, codex, acp, follow, mock, shared (base + glue)
  session/            # SessionHost (the unit consumed by frontends) + cross-backend resume
  frontends/          # tui/ (the only in-tree frontend; bantai-slack is a companion repo)
  ab/                 # A/B comparison: spawn two backends, judge + combine outputs
  subagents/          # Sub-agent definitions + orchestration
  commands/           # Slash-command registry + built-ins (/thinking, /backend, …)
  mcp/                # Built-in MCP servers (state-bridge, tools)
  storybook/          # Component storybook for the TUI
  config/settings.ts  # User settings persistence
  utils/logger.ts     # File-based session logger (singleton `log`)
tests/                # Mirrors src/; protocol/ holds the contract tests, written FIRST
```

## State Machine

States and lifecycle order live in `src/protocol/session-state.ts` (`SESSION_STATES`). At the time of writing, 8 entries: `INITIALIZING` → `IDLE` → `RUNNING` → `WAITING_FOR_PERM` / `WAITING_FOR_ELIC` → `INTERRUPTING` → `ERROR` / `SHUTTING_DOWN`.

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
bun test --watch                  # Watch mode
bun run docs:check                # Grep-asserts high-risk facts in this doc
```

**Contract tests** (`tests/protocol/contract.test.ts`) validate:

- `session_init` must be the first event.
- `turn_start` must precede `text_delta`.
- `turn_complete` must follow every turn.
- `permission_request` must block until approve/deny.
- No events after `close()`.

(Slack pipeline + integration tests live in [bantai-slack](https://github.com/ohwxyz/bantai-slack); they exercise the same protocol contract from the Slack side.)

## Logging

Session logs live at `~/.bantai/logs/<session-id>.log`. Each run gets a unique file; the session ID and log path are printed on exit. Use `--debug` for event-level logging; default is `info`. Import the singleton via `import { log } from "./utils/logger"`.
