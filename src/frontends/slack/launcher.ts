/**
 * Slack Launcher — boots the Slack frontend server.
 *
 * Wires the full round-trip pipeline:
 *
 *   Slack event → inbox (dedup + gate + turn-build) → router (resolver +
 *   session registry) → SessionHost.send → backend emits AgentEvents →
 *   view event-renderer → chat.postMessage / chat.update / files.upload /
 *   reactions.add / Block Kit cards.
 *
 * The per-event dispatch + routing helpers live in `./routing.ts` to
 * keep this file focused on boot / lifecycle.
 */

import type { App } from "@slack/bolt"
import type { CLIFlags } from "../../cli/options"
import { log } from "../../utils/logger"
import { loadSlackConfig } from "./config/loader"
import type { ResolvedSlackConfig } from "./config/schema"
import {
  attachFatalAuthGuard,
  createBoltApp,
  runBootDiagnostics,
  verifyAuth,
} from "./transport/bolt"
import { registerEvents } from "./transport/events"
import {
  createSessionRegistry,
  type SessionRegistry,
  type BuildHostOpts,
  type HostPair,
} from "./router/registry"
import { auditSlackConfig } from "./router/audit"
import { createDedupCache } from "./inbox/dedup"
import { createThreadParticipationCache } from "./inbox/thread-participation"
import {
  appendNativeSlackStream,
  startNativeSlackStream,
  stopNativeSlackStream,
} from "./view/native-stream"
import type { NativeStreamCapability } from "./view/outbox"
import { createUserCache, type UserCache } from "./view/user-cache"
import { buildDefaultSendAdapter } from "./view/event-renderer"
import { createApprovalCoordinator } from "./approvals/coordinator"
import { createElicitationCoordinator } from "./elicitations/coordinator"
import {
  createAttachmentFetcher,
  type AttachmentFetcher,
} from "./inbox/attachments"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { createSlackUploadMcpServer } from "./mcp/slack-upload"
import { buildSlackFileClient } from "./view/upload"
import {
  createMetricsCollector,
  type MetricsCollector,
} from "./metrics/collector"
import {
  createNoopSessionStore,
  createSessionStore,
  type SessionStore,
} from "./store/sessions"
import {
  buildRoutingHandler,
  invalidateProjectOverrides,
  parseSessionKey,
  type RoutingCtx,
  type RuntimeChannelOverride,
} from "./routing"
import {
  createConfigReloader,
  formatDiffSummary,
  formatRejectionSummary,
  type ConfigReloader,
} from "./config/reloader"
import { markdownToSlackMrkdwn } from "./view/format"
import { homedir } from "node:os"
import { join as pathJoin, dirname } from "node:path"
import { mkdirSync } from "node:fs"

export { mergeCumulativeUsage } from "./usage"

export interface LaunchSlackOpts extends CLIFlags {
  /** Explicit slack.json path — takes precedence over config search. */
  slackConfigPath?: string
  /** Override for workspace.slack_api_url — the minislack URL in tests. */
  slackApiUrlOverride?: string
  /**
   * Inline config object — bypasses the filesystem search. Integration tests
   * use this to drive the launcher from in-process minislack handles.
   */
  slackConfigInline?: unknown
  /**
   * When true, return after the server is ready instead of blocking forever.
   * Integration tests use this; the CLI path does not.
   */
  returnHandle?: boolean
  /**
   * Test hook — override the router's host factory (e.g. plug in a stub
   * backend that emits canned events). Production code leaves this unset.
   */
  buildHost?: (opts: BuildHostOpts) => HostPair
  /**
   * Test hook — override the inbound-attachment fetcher. Integration tests
   * inject a fake fetcher so uploads can be driven without Slack's actual
   * file-download endpoint.
   */
  attachmentFetcher?: AttachmentFetcher
  /** Override the staging directory for inbound files. */
  attachmentStagingDir?: string
}

export interface SlackLaunchHandle {
  app: App
  config: ResolvedSlackConfig
  botUserId: string
  registry: SessionRegistry
  userCache: UserCache
  /** Live metrics collector — exposed for tests + future introspection. */
  metrics: MetricsCollector
  stop(): Promise<void>
}

