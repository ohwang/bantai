# Handling data from external sources

This is the deeper dive behind the **"never silently drop data from an external
source"** rule in `AGENTS.md` (§ Cross-cutting). Read that rule first; this
document just collects the postmortems and concrete patterns it encodes.

## The rule, restated

Every skip path on data we did not author MUST log; every unrecognised shape
MUST `log.warn`. A bare `break` / `continue` / `return []` / `if (!expected)
break` on external data is a bug.

External data, in this codebase, means: SDK events (Claude / Codex), session
JSONL files on disk, MCP payloads, ACP notifications, Slack events, and user
config. It does **not** include data we just constructed ourselves — those are
plain control-flow.

## Why we have this rule

Multiple production regressions in this repo all traced back to the same
shape — a parser that hit an unknown branch, took a `continue`, and produced a
silently smaller output. The two canonical examples:

- **"User messages vanish on resume"** — `session-reader.ts` had a branch over
  `MessageParam.content` that handled `Array<ContentBlockParam>` but
  bare-dropped the `string` form. The SDK types both as legal. Real JSONL has
  both. Resumed sessions silently lost their user turns. Fix:
  `extractUserMessageText` normalises the shape (upgrade `string` to
  `[{ type: "text", text }]`) before the main loop, and the unknown branch
  `log.warn`s with a snippet.
- **`<command-name>` markers leak into the live event stream** — the Claude
  event-mapper had its own copy of the user-content parser **without** the
  `detectSyntheticReason` filter that the JSONL reader used. Slash-command
  scaffolding (`<command-name>`, `<local-command-stdout>`, `isMeta: true`)
  ended up rendered as user turns. Fix: hoist `extractUserMessageText` and
  `detectSyntheticReason` into `src/backends/claude/jsonl-shapes.ts`; route
  every consumer through it. Synthetic turns are `log.debug`-suppressed with
  a named reason — never bare-dropped.

Both bugs share the failure mode: **TypeScript was happy** because the
input type technically allowed both shapes, and the code branched without
logging when reality landed on the unhandled side.

## Concrete patterns

### Event mappers (`src/backends/*/event-mapper.ts`)

Every SDK / ACP message branch either maps to an `AgentEvent` or logs.

- **Intentional suppressions** (per-delta items whose content arrives via
  `*_delta` events) use `log.debug` with a stable reason string. Don't use
  `log.warn` for these — they fire on every turn and would drown the log.
- **Unknown types/subtypes** and **expected field missing** use `log.warn`.
  These are the signals that a provider's protocol drifted and we need to
  add a branch.
- **Never `default: break`** without a log. If the switch is exhaustive over a
  closed enum, prefer `Record<X, V>` or an exhaustiveness assertion so TS
  catches the gap at compile time.

### Session-file parsers (`src/backends/claude/session-reader.ts`, `src/session/cross-backend.ts`)

The Claude SDK types `MessageParam.content` as
`string | Array<ContentBlockParam>`, and both forms appear in real JSONL.

- **Handle both shapes.** Prefer normalising at the top of the function
  (upgrade a string to `[{ type: "text", text }]`) and branching once,
  rather than carrying the union through every nested block.
- **When neither shape applies**, `log.warn` with a snippet of the offending
  payload. That snippet is what makes the log useful when a regression ships.
- **Synthetic SDK-injected turns** (compaction summaries, `<command-name>`
  slash markers, `<local-command-*>` wrappers, `isMeta: true`) are suppressed
  with `log.debug` that names the reason — not bare-dropped. The user-message
  regression above was exactly this bug.

### `as any` / `unknown` escape hatches

If you reach for `as any`, you owe either:

- a runtime type check at the same site, with a `log.warn` on the unexpected
  branch, **or**
- a tight narrowed type that justifies the cast.

"It's probably fine" is how this class of bug ships.

## See also

- `AGENTS.md` § Cross-cutting — the one-line rule.
- `src/backends/claude/jsonl-shapes.ts` — `extractUserMessageText`,
  `detectSyntheticReason`. Reference implementations.
- `src/utils/logger.ts` — the `log` singleton. Use `log.debug` for expected
  noise, `log.warn` for "this means the protocol drifted".
