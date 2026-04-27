/**
 * CLI Program — Commander.js program definition with subcommands
 *
 * Defines the command structure:
 *   bantai [prompt]              → TUI with default backend (claude)
 *   bantai run <message..>       → headless non-interactive mode
 *   bantai resume [id]           → resume a session (interactive picker if no id)
 *   bantai continue              → continue most recent session
 *   bantai claude [prompt]       → TUI with claude backend
 *   bantai codex [prompt]        → TUI with codex backend
 *   bantai gemini [prompt]       → TUI with gemini backend
 *
 * The Slack frontend is a separate bin (`bantai-slack`) shipped by the
 * companion repo at https://github.com/ohwxyz/bantai-slack. It is NOT
 * exposed as a subcommand of `bantai` — install bantai-slack globally
 * and invoke it directly.
 */

import { Command } from "commander"
import { addGlobalOptions, addTuiOptions, listOutputFormatsForCli, resolveFlags } from "./options"
import { launchTui } from "../frontends/tui/launcher"
import { runHeadless } from "./commands/run"
import { listCliSubcommandBackends } from "../protocol/registry"

const VERSION = "0.1.0"

/**
 * Build and run the CLI program.
 *
 * @param argv - process.argv (includes bun/node and script path)
 */
export async function runCli(argv: string[]): Promise<void> {
  const program = new Command()

  program
    .name("bantai")
    .description("Open-source terminal UI for agentic coding backends")
    .version(VERSION, "-v, --version")
    .argument("[prompt]", "Initial prompt")
    .allowUnknownOption(false)

  // Attach global options to the root program
  addGlobalOptions(program)

  // Attach TUI-specific options to the root program (default command)
  addTuiOptions(program)

  // Default action: launch TUI
  program.action(async (prompt: string | undefined) => {
    const opts = program.opts()
    const flags = resolveFlags(opts, prompt)
    await launchTui(flags)
  })

  // -----------------------------------------------------------------------
  // Subcommand: run <message..>
  // -----------------------------------------------------------------------
  const runCmd = new Command("run")
    .description("Run non-interactively with default backend")
    .argument("<message...>", "Message to send")
    .option(
      "--output-format <format>",
      `Output format: ${listOutputFormatsForCli()}`,
    )
  addGlobalOptions(runCmd)
  addTuiOptions(runCmd)
  runCmd.action(async (messageParts: string[], _opts: unknown, cmd: Command) => {
    const message = messageParts.join(" ")
    // optsWithGlobals merges parent + self correctly; a manual spread of
    // `{ ...program.opts(), ...runCmd.opts() }` lets defaults on the child
    // (e.g. --acp-args' `[]`) clobber the actually-parsed parent value.
    const opts = cmd.optsWithGlobals()
    const flags = resolveFlags(opts)
    await runHeadless(flags, message)
  })
  program.addCommand(runCmd)

  // -----------------------------------------------------------------------
  // Subcommand: resume [id]
  // -----------------------------------------------------------------------
  const resumeCmd = new Command("resume")
    .description("Resume a session (omit id for interactive picker)")
    .argument("[id]", "Session ID to resume")
  addGlobalOptions(resumeCmd)
  addTuiOptions(resumeCmd)
  resumeCmd.action(async (id: string | undefined, _opts: unknown, cmd: Command) => {
    const opts = cmd.optsWithGlobals()
    // Set resume flags as if --resume was used
    if (id) {
      opts.resume = id
    } else {
      opts.resume = true // triggers resumeInteractive
    }
    const flags = resolveFlags(opts)
    await launchTui(flags)
  })
  program.addCommand(resumeCmd)

  // -----------------------------------------------------------------------
  // Subcommand: continue
  // -----------------------------------------------------------------------
  const continueCmd = new Command("continue")
    .description("Continue most recent session")
  addGlobalOptions(continueCmd)
  addTuiOptions(continueCmd)
  continueCmd.action(async (_opts: unknown, cmd: Command) => {
    const opts = cmd.optsWithGlobals()
    opts.continue = true
    const flags = resolveFlags(opts)
    await launchTui(flags)
  })
  program.addCommand(continueCmd)

  // -----------------------------------------------------------------------
  // Subcommand: follow <session-id>  (experimental)
  //
  // Read-only TUI that tails a live Claude session JSONL on the same host.
  // Claude-only, same-host only — see team/bantai-follow-tui.md.
  // -----------------------------------------------------------------------
  const followCmd = new Command("follow")
    .description("Follow a live Claude session read-only (experimental)")
    .argument("<session-id>", "Session ID to follow")
  addGlobalOptions(followCmd)
  addTuiOptions(followCmd)
  followCmd.action(async (sessionId: string, _opts: unknown, cmd: Command) => {
    const opts = cmd.optsWithGlobals()
    const flags = resolveFlags(opts)
    flags.follow = { sessionId }
    await launchTui(flags)
  })
  program.addCommand(followCmd)

  // -----------------------------------------------------------------------
  // Backend subcommands — derived from the registry. Any descriptor with
  // `exposeAsCliSubcommand: true` automatically gets a `bantai <id>` verb.
  // -----------------------------------------------------------------------
  for (const descriptor of listCliSubcommandBackends()) {
    const backendName = descriptor.id
    const cmd = new Command(backendName)
      .description(`Launch TUI with ${descriptor.displayName} backend`)
      .argument("[prompt]", "Initial prompt")
    addGlobalOptions(cmd)
    addTuiOptions(cmd)
    cmd.action(async (prompt: string | undefined, _opts: unknown, c: Command) => {
      const opts = c.optsWithGlobals()
      const flags = resolveFlags(opts, prompt, backendName)
      await launchTui(flags)
    })
    program.addCommand(cmd)
  }

  // Parse and execute
  await program.parseAsync(argv)
}
