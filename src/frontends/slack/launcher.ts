/**
 * Slack Launcher — boots the Slack frontend server.
 *
 * Phase S1 (current): wires the full round-trip pipeline:
 *
 *   Slack event → inbox (dedup + gate + turn-build) → router (resolver +
 *   session registry) → SessionHost.send → backend emits AgentEvents →
 *   view event-renderer → chat.postMessage.
 *
 * Each inbound text message drives a full agent turn. The bot posts one
 * assistant message per turn (no streaming yet — S2 adds streaming + status
 * reactions).
 *
 * Phase S2+ plug in: streaming (three-tier), reaction state machine, Block
 * Kit cards, approvals, SQLite persistence.
 */

import type { App } from "@slack/bolt"
import type { CLIFlags } from "../../cli/options"
import { log } from "../../utils/logger"
import { loadSlackConfig } from "./config/loader"
import type { ResolvedSlackConfig } from "./config/schema"
import { createBoltApp, verifyAuth } from "./transport/bolt"
import { registerEvents, type InboundSlackEvent } from "./transport/events"
import {
  createSessionRegistry,
  type SessionEntry,
  type SessionRegistry,
  type BuildHostOpts,
  type HostPair,
} from "./router/registry"
import { resolveProjectForChannel } from "./router/resolver"
import { createDedupCache } from "./inbox/dedup"
import { decideGate } from "./inbox/gate"
import { buildInboundTurn } from "./inbox/turn-builder"
import { createEventRenderer } from "./view/event-renderer"
import { createUserCache, type UserCache } from "./view/user-cache"

export interface LaunchSlackOpts extends CLIFlags {
  /** Explicit slack.toml path — takes precedence over config search. */
  slackConfigPath?: string
  /** Override for [workspace].slack_api_url — the minislack URL in tests. */
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
}

export interface SlackLaunchHandle {
  app: App
  config: ResolvedSlackConfig
  botUserId: string
  registry: SessionRegistry
  userCache: UserCache
  stop(): Promise<void>
}

export async function launchSlack(opts: LaunchSlackOpts): Promise<SlackLaunchHandle | void> {
  if (opts.debug) log.setLevel("debug")
  else log.setLevel("info")

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

  const app = createBoltApp({ config })
  await app.start()
  const auth = await verifyAuth(app)
  const launchCwd = opts.config.cwd ?? process.cwd()
  const workspaceId = auth.teamId ?? "unknown"

  const registry = createSessionRegistry({
    workspace: workspaceId,
    ...(opts.buildHost ? { buildHost: opts.buildHost } : {}),
  })
  const dedup = createDedupCache()
  const userCache = createUserCache(app)

  registerEvents({
    app,
    botUserId: auth.botUserId,
    onInbound: buildRoutingHandler({
      app,
      config,
      registry,
      dedup,
      userCache,
      botUserId: auth.botUserId,
      workspaceId,
      launchCwd,
      renderedEntries: new WeakSet(),
    }),
  })

  log.info(`slack: server ready — bot user ${auth.botUserId}, team ${workspaceId}`)

  const handle: SlackLaunchHandle = {
    app,
    config,
    botUserId: auth.botUserId,
    registry,
    userCache,
    async stop() {
      registry.closeAll()
      await app.stop()
    },
  }

  if (opts.returnHandle) return handle

  await waitForSignal()
  log.info("slack: received shutdown signal — stopping")
  await handle.stop()
  return undefined
}

// ---------------------------------------------------------------------------
// S1 inbound handler — the round-trip pipeline
// ---------------------------------------------------------------------------

interface RoutingCtx {
  app: App
  config: ResolvedSlackConfig
  registry: SessionRegistry
  dedup: ReturnType<typeof createDedupCache>
  userCache: UserCache
  botUserId: string
  workspaceId: string
  launchCwd: string
  /** Tracks which session entries already have an event-renderer subscribed. */
  renderedEntries: WeakSet<SessionEntry>
}

function buildRoutingHandler(ctx: RoutingCtx): (event: InboundSlackEvent) => Promise<void> {
  return async (event) => {
    if (event.kind !== "message" && event.kind !== "app_mention") {
      // Other event kinds are routed by later phases (reactions → commands,
      // block actions → approvals). For S1 we short-circuit.
      return
    }
    // Dedup by channel:ts. Both message and app_mention carry both.
    const key = `${event.channel}:${event.ts}`
    if (!ctx.dedup.markFresh(key)) {
      log.debug(`slack: duplicate ${event.kind} ${key}, ignoring`)
      return
    }

    // Anchor the session at the thread parent when this is a reply, else at
    // the triggering message's own ts (the ts the bot's reply will thread
    // under). This makes "top-level message" and "replies under it" converge
    // onto the same session key.
    const anchorTs = event.threadTs ?? event.ts
    const sessionParts = {
      workspace: ctx.workspaceId,
      channelId: event.channel,
      threadTs: anchorTs,
    }
    const existing = ctx.registry.peek(sessionParts)

    const project = resolveProjectForChannel(ctx.config, event.channel, {
      launchCwd: ctx.launchCwd,
    })

    const decision = decideGate({
      channel: event.channel,
      text: event.text,
      threadTs: event.threadTs,
      botUserId: ctx.botUserId,
      requireMention: project.requireMention,
      autoJoinThreads: project.autoJoinThreads,
      threadHasActiveSession: !!existing,
    })
    if (!decision.accept) {
      log.debug(`slack: gate rejected ${event.kind} ${key} (${decision.reason})`)
      return
    }

    const displayName = await ctx.userCache.displayName(event.user)
    const turn = buildInboundTurn({
      text: event.text,
      channel: event.channel,
      ts: event.ts,
      threadTs: event.threadTs,
      userId: event.user,
      userDisplayName: displayName,
      botUserId: ctx.botUserId,
    })

    // Lazy-create the SessionHost on first turn; subsequent turns reuse it.
    const entry = ctx.registry.getOrCreate(
      sessionParts,
      project,
      turn.parentTs,
    )

    // Attach a renderer once per session. The WeakSet on the closure tracks
    // which entries are already bound so we don't double-subscribe on
    // subsequent turns into the same thread.
    if (!ctx.renderedEntries.has(entry)) {
      ctx.renderedEntries.add(entry)
      const renderer = createEventRenderer({
        app: ctx.app,
        binding: { channel: turn.channel, threadTs: turn.parentTs },
      })
      entry.subscribe(renderer.onEvent)
    }

    entry.send({ text: turn.text })
  }
}

// ---------------------------------------------------------------------------
// SIGINT / SIGTERM handling
// ---------------------------------------------------------------------------

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
