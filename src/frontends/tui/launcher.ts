/**
 * TUI Launcher — boots the interactive terminal UI.
 *
 * Lives inside the TUI frontend (`src/tui/`) because it knows about
 * TUI-specific concerns: theme application, status bar presets, OpenTUI
 * rendering lifecycle, session picker preloading. The CLI (`src/cli/`)
 * is a thin dispatcher that calls into `launchTui()` — it doesn't reach
 * into TUI internals itself.
 *
 * Called by the default command, backend subcommands (claude/codex/gemini),
 * and session management subcommands (resume/continue).
 */

import { existsSync, statSync } from "node:fs"
import type { CLIFlags } from "../../cli/options"
import type { AgentBackend, SessionOrigin } from "../../protocol/types"
import { getBackendDescriptor, instantiateBackend } from "../../protocol/registry"
import { startApp } from "./app"
import { log } from "../../utils/logger"
import { backendTrace } from "../../utils/backend-trace"
import { SubagentManager } from "../../subagents/manager"
import { setSubagentManager } from "../../subagents/mcp-tools"
import { setCommandsManager } from "../../subagents/commands"
import { setupProcessHandlers } from "../../cli/lifecycle"
import { createSessionHost } from "../../session/host"

const VERSION = "0.1.0"

/**
 * Launch the interactive TUI with the given CLI flags.
 *
 * This is the main action for `bantai`, `bantai claude`, `bantai codex`,
 * `bantai gemini`, `bantai resume`, and `bantai continue`.
 */
