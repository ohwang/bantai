/**
 * Control-command parser.
 *
 * The Slack frontend uses a text-prefix convention ("!bantai <cmd> [args]")
 * rather than Slack slash commands, because slash names collide with
 * whatever the workspace already has registered (plan §7.4). This parser
 * pulls the command + remainder out of the raw message text (AFTER the
 * bot mention has been stripped by `stripBotMention`).
 *
 * Pure: no IO, no logging. Returns `null` when the text is not a
 * control-command invocation.
 */

export interface ControlCommand {
  /** Normalised command name, e.g. "help", "stop", "model". */
  cmd: string
  /** Raw argument string — whatever followed the command name. */
  args: string
}

export interface ParseOpts {
  /** Prefix to match. Default "!bantai" — customised per plan §3.2. */
  prefix?: string
}

export function parseControlCommand(text: string, opts: ParseOpts = {}): ControlCommand | null {
  const prefix = opts.prefix ?? "!bantai"
  const trimmed = text.trim()
  // Allow "@alice: !bantai stop" and the like — look past any leading
  // @mention prefix the turn-builder injected.
  const afterPrefix = stripLeadingMentionPrefix(trimmed)
  if (!afterPrefix.startsWith(prefix)) return null
  const rest = afterPrefix.slice(prefix.length).trimStart()
  if (rest.length === 0) return { cmd: "help", args: "" }
  const match = /^(\S+)\s*(.*)$/.exec(rest)
  if (!match) return { cmd: "help", args: "" }
  const [, cmd, args] = match
  return { cmd: cmd!.toLowerCase(), args: args!.trim() }
}

/**
 * Turn-builder adds a "@<name>: " prefix (plan §2.3). When the user
 * writes "@bantai !bantai stop", the inbound turn text is
 * "@alice: !bantai stop" — strip the author prefix so the command
 * parser sees the command at the head.
 */
function stripLeadingMentionPrefix(text: string): string {
  return text.replace(/^@\S+:\s*/, "")
}
