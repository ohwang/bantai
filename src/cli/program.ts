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
 *   bantai slack                 → Slack frontend server (placeholder)
 */

import { Command } from "commander"
import { addGlobalOptions, addTuiOptions, resolveFlags } from "./options"
import { launchTui } from "../frontends/tui/launcher"
import { launchSlack } from "../frontends/slack/launcher"
import { launchMinislack } from "../minislack/launcher"
import type { FixtureName } from "../minislack/testing/fixtures"
import { runHeadless } from "./commands/run"

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
  addGlobalOptions(runCmd)
  addTuiOptions(runCmd)
  runCmd.action(async (messageParts: string[]) => {
    const message = messageParts.join(" ")
    const opts = { ...program.opts(), ...runCmd.opts() }
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
  resumeCmd.action(async (id: string | undefined) => {
    const opts = { ...program.opts(), ...resumeCmd.opts() }
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
  continueCmd.action(async () => {
    const opts = { ...program.opts(), ...continueCmd.opts() }
    opts.continue = true
    const flags = resolveFlags(opts)
    await launchTui(flags)
  })
  program.addCommand(continueCmd)

  // -----------------------------------------------------------------------
  // Backend subcommands: claude, codex, gemini
  // -----------------------------------------------------------------------
  for (const backendName of ["claude", "codex", "gemini"] as const) {
    const cmd = new Command(backendName)
      .description(`Launch TUI with ${backendName} backend`)
      .argument("[prompt]", "Initial prompt")
    addGlobalOptions(cmd)
    addTuiOptions(cmd)
    cmd.action(async (prompt: string | undefined) => {
      const opts = { ...program.opts(), ...cmd.opts() }
      const flags = resolveFlags(opts, prompt, backendName)
      await launchTui(flags)
    })
    program.addCommand(cmd)
  }

  // -----------------------------------------------------------------------
  // Frontend subcommand: slack — runs the Slack frontend server
  // -----------------------------------------------------------------------
  const slackCmd = new Command("slack")
    .description("Run bantai as a Slack frontend server")
    .option(
      "--slack-config <path>",
      "Path to slack.toml (default: ./.bantai/slack.toml, ~/.bantai/slack.toml)",
    )
    .option(
      "--slack-api-url <url>",
      "Override the Slack Web API base URL (e.g. for minislack: http://localhost:3102)",
    )
  addGlobalOptions(slackCmd)
  slackCmd.action(async () => {
    const opts = { ...program.opts(), ...slackCmd.opts() }
    const flags = resolveFlags(opts)
    await launchSlack({
      ...flags,
      slackConfigPath: opts.slackConfig as string | undefined,
      slackApiUrlOverride: opts.slackApiUrl as string | undefined,
    })
  })
  slackCmd
    .command("doctor")
    .description("Verify slack.toml + workspace install without starting the server")
    .option(
      "--slack-config <path>",
      "Path to slack.toml (default: ./.bantai/slack.toml, ~/.bantai/slack.toml)",
    )
    .option(
      "--slack-api-url <url>",
      "Override the Slack Web API base URL (e.g. minislack)",
    )
    .action(async (subOpts: {
      slackConfig?: string
      slackApiUrl?: string
    }) => {
      const { runSlackDoctor, formatSlackDoctorReport } = await import(
        "../frontends/slack/doctor"
      )
      try {
        const report = await runSlackDoctor({
          ...(subOpts.slackConfig ? { configPath: subOpts.slackConfig } : {}),
          ...(subOpts.slackApiUrl ? { slackApiUrlOverride: subOpts.slackApiUrl } : {}),
        })
        // eslint-disable-next-line no-console
        console.log(formatSlackDoctorReport(report))
        process.exit(report.findings.length === 0 ? 0 : 1)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`slack doctor failed: ${(err as Error).message ?? String(err)}`)
        process.exit(2)
      }
    })
  slackCmd
    .command("init-manifest")
    .description("Print a Slack app manifest for bantai (paste into api.slack.com)")
    .option("--format <json|yaml>", "Output format (default: yaml)", "yaml")
    .option("--name <name>", "App display name", "bantai")
    .option("--http", "Emit an HTTP-mode manifest (default: socket mode)")
    .option("--request-url <url>", "Events API request URL (HTTP mode)")
    .action(async (subOpts: {
      format: string
      name: string
      http?: boolean
      requestUrl?: string
    }) => {
      const { buildManifest, manifestToJson, manifestToYaml } = await import(
        "../frontends/slack/manifest"
      )
      const manifest = buildManifest({
        displayName: subOpts.name,
        socketMode: !subOpts.http,
        ...(subOpts.requestUrl ? { requestUrl: subOpts.requestUrl } : {}),
      })
      const out =
        subOpts.format === "json"
          ? manifestToJson(manifest)
          : manifestToYaml(manifest)
      // eslint-disable-next-line no-console
      console.log(out)
    })
  program.addCommand(slackCmd)

  // -----------------------------------------------------------------------
  // Dev tool: minislack — fake Slack server + web UI for testing frontends
  // -----------------------------------------------------------------------
  const minislackCmd = new Command("minislack")
    .description("Run a fake Slack workspace (dev + integration tests)")
    .option("--port <n>", "Port (default 3102; 0 = ephemeral)", "3102")
    .option("--persist [dir]", "Persist state to <dir> (default: ~/.bantai/minislack/default)")
    .option("--fixture <name>", "empty | basic | threaded | multi-user", "basic")
    .option("--emojis <file>", "Path to a JSON file of custom emoji ({ name: url-or-alias, ... } or raw emoji.list output)")
    .option("--no-web", "Skip serving the web UI")
  minislackCmd.action(async () => {
    const opts = minislackCmd.opts() as {
      port?: string
      persist?: boolean | string
      fixture?: string
      emojis?: string
      web?: boolean
    }
    const portNum = opts.port !== undefined ? Number(opts.port) : 3102
    if (!Number.isFinite(portNum) || portNum < 0) {
      console.error(`Error: --port must be a non-negative integer, got "${opts.port}"`)
      process.exit(1)
    }
    const persist =
      typeof opts.persist === "string"
        ? opts.persist
        : opts.persist === true
          ? "__default__"
          : undefined
    await launchMinislack({
      port: portNum,
      fixture: (opts.fixture ?? "basic") as FixtureName,
      persist,
      emojisFile: opts.emojis,
      serveWeb: opts.web !== false,
    })
  })
  program.addCommand(minislackCmd)

  // Parse and execute
  await program.parseAsync(argv)
}
