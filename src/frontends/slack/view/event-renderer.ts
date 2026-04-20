/**
 * Event renderer — AgentEvent → Slack side-effects.
 *
 * The renderer is bound to one (channel, threadTs, triggerTs) triple: the
 * channel + thread ts the bot's replies post to, plus the ts the status
 * reaction lands on. `triggerTs` is the THREAD ROOT (one emoji per thread,
 * never per-turn or per-message) — for a top-level mention it's the
 * message itself, for a mid-thread mention it's the thread's parent post,
 * NOT the message that pulled bantai in.
 *
 * Per turn it drives:
 *   - an OutboundStream (view/outbox.ts) — draft `chat.postMessage` →
 *     throttled `chat.update` tier-2 streaming, tier-3 chunked fallback
 *     on failure. Started on the first `text_delta` and stopped on
 *     `turn_complete`.
 *   - a StatusReactionController (view/reactions.ts) — emoji state
 *     machine pinned to the thread root. Lives for the full renderer
 *     lifetime so the 📍 ⇄ 💬 flip happens on the same message across
 *     every turn in the session (a fresh controller per turn would leave
 *     a stale 📍 behind on turn N when turn N+1 starts).
 *   - error posts rendered inline with a terse `[error|warn] code: message`
 *     reply.
 *   - tool cards, plan updates, and thinking breakouts (verbosity ≥ verbose).
 *
 * We feed events through the shared 16ms EventBatcher (same coalescer the
 * TUI uses) so bursts of deltas don't pummel Slack.
 */

import type { App } from "@slack/bolt"
import type { ConversationEvent, TokenUsage } from "../../../protocol/types"
import { EventBatcher } from "../../../utils/event-batcher"
import { log } from "../../../utils/logger"
import type { ApprovalHook } from "../approvals/coordinator"
import type { ElicitationHook } from "../elicitations/coordinator"
import type { VerbosityLevel } from "../config/schema"
import {
  createOutboundStream,
  type NativeStreamCapability,
  type OutboundIdentity,
  type OutboundStream,
  type SendAdapter,
} from "./outbox"
import {
  createStatusReactionController,
  type ReactionAdapter,
  type StatusReactionController,
} from "./reactions"
import {
  createThreadStatusController,
  type ThreadStatusAdapter,
  type ThreadStatusController,
} from "./thread-status"
import {
  buildConciseToolSummary,
  buildToolCompletedCard,
  buildToolRunningCard,
} from "./blocks/tool-card"
import { buildPlanBlocks } from "./blocks/plan"
import { buildThinkingBlocks } from "./blocks/thinking"
import { compileSlackInteractiveReplies } from "./interactive-replies"
import {
  buildSlackFileClient,
  uploadFileBestEffort,
  type SlackFileClient,
} from "./upload"
import { buildDefaultSendAdapter } from "./send-adapter"
import { buildCostFooter } from "./cost-footer"

// Re-exports so existing imports of `event-renderer` keep working after
// the send-adapter + cost-footer extractions.
export { buildDefaultSendAdapter } from "./send-adapter"
export { buildCostFooter } from "./cost-footer"

export interface RendererBinding {
  /** Channel id to post replies in. */
  channel: string
  /** Thread anchor ts for replies. */
  threadTs: string
  /**
   * Thread-root ts the reaction state machine pins to. One emoji per
   * thread, never per-turn or per-message — the waiting 📍 / working 💬
   * pair lives on this single ts across every turn in the session.
   * For a top-level mention this is the message itself; for a mid-thread
   * mention this is the thread's PARENT (ts of the thread's first post),
   * NOT the message that pulled bantai in. Undefined → reactions disabled
   * (test stub).
   */
  triggerTs?: string
}

export interface EventRenderer {
  /** Subscriber to pass into registry.entry.subscribe. */
  onEvent(event: ConversationEvent): void
  /** Force-flush any pending events (e.g. on shutdown). */
  flush(): void
  /** Stop the renderer. Does NOT post any pending text. */
  destroy(): void
  /**
   * Cumulative cost + token totals for this session, summed across every
   * turn the renderer has seen. Drives `!bantai cost` and the future cost
   * cap (plan §S8). Fresh renderers report zeros.
   */
  cumulativeUsage(): CumulativeUsage
}

