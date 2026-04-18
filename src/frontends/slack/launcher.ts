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
import { buildDefaultSendAdapter, createEventRenderer, type EventRenderer } from "./view/event-renderer"
import { postSessionBanner } from "./view/banner"
import { createUserCache, type UserCache } from "./view/user-cache"
import { parseControlCommand } from "./commands/parser"
import { dispatchCommand, type CommandContext } from "./commands/dispatch"
import type { VerbosityLevel } from "./config/schema"
import type { ConversationEvent } from "../../protocol/types"
import type { ProjectConfig } from "./router/resolver"

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
      renderers: new WeakMap(),
      projectOverrides: new Map(),
      bannerPosted: new WeakSet(),
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
  /**
   * One event-renderer per live session. We keep a map (not just a set) so
   * the handler can update the per-turn triggerTs when a new mention lands
   * in the same thread.
   */
  renderers: WeakMap<SessionEntry, EventRenderer>
  /**
   * Mutable per-channel project view — populated on first resolve, updated
   * by `!bantai verbosity` / `!bantai model` etc. without touching the
   * underlying immutable ResolvedSlackConfig.
   */
  projectOverrides: Map<string, ProjectConfig>
  /** Sessions for which we've already posted the banner. */
  bannerPosted: WeakSet<SessionEntry>
}

function buildRoutingHandler(ctx: RoutingCtx): (event: InboundSlackEvent) => Promise<void> {
  return async (event) => {
    if (event.kind !== "message" && event.kind !== "app_mention") {
      // Other event kinds are routed by later phases (reactions → commands,
      // block actions → approvals).
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

    const project = mutableProjectFor(ctx, event.channel)

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

    // Is this a control command invocation? If so, dispatch + return
    // without opening / running a backend turn.
    const cmd = parseControlCommand(turn.text, { prefix: project.controlPrefix })
    if (cmd) {
      await handleControlCommand({
        ctx,
        cmd,
        project,
        channel: event.channel,
        threadTs: turn.parentTs,
        sessionParts,
      })
      return
    }

    // Lazy-create the SessionHost on first turn; subsequent turns reuse it.
    const entry = ctx.registry.getOrCreate(
      sessionParts,
      project,
      turn.parentTs,
    )

    let renderer = ctx.renderers.get(entry)
    if (!renderer) {
      renderer = createEventRenderer({
        app: ctx.app,
        binding: {
          channel: turn.channel,
          threadTs: turn.parentTs,
          triggerTs: turn.triggerTs,
        },
      })
      ctx.renderers.set(entry, renderer)
      entry.subscribe(renderer.onEvent)
      // Post the session banner on the first session_init we see from
      // this entry. The one-shot subscriber is detached the first time it
      // fires so subsequent turns don't re-post a banner.
      if (project.sessionBanner) {
        attachBannerOnce(ctx, entry, project, turn.channel, turn.parentTs)
      }
    } else {
      renderer.setTriggerTs(turn.triggerTs)
    }

    entry.send({ text: turn.text })
  }
}

/**
 * Resolve the project config for the channel, returning a MUTABLE snapshot
 * (so `!bantai verbosity <l>` can update the in-memory view). The SlackConfig
 * itself stays immutable in this launcher; mutations travel via
 * `ctx.projectOverrides.set(channelId, nextConfig)`.
 */
function mutableProjectFor(ctx: RoutingCtx, channelId: string): ProjectConfig {
  const cached = ctx.projectOverrides.get(channelId)
  if (cached) return cached
  const fresh = resolveProjectForChannel(ctx.config, channelId, {
    launchCwd: ctx.launchCwd,
  })
  ctx.projectOverrides.set(channelId, fresh)
  return fresh
}

interface CommandRouteArgs {
  ctx: RoutingCtx
  cmd: { cmd: string; args: string }
  project: ProjectConfig
  channel: string
  threadTs: string
  sessionParts: {
    workspace: string
    channelId: string
    threadTs: string
  }
}

async function handleControlCommand(args: CommandRouteArgs): Promise<void> {
  const { ctx, cmd, project, channel, threadTs, sessionParts } = args
  const adapter = buildDefaultSendAdapter(ctx.app)
  const existing = ctx.registry.peek(sessionParts)

  const commandCtx: CommandContext = {
    async sendReply(text) {
      try {
        await adapter.postMessage({ channel, threadTs, text })
      } catch (err) {
        log.error(`slack commands: sendReply failed: ${String(err)}`)
      }
    },
    interrupt() {
      existing?.host.backend.interrupt()
    },
    async setModel(model) {
      if (existing) await existing.host.backend.setModel(model)
      // Persist for future turns in this channel.
      ctx.projectOverrides.set(project.channelId, { ...project, model })
    },
    async resetSession() {
      existing?.close()
    },
    setVerbosity(level: VerbosityLevel) {
      ctx.projectOverrides.set(project.channelId, { ...project, verbosity: level })
    },
    async availableModels() {
      if (!existing) return []
      const list = await existing.host.backend.availableModels()
      return list.map((m) => m.id)
    },
    project,
    workspace: sessionParts.workspace,
    channel,
    threadTs,
  }
  await dispatchCommand(cmd, commandCtx)
}

/**
 * Subscribe one banner-poster. The subscriber captures the first
 * `session_init` event's sessionId and posts the banner, then unsubscribes
 * itself. Guarded by a WeakSet so we never post two banners for the same
 * session.
 */
function attachBannerOnce(
  ctx: RoutingCtx,
  entry: SessionEntry,
  project: ProjectConfig,
  channel: string,
  threadTs: string,
): void {
  if (ctx.bannerPosted.has(entry)) return
  const adapter = buildDefaultSendAdapter(ctx.app)
  let unsub: (() => void) | null = null
  const subscriber = (event: ConversationEvent): void => {
    if (event.type !== "session_init") return
    ctx.bannerPosted.add(entry)
    unsub?.()
    unsub = null
    postSessionBanner({
      adapter,
      channel,
      threadTs,
      inputs: {
        project,
        sessionId: event.sessionId,
      },
    }).catch((err) => log.error(`slack banner: ${String(err)}`))
  }
  unsub = entry.subscribe(subscriber)
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
