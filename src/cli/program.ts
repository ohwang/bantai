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
  followCmd.action(async (sessionId: string) => {
    const opts = { ...program.opts(), ...followCmd.opts() }
    const flags = resolveFlags(opts)
    flags.follow = { sessionId }
    await launchTui(flags)
  })
  program.addCommand(followCmd)

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
      "Path to slack.json (default: ./.bantai/slack.json, ~/.bantai/slack.json)",
    )
    .option(
      "--slack-api-url <url>",
      "Override the Slack Web API base URL (e.g. for minislack: http://localhost:3102)",
    )
    // Admin surface flags. Each mirrors a field under slack.json's `admin`
    // block and only overrides when explicitly passed — absent flags leave
    // the config (or schema default) in place. `--admin` / `--no-admin`
    // flip the on/off switch, `--admin-read-only` enables read-only mode.
    .option("--admin", "Enable the admin HTTP+WebSocket surface")
    .option("--no-admin", "Disable the admin HTTP+WebSocket surface")
    .option("--admin-host <host>", "Bind host for the admin server (default: 127.0.0.1)")
    .option(
      "--admin-port <port>",
      "Bind port for the admin server (default: 8787, 0 = OS-picked)",
    )
    .option(
      "--admin-token-path <path>",
      "Path to the admin bearer-token file (default: ~/.bantai/slack/admin-token)",
    )
    .option(
      "--admin-read-only",
      "Run the admin surface in read-only mode (GETs + WS only, POSTs return 403)",
    )
  addGlobalOptions(slackCmd)
  slackCmd.action(async () => {
    const opts = { ...program.opts(), ...slackCmd.opts() }
    const flags = resolveFlags(opts)
    const adminOverrides = resolveAdminOverrides(opts)
    await launchSlack({
      ...flags,
      slackConfigPath: opts.slackConfig as string | undefined,
      slackApiUrlOverride: opts.slackApiUrl as string | undefined,
      ...(adminOverrides ? { adminOverrides } : {}),
    })
  })
  slackCmd
    .command("doctor")
    .description("Verify slack.json + workspace install without starting the server")
    // Intentionally no .option() here — `--slack-config` / `--slack-api-url`
    // live on the parent `slackCmd` so they work for both `bantai slack` and
    // `bantai slack doctor`. Redeclaring them on the subcommand causes
    // commander to bind the value to the parent and leave the child's own
    // opts empty — we use optsWithGlobals() below to read the merged view.
    .action(async (_subOpts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as {
        slackConfig?: string
        slackApiUrl?: string
      }
      const { runSlackDoctor, formatSlackDoctorReport } = await import(
        "../frontends/slack/doctor"
      )
      try {
        const report = await runSlackDoctor({
          ...(opts.slackConfig ? { configPath: opts.slackConfig } : {}),
          ...(opts.slackApiUrl ? { slackApiUrlOverride: opts.slackApiUrl } : {}),
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
    .command("monitor")
    .description("Connect a read-through TUI to a running `bantai slack` admin surface")
    .option(
      "--url <url>",
      "Admin server base URL (default: derived from slack.json admin.host/port)",
    )
    .option(
      "--token <value>",
      "Admin bearer token (default: read from --token-path or slack.json)",
    )
    .option(
      "--token-path <path>",
      "Path to the admin bearer-token file (default: from slack.json or ~/.bantai/slack/admin-token)",
    )
    .option(
      "--max-events <n>",
      "Cap per-session event tail held in memory (default: 1000)",
    )
    // `--slack-config` lives on the parent `slackCmd` — monitor picks it up via optsWithGlobals().
    .action(async (_subOpts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as {
        slackConfig?: string
        url?: string
        token?: string
        tokenPath?: string
        maxEvents?: string
      }
      const maxEvents =
        opts.maxEvents !== undefined ? Number(opts.maxEvents) : undefined
      if (maxEvents !== undefined && (!Number.isFinite(maxEvents) || maxEvents < 1)) {
        console.error(
          `Error: --max-events must be a positive integer, got "${String(opts.maxEvents)}"`,
        )
        process.exit(1)
      }
      const { launchSlackMonitor } = await import(
        "../frontends/slack-monitor/launcher"
      )
      try {
        await launchSlackMonitor({
          ...(opts.url ? { url: opts.url } : {}),
          ...(opts.token ? { token: opts.token } : {}),
          ...(opts.tokenPath ? { tokenPath: opts.tokenPath } : {}),
          ...(opts.slackConfig ? { slackConfigPath: opts.slackConfig } : {}),
          ...(maxEvents !== undefined ? { maxEventsPerSession: maxEvents } : {}),
        })
      } catch (err) {
        console.error(
          `bantai slack monitor failed: ${(err as Error).message ?? String(err)}`,
        )
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

/**
 * Collapse the admin-related CLI flags into the `adminOverrides` object
 * consumed by `launchSlack`. Returns `undefined` when the operator passed
 * NO admin flags — that way `launchSlack` knows the CLI had nothing to say
 * and leaves `config.admin` completely alone (including the `enabled`
 * default), rather than forcing every field to "preserve whatever
 * slack.json had". Every mapped key is optional, so passing one flag
 * still leaves the others alone.
 *
 * `--admin` + `--no-admin` are handled by commander's own negatable flag
 * support: when either is present, `opts.admin` is a boolean; when neither
 * was passed, the key is absent entirely.
 *
 * `--admin-port` is validated here (Number() + range) so a bad value
 * surfaces as a clean CLI error rather than a runtime config-resolve
 * exception deep in the launcher.
 */
function resolveAdminOverrides(
  opts: Record<string, unknown>,
):
  | {
      enabled?: boolean
      host?: string
      port?: number
      tokenPath?: string
      readOnly?: boolean
    }
  | undefined {
  const out: {
    enabled?: boolean
    host?: string
    port?: number
    tokenPath?: string
    readOnly?: boolean
  } = {}
  if (typeof opts.admin === "boolean") out.enabled = opts.admin
  if (typeof opts.adminHost === "string" && opts.adminHost.length > 0) {
    out.host = opts.adminHost
  }
  if (opts.adminPort !== undefined) {
    const n = Number(opts.adminPort)
    if (!Number.isFinite(n) || n < 0 || n > 65535) {
      console.error(
        `Error: --admin-port must be between 0 and 65535, got "${String(opts.adminPort)}"`,
      )
      process.exit(1)
    }
    out.port = n
  }
  if (typeof opts.adminTokenPath === "string" && opts.adminTokenPath.length > 0) {
    out.tokenPath = opts.adminTokenPath
  }
  if (typeof opts.adminReadOnly === "boolean") out.readOnly = opts.adminReadOnly
  return Object.keys(out).length === 0 ? undefined : out
}
