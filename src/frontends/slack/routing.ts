/**
 * Inbound routing handler — the round-trip pipeline's dispatch layer.
 *
 *   Slack event → inbox (dedup + gate + turn-build) → [this module] →
 *   SessionHost.send → backend emits AgentEvents → view event-renderer →
 *   chat.postMessage.
 *
 * Pulled out of `launcher.ts` to keep each file under the project's
 * ~500-line guideline. This module owns the per-event decision tree;
 * the launcher stays focused on boot + lifecycle. All dependencies
 * arrive via the `RoutingCtx` struct — the module has no module-level
 * state, which makes it easy to unit-test by constructing a synthetic
 * ctx.
 */
import type { App } from "@slack/bolt"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { log } from "../../utils/logger"
import type { ConversationEvent, SessionConfig } from "../../protocol/types"
import type { ResolvedSlackConfig, VerbosityLevel } from "./config/schema"
import { resolveProjectForChannel, type ProjectConfig } from "./router/resolver"
import type { SessionEntry, SessionRegistry } from "./router/registry"
import type { InboundSlackEvent } from "./transport/events"
import type { createDedupCache } from "./inbox/dedup"
import { decideGate } from "./inbox/gate"
import { buildInboundTurn } from "./inbox/turn-builder"
import type { AttachmentFetcher } from "./inbox/attachments"
import {
  buildDefaultSendAdapter,
  createEventRenderer,
  type EventRenderer,
} from "./view/event-renderer"
import { postSessionBanner } from "./view/banner"
import type { UserCache } from "./view/user-cache"
import { parseControlCommand } from "./commands/parser"
import { dispatchCommand, type CommandContext } from "./commands/dispatch"
import type { ApprovalCoordinator } from "./approvals/coordinator"
import type { ElicitationCoordinator } from "./elicitations/coordinator"
import { mergeCumulativeUsage } from "./usage"

// ---------------------------------------------------------------------------
// RoutingCtx — the struct the launcher hands to `buildRoutingHandler`.
// ---------------------------------------------------------------------------

export interface RoutingCtx {
  app: App
  config: ResolvedSlackConfig
  registry: SessionRegistry
  dedup: ReturnType<typeof createDedupCache>
  userCache: UserCache
  botUserId: string
  workspaceId: string
  launchCwd: string
  /** Cross-session approval coordinator (registry + block-actions handler). */
  approvals: ApprovalCoordinator
  /** Cross-session elicitation coordinator (card → modal → view_submission). */
  elicitations: ElicitationCoordinator
  /** Fetches inbound file attachments into images / staging files. */
  attachments: AttachmentFetcher
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
  /**
   * Set to true once `handle.stop()` begins. Inbound events arriving after
   * this briefly ack with a "bot is shutting down" ephemeral and drop on
   * the floor — rather than spinning up a fresh session that will die
   * mid-turn when `registry.closeAll()` runs moments later.
   */
  shuttingDown: { value: boolean }
  /**
   * Build a per-session `slack_upload` MCP server config. The launcher
   * constructs one for every new SessionHost so the tool handler closes
   * over the correct (channel, threadTs, cwd) binding.
   */
  slackUploadMcpFor: (
    channel: string,
    threadTs: string,
    cwd: string,
  ) => McpSdkServerConfigWithInstance
}

// ---------------------------------------------------------------------------
// parseSessionKey — shared helper (coordinators use it for block-action
// dispatch; the routing handler consumes it indirectly via the registry).
// ---------------------------------------------------------------------------

/**
 * Parse a session key of the form `slack:<workspace>:<channel>:<threadTs|main>`
 * back into the parts the registry expects. Returns undefined when the
 * key doesn't match the expected shape — approval clicks arriving for a
 * dead session then log + no-op rather than crashing.
 */
export function parseSessionKey(
  key: string,
): { workspace: string; channelId: string; threadTs?: string } | undefined {
  const parts = key.split(":")
  if (parts.length !== 4) return undefined
  if (parts[0] !== "slack") return undefined
  const [, workspace, channelId, thread] = parts as [string, string, string, string]
  return {
    workspace,
    channelId,
    ...(thread === "main" ? {} : { threadTs: thread }),
  }
}

// ---------------------------------------------------------------------------
// Main dispatch.
// ---------------------------------------------------------------------------