export async function launchSlack(opts: LaunchSlackOpts): Promise<SlackLaunchHandle | void> {
  if (opts.debug) log.setLevel("debug")
  else log.setLevel("info")

  // When run in the foreground (CLI path, not integration tests), print a
  // startup banner and mirror log lines to stdout so the operator can see
  // what the server is doing in real time. Without this, `bantai slack`
  // looks hung — the only output is eventually written to the log file.
  const unsubscribeConsoleLogs = opts.returnHandle
    ? null
    : attachConsoleLogStream(opts.debug ? "debug" : "info")
  if (!opts.returnHandle) {
    process.stdout.write(
      "bantai slack — starting Slack frontend server\n" +
        `  log file: ${log.getLogFile()}\n` +
        `  verbosity: ${opts.debug ? "debug" : "info"}` +
        `${opts.debug ? "" : " (pass --debug for more detail)"}\n` +
        "  press Ctrl-C to stop\n\n",
    )
  }

  const config = await loadSlackConfig({
    path: opts.slackConfigPath,
    cwd: opts.config.cwd,
    inline: opts.slackConfigInline,
  })
  if (opts.slackApiUrlOverride) {
    config.workspace.slackApiUrl = opts.slackApiUrlOverride
  }

  log.info(
    `slack: loaded config from ${config.source} (mode=${config.workspace.mode}` +
      (config.workspace.slackApiUrl ? `, api=${config.workspace.slackApiUrl}` : "") +
      `)`,
  )

  // Run the boot-time config audit BEFORE we stand up Bolt / the registry.
  // Findings are informational; we still proceed with launch so a partial
  // misconfiguration doesn't block the operator.
  for (const finding of auditSlackConfig(config, {
    launchCwd: opts.config.cwd ?? process.cwd(),
  })) {
    if (finding.severity === "warn") log.warn(`slack audit: ${finding.message}`)
    else log.info(`slack audit: ${finding.message}`)
  }

  // Metrics collector + /metrics route. Wired only in HTTP mode — Socket
  // Mode has no HTTP receiver surface to attach to, so scrapers can't
  // reach it anyway. The collector still exists in Socket Mode for
  // symmetry (registry + coordinator record into it), just with no
  // scrape endpoint.
  const metrics: MetricsCollector = createMetricsCollector()
  const metricsRoute =
    config.workspace.mode === "http"
      ? [
          {
            path: "/metrics",
            method: "GET",
            handler: (
              _req: import("node:http").IncomingMessage,
              res: import("node:http").ServerResponse,
            ) => {
              res.writeHead(200, {
                "content-type": "text/plain; version=0.0.4; charset=utf-8",
              })
              res.end(metrics.render())
            },
          },
        ]
      : []

  const app = createBoltApp({ config, customRoutes: metricsRoute })
  // Guard against token-revocation / account-deactivation reconnect loops.
  // Bolt's socket client otherwise spins forever on `invalid_auth`, which
  // looks identical to a transient outage in the log. On a fatal auth
  // error we log loud and exit with a non-zero code so supervisor
  // processes (systemd, k8s) see the failure and stop restarting.
  attachFatalAuthGuard(app, {
    onFatal: () => {
      // Give the error log a beat to flush, then exit. Skip in tests
      // that set returnHandle — the caller owns shutdown there.
      if (opts.returnHandle) return
      setTimeout(() => process.exit(1), 100)
    },
  })
  await app.start()
  const auth = await verifyAuth(app)
  // Boot-time scope probes — best-effort, never blocks startup. Log each
  // finding as a warn so operators see the missing-scope list without
  // having to know which probe failed.
  for (const f of await runBootDiagnostics(app)) {
    log.warn(`slack diagnostic: ${f.message}`)
  }
  const launchCwd = opts.config.cwd ?? process.cwd()
  const workspaceId = auth.teamId ?? "unknown"

  // Open the persistent session store (S8 crash recovery). Empty path
  // keeps the store out of the picture — useful for tests + for operators
  // who explicitly opt out of persistence.
  const store = openSessionStore(config.storePath)
  const registry = createSessionRegistry({
    workspace: workspaceId,
    store,
    idleTimeoutMs: config.defaults.idle_timeout_s * 1000,
    metrics: {
      onSessionOpened: (active) =>
        metrics.setGauge("bantai_slack_sessions_active", active),
      onSessionClosed: (active) =>
        metrics.setGauge("bantai_slack_sessions_active", active),
      onTurnStarted: () => metrics.inc("bantai_slack_turn_started_total"),
      onTurnCompleted: (addUsd) => {
        metrics.inc("bantai_slack_turn_completed_total")
        if (addUsd > 0) metrics.add("bantai_slack_cost_usd_sum", addUsd)
      },
      onTurnErrored: () => metrics.inc("bantai_slack_turn_errored_total"),
    },
    ...(opts.buildHost ? { buildHost: opts.buildHost } : {}),
  })
  const dedup = createDedupCache()
  const threadParticipation = createThreadParticipationCache()
  // Tier-1 native-stream factory. Handed to the routing layer so each
  // renderer can opt in. Channels that keep `native_streaming: false`
  // never touch this capability — the factory returning a no-op would
  // have worked too, but the outbox already guards on opts.nativeStream
  // being present, so the cleaner path is to only hand it in when the
  // channel's project config enables it.
  const nativeStream: NativeStreamCapability = {
    async start({ channel, threadTs, initialText }) {
      const session = await startNativeSlackStream({
        app,
        channel,
        threadTs,
        ...(initialText ? { text: initialText } : {}),
        ...(auth.teamId ? { teamId: auth.teamId } : {}),
      })
      return {
        append: (text) => appendNativeSlackStream(session, text),
        stop: (finalText) => stopNativeSlackStream(session, finalText),
      }
    },
  }
  const userCache = createUserCache(app)
  const defaultAdapter = buildDefaultSendAdapter(app, {
    onPostSucceeded: ({ channel, threadTs }) => {
      threadParticipation.record(channel, threadTs)
    },
  })
  const approvals = createApprovalCoordinator({
    adapter: defaultAdapter,
    metrics: {
      onRequested: () => metrics.inc("bantai_slack_approval_requested_total"),
      onApproved: () => metrics.inc("bantai_slack_approval_approved_total"),
      onDenied: () => metrics.inc("bantai_slack_approval_denied_total"),
    },
    lookupSession(sessionKey) {
      // Sessions are keyed by `slack:<workspace>:<channel>:<threadTs|main>`.
      // Parse out the channel + thread and walk the registry.
      const parts = parseSessionKey(sessionKey)
      if (!parts) return undefined
      const entry = registry.peek(parts)
      if (!entry) return undefined
      return {
        approve: (id, opts) => {
          entry.host.backend.approveToolUse(id, {
            ...(opts?.alwaysAllow ? { alwaysAllow: true } : {}),
          })
        },
        deny: (id, reason) => {
          entry.host.backend.denyToolUse(id, reason)
        },
      }
    },
  })
  // Flip to true in handle.stop() so the inbound routing layer can
  // shortcut new turns with a "shutting down" ack instead of spinning up
  // a doomed SessionHost.
  const shuttingDown = { value: false }

  // Build the per-session `slack_upload` MCP server on demand. One config
  // per (channel, threadTs) pair — the tool handler closes over the
  // binding so the backend doesn't have to pass the context on every call.
  const slackFileClient = buildSlackFileClient(app)
  function slackUploadMcpFor(
    channel: string,
    threadTs: string,
    cwd: string,
  ): McpSdkServerConfigWithInstance {
    return createSlackUploadMcpServer({
      binding: { channel, threadTs },
      fileClient: slackFileClient,
      cwd,
    })
  }

  const attachmentStagingDir =
    opts.attachmentStagingDir ??
    pathJoin(homedir(), ".bantai", "slack-attachments")
  const attachments: AttachmentFetcher =
    opts.attachmentFetcher ??
    createAttachmentFetcher({
      botToken: config.workspace.botToken ?? "",
      stagingDir: attachmentStagingDir,
      ...(config.workspace.slackApiUrl
        ? {
            rewriteUrl: rewriterForSlackApiUrl(config.workspace.slackApiUrl),
            // Extend the SSRF allowlist with the minislack host — the
            // rewriter directs every Slack-hosted URL at it, and without
            // this the guard would drop every inbound attachment in
            // local dev. In prod runs `slackApiUrl` is unset and the
            // default `*.slack*.com` allowlist applies.
            extraAllowedHosts: extractHost(config.workspace.slackApiUrl),
          }
        : {}),
    })
  const elicitations = createElicitationCoordinator({
    adapter: defaultAdapter,
    app,
    lookupSession(sessionKey) {
      const parts = parseSessionKey(sessionKey)
      if (!parts) return undefined
      const entry = registry.peek(parts)
      if (!entry) return undefined
      return {
        respond: (id, answers) => {
          entry.host.backend.respondToElicitation(id, answers)
        },
        cancel: (id) => {
          entry.host.backend.cancelElicitation(id)
        },
      }
    },
  })

  // Per-channel user-scope overrides (`!bantai verbosity`, `!bantai model`).
  // Lives outside `projectOverrides` so a config reload (which clears the
  // resolution cache) doesn't erase an operator's live tweaks.
  const runtimeOverrides = new Map<string, RuntimeChannelOverride>()
  // Live reference to the current ResolvedSlackConfig. The getter on the
  // routing ctx reads from this every time `mutableProjectFor` runs, so a
  // successful `ConfigReloader` apply flows into every downstream decision
  // (gate, debouncer, resolver) without re-wiring the handler.
  let currentConfig: ResolvedSlackConfig = config

  const routingCtx: RoutingCtx = {
    app,
    get config() {
      return currentConfig
    },
    registry,
    dedup,
    userCache,
    botUserId: auth.botUserId,
    workspaceId,
    launchCwd,
    approvals,
    elicitations,
    attachments,
    renderers: new WeakMap(),
    projectOverrides: new Map(),
    runtimeOverrides,
    bannerPosted: new WeakSet(),
    shuttingDown,
    slackUploadMcpFor,
    threadParticipation,
    nativeStream,
    // Thread-status banner wrapper — single adapter per process. The
    // controller self-disables on channels that don't support the
    // capability, so it's safe to pass unconditionally.
    threadStatus: {
      async setStatus({ channel, threadTs, status }) {
        const client = app.client as unknown as {
          assistant?: {
            threads?: {
              setStatus?: (args: {
                channel_id: string
                thread_ts: string
                status: string
              }) => Promise<{ ok: boolean; error?: string }>
            }
          }
        }
        const fn = client.assistant?.threads?.setStatus
        if (!fn) {
          throw new Error("missing_scope:assistant.threads.setStatus")
        }
        const res = await fn.call(client.assistant!.threads!, {
          channel_id: channel,
          thread_ts: threadTs,
          status,
        })
        if (!res.ok) {
          throw new Error(res.error ?? "unknown")
        }
      },
    },
  }

  const routing = buildRoutingHandler(routingCtx)
  registerEvents({
    app,
    botUserId: auth.botUserId,
    onInbound: routing.onInbound,
  })

  // Config hot-reload. `<inline>` configs (test harnesses + future
  // programmatic overrides) disable the watcher — there's no file on disk
  // to watch. Inline sources also get an empty source string, so guard
  // defensively: only enable when we can confirm `source` is a real path.
  const reloader: ConfigReloader = createConfigReloader({
    path: config.source,
    initial: config,
    ...(config.source === "<inline>" || config.source.length === 0
      ? { disableWatcher: true }
      : {}),
  })
  const notifyAdapter = buildDefaultSendAdapter(app)
  const unsubApplied = reloader.onApplied((event) => {
    currentConfig = event.next
    invalidateProjectOverrides(routingCtx, event.diff)
    metrics.inc("bantai_slack_config_reload_applied_total")
    metrics.setGauge(
      "bantai_slack_config_last_reload_timestamp_seconds",
      Math.floor(Date.now() / 1000),
    )
    if (event.restartRequired.length > 0) {
      log.warn(
        `slack reload: restart required for: ${event.restartRequired.join(", ")}`,
      )
    }
    const logLine = formatDiffSummary(event.diff, {
      source: event.next.source,
      next: event.next,
      previous: event.previous,
      restartRequired: event.restartRequired,
    })
    log.info(`slack reload: ${logLine.replace(/\n/g, " | ")}`)
    const channel = event.next.defaults.reload_notify_channel
    if (channel && channel.length > 0) {
      const mdBody = formatDiffSummary(event.diff, {
        source: event.next.source,
        mrkdwn: true,
        next: event.next,
        previous: event.previous,
        restartRequired: event.restartRequired,
      })
      notifyAdapter
        .postMessage({ channel, text: markdownToSlackMrkdwn(mdBody) })
        .catch((err) => {
          log.warn(
            `slack reload: notify-channel post to ${channel} failed: ${String(err)}`,
          )
        })
    }
  })
  const unsubRejected = reloader.onRejected((event) => {
    metrics.inc("bantai_slack_config_reload_rejected_total")
    log.warn(
      `slack reload: rejected (${event.reason}) — ${event.errors.join("; ")}`,
    )
    // Notify-channel posts are best-effort; a config so broken we can't
    // even post about it still logs to the server log.
    const channel = currentConfig.defaults.reload_notify_channel
    if (channel && channel.length > 0) {
      const mdBody = formatRejectionSummary(event.errors, {
        source: currentConfig.source,
        mrkdwn: true,
      })
      notifyAdapter
        .postMessage({ channel, text: markdownToSlackMrkdwn(mdBody) })
        .catch((err) => {
          log.warn(
            `slack reload: notify-channel rejection post to ${channel} failed: ${String(err)}`,
          )
        })
    }
  })

  log.info(`slack: server ready — bot user ${auth.botUserId}, team ${workspaceId}`)

  const handle: SlackLaunchHandle = {
    app,
    // Live getter — a successful hot-reload updates `currentConfig`, and
    // any external observer (integration tests, future admin command)
    // reading `handle.config` picks up the new value rather than a stale
    // boot-time snapshot.
    get config() {
      return currentConfig
    },
    botUserId: auth.botUserId,
    registry,
    userCache,
    metrics,
    async stop() {
      // Stop accepting new turns BEFORE tearing anything down so inbound
      // events that race the signal get an ephemeral "shutting down"
      // rather than being dispatched into a session that's about to die.
      shuttingDown.value = true
      // Flush any in-flight debounced inbound batches BEFORE tearing
      // down so rapid-fire messages the user just posted don't get
      // silently dropped. Any entries that flush now will still hit a
      // live registry; the shuttingDown flag keeps NEW inbound events
      // at the handler's early return path.
      try {
        await routing.shutdown()
      } catch (err) {
        log.debug(`slack: routing shutdown flush threw: ${String(err)}`)
      }
      approvals.closeAll()
      elicitations.closeAll()
      registry.closeAll()
      try {
        unsubApplied()
        unsubRejected()
        reloader.close()
      } catch (err) {
        log.debug(`slack: reloader.close threw: ${String(err)}`)
      }
      await app.stop()
      try {
        store.close()
      } catch (err) {
        log.debug(`slack: store.close threw: ${String(err)}`)
      }
    },
  }

  if (opts.returnHandle) return handle

  await waitForSignal()
  log.info("slack: received shutdown signal — stopping")
  await handle.stop()
  if (unsubscribeConsoleLogs) unsubscribeConsoleLogs()
  return undefined
}