export interface CumulativeUsage {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number
}

export interface CreateRendererOpts {
  app: App
  binding: RendererBinding
  /**
   * Test hook: replaces the live SendAdapter (chat.postMessage + chat.update)
   * so tests don't need a live WebClient.
   */
  sendAdapter?: SendAdapter
  /**
   * Test hook: replaces the live ReactionAdapter (reactions.add + reactions.remove).
   */
  reactionAdapter?: ReactionAdapter
  /**
   * Optional assistant-thread status adapter. When provided, every
   * agent event drives the `assistant.threads.setStatus` banner on
   * the bound thread ("thinking…", "running Bash…"). The launcher
   * always wires this; the controller self-disables gracefully on
   * channels that don't support the capability. Tests that don't
   * care about thread status omit it.
   */
  threadStatusAdapter?: ThreadStatusAdapter
  /**
   * Optional approval hook. When present, every `permission_request` event
   * is handed off to the hook; the launcher wires this to the approval
   * coordinator so cards land in Slack and clicks route back to the
   * backend's canUseTool resolver.
   */
  approvals?: ApprovalHook
  /**
   * Optional elicitation hook. Same shape as `approvals` — the launcher
   * wires it to the elicitation coordinator so `elicitation_request` events
   * surface as an inline "Answer questions" card + modal, and the click
   * path round-trips back through `backend.respondToElicitation` /
   * `backend.cancelElicitation`.
   */
  elicitations?: ElicitationHook
  /**
   * Verbosity level for tool/plan/thinking/cost surface. Defaults to
   * "normal". Reading the channel's resolved project config is the
   * launcher's job; the renderer takes the final value.
   */
  verbosity?: VerbosityLevel
  /**
   * Post a cost footer on every turn_complete. Off by default per plan §6
   * (verbosity gating still applies — at `silent` / `concise` no footer
   * is emitted regardless).
   */
  showCost?: boolean
  /**
   * Test hook — replace the production file client that powers long-
   * output auto-upload. When absent, the renderer builds one from `app`;
   * when `app` itself is a stub (unit tests), any upload attempt will
   * no-op silently via `uploadFileBestEffort`.
   */
  fileClient?: SlackFileClient
  /**
   * Threshold at which a tool_use_end.output triggers an auto-upload. Any
   * output whose line count exceeds this is uploaded as a file and the
   * tool card renders a permalink instead of an inline preview. Defaults
   * to 200 lines.
   */
  toolOutputFileLines?: number
  /**
   * Optional per-turn deadline in seconds. When set, the renderer arms a
   * timer on turn_start and calls `onTurnTimeout()` if turn_complete hasn't
   * landed by then. 0 / undefined → disabled.
   */
  turnTimeoutS?: number
  /**
   * Called when `turnTimeoutS` elapses before a turn_complete arrives. The
   * launcher wires this to `backend.interrupt()` so the backend actually
   * stops producing events. Pure function — the renderer itself only
   * renders the :hourglass_flowing_sand: warning, it does NOT call the
   * backend directly (keeps the module frontend-agnostic).
   */
  onTurnTimeout?: () => void
  /**
   * Optional session-wide cost cap in USD. Checked on every turn_complete;
   * if cumulative cost crosses the threshold, `onBudgetExceeded()` is
   * called once (subsequent turns still fire the callback so the launcher
   * can choose to gate them). 0 / undefined → disabled.
   */
  maxBudgetUsd?: number
  onBudgetExceeded?: (cumulativeUsd: number, cap: number) => void
  /**
   * When true, the final reply text is passed through
   * `compileSlackInteractiveReplies` — `[[slack_buttons:…]]` /
   * `[[slack_select:…]]` directives and trailing `Options: …` lines
   * are promoted into Block Kit actions. Clicks are routed by the
   * launcher's block_action handler and dispatched as a new inbound
   * turn carrying the clicked value.
   */
  interactiveReplies?: boolean
  /**
   * When provided, the outbox tries this tier-1 native-streaming path
   * on each new turn before falling back to tier-2 draft+update. The
   * launcher builds this from `app.client.chatStream` + resolved
   * teamId; tests leave it undefined so the outbox stays on tier-2.
   */
  nativeStream?: NativeStreamCapability
  /**
   * Optional per-agent identity (`username` / `iconUrl` / `iconEmoji`)
   * applied to every outbound post this renderer makes — draft/final
   * stream text, tool cards, plan/thinking breakouts, cost/budget
   * notices, interactive-reply blocks. Requires `chat:write.customize`
   * on the bot token; when the scope is missing, the send-adapter
   * silently falls back to the default workspace identity and logs
   * one warning per process.
   */
  identity?: OutboundIdentity
}

