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
import type { ThreadParticipationCache } from "./inbox/thread-participation"
import type { NativeStreamCapability } from "./view/outbox"
import type { ThreadStatusAdapter } from "./view/thread-status"
import { decideGate } from "./inbox/gate"
import { buildInboundTurn } from "./inbox/turn-builder"
import {
  createInboundDebouncer,
  type InboundDebouncer,
} from "./inbox/debouncer"
import { parseInteractiveReplyActionId } from "./view/interactive-replies"
import type { AttachmentFetcher } from "./inbox/attachments"
import {
  fetchThreadHistory,
  formatThreadHistory,
} from "./inbox/thread-history"
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
  /**
   * Cache of (channel, thread) pairs the bot has recently posted in. Used
   * to let follow-up user messages in those threads drive a turn without
   * requiring `@bantai` every time. Populated by the send-adapter's
   * `onPostSucceeded` hook; read here before calling `decideGate`.
   */
  threadParticipation: ThreadParticipationCache
  /**
   * Optional tier-1 native-stream factory. The launcher builds it
   * from `app.client.chatStream` + resolved teamId; channels with
   * `native_streaming: true` in their project config pass it to the
   * renderer, others leave it undefined so the outbox stays on tier-2.
   */
  nativeStream?: NativeStreamCapability
  /**
   * Assistant-thread status banner adapter. Always provided in
   * production (the controller self-disables on channels that don't
   * support the capability); tests omit it to keep the renderer path
   * quiet.
   */
  threadStatus?: ThreadStatusAdapter
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

export interface RoutingHandle {
  onInbound: (event: InboundSlackEvent) => Promise<void>
  /**
   * Flush any buffered debounced entries. The launcher calls this on
   * shutdown so in-flight rapid-message batches still reach the agent
   * (or are dropped deliberately — if the backend is tearing down,
   * the flush will end up posting a "shutting down" ephemeral).
   */
  shutdown(): Promise<void>
}

// ---------------------------------------------------------------------------
// Inbound debouncer — groups rapid messages from the same
// (workspace, channel, thread, sender) tuple into one agent turn. Keyed
// on the resolved anchor ts (same anchor the session registry uses) so
// that a user posting the mention message followed by a series of
// thread replies all collapse into one dispatch.
// ---------------------------------------------------------------------------

interface DebouncedEntry {
  event: Extract<InboundSlackEvent, { kind: "message" | "app_mention" }>
  anchorTs: string
}

function buildDebouncerKey(
  workspaceId: string,
  entry: DebouncedEntry,
): string {
  return `${workspaceId}:${entry.event.channel}:${entry.anchorTs}:${entry.event.user}`
}

