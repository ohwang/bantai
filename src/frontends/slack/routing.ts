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
import type { ConfigDiff } from "./config/reloader"
import {
  isChannelConfigured,
  resolveProjectForChannel,
  type ProjectConfig,
} from "./router/resolver"
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
import type { InboundFileMetadata } from "./transport/events"
import {
  fetchThreadHistory,
  formatThreadHistory,
} from "./inbox/thread-history"
import {
  createEventRenderer,
  type EventRenderer,
} from "./view/event-renderer"
import type { SendAdapter } from "./view/outbox"
import { postSessionBanner } from "./view/banner"
import type { UserCache } from "./view/user-cache"
import { parseControlCommand } from "./commands/parser"
import { dispatchCommand, type CommandContext } from "./commands/dispatch"
import {
  classifyVisibility,
  parseSlashText,
  requiresThread,
  THREAD_REQUIRED_HINT,
} from "./commands/slash-adapter"
import type { ApprovalCoordinator } from "./approvals/coordinator"
import type { ElicitationCoordinator } from "./elicitations/coordinator"
import type { SessionStore } from "./store/sessions"
import type { StaleResumeCoordinator } from "./recovery/coordinator"
import type { InboundTurn } from "./inbox/turn-builder"
import type { SessionKeyParts } from "./router/registry"
import { mergeCumulativeUsage } from "./usage"

// ---------------------------------------------------------------------------
// RoutingCtx — the struct the launcher hands to `buildRoutingHandler`.
// ---------------------------------------------------------------------------

/**
 * User-scope per-channel state that must survive a config reload. When
 * `slack.json` changes, the cached `projectOverrides` map is blown away
 * and re-resolved from the new config; anything in this struct is layered
 * back on top so control-command state isn't clobbered by an unrelated
 * edit to `defaults` or a freshly-added channel row.
 */
export interface RuntimeChannelOverride {
  verbosity?: VerbosityLevel
  model?: string
}

