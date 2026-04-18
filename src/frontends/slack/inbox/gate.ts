/**
 * Mention / trigger gate.
 *
 * Decides whether an inbound message should drive a backend turn or be
 * silently ignored. The rules follow plan §2.3 + §9.1:
 *
 *   - DMs (channel starts with "D") ALWAYS trigger, regardless of mention.
 *   - Channel messages require one of:
 *       a) a `<@BOTID>` mention of our bot user, OR
 *       b) `project.autoJoinThreads && thread is already attached`
 *          — i.e. the bot has replied in this thread before, so replies
 *          without re-mentions continue to drive the same session.
 *       c) `project.requireMention === false` — explicit opt-out, useful
 *          for "sandbox" channels where every post goes to the agent.
 *
 * Returns a decision object so the launcher can log the reason in debug
 * mode. Keep this file pure — no side effects, no logging.
 */

export interface GateContext {
  /** Message channel id. DMs start with "D". */
  channel: string
  /** Raw text, still containing any `<@UXXX>` mention tokens. */
  text: string
  /** Thread anchor ts (falsy when the message is top-level). */
  threadTs?: string
  /** The bot's own user id, from auth.test. */
  botUserId: string
  /** Whether the channel config requires @mentions. Comes from ProjectConfig. */
  requireMention: boolean
  /** Whether auto-attaching to threads is enabled. */
  autoJoinThreads: boolean
  /** True when the (channel, thread) pair already has an active SessionHost. */
  threadHasActiveSession: boolean
}

export type GateDecision =
  | { accept: true; reason: "dm" | "mention" | "thread-auto-join" | "no-mention-required" }
  | { accept: false; reason: "no-mention-in-channel" | "empty-text" | "self" }

export function decideGate(ctx: GateContext): GateDecision {
  const t = ctx.text.trim()
  if (t.length === 0) return { accept: false, reason: "empty-text" }

  // DMs always pass (channel id starts with "D" for IMs / MPIMs in Slack).
  if (isDm(ctx.channel)) return { accept: true, reason: "dm" }

  if (mentionsBot(ctx.text, ctx.botUserId)) {
    return { accept: true, reason: "mention" }
  }

  if (!ctx.requireMention) {
    return { accept: true, reason: "no-mention-required" }
  }

  if (ctx.autoJoinThreads && ctx.threadTs && ctx.threadHasActiveSession) {
    return { accept: true, reason: "thread-auto-join" }
  }

  return { accept: false, reason: "no-mention-in-channel" }
}

// Exported for the inbox + commands modules.
export function isDm(channelId: string): boolean {
  return channelId.startsWith("D")
}

export function mentionsBot(text: string, botUserId: string): boolean {
  // Slack encodes mentions as "<@U12345>" or "<@U12345|handle>". Match both.
  return new RegExp(`<@${escapeRegex(botUserId)}(\\|[^>]*)?>`).test(text)
}

export function stripBotMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${escapeRegex(botUserId)}(\\|[^>]*)?>`, "g"), "")
    .replace(/\s+/g, " ")
    .trim()
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