export function buildRoutingHandler(ctx: RoutingCtx): RoutingHandle {
  const defaultDebounceMs = ctx.config.defaults.debounce_ms ?? 0
  // Per-channel overrides may set a different debounceMs. We build a
  // single debouncer anyway — shouldDebounce consults the project for
  // the specific channel before enqueueing, so a channel with
  // debounce_ms=0 takes the synchronous bypass path while a neighbour
  // with debounce_ms=1500 still batches.
  const debouncer: InboundDebouncer<DebouncedEntry> = createInboundDebouncer<DebouncedEntry>({
    debounceMs: defaultDebounceMs > 0 ? defaultDebounceMs : 1500,
    buildKey: (entry) => buildDebouncerKey(ctx.workspaceId, entry),
    shouldDebounce: (entry) => {
      const project = mutableProjectFor(ctx, entry.event.channel)
      return project.debounceMs > 0
    },
    onFlush: async (entries) => {
      await dispatchMessageBatch(ctx, entries)
    },
    onError: (err) => {
      log.error(`slack routing: debounce flush threw: ${String(err)}`)
    },
  })

  const handler = async (event: InboundSlackEvent): Promise<void> => {
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
          const interactiveHandled = await handleInteractiveReplyAction(ctx, event)
          if (!interactiveHandled) {
            log.debug(
              `slack: unrecognised block_action ignored: ${event.actionId}`,
            )
          }
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

    const anchorTs = event.threadTs ?? event.ts
    const project = mutableProjectFor(ctx, event.channel)

    // Gate the inbound on the *raw* event text — control commands
    // (e.g. `!bantai status`) must fire immediately without sharing a
    // debounce bucket with surrounding chatter, and a rejected message
    // never triggers a later flush. The debouncer only sees events the
    // gate already accepted.
    const decision = decideGate({
      channel: event.channel,
      text: event.text,
      threadTs: event.threadTs,
      botUserId: ctx.botUserId,
      requireMention: project.requireMention,
      autoJoinThreads: project.autoJoinThreads,
      threadHasActiveSession: !!ctx.registry.peek({
        workspace: ctx.workspaceId,
        channelId: event.channel,
        threadTs: anchorTs,
      }),
      threadHasPriorBotPost: event.threadTs
        ? ctx.threadParticipation.has(event.channel, event.threadTs)
        : false,
      threadRequireExplicitMention: project.threadRequireExplicitMention,
    })
    if (!decision.accept) {
      log.debug(`slack: gate rejected ${event.kind} ${key} (${decision.reason})`)
      return
    }

    // Control-prefix detection uses the mention-stripped turn text so
    // `@bantai !bantai status` still parses. Commands always skip the
    // debouncer — they're synchronous by nature.
    const displayName = await ctx.userCache.displayName(event.user)
    const controlTurn = buildInboundTurn({
      text: event.text,
      channel: event.channel,
      ts: event.ts,
      threadTs: event.threadTs,
      userId: event.user,
      userDisplayName: displayName,
      botUserId: ctx.botUserId,
    })
    const cmd = parseControlCommand(controlTurn.text, {
      prefix: project.controlPrefix,
    })
    if (cmd) {
      await handleControlCommand({
        ctx,
        cmd,
        project,
        channel: event.channel,
        threadTs: controlTurn.parentTs,
        sessionParts: {
          workspace: ctx.workspaceId,
          channelId: event.channel,
          threadTs: anchorTs,
        },
      })
      return
    }

    // Everything else flows through the debouncer. When debounceMs is 0
    // for this channel, `shouldDebounce` returns false and the entry
    // dispatches synchronously — behaviour-preserving for callers that
    // haven't opted in to batching.
    await debouncer.enqueue({ event, anchorTs })
  }

  return {
    onInbound: handler,
    shutdown: () => debouncer.flushAll(),
  }
}

// ---------------------------------------------------------------------------
// Dispatch — runs after the debouncer flushes (either synchronously via
// the bypass path, or trailing-edge after debounceMs).
// ---------------------------------------------------------------------------