export interface RoutingCtx {
  app: App
  /**
   * Current resolved config. Backed by a getter on the object literal so a
   * later `ConfigReloader` apply automatically surfaces the new value to
   * every downstream read — no re-wiring required. The interface shape stays
   * a plain property so existing call sites (`ctx.config.defaults…`) work
   * unchanged.
   */
  readonly config: ResolvedSlackConfig
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
  /**
   * Persistent session store — the same handle `SessionRegistry` uses.
   * Exposed here so the stale-resume coordinator can inspect the persisted
   * row BEFORE `getOrCreate` mutates it.
   */
  store: SessionStore
  /**
   * Coordinator that intercepts inbound turns whose persisted backend session
   * can't be resumed (backend flipped, session file deleted). Posts a Block
   * Kit card + persists the queued turn for replay on click.
   */
  staleResume: StaleResumeCoordinator
  /** Fetches inbound file attachments into images / staging files. */
  attachments: AttachmentFetcher
  /**
   * One event-renderer per live session, keyed on the session entry so we
   * can recover the same renderer across multiple turns in the same thread.
   * Reactions anchor to the thread root and transition via the renderer's
   * internal state machine — no per-turn rebinding needed.
   */
  renderers: WeakMap<SessionEntry, EventRenderer>
  /**
   * Mutable per-channel project view — populated on first resolve, updated
   * by `!bantai verbosity` / `!bantai model` etc. without touching the
   * underlying immutable ResolvedSlackConfig. Cleared lazily on config
   * reload via `invalidateProjectOverrides` so the next access re-resolves
   * against the fresh config (runtime overrides are re-layered from
   * `runtimeOverrides`, see below).
   */
  projectOverrides: Map<string, ProjectConfig>
  /**
   * Per-channel runtime overrides that survive config reloads — a user who
   * typed `!bantai verbosity debug` shouldn't lose that setting because
   * somebody else edited slack.json to add a new channel. Narrow on purpose:
   * only fields the control-command surface writes. Merged on top of a
   * fresh resolution inside `mutableProjectFor`.
   */
  runtimeOverrides: Map<string, RuntimeChannelOverride>
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
  /**
   * The launcher's shared SendAdapter — wired with the `onPostSucceeded`
   * hook that records thread-participation. EVERY outbound agent post
   * (event renderer, banner, approvals, elicitations, stale-resume cards,
   * control replies) must go through this adapter so every successful
   * `chat.postMessage` records the (channel, thread) pair and the gate's
   * `threadHasPriorBotPost` signal stays in sync with what the bot has
   * actually said. Building a bare `buildDefaultSendAdapter(app)` skips
   * the hook — this was a latent bug where plain agent replies never
   * populated the participation cache.
   */
  sendAdapter: SendAdapter
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
      } else if (event.kind === "slash_command") {
        // Slash commands MUST ack within 3s or Slack surfaces
        // "operation_timeout" to the user. Fire an ephemeral ack so the
        // operator sees the shutdown banner instead of a raw timeout.
        try {
          await event.ack({
            response_type: "ephemeral",
            text: ":zzz: bantai is shutting down — please retry in a moment",
          })
        } catch (err) {
          log.debug(`slack: shutdown slash ack failed: ${String(err)}`)
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
          // Stale-resume cards share the same block_action wire envelope;
          // try that next so a "Start fresh" / "Resume with history" /
          // "Cancel turn" click from a previously-posted recovery card
          // doesn't fall through to the interactive-reply handler (which
          // would treat it as a bogus agent-authored button).
          const staleRes = await ctx.staleResume.handleBlockAction({
            actionId: event.actionId,
            userId: event.user,
            workspace: ctx.workspaceId,
          })
          if (staleRes.kind === "malformed") {
            const interactiveHandled = await handleInteractiveReplyAction(ctx, event)
            if (!interactiveHandled) {
              log.debug(
                `slack: unrecognised block_action ignored: ${event.actionId}`,
              )
            }
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
    if (event.kind === "slash_command") {
      await handleSlashCommand(ctx, event)
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

    // When the workspace has set up per-channel mappings but this
    // particular channel isn't one of them, refuse to silently fall
    // back to `defaults` + launchCwd (which usually means running in
    // the wrong repo). Post a helpful reply pointing at slack.json and
    // stop. Self-host mode (`channels: []`) is unaffected — every
    // channel there is intentionally using defaults.
    if (
      ctx.config.channels.length > 0 &&
      !isChannelConfigured(ctx.config, event.channel)
    ) {
      await postUnconfiguredChannelNotice(ctx, {
        channel: event.channel,
        threadTs: event.threadTs ?? event.ts,
        channelId: event.channel,
      })
      log.info(
        `slack: ignoring ${event.kind} in unconfigured channel ${event.channel} — posted helper`,
      )
      return
    }

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

/**
 * Post a one-shot "this channel isn't configured" reply and return.
 *
 * Called from the inbound handler when `channels[]` is non-empty but the
 * triggering channel isn't declared. The message is posted as a regular
 * threaded reply (not ephemeral) so the whole channel can see the
 * instruction — otherwise a follow-up user retries the same message and
 * gets the same silent no-response experience.
 *
 * Uses `buildDefaultSendAdapter` so the text flows through the standard
 * mrkdwn conversion in `view/format.ts` (backticks + bullets render
 * correctly in Slack).
 */
async function postUnconfiguredChannelNotice(
  ctx: RoutingCtx,
  args: { channel: string; threadTs: string; channelId: string },
): Promise<void> {
  const adapter = ctx.sendAdapter
  const text =
    `:wave: I'm not configured for this channel yet, so I'll stay quiet to avoid ` +
    `running in the wrong project.\n\n` +
    `Add an entry under \`channels\` in your \`slack.json\` with at least:\n` +
    `- \`id: "${args.channelId}"\`\n` +
    `- \`project_dir: "/path/to/repo"\`\n\n` +
    `Then run \`bantai slack doctor\` to verify the config and restart the bot.`
  try {
    await adapter.postMessage({
      channel: args.channel,
      threadTs: args.threadTs,
      text,
    })
  } catch (err) {
    log.error(`slack: unconfigured-channel notice failed: ${String(err)}`)
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

  // Stale-resume interception. When there's no live in-memory session for
  // this thread, consult the persisted row: a mismatched backend (channel
  // was flipped) or a missing session file means blindly calling
  // `getOrCreate` would hand the backend a sessionId it can't resume
  // (Gemini returns JSON-RPC -32603, Codex/Claude start fresh and drop
  // history silently). Instead we post a Block Kit card and stop the
  // dispatch mid-flight; the user picks a recovery strategy and the
  // coordinator calls back into `dispatchTurnToRegistry` to replay.
  if (!hadExistingSession) {
    const persisted = ctx.store.get(sessionKeyForParts(sessionParts))
    const detection = ctx.staleResume.detect({ persisted, project })
    if (detection) {
      const replayPreview = buildInboundTurn({
        text: combinedText,
        channel,
        ts: last.event.ts,
        threadTs: last.event.threadTs,
        userId,
        userDisplayName: displayName,
        botUserId: ctx.botUserId,
      })
      try {
        await ctx.staleResume.promptAndQueue({
          detection,
          sessionKey: sessionKeyForParts(sessionParts),
          channel,
          threadTs: replayPreview.parentTs,
          project,
          turn: replayPreview,
        })
      } catch (err) {
        log.error(
          `slack: stale-resume prompt failed for ${channel}:${replayPreview.parentTs}: ${String(err)}. Proceeding with a fresh session.`,
        )
      }
      return
    }
  }

  await dispatchTurnToRegistry(ctx, {
    turn,
    project,
    sessionParts,
    lastEventThreadTs: last.event.threadTs,
    lastEventTs: last.event.ts,
    incomingFiles: entries.flatMap((e) =>
      "files" in e.event && e.event.files ? e.event.files : [],
    ),
    hadExistingSession,
  })
}

/**
 * Session-key helper — a shim around `router/registry.sessionKeyFor` so this
 * module doesn't duplicate the canonical builder. Kept inline so routing.ts
 * stays free of a cross-module import cycle (registry imports session types;
 * routing holds a registry).
 */
function sessionKeyForParts(parts: SessionKeyParts): string {
  const thread = parts.threadTs ?? "main"
  return `slack:${parts.workspace}:${parts.channelId}:${thread}`
}

/**
 * The post-detection tail of dispatchMessageBatch — given a fully-built turn
 * + project + session identifiers, construct (or reuse) the SessionEntry,
 * wire up the renderer, prefetch thread history when appropriate, ingest
 * attachments, and push the turn into the backend.
 *
 * Extracted so the stale-resume coordinator can replay a queued turn
 * through the exact same path the original inbound would have taken. When
 * `replayContext` is set (inject decision), it's merged into the session
 * config overlay so the backend gets the foreign-session history on first
 * turn.
 */
export interface DispatchTurnOpts {
  turn: InboundTurn
  project: ProjectConfig
  sessionParts: SessionKeyParts
  /** The original last.event.threadTs — undefined for top-level messages. */
  lastEventThreadTs?: string
  /** The original last.event.ts — the most recent inbound in the batch. */
  lastEventTs: string
  /** Inbound file-event attachments, pre-flattened across the batch. */
  incomingFiles: InboundFileMetadata[]
  /**
   * True when a live in-memory session already existed at dispatch time.
   * Controls thread-history prefetch (only runs for NEW sessions).
   */
  hadExistingSession: boolean
  /**
   * Optional replayContext to stash into the backend on first turn. Supplied
   * by the stale-resume coordinator's `inject` path; absent for the normal
   * dispatch + `fresh` paths.
   */
  replayContext?: import("../../protocol/types").SessionConfig["replayContext"]
}

export async function dispatchTurnToRegistry(
  ctx: RoutingCtx,
  args: DispatchTurnOpts,
): Promise<void> {
  const { turn, project, sessionParts, hadExistingSession } = args
  const overlay: Partial<import("../../protocol/types").SessionConfig> = {
    ...buildSessionMcpOverlay({
      project,
      channel: turn.channel,
      threadTs: turn.parentTs,
      slackUploadMcp: ctx.slackUploadMcpFor,
    }),
    ...(args.replayContext ? { replayContext: args.replayContext } : {}),
  }

  const entry = ctx.registry.getOrCreate(
    sessionParts,
    project,
    turn.parentTs,
    overlay,
  )

  let renderer = ctx.renderers.get(entry)
  if (!renderer) {
    renderer = createEventRenderer({
      app: ctx.app,
      // Use the launcher's shared adapter so every outbound post runs the
      // `onPostSucceeded` hook that records thread participation. Without
      // this the gate's `threadHasPriorBotPost` fallback never fired for
      // plain agent replies and follow-ups silently dropped after idle-
      // close / restart.
      sendAdapter: ctx.sendAdapter,
      binding: {
        channel: turn.channel,
        threadTs: turn.parentTs,
        // Reactions live on the thread ROOT, not on the per-turn trigger
        // message. Mid-thread mentions inherit the thread's original ts,
        // so the 📍 / 💬 emoji stays pinned to the first post that
        // opened the thread — never on each individual user message.
        triggerTs: turn.parentTs,
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
  }
  // Subsequent turns reuse the same renderer + reaction controller. The
  // next turn_start AgentEvent naturally flips the emoji 📍 → 💬 via the
  // controller's state machine, so there's no per-turn rebind to do here.

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
  const triggeredMidThread = !!args.lastEventThreadTs
  const shouldPrefetchHistory =
    triggeredMidThread &&
    !hadExistingSession &&
    !entry.resumed &&
    project.threadHistoryLimit > 0
  if (shouldPrefetchHistory) {
    const prefix = await buildThreadHistoryPrefix(ctx, {
      channelId: turn.channel,
      threadTs: args.lastEventThreadTs!,
      currentMessageTs: args.lastEventTs,
      limit: project.threadHistoryLimit,
    })
    if (prefix) {
      turn.text = `${prefix}\n\n${turn.text}`
    }
  }

  // Pool attachments across the batch — a user who drops two images in
  // quick succession expects the agent to see both in the same turn.
  if (args.incomingFiles.length > 0) {
    try {
      const ingested = await ctx.attachments.fetch(args.incomingFiles, {
        channelId: turn.channel,
        ts: args.lastEventTs,
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
 *
 * Cache semantics: `projectOverrides` is a plain perf cache that
 * `invalidateProjectOverrides` clears after a config reload. User-scope
 * overrides (`!bantai verbosity`, `!bantai model`) live in
 * `ctx.runtimeOverrides` and are re-layered on top of a fresh resolution
 * when the cache is cold.
 */
export function mutableProjectFor(ctx: RoutingCtx, channelId: string): ProjectConfig {
  const cached = ctx.projectOverrides.get(channelId)
  if (cached) return cached
  const fresh = resolveProjectForChannel(ctx.config, channelId, {
    launchCwd: ctx.launchCwd,
  })
  const withOverrides = applyRuntimeOverrides(fresh, ctx.runtimeOverrides.get(channelId))
  ctx.projectOverrides.set(channelId, withOverrides)
  return withOverrides
}

function applyRuntimeOverrides(
  project: ProjectConfig,
  overrides: RuntimeChannelOverride | undefined,
): ProjectConfig {
  if (!overrides) return project
  const next: ProjectConfig = { ...project }
  if (overrides.verbosity !== undefined) next.verbosity = overrides.verbosity
  if (overrides.model !== undefined) next.model = overrides.model
  return next
}

/**
 * Drop the cached per-channel resolutions in `ctx.projectOverrides` so the
 * next `mutableProjectFor(...)` re-resolves against `ctx.config`. Called
 * after a successful `ConfigReloader` apply.
 *
 * Invalidation scope is coarse on purpose: any resolved field
 * (defaults.*, workspace, store_path, channels[], mcp_servers) can cascade
 * into the per-channel view (e.g. defaults.verbosity flows into channels
 * that didn't set their own verbosity), so teasing apart "which channels'
 * resolutions actually changed" would duplicate the resolver's precedence
 * logic. Reloads are rare; clearing a Map<channelId, ProjectConfig> with a
 * handful of entries is trivial.
 *
 * Runtime overrides in `ctx.runtimeOverrides` are NOT cleared — they're
 * re-applied on the next access so `!bantai verbosity debug` survives an
 * unrelated config edit.
 */
export function invalidateProjectOverrides(
  ctx: RoutingCtx,
  _diff: ConfigDiff,
): void {
  ctx.projectOverrides.clear()
}

/**
 * Merge a partial runtime override into `ctx.runtimeOverrides[channelId]`.
 * Keeps existing keys (a later `!bantai verbosity` doesn't erase an earlier
 * `!bantai model`).
 */
function rememberRuntimeOverride(
  ctx: RoutingCtx,
  channelId: string,
  patch: Partial<RuntimeChannelOverride>,
): void {
  const prev = ctx.runtimeOverrides.get(channelId) ?? {}
  ctx.runtimeOverrides.set(channelId, { ...prev, ...patch })
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

/**
 * Slash-command dispatcher — entry point for every `/bantai …` invocation.
 *
 * The pipeline diverges from the `!bantai`-in-a-message path in two ways:
 *
 *   1. The response lands via Bolt's `ack()` callback rather than a fresh
 *      `chat.postMessage`. We wrap the `CommandContext.sendReply` so the
 *      FIRST call flows into the ack body (tagged `ephemeral` or
 *      `in_channel` per `classifyVisibility`). A hypothetical second reply
 *      from the same dispatch falls through to `chat.postMessage` via the
 *      shared SendAdapter — but none of today's commands emit two
 *      messages, so that branch is defensive rather than exercised.
 *   2. We skip `decideGate` entirely. A slash command is an explicit,
 *      Slack-authorised user action — the workspace's install grant is
 *      the authorization. Channel-gating (workspace with a configured
 *      `channels[]` list) still runs, because the bot has no project to
 *      mutate in an unknown channel.
 *
 * Thread-scoped commands (`stop`, `new`, `verbosity`, `model <id>`)
 * refuse to run without a `thread_ts` in the payload — there's no single
 * "active" session to mutate at the channel level. We respond with an
 * ephemeral "invoke inside a thread" hint rather than guessing.
 */
async function handleSlashCommand(
  ctx: RoutingCtx,
  event: Extract<InboundSlackEvent, { kind: "slash_command" }>,
): Promise<void> {
  const project = mutableProjectFor(ctx, event.channel)

  // Channel-configuration guard — mirrors the message path. An unconfigured
  // channel means the bot has no `projectDir` to act on; rather than fall
  // back to `launchCwd` (likely the wrong repo), tell the user what to
  // add to slack.json. Posted ephemerally so it doesn't spam the channel.
  if (
    ctx.config.channels.length > 0 &&
    !isChannelConfigured(ctx.config, event.channel)
  ) {
    await event.ack({
      response_type: "ephemeral",
      text:
        `:wave: I'm not configured for <#${event.channel}> yet. Add the ` +
        `channel id under \`channels\` in \`slack.json\` (at least ` +
        `\`id\` + \`project_dir\`) and re-run \`bantai slack doctor\`.`,
    })
    log.info(
      `slack: slash command in unconfigured channel ${event.channel} — ephemeral nudge`,
    )
    return
  }

  const command = parseSlashText(event.text)

  // Thread-scope gate (plan D2). Channel-level reads (help, status,
  // settings, cost, model-list) pass through; thread-scoped writes
  // bounce with a short hint so the user knows what to do next.
  if (requiresThread(command) && !event.threadTs) {
    await event.ack({ response_type: "ephemeral", text: THREAD_REQUIRED_HINT })
    return
  }

  const visibility = classifyVisibility(command)

  // `threadTs` in the CommandContext is used by `status` to print the
  // thread anchor in the resolved-config dump. At channel level there's
  // no thread — substitute a friendly placeholder rather than an empty
  // backtick pair.
  const threadTsForContext = event.threadTs ?? "<channel-level>"

  // Session lookup: only meaningful when we actually have a thread.
  // Channel-level commands treat `existing` as undefined and the
  // dispatcher falls back to the project-config snapshot (availableModels
  // returns [], cumulativeUsage returns "no cost tracked yet", etc.).
  const sessionParts = event.threadTs
    ? {
        workspace: ctx.workspaceId,
        channelId: event.channel,
        threadTs: event.threadTs,
      }
    : undefined
  const existing = sessionParts ? ctx.registry.peek(sessionParts) : undefined

  // Single-shot ack: the FIRST `sendReply` call becomes the ack body; any
  // subsequent reply (defensive — no command emits two today) is posted
  // via `chat.postMessage` so the user still sees it. The transport-layer
  // `safeAck` wrapper in events.ts further guards against double-ack.
  let acked = false
  const adapter = ctx.sendAdapter

  const commandCtx: CommandContext = {
    async sendReply(text) {
      if (!acked) {
        acked = true
        try {
          await event.ack({ response_type: visibility, text })
        } catch (err) {
          log.error(`slack slash: ack failed: ${String(err)}`)
        }
        return
      }
      // Defensive follow-up path. Channel-level (no thread): ephemeral so
      // the wider channel stays quiet. Thread-level: regular threaded
      // reply so participants see the state change.
      try {
        if (event.threadTs) {
          await adapter.postMessage({
            channel: event.channel,
            threadTs: event.threadTs,
            text,
          })
        } else {
          await ctx.app.client.chat.postEphemeral({
            channel: event.channel,
            user: event.user,
            text,
          })
        }
      } catch (err) {
        log.error(`slack slash: follow-up sendReply failed: ${String(err)}`)
      }
    },
    interrupt() {
      existing?.host.backend.interrupt()
    },
    async setModel(model) {
      if (existing) await existing.host.backend.setModel(model)
      ctx.projectOverrides.set(project.channelId, { ...project, model })
      rememberRuntimeOverride(ctx, project.channelId, { model })
    },
    async resetSession() {
      existing?.reset()
    },
    setVerbosity(level: VerbosityLevel) {
      ctx.projectOverrides.set(project.channelId, { ...project, verbosity: level })
      rememberRuntimeOverride(ctx, project.channelId, { verbosity: level })
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
    workspace: ctx.workspaceId,
    channel: event.channel,
    threadTs: threadTsForContext,
  }

  await dispatchCommand(command, commandCtx)

  // If dispatchCommand didn't end up calling sendReply (e.g. a future
  // no-op command), we still owe Slack an ack. Fire an empty one so the
  // command doesn't render as a 3-second timeout to the user.
  if (!acked) {
    acked = true
    try {
      await event.ack({})
    } catch (err) {
      log.error(`slack slash: fallback empty ack failed: ${String(err)}`)
    }
  }
}

async function handleControlCommand(args: CommandRouteArgs): Promise<void> {
  const { ctx, cmd, project, channel, threadTs, sessionParts } = args
  const adapter = ctx.sendAdapter
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
      rememberRuntimeOverride(ctx, project.channelId, { model })
    },
    async resetSession() {
      existing?.reset()
    },
    setVerbosity(level: VerbosityLevel) {
      ctx.projectOverrides.set(project.channelId, { ...project, verbosity: level })
      rememberRuntimeOverride(ctx, project.channelId, { verbosity: level })
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
  const adapter = ctx.sendAdapter
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