export function createEventRenderer(opts: CreateRendererOpts): EventRenderer {
  const { app, binding } = opts
  const baseSendAdapter: SendAdapter =
    opts.sendAdapter ?? buildDefaultSendAdapter(app)
  // Wrap once so every postMessage call in this renderer (tool cards,
  // thinking, plan, error inline, budget/timeout notices, concise
  // summary, cost footer) inherits the per-channel `identity` without
  // threading it through every handler.
  const sendAdapter: SendAdapter = opts.identity
    ? withIdentity(baseSendAdapter, opts.identity)
    : baseSendAdapter

  const reactionAdapter: ReactionAdapter =
    opts.reactionAdapter ?? {
      async addReaction(args) {
        const res = await app.client.reactions.add({
          channel: args.channel,
          timestamp: args.timestamp,
          name: args.name,
        })
        if (!res.ok) throw new Error(`reactions.add failed: ${res.error ?? "unknown"}`)
      },
      async removeReaction(args) {
        const res = await app.client.reactions.remove({
          channel: args.channel,
          timestamp: args.timestamp,
          name: args.name,
        })
        if (!res.ok) throw new Error(`reactions.remove failed: ${res.error ?? "unknown"}`)
      },
    }

  const verbosity: VerbosityLevel = opts.verbosity ?? "normal"
  const annotationsEnabled =
    verbosity !== "silent" && verbosity !== "concise"
  const showCost = opts.showCost ?? false
  const interactiveReplies = opts.interactiveReplies ?? false
  const toolOutputFileLines = Math.max(1, opts.toolOutputFileLines ?? 200)
  const turnTimeoutMs = (opts.turnTimeoutS ?? 0) * 1000
  const maxBudgetUsd = opts.maxBudgetUsd ?? 0
  let turnTimeoutTimer: ReturnType<typeof setTimeout> | undefined
  let budgetAlreadyExceeded = false
  const fileClient: SlackFileClient | undefined =
    opts.fileClient ?? (isLiveApp(app) ? buildSlackFileClient(app) : undefined)

  let triggerTs: string | undefined = binding.triggerTs
  let stream: OutboundStream | undefined
  let reactions: StatusReactionController | undefined
  // Thread-status banner lives alongside reactions — same lifecycle,
  // different API surface (`assistant.threads.setStatus` vs reactions).
  // Only instantiated when a threadStatusAdapter is provided.
  let threadStatus: ThreadStatusController | undefined
  let finalText: string | undefined
  let inTurn = false
  /** permission_request ids we've handed off to approvals but not yet heard
   *  a permission_response for. Used to auto-deny on interrupt/destroy. */
  const pendingApprovals = new Set<string>()
  /** elicitation_request ids outstanding. Auto-cancelled on interrupt/destroy. */
  const pendingElicitations = new Set<string>()

  // Per-turn tool card state (reset on turn_start).
  const toolCardTs = new Map<string, string>()
  const toolStartTime = new Map<string, number>()
  const toolInputCache = new Map<string, unknown>()
  const toolNameById = new Map<string, string>()
  /**
   * Per-tool-id promise chain so tool_use_end always runs AFTER its
   * tool_use_start's postMessage has resolved (otherwise the running card
   * ts isn't available yet and the end handler falls back to a fresh post).
   */
  const toolChain = new Map<string, Promise<void>>()
  /** Tools seen this turn (for the concise aggregator posted at turn_complete). */
  let toolHistory: string[] = []
  // Per-turn thinking state.
  let thinkingText = ""
  let thinkingMessageTs: string | undefined
  let lastThinkingPostAt = 0
  // Session-scoped plan message ts — edited in place on each plan_update.
  let planMessageTs: string | undefined
  // Latest TokenUsage seen in this turn (for cost footer).
  let turnUsage: TokenUsage | undefined
  let lastInputTokens = 0
  let lastOutputTokens = 0
  let lastCostUsd = 0
  // Session-cumulative usage — sums every turn_complete.usage plus every
  // standalone cost_usage event. Exposed via renderer.cumulativeUsage()
  // for `!bantai cost` and future cost-cap enforcement.
  const cumulative: CumulativeUsage = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0,
  }

  function armTurnTimeout(): void {
    if (turnTimeoutMs <= 0) return
    clearTurnTimeout()
    turnTimeoutTimer = setTimeout(() => {
      turnTimeoutTimer = undefined
      if (!inTurn) return
      try {
        opts.onTurnTimeout?.()
      } catch (err) {
        log.error(`slack renderer: onTurnTimeout threw: ${String(err)}`)
      }
      void sendAdapter
        .postMessage({
          channel: binding.channel,
          threadTs: binding.threadTs,
          text: `:hourglass_flowing_sand: turn exceeded ${opts.turnTimeoutS ?? 0}s — interrupting`,
        })
        .catch((err) => log.warn(`slack renderer: timeout notice post failed: ${String(err)}`))
    }, turnTimeoutMs)
  }

  function clearTurnTimeout(): void {
    if (turnTimeoutTimer !== undefined) {
      clearTimeout(turnTimeoutTimer)
      turnTimeoutTimer = undefined
    }
  }

  function maybeNotifyBudget(): void {
    if (maxBudgetUsd <= 0) return
    if (cumulative.totalCostUsd < maxBudgetUsd) return
    if (budgetAlreadyExceeded) return
    budgetAlreadyExceeded = true
    try {
      opts.onBudgetExceeded?.(cumulative.totalCostUsd, maxBudgetUsd)
    } catch (err) {
      log.error(`slack renderer: onBudgetExceeded threw: ${String(err)}`)
    }
    void sendAdapter
      .postMessage({
        channel: binding.channel,
        threadTs: binding.threadTs,
        text: `:moneybag: session cost $${cumulative.totalCostUsd.toFixed(4)} crossed cap $${maxBudgetUsd.toFixed(2)} — interrupting`,
      })
      .catch((err) => log.warn(`slack renderer: budget notice post failed: ${String(err)}`))
  }

  function ensureStream(): OutboundStream {
    if (!stream) {
      stream = createOutboundStream({
        // Hand the outbox the RAW adapter + identity so its `identity`
        // accessor (passed to outbox.ts directly) stays the single
        // source of truth. If we passed the wrapped adapter here, an
        // identity override would be applied twice — harmless but
        // confusing when reading a debug log.
        adapter: baseSendAdapter,
        channel: binding.channel,
        threadTs: binding.threadTs,
        ...(opts.nativeStream ? { nativeStream: opts.nativeStream } : {}),
        ...(opts.identity ? { identity: opts.identity } : {}),
      })
    }
    return stream
  }

  function ensureReactions(): StatusReactionController | undefined {
    if (!triggerTs) return undefined
    if (!reactions) {
      reactions = createStatusReactionController({
        adapter: reactionAdapter,
        channel: binding.channel,
        triggerTs,
        initial: "working",
      })
    }
    return reactions
  }

  function ensureThreadStatus(): ThreadStatusController | undefined {
    if (!opts.threadStatusAdapter) return undefined
    if (!threadStatus) {
      threadStatus = createThreadStatusController({
        adapter: opts.threadStatusAdapter,
        channel: binding.channel,
        threadTs: binding.threadTs,
      })
    }
    return threadStatus
  }

  function cancelPendingApprovals(): void {
    if (!opts.approvals || pendingApprovals.size === 0) return
    const ids = Array.from(pendingApprovals)
    pendingApprovals.clear()
    for (const id of ids) {
      try {
        opts.approvals.onCancel(id)
      } catch (err) {
        log.error(`slack renderer: approval cancel threw for ${id}: ${String(err)}`)
      }
    }
  }

  function cancelPendingElicitations(): void {
    if (!opts.elicitations || pendingElicitations.size === 0) return
    const ids = Array.from(pendingElicitations)
    pendingElicitations.clear()
    for (const id of ids) {
      try {
        opts.elicitations.onCancel(id)
      } catch (err) {
        log.error(`slack renderer: elicitation cancel threw for ${id}: ${String(err)}`)
      }
    }
  }

  async function endTurn(terminal: "done" | "interrupted" | "error"): Promise<void> {
    inTurn = false
    if (terminal !== "done") {
      cancelPendingApprovals()
      cancelPendingElicitations()
    }
    const s = stream
    // NOTE: `reactions` is NOT nulled here. The controller is session-
    // scoped (pinned to the thread root) so a fresh turn_start on the
    // next turn flips its state "waiting" → "working" and naturally
    // replaces the 📍 with 💬 on the same ts. A per-turn teardown would
    // leave a stale 📍 behind — the new controller would have
    // `applied=""` and just stack a second 💬 on top of the existing 📍.
    const r = reactions
    const ts = threadStatus
    const final = finalText
    stream = undefined
    threadStatus = undefined
    finalText = undefined
    if (s) {
      // Optionally compile interactive-reply directives out of the
      // final text. Only on "done" — interrupt / error paths skip
      // the DSL so buttons don't linger below an aborted reply.
      if (
        interactiveReplies &&
        terminal === "done" &&
        typeof final === "string" &&
        final.length > 0
      ) {
        const compiled = compileSlackInteractiveReplies(final)
        if (compiled.hasInteractive && compiled.blocks) {
          await s.stop(compiled.text, compiled.blocks)
        } else {
          await s.stop(final)
        }
      } else {
        await s.stop(final)
      }
    }
    if (r) await r.terminate(terminal)
    // Always clear the thread-status banner — a stale "thinking…" on a
    // timed-out turn reads as "the bot is hung," which is the opposite
    // of what we want to communicate.
    if (ts) await ts.terminate()
    if (terminal === "done") {
      await postPerTurnAnnotations()
    }
    // Reset per-turn state regardless of terminal kind.
    resetTurnState()
  }

  function resetTurnState(): void {
    toolCardTs.clear()
    toolStartTime.clear()
    toolInputCache.clear()
    toolNameById.clear()
    toolChain.clear()
    toolHistory = []
    thinkingText = ""
    thinkingMessageTs = undefined
    lastThinkingPostAt = 0
    turnUsage = undefined
    lastInputTokens = 0
    lastOutputTokens = 0
    lastCostUsd = 0
  }

  async function postPerTurnAnnotations(): Promise<void> {
    // Drain the tool chain so every tool card's post/update has settled
    // before we emit annotations that the caller will expect to land last.
    const chains = Array.from(toolChain.values())
    if (chains.length > 0) {
      await Promise.all(chains).catch(() => undefined)
    }

    // Concise: one summary line of the tool history.
    if (verbosity === "concise" && toolHistory.length > 0) {
      const summary = buildConciseToolSummary(toolHistory)
      if (summary) {
        try {
          await sendAdapter.postMessage({
            channel: binding.channel,
            threadTs: binding.threadTs,
            text: summary.text,
            blocks: summary.blocks,
          })
        } catch (err) {
          log.error(`slack renderer: concise summary post failed: ${String(err)}`)
        }
      }
    }
    // Cost footer: opt-in via showCost. Verbosity gates the detail level.
    if (
      showCost &&
      (verbosity === "normal" || verbosity === "verbose" || verbosity === "debug")
    ) {
      const footer = buildCostFooter({
        verbosity,
        usage: turnUsage,
        fallback: {
          inputTokens: lastInputTokens,
          outputTokens: lastOutputTokens,
          totalCostUsd: lastCostUsd,
        },
      })
      if (footer) {
        try {
          await sendAdapter.postMessage({
            channel: binding.channel,
            threadTs: binding.threadTs,
            text: footer.text,
            blocks: footer.blocks,
          })
        } catch (err) {
          log.error(`slack renderer: cost footer post failed: ${String(err)}`)
        }
      }
    }
  }

  function handleToolStart(event: {
    id: string
    tool: string
    input: unknown
  }): void {
    toolHistory.push(event.tool)
    toolInputCache.set(event.id, event.input)
    toolNameById.set(event.id, event.tool)
    toolStartTime.set(event.id, Date.now())
    if (!annotationsEnabled) return
    const card = buildToolRunningCard({
      id: event.id,
      tool: event.tool,
      input: event.input,
      verbosity,
    })
    if (!card) return
    const prior = toolChain.get(event.id) ?? Promise.resolve()
    const next = prior
      .then(async () => {
        try {
          const res = await sendAdapter.postMessage({
            channel: binding.channel,
            threadTs: binding.threadTs,
            text: card.text,
            blocks: card.blocks,
          })
          toolCardTs.set(event.id, res.ts)
        } catch (err) {
          log.error(`slack renderer: tool card post failed for ${event.id}: ${String(err)}`)
        }
      })
      .catch(() => undefined)
    toolChain.set(event.id, next)
  }

  function handleToolEnd(event: {
    id: string
    output: string
    error?: string
  }): void {
    if (!annotationsEnabled) return
    const tool = extractToolName(event.id)
    const input = toolInputCache.get(event.id)
    const started = toolStartTime.get(event.id)
    const elapsedMs = started !== undefined ? Date.now() - started : undefined
    const prior = toolChain.get(event.id) ?? Promise.resolve()
    const next = prior
      .then(async () => {
        // Decide whether to offload the output to a file before rendering.
        let renderOutput = event.output
        let permalink: string | undefined
        const lineCount = event.output ? event.output.split("\n").length : 0
        if (
          fileClient &&
          !event.error &&
          lineCount > toolOutputFileLines &&
          event.output
        ) {
          const filename = suggestToolOutputFilename(tool, event.id)
          const res = await uploadFileBestEffort(fileClient, {
            filename,
            content: event.output,
            channel: binding.channel,
            threadTs: binding.threadTs,
          })
          if (res) {
            permalink = res.permalink ?? undefined
            // Replace the body with a short summary — the upload carries
            // the full content. The full output is still available via
            // the permalink the card will show.  Stay strictly under the
            // tool card's 6-line preview so none of this gets truncated.
            const head = event.output.split("\n").slice(0, 4).join("\n")
            renderOutput =
              `${head}\n… full output (${lineCount} lines) in attached file`
          }
        }

        const card = buildToolCompletedCard({
          id: event.id,
          tool,
          input,
          output: renderOutput,
          ...(event.error !== undefined ? { error: event.error } : {}),
          ...(elapsedMs !== undefined ? { elapsedMs } : {}),
          verbosity,
        })
        if (!card) return
        // If we uploaded, append a permalink context block.
        if (permalink) {
          card.blocks.push({
            type: "context",
            elements: [
              { type: "mrkdwn", text: `:paperclip: <${permalink}|Full output>` },
            ],
          })
        }

        const ts = toolCardTs.get(event.id)
        try {
          if (ts) {
            await sendAdapter.updateMessage({
              channel: binding.channel,
              ts,
              text: card.text,
              blocks: card.blocks,
            })
          } else {
            // No running card landed (post failed, or start event was dropped) —
            // fall back to a fresh post so the completion is still visible.
            const res = await sendAdapter.postMessage({
              channel: binding.channel,
              threadTs: binding.threadTs,
              text: card.text,
              blocks: card.blocks,
            })
            toolCardTs.set(event.id, res.ts)
          }
        } catch (err) {
          log.error(`slack renderer: tool card update failed for ${event.id}: ${String(err)}`)
        }
      })
      .catch(() => undefined)
    toolChain.set(event.id, next)
  }

  function suggestToolOutputFilename(tool: string, toolId: string): string {
    const base = `${tool.toLowerCase()}-${toolId.slice(0, 8)}`.replace(/[^a-z0-9_-]/g, "")
    // Agents produce free-form output; default to .txt so syntax highlight
    // doesn't misinterpret it. Callers that produce JSON/diff can still
    // switch extension in a future polish pass.
    return `${base}.txt`
  }

  /** Recover the tool name from the start event — tool_use_end doesn't carry it. */
  function extractToolName(toolUseId: string): string {
    return toolNameById.get(toolUseId) ?? "Tool"
  }

  async function handleThinkingDelta(event: { text: string }): Promise<void> {
    if (verbosity !== "verbose" && verbosity !== "debug") return
    thinkingText += event.text
    // Throttle at ~250ms to avoid chat.update storms during fast streams.
    const now = Date.now()
    if (thinkingMessageTs && now - lastThinkingPostAt < 250) return
    const card = buildThinkingBlocks({ text: thinkingText, verbosity })
    if (!card) return
    try {
      if (thinkingMessageTs) {
        await sendAdapter.updateMessage({
          channel: binding.channel,
          ts: thinkingMessageTs,
          text: card.text,
          blocks: card.blocks,
        })
      } else {
        const res = await sendAdapter.postMessage({
          channel: binding.channel,
          threadTs: binding.threadTs,
          text: card.text,
          blocks: card.blocks,
        })
        thinkingMessageTs = res.ts
      }
      lastThinkingPostAt = now
    } catch (err) {
      log.error(`slack renderer: thinking post/update failed: ${String(err)}`)
    }
  }

  async function handlePlanUpdate(entries: readonly unknown[]): Promise<void> {
    if (verbosity === "silent") return
    const rendered = buildPlanBlocks({
      entries: entries as Parameters<typeof buildPlanBlocks>[0]["entries"],
    })
    if (!rendered) return
    try {
      if (planMessageTs) {
        await sendAdapter.updateMessage({
          channel: binding.channel,
          ts: planMessageTs,
          text: rendered.text,
          blocks: rendered.blocks,
        })
      } else {
        const res = await sendAdapter.postMessage({
          channel: binding.channel,
          threadTs: binding.threadTs,
          text: rendered.text,
          blocks: rendered.blocks,
        })
        planMessageTs = res.ts
      }
    } catch (err) {
      log.error(`slack renderer: plan post/update failed: ${String(err)}`)
    }
  }

  function applyEvents(events: ConversationEvent[]): void {
    for (const event of events) {
      // Feed every event into the reaction state machine + thread-status
      // banner. Both are display-only side effects — separate surfaces,
      // same lifecycle, so they're driven side by side here.
      ensureReactions()?.apply(event)
      ensureThreadStatus()?.apply(event)

      switch (event.type) {
        case "turn_start":
          inTurn = true
          finalText = undefined
          resetTurnState()
          armTurnTimeout()
          break
        case "text_delta":
          if (verbosity !== "silent") ensureStream().append(event.text)
          break
        case "text_complete":
          // Capture the canonical text for stop(finalText) to post.
          finalText = event.text
          // Touch the stream so the draft post happens for tool-only turns
          // that only speak at the very end.
          if (verbosity !== "silent") ensureStream().append("")
          break
        case "turn_complete":
          if (event.usage) turnUsage = event.usage
          // Session-cumulative usage update.
          cumulative.turns += 1
          if (event.usage) {
            cumulative.inputTokens += event.usage.inputTokens ?? 0
            cumulative.outputTokens += event.usage.outputTokens ?? 0
            cumulative.cacheReadTokens += event.usage.cacheReadTokens ?? 0
            cumulative.cacheCreationTokens +=
              event.usage.cacheWriteTokens ?? 0
            cumulative.totalCostUsd += event.usage.totalCostUsd ?? 0
          }
          clearTurnTimeout()
          maybeNotifyBudget()
          void endTurn("done").catch((err) =>
            log.error(`slack renderer: endTurn threw: ${String(err)}`),
          )
          break
        case "tool_use_start":
          handleToolStart(event)
          break
        case "tool_use_end":
          handleToolEnd(event)
          break
        case "thinking_delta":
          void handleThinkingDelta(event)
          break
        case "plan_update":
          void handlePlanUpdate(event.entries)
          break
        case "cost_update":
          lastInputTokens = event.inputTokens
          lastOutputTokens = event.outputTokens
          if (event.cost !== undefined) lastCostUsd = event.cost
          break
        case "interrupt":
          void endTurn("interrupted").catch((err) =>
            log.error(`slack renderer: endTurn threw: ${String(err)}`),
          )
          break
        case "error":
          if (event.severity === "fatal") {
            void postErrorInline(event.code, event.message, "fatal").then(() => endTurn("error"))
          } else {
            void postErrorInline(event.code, event.message, event.severity ?? "recoverable")
          }
          break
        case "permission_request":
          if (opts.approvals) {
            pendingApprovals.add(event.id)
            try {
              opts.approvals.onRequest({
                request: event,
                channel: binding.channel,
                threadTs: binding.threadTs,
              })
            } catch (err) {
              log.error(`slack renderer: approval onRequest threw: ${String(err)}`)
            }
          } else {
            log.warn(
              `slack renderer: permission_request ${event.id} (${event.tool}) — no approval hook wired, backend will block`,
            )
          }
          break
        case "permission_response":
          pendingApprovals.delete(event.id)
          break
        case "elicitation_request":
          if (opts.elicitations) {
            pendingElicitations.add(event.id)
            try {
              opts.elicitations.onRequest({
                request: event,
                channel: binding.channel,
                threadTs: binding.threadTs,
              })
            } catch (err) {
              log.error(`slack renderer: elicitation onRequest threw: ${String(err)}`)
            }
          } else {
            log.warn(
              `slack renderer: elicitation_request ${event.id} — no hook wired, backend will block`,
            )
          }
          break
        case "elicitation_response":
          pendingElicitations.delete(event.id)
          break
        default:
          log.debug(`slack renderer: consumed ${event.type} for reactions only`)
          break
      }
    }
  }

  async function postErrorInline(
    code: string,
    message: string,
    severity: string,
  ): Promise<void> {
    try {
      await sendAdapter.postMessage({
        channel: binding.channel,
        threadTs: binding.threadTs,
        text: `[${severity === "fatal" ? "error" : "warn"}] ${code}: ${message}`,
      })
    } catch (err) {
      log.error(`slack renderer: error-post failed: ${String(err)}`)
    }
  }

  const batcher = new EventBatcher(applyEvents, 16)

  return {
    onEvent(event) {
      batcher.push(event)
    },
    flush() {
      batcher.flush()
    },
    destroy() {
      batcher.destroy()
      clearTurnTimeout()
      if (inTurn) {
        void endTurn("interrupted").catch(() => undefined)
      } else {
        cancelPendingApprovals()
        cancelPendingElicitations()
      }
    },
    cumulativeUsage() {
      return { ...cumulative }
    },
  }
}

/**
 * True when `app` has a live Bolt client we can use for file uploads.
 * Unit tests pass a `{} as App` stub — we detect the absence of the
 * client and skip wiring the file surface so uploads silently no-op.
 */
function isLiveApp(app: App): boolean {
  const client = (app as { client?: unknown }).client
  if (!client || typeof client !== "object") return false
  const files = (client as { files?: unknown }).files
  return typeof files === "object" && files !== null
}

/**
 * Decorate a SendAdapter so every `postMessage` call rides with the
 * bound identity. If a caller already supplied `identity`, it wins —
 * this is a default, not an override.
 *
 * `updateMessage` is left untouched. Slack's `chat.update` ignores
 * identity fields, so carrying them here would just produce API
 * warnings for no gain.
 */
function withIdentity(
  base: SendAdapter,
  identity: OutboundIdentity,
): SendAdapter {
  return {
    postMessage(args) {
      return base.postMessage({
        ...args,
        identity: args.identity ?? identity,
      })
    },
    updateMessage(args) {
      return base.updateMessage(args)
    },
  }
}