export async function launchTui(flags: CLIFlags): Promise<void> {
  // Capture the actual launch directory before anything (SDK, plugins) can
  // change it. This is the CWD the user sees in their shell.
  const launchCwd = process.cwd()

  // Default config.cwd to the actual launch directory when not overridden
  if (!flags.config.cwd) {
    flags.config.cwd = launchCwd
  }

  // Fill in persisted defaults from the bantai settings loader. CLI flags
  // always win — we only touch values the user didn't provide.
  const { loadConfig } = await import("../../config/settings")
  const resolved = await loadConfig({ cwd: flags.config.cwd })
  if (!flags.theme && resolved.sources.theme && resolved.sources.theme !== "default") {
    flags.theme = resolved.values.theme
  }
  if (!flags.statusBar && resolved.values.statusBar) {
    // Always pull through — `default` still needs to be applied so an earlier
    // /status-bar change gets reset if the user hasn't overridden it.
    flags.statusBar = resolved.values.statusBar
  }
  if (flags.config.model === undefined && resolved.values.model) {
    const modelSource = resolved.sources.model
    const isClaudeBackend = !flags.backend || flags.backend === "claude"
    if (modelSource !== "claude-fallback" || isClaudeBackend) {
      flags.config.model = resolved.values.model
    }
  }
  if (flags.config.permissionMode === undefined && resolved.values.permissionMode) {
    flags.config.permissionMode = resolved.values.permissionMode
  }
  // Backend-level default (currently: claude → "auto"). Applied LAST in the
  // precedence chain — only kicks in when neither CLI nor any settings scope
  // supplied a value. See `BackendDescriptor.defaultPermissionMode`.
  if (flags.config.permissionMode === undefined) {
    const def = getBackendDescriptor(flags.backend)?.defaultPermissionMode
    if (def) flags.config.permissionMode = def
  }
  if (!flags.debug && resolved.values.debug) {
    flags.debug = true
  }

  // Configure logging
  if (flags.debug) {
    log.setLevel("debug")
  }
  backendTrace.setEnabled(flags.debugBackend)
  log.info("Starting bantai", { version: VERSION, backend: flags.backend, debug: flags.debug, cwd: flags.config.cwd })
  log.debug("Session config", flags.config)

  // Create backend
  let backend: AgentBackend
  if (flags.follow) {
    // Experimental: read-only follow mode. Detect the session origin first,
    // refuse cross-backend follow, and refuse if the ID isn't known at all.
    // The actual FollowBackend is wired up once the feature lands end-to-end;
    // this early-exit skeleton is the validation path.
    const { detectSessionOrigin } = await import("../../session/cross-backend")
    const { findClaudeSessionFileAnywhere, readClaudeSessionCwd } =
      await import("../../backends/follow/find-session")
    const callerCwd = flags.config.cwd ?? process.cwd()
    const origin = detectSessionOrigin(flags.follow.sessionId, callerCwd)
    if (!origin) {
      console.error(
        `No local session found with ID ${flags.follow.sessionId}. ` +
          `(Follow mode searches ~/.claude/projects, ~/.codex/sessions, and ~/.gemini/tmp.)`,
      )
      process.exit(2)
    }
    if (origin !== "claude") {
      console.error(
        `bantai follow only supports Claude sessions for now (session is from ${origin}).`,
      )
      process.exit(1)
    }

    // Locate the session on disk so we can chdir the bantai process into the
    // originating repo. This only affects the bantai process — the invoking
    // shell stays wherever it was, so `exit` returns the user to their
    // original dir. Reads the authoritative `cwd` from the JSONL itself
    // (Claude writes it on every entry); the decoded project-key fallback
    // handles the rare case where the JSONL is empty or unreadable.
    const found = findClaudeSessionFileAnywhere(flags.follow.sessionId, callerCwd)
    if (!found) {
      // detectSessionOrigin said "claude" so this is theoretically
      // unreachable — belt-and-braces since both helpers can race against
      // a session being deleted between the two calls.
      console.error(
        `No Claude session file found on disk for ID ${flags.follow.sessionId}.`,
      )
      process.exit(2)
    }
    const recordedCwd = readClaudeSessionCwd(found.path) ?? found.cwd
    let resolvedCwd = callerCwd
    if (
      existsSync(recordedCwd) &&
      statSync(recordedCwd).isDirectory()
    ) {
      try {
        if (recordedCwd !== callerCwd) {
          process.chdir(recordedCwd)
          log.info("bantai follow: chdir into session's originating cwd", {
            sessionId: flags.follow.sessionId,
            from: callerCwd,
            to: recordedCwd,
          })
        }
        resolvedCwd = recordedCwd
      } catch (err) {
        log.warn("bantai follow: chdir failed — staying in caller's cwd", {
          sessionId: flags.follow.sessionId,
          target: recordedCwd,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } else {
      log.warn(
        "bantai follow: originating cwd no longer exists — staying in caller's cwd",
        {
          sessionId: flags.follow.sessionId,
          recordedCwd,
          callerCwd,
        },
      )
    }
    flags.config.cwd = resolvedCwd

    // FollowBackend is resolved dynamically so the skeleton landed in commit
    // 1 (CLI + guard only) can validate the session origin without the
    // adapter implementation existing yet. Later commits wire this up.
    let adapterModule: typeof import("../../backends/follow/adapter") | null = null
    try {
      adapterModule = await import("../../backends/follow/adapter")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error("Follow adapter not implemented yet", { error: msg })
      console.error(
        `bantai follow is not yet implemented (missing src/backends/follow/adapter.ts).`,
      )
      process.exit(1)
    }
    try {
      backend = adapterModule.createFollowBackend({
        sessionId: flags.follow.sessionId,
        cwd: resolvedCwd,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error("Failed to create follow backend", { error: msg })
      console.error(`Error: ${msg}`)
      process.exit(1)
    }
    // Route the rest of the launcher through the "resume" path so the event
    // loop calls backend.start() with config.resume set — FollowBackend's
    // runSession reads that ID and begins tailing.
    flags.config.readOnly = true
    flags.config.resume = flags.follow.sessionId
    flags.config.sessionOrigin = "claude"
    // Follow sessions are observational; never write back to the session store.
    flags.config.persistSession = false
  } else {
    try {
      backend = instantiateBackend(flags.backend, {
        acpCommand: flags.acpCommand,
        acpArgs: flags.acpArgs,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error("Failed to create backend", { error: msg })
      console.error(`Error: ${msg}`)
      process.exit(1)
    }
  }

  log.info("Backend created", { backend: flags.backend })
  log.setBackendName(flags.backend)

  // Create SubagentManager and wire module-level setters
  const subagentManager = new SubagentManager()
  setSubagentManager(subagentManager)
  setCommandsManager(subagentManager)

  // Setup process lifecycle handlers (SIGINT, SIGTERM, etc.)
  setupProcessHandlers({ backend, subagentManager })

  // Check for piped stdin (non-TTY input)
  if (!process.stdin.isTTY && !flags.prompt) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk)
    }
    const piped = Buffer.concat(chunks).toString().trim()
    if (piped) {
      flags.prompt = piped
    }
  }

  // Apply theme if specified (must happen before render)
  if (flags.theme) {
    const { getTheme, listThemes } = await import("./theme/registry")
    const { applyTheme } = await import("./theme/tokens")
    const theme = getTheme(flags.theme)
    if (theme) {
      applyTheme(theme)
      log.info("Theme applied", { theme: flags.theme })
    } else {
      const available = listThemes().map((t) => t.id).join(", ")
      console.error(`Unknown theme: ${flags.theme}. Available: ${available}`)
      process.exit(1)
    }
  }

  // Apply status bar preset (soft-fails to default for unknown ids)
  if (flags.statusBar) {
    const { applyStatusBar } = await import("./status-bar/active")
    const { listStatusBars } = await import("./status-bar/registry")
    const result = applyStatusBar(flags.statusBar)
    if (result.fellBack) {
      const available = listStatusBars().map((p) => p.id).join(", ")
      console.error(
        `Unknown status bar preset: "${flags.statusBar}". Falling back to "${result.id}". Available: ${available}`,
      )
    } else {
      log.info("Status bar preset applied", { statusBar: result.id })
    }
  }

  // Pass initial prompt through config so the sync provider can handle it
  if (flags.prompt) {
    flags.config.initialPrompt = flags.prompt
  }

  // Set sessionOrigin so cross-backend resume detection works in SyncProvider
  flags.config.sessionOrigin = flags.backend

  // If --resume was used without a session ID, eagerly fetch sessions from
  // every backend that registers a `sessionFile.listFromDisk` handler. The
  // registry is the source of truth — adding a new backend with on-disk
  // session storage automatically pulls it into the multi-backend picker
  // (Sprint 1 / Cluster 1; live bug L1 — qwen sessions were silently dropped
  // because this loop used to be a hardcoded [claude, codex, gemini] triple).
  let preloadedSessions: import("../../protocol/types").MultiBackendSessions | undefined
  if (flags.config.resumeInteractive) {
    try {
      const { enrichSessions } = await import("../../session/cross-backend")
      const { listSessionFileBackends } = await import("../../protocol/registry")
      const cwd = flags.config.cwd ?? process.cwd()
      const backendKey = flags.backend

      const fileBackends = listSessionFileBackends()

      // Parallel disk scan across every registered backend with sessionFile.
      const diskByBackend = await Promise.all(
        fileBackends.map(async (b) => {
          try {
            return [b.id, b.sessionFile!.listFromDisk(cwd)] as const
          } catch (err) {
            log.warn("listFromDisk failed for backend", {
              backend: b.id,
              error: String(err),
            })
            return [b.id, [] as import("../../protocol/types").SessionInfo[]] as const
          }
        }),
      )

      // For the active backend, also try the SDK's listSessions() for richer
      // metadata (custom titles, message counts) and merge with disk results.
      let sdkSessions: import("../../protocol/types").SessionInfo[] = []
      try {
        sdkSessions = await backend.listSessions()
        for (const s of sdkSessions) {
          ;(s as any).origin = backendKey
        }
      } catch {
        // SDK not ready — disk results are fine
      }

      // Merge: prefer SDK sessions (richer metadata), fall back to disk
      const merge = (
        sdk: import("../../protocol/types").SessionInfo[],
        disk: import("../../protocol/types").SessionInfo[],
      ) => {
        const sdkIds = new Set(sdk.map(s => s.id))
        return [...sdk, ...disk.filter(s => !sdkIds.has(s.id))]
      }

      const raw: import("../../protocol/types").MultiBackendSessions = {}
      for (const [id, disk] of diskByBackend) {
        raw[id] = id === backendKey ? merge(sdkSessions, disk) : disk
      }

      // Enrich top-20 per backend with deep-parsed metadata.
      preloadedSessions = {}
      for (const [id, sessions] of Object.entries(raw)) {
        preloadedSessions[id] = enrichSessions(sessions, cwd, 20)
      }

      const counts: Record<string, number> = {}
      for (const [id, sessions] of Object.entries(preloadedSessions)) {
        counts[id] = sessions.length
      }
      log.info("Preloaded multi-backend sessions", counts)
    } catch (err) {
      log.warn("Failed to preload sessions", { error: String(err) })
      // Empty record: every fileBackend gets an empty list when reachable.
      preloadedSessions = {}
    }
  }

  // Build the SessionHost — the frontend-neutral unit of "one live session."
  // The TUI attaches to the host rather than receiving scattered fields; a
  // future Slack / GUI frontend constructs the same host type.
  const { createCleanup } = await import("../../cli/lifecycle")
  const host = createSessionHost({
    backend,
    config: flags.config,
    subagentManager,
    currentBackend: flags.backend as SessionOrigin,
    preloadedSessions,
    close: createCleanup({ backend, subagentManager }),
  })

  // Start the TUI — do not await; OpenTUI's native event loop keeps the process alive
  startApp({
    host,
    onExit: () => host.close(),
    noDiagnosticsMcp: flags.noDiagnosticsMcp,
  })
}