async function dispatchMessageBatch(
  ctx: RoutingCtx,
  entries: DebouncedEntry[],
): Promise<void> {
  if (entries.length === 0) return
  const first = entries[0]!
  const last = entries[entries.length - 1]!
  const channel = first.event.channel
  const userId = first.event.user
  const anchorTs = first.anchorTs
  const sessionParts = {
    workspace: ctx.workspaceId,
    channelId: channel,
    threadTs: anchorTs,
  }
  const project = mutableProjectFor(ctx, channel)
  const displayName = await ctx.userCache.displayName(userId)

  // Combine batched texts — newline-joined, preserving order. The gate
  // already accepted each event independently; when multiple messages
  // batch, the combined text retains every mention so the agent sees
  // the same signals it would in the un-batched case.
  const combinedText = entries
    .map((e) => e.event.text)
    .filter((t) => t && t.length > 0)
    .join("\n")

  const turn = buildInboundTurn({
    text: combinedText,
    channel,
    ts: last.event.ts,
    threadTs: last.event.threadTs,
    userId,
    userDisplayName: displayName,
    botUserId: ctx.botUserId,
  })

  // Capture whether a session already exists for this thread *before*
  // getOrCreate mutates the registry. Used below to decide whether to
  // prefetch thread history: a fresh session + mid-thread trigger
  // means the bot was just pulled into an existing conversation and
  // needs the prior context to make sense of the current message.
  const hadExistingSession = !!ctx.registry.peek(sessionParts)

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
      interactiveReplies: project.interactiveReplies,
      ...(project.nativeStreaming && ctx.nativeStream
        ? { nativeStream: ctx.nativeStream }
        : {}),
      ...(project.agentIdentity ? { identity: project.agentIdentity } : {}),
      ...(ctx.threadStatus ? { threadStatusAdapter: ctx.threadStatus } : {}),
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

  // Prefetch thread history when the bot is pulled into an existing
  // thread for the first time. Three conditions must all hold:
  //   1. the trigger has a threadTs (user replied inside a thread)
  //   2. no session existed before this dispatch (first time this
  //      thread is getting a session)
  //   3. the entry wasn't rehydrated from the persistence store
  //      (a resumed session already carries its own history in the
  //      backend — re-injecting the thread would double-count)
  //   4. the project opts in via `thread_history_limit > 0`
  // The prefix becomes part of turn.text so the downstream attachment
  // path (which wraps turn.text with `ingested.textHint`) carries it
  // through unchanged.
  const triggeredMidThread = !!last.event.threadTs
  const shouldPrefetchHistory =
    triggeredMidThread &&
    !hadExistingSession &&
    !entry.resumed &&
    project.threadHistoryLimit > 0
  if (shouldPrefetchHistory) {
    const prefix = await buildThreadHistoryPrefix(ctx, {
      channelId: channel,
      threadTs: last.event.threadTs!,
      currentMessageTs: last.event.ts,
      limit: project.threadHistoryLimit,
    })
    if (prefix) {
      turn.text = `${prefix}\n\n${turn.text}`
    }
  }

  // Pool attachments across the batch — a user who drops two images in
  // quick succession expects the agent to see both in the same turn.
  const incomingFiles = entries.flatMap((e) =>
    "files" in e.event && e.event.files ? e.event.files : [],
  )
  if (incomingFiles.length > 0) {
    try {
      const ingested = await ctx.attachments.fetch(incomingFiles, {
        channelId: channel,
        ts: last.event.ts,
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

/**
 * Fetch + format the prior thread messages as a `<slack_thread_history>`
 * preamble. Returns undefined on empty / error so the caller can fall
 * back to the bare turn text.
 */
async function buildThreadHistoryPrefix(
  ctx: RoutingCtx,
  args: {
    channelId: string
    threadTs: string
    currentMessageTs: string
    limit: number
  },
): Promise<string | undefined> {
  try {
    const messages = await fetchThreadHistory({
      app: ctx.app,
      channelId: args.channelId,
      threadTs: args.threadTs,
      currentMessageTs: args.currentMessageTs,
      limit: args.limit,
    })
    if (messages.length === 0) return undefined
    const prefix = await formatThreadHistory({
      messages,
      botUserId: ctx.botUserId,
      userCache: ctx.userCache,
    })
    if (prefix) {
      log.info(
        `slack: prepended thread history (${messages.length} msg) for new session in ${args.channelId}:${args.threadTs}`,
      )
    }
    return prefix
  } catch (err) {
    // Non-fatal — the current message alone is still useful.
    log.warn(
      `slack: thread-history prefetch failed for ${args.channelId}:${args.threadTs}: ${String(err)}`,
    )
    return undefined
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

// ---------------------------------------------------------------------------
// Interactive-reply click dispatch.
//
// When an agent-authored `[[slack_buttons:…]]` / `[[slack_select:…]]`
// block is clicked, Slack fires a block_action with an id prefixed
// `bantai:reply_button:` / `bantai:reply_select:` and the clicked value
// on the action payload. We translate that into a fresh inbound turn on
// the same session (thread) so the agent can react to the choice.
// ---------------------------------------------------------------------------

async function handleInteractiveReplyAction(
  ctx: RoutingCtx,
  event: Extract<InboundSlackEvent, { kind: "block_action" }>,
): Promise<boolean> {
  const parsed = parseInteractiveReplyActionId(event.actionId)
  if (!parsed) return false
  if (!event.channel) {
    log.warn(
      `slack: interactive-reply click ${event.actionId} arrived without a channel`,
    )
    return true
  }
  if (!event.value) {
    log.warn(
      `slack: interactive-reply click ${event.actionId} carried no value; ignoring`,
    )
    return true
  }
  // The session is anchored at the *thread* the user clicked under.
  // For a top-level message (no thread), anchor on the message's own
  // ts — same convention `buildRoutingHandler` uses for fresh inbound
  // messages.
  const anchorTs = event.messageThreadTs ?? event.messageTs
  if (!anchorTs) {
    log.warn(
      `slack: interactive-reply click ${event.actionId} missing both thread_ts and message ts`,
    )
    return true
  }
  const entry = ctx.registry.peek({
    workspace: ctx.workspaceId,
    channelId: event.channel,
    threadTs: anchorTs,
  })
  if (!entry) {
    log.info(
      `slack: interactive-reply click on a session that has been evicted ` +
        `(channel=${event.channel} thread=${anchorTs}); posting ephemeral`,
    )
    try {
      await ctx.app.client.chat.postEphemeral({
        channel: event.channel,
        user: event.user,
        text: ":warning: that session has ended — @mention the bot to start a new one.",
      })
    } catch (err) {
      log.debug(`slack: ephemeral post failed: ${String(err)}`)
    }
    return true
  }
  const displayName = await ctx.userCache.displayName(event.user)
  const authorLabel = displayName ?? event.user
  entry.send({ text: `@${authorLabel}: ${event.value}` })
  return true
}
