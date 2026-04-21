/**
 * Slash-command adapter.
 *
 * Bridges Slack's `/bantai <subcommand> [args]` wire format into the
 * transport-agnostic `ControlCommand` + `CommandContext` the existing
 * dispatcher (dispatch.ts) consumes. The module is pure — no IO, no
 * logging — so each layer stays unit-testable:
 *
 *   `parseSlashText(text)` → `ControlCommand`
 *   `classifyVisibility(cmd)` → "ephemeral" | "in_channel"
 *   `requiresThread(cmd)` → boolean
 *
 * The routing layer glues these to Bolt's `ack()` + the shared
 * SendAdapter (see routing.ts#handleSlashCommand).
 *
 * Why not reuse `parseControlCommand`? That parser matches a text prefix
 * (`!bantai …`); the slash payload already gave us everything AFTER the
 * command name in `payload.text`, so we just split the first whitespace
 * token and call it a command. Keeping it separate means the legacy
 * `!bantai` parser can be deleted alongside the surface in a later
 * commit without unwinding slash-command support.
 */

import type { ControlCommand } from "./parser"

/**
 * Parse the `text` portion of a Slack slash-command payload (everything
 * after `/bantai `). Empty input → `{ cmd: "help", args: "" }`, matching
 * the legacy `!bantai` shortcut.
 *
 * Case-normalises the command name to keep dispatch lookup cheap.
 * Preserves argument casing — `model` + `verbosity` both take
 * user-supplied identifiers verbatim.
 */
export function parseSlashText(text: string): ControlCommand {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { cmd: "help", args: "" }
  const match = /^(\S+)\s*(.*)$/.exec(trimmed)
  if (!match) return { cmd: "help", args: "" }
  const [, cmd, args] = match
  return { cmd: cmd!.toLowerCase(), args: args!.trim() }
}

/**
 * Visibility policy per plan D3:
 *   - informational reads → ephemeral (only the invoker)
 *   - state-changing writes + interrupts → in_channel (everyone in the
 *     thread sees the change)
 *   - unknown commands → ephemeral (a typo shouldn't shout at the
 *     channel)
 *
 * Kept as a table rather than a switch so the policy is reviewable at a
 * glance and easy to tweak. `EPHEMERAL_COMMANDS` is a readonly set
 * because TypeScript narrows the membership check and the caller never
 * needs to mutate it.
 */
export type SlashVisibility = "ephemeral" | "in_channel"

const IN_CHANNEL_COMMANDS: ReadonlySet<string> = new Set([
  "stop",
  "cancel",
  "interrupt",
  "new",
  "reset",
  "verbosity",
  // `model` alone is a read; `model <id>` is a write. The router upgrades
  // visibility when args are non-empty — see classifyVisibility.
])

export function classifyVisibility(cmd: ControlCommand): SlashVisibility {
  if (cmd.cmd === "model" && cmd.args.length > 0) return "in_channel"
  return IN_CHANNEL_COMMANDS.has(cmd.cmd) ? "in_channel" : "ephemeral"
}

/**
 * Commands that operate on a specific thread's session. When invoked
 * without `thread_ts` in the slash payload, the router short-circuits
 * with a "run this inside a thread" ephemeral instead of guessing which
 * session the user meant.
 *
 * Channel-level reads (help, status, settings, cost, model-list) stay
 * outside this set so they work from the channel composer too.
 */
const THREAD_SCOPED_COMMANDS: ReadonlySet<string> = new Set([
  "stop",
  "cancel",
  "interrupt",
  "new",
  "reset",
  "verbosity",
])

export function requiresThread(cmd: ControlCommand): boolean {
  // `model <id>` mutates the live session's model — requires a thread.
  // `model` alone is a read and works at channel level (shows the list).
  if (cmd.cmd === "model" && cmd.args.length > 0) return true
  return THREAD_SCOPED_COMMANDS.has(cmd.cmd)
}

/**
 * Normalised copy for the "run inside a thread" ephemeral. Hoisted so
 * tests can reference the same string without duplicating the wording.
 */
export const THREAD_REQUIRED_HINT =
  "this `/bantai` command needs a thread — invoke it from inside a " +
  "thread (the reply composer), not from the channel's top-level " +
  "message box."