export function buildRoutingHandler(
  ctx: RoutingCtx,
): (event: InboundSlackEvent) => Promise<void> {
  return async (event) => {
    if (ctx.shuttingDown.value) {
      if (event.kind === "message" || event.kind === "app_mention") {
        try {
          await ctx.app.client.chat.postEphemeral({
            channel: event.channel,
            user: event.user,
            text: ":zzz: bantai is shutting down — please retry in a moment",
          })
        } catch (err) {
          log.debug(`slack: shutdown ephemeral post failed: ${String(err)}`)
        }
      }
      return
    }
    if (event.kind === "block_action") {
      const approvalRes = await ctx.approvals.handleBlockAction({
        actionId: event.actionId,
        userId: event.user,
        channel: event.channel,
      })
      if (approvalRes.kind === "unauthorized") {
        try {
          if (event.channel) {
            await ctx.app.client.chat.postEphemeral({
              channel: event.channel,
              user: event.user,
              text: `You are not on the approver list for this action.`,
            })
          }
        } catch (err) {
          log.debug(`slack: chat.postEphemeral failed: ${String(err)}`)
        }
        return
      }
      if (approvalRes.kind === "malformed") {
        const elicRes = await ctx.elicitations.handleBlockAction({
          actionId: event.actionId,
          userId: event.user,
          triggerId: event.triggerId,
          channel: event.channel,
        })
        if (elicRes.kind === "malformed") {
          log.debug(`slack: unrecognised block_action ignored: ${event.actionId}`)
        }
      }
      return
    }
    if (event.kind === "view_submission") {
      const res = await ctx.elicitations.handleViewSubmission({
        callbackId: event.callbackId,
        userId: event.user,
        values: event.values,
      })
      if (res.kind === "malformed") {
        log.debug(`slack: unrecognised view_submission ignored: ${event.callbackId}`)
      }
      return
    }
    if (event.kind !== "message" && event.kind !== "app_mention") {
      return
    }
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

    const entry = ctx.registry.getOrCreate(
      sessionParts,
      project,
      turn.parentTs,
      buildSessionMcpOverlay({
        project,
        channel: turn.channel,
        threadTs: turn.parentTs,
        slackUploadMcp: ctx.slackUploadMcpFor,
      }),
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
        verbosity: project.verbosity,
        showCost: project.showCost,
        turnTimeoutS: project.turnTimeoutS,
        onTurnTimeout: () => {
          entry.host.backend.interrupt()
        },
        maxBudgetUsd: project.maxBudgetUsd,
        onBudgetExceeded: () => {
          entry.host.backend.interrupt()
        },
        approvals: ctx.approvals.bindSession({
          sessionKey: entry.key,
          approvers: project.approvers,
        }),
        elicitations: ctx.elicitations.bindSession({
          sessionKey: entry.key,
        }),
      })
      ctx.renderers.set(entry, renderer)
      entry.subscribe(renderer.onEvent)
      if (project.sessionBanner) {
        attachBannerOnce(ctx, entry, project, turn.channel, turn.parentTs)
      }
    } else {
      renderer.setTriggerTs(turn.triggerTs)
    }

    const incomingFiles = "files" in event ? event.files : undefined
    if (incomingFiles && incomingFiles.length > 0) {
      try {
        const ingested = await ctx.attachments.fetch(incomingFiles, {
          channelId: event.channel,
          ts: event.ts,
        })
        entry.send({
          text: turn.text + ingested.textHint,
          ...(ingested.images.length > 0 ? { images: ingested.images } : {}),
        })
        return
      } catch (err) {
        log.error(`slack: attachment ingest failed: ${String(err)}. Proceeding without files.`)
      }
    }

    entry.send({ text: turn.text })
  }
}

// ---------------------------------------------------------------------------
// Per-session MCP overlay + project resolution + control-command routing.
// ---------------------------------------------------------------------------

/**
 * Build the sessionConfigOverlay that injects the per-session `slack_upload`
 * MCP server. Merges with `project.resolvedMcpServers` so a channel's
 * user-configured MCP set remains active alongside the upload tool.
 */
export function buildSessionMcpOverlay(args: {
  project: ProjectConfig
  channel: string
  threadTs: string
  slackUploadMcp: (
    channel: string,
    threadTs: string,
    cwd: string,
  ) => McpSdkServerConfigWithInstance
}): Partial<SessionConfig> | undefined {
  const upload = args.slackUploadMcp(
    args.channel,
    args.threadTs,
    args.project.projectDir,
  )
  const base = args.project.resolvedMcpServers ?? {}
  return {
    mcpServers: {
      ...base,
      "bantai-slack-upload": upload,
    },
  }
}

/**
 * Resolve the project config for the channel, returning a MUTABLE snapshot
 * (so `!bantai verbosity <l>` can update the in-memory view). The SlackConfig
 * itself stays immutable in this launcher; mutations travel via
 * `ctx.projectOverrides.set(channelId, nextConfig)`.
 */
export function mutableProjectFor(ctx: RoutingCtx, channelId: string): ProjectConfig {
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
      ctx.projectOverrides.set(project.channelId, { ...project, model })
    },
    async resetSession() {
      existing?.reset()
    },
    setVerbosity(level: VerbosityLevel) {
      ctx.projectOverrides.set(project.channelId, { ...project, verbosity: level })
    },
    async availableModels() {
      if (!existing) return []
      const list = await existing.host.backend.availableModels()
      return list.map((m) => m.id)
    },
    cumulativeUsage() {
      const renderer = existing ? ctx.renderers.get(existing) : undefined
      return mergeCumulativeUsage(
        renderer?.cumulativeUsage(),
        existing?.priorUsage,
      )
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
        ...(entry.resumed
          ? {
              resumed: {
                priorTurns: entry.priorUsage.turns,
                priorCostUsd: entry.priorUsage.totalCostUsd,
              },
            }
          : {}),
      },
    }).catch((err) => log.error(`slack banner: ${String(err)}`))
  }
  unsub = entry.subscribe(subscriber)
}