/**
 * Mirror logger output to stdout at-or-above `threshold`. Returns an
 * unsubscribe handle. Used only on the CLI path — integration tests keep
 * their log output silent.
 */
function attachConsoleLogStream(threshold: "debug" | "info"): () => void {
  const rank = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const
  const min = threshold === "debug" ? rank.DEBUG : rank.INFO
  return log.subscribe((line) => {
    const m = line.match(/^\[[^\]]+\]\s*\[(\w+)/)
    const tag = (m?.[1] ?? "INFO") as keyof typeof rank
    if ((rank[tag] ?? rank.INFO) < min) return
    process.stdout.write(line + "\n")
  })
}

// ---------------------------------------------------------------------------
// Launcher-local helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the config's `storePath` into a live `SessionStore`. Empty path
 * → no-op store (persistence disabled via explicit `store_path: ""` in
 * slack.json). Non-empty path → bun:sqlite, with the parent directory
 * auto-created if needed. Any construction error falls back to the no-op
 * store + log.warn so a broken path never blocks the launcher.
 *
 * Note: the empty-string branch here is reached only when slack.json
 * explicitly opts out of persistence. An absent `store_path` key is
 * resolved by the schema to `~/.bantai/slack.db` (default-on).
 */
function openSessionStore(path: string): SessionStore {
  if (!path) {
    log.warn(
      "slack: session persistence DISABLED (slack.json set store_path to \"\"). " +
        "Slack threads will NOT survive a bantai slack restart — each restart " +
        "spins up fresh sessions even for existing threads. Remove the key or " +
        "set a path to re-enable.",
    )
    return createNoopSessionStore()
  }
  try {
    if (path !== ":memory:") {
      const dir = dirname(path)
      if (dir && dir !== ".") mkdirSync(dir, { recursive: true })
    }
    const store = createSessionStore({ path })
    log.info(`slack: session persistence enabled at ${path}`)
    return store
  } catch (err) {
    log.warn(
      `slack: failed to open session store at ${path}: ${String(err)} — persistence disabled for this run`,
    )
    return createNoopSessionStore()
  }
}

/**
 * When the launcher is pointed at a non-Slack API URL (minislack in tests,
 * a mirror in air-gapped deploys), the file URLs on message events still
 * carry `https://slack.com/...`. Rewrite them onto the configured host so
 * the attachment fetcher can reach the bytes.
 */
function rewriterForSlackApiUrl(slackApiUrl: string): (url: string) => string {
  const base = slackApiUrl.replace(/\/$/, "")
  return (u) => u.replace(/^https?:\/\/[^/]+/, base)
}

/**
 * Extract the host from a URL for the SSRF allowlist. Returns a single-
 * element array (the host) or an empty array if the URL is unparseable
 * — the caller falls back to the default Slack allowlist in that case.
 */
function extractHost(url: string): string[] {
  try {
    return [new URL(url).hostname]
  } catch {
    return []
  }
}

function waitForSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      resolve()
    }
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
  })
}
