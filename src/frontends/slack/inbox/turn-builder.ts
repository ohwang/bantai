/**
 * Turn builder — assembles an `InboundTurn` from a gated Slack message.
 *
 * An InboundTurn is what the router feeds to `SessionHost.send(...)`. It
 * normalises the text (strips the leading bot mention), resolves the
 * thread anchor ts, and prefixes the text with the author's display name
 * so the agent sees who's talking. This turn prefix is the simplest piece
 * of "multi-user in one thread" support (plan §2.3) — we'll layer
 * participant lists + per-message attribution in S7.
 */

import { stripBotMention } from "./gate"

export interface TurnBuildOpts {
  text: string
  channel: string
  /** Top-level message ts if this is the session-anchor post, else undefined. */
  ts: string
  /** Thread anchor ts if the message is a reply in a thread. */
  threadTs?: string
  /** Author Slack user id. */
  userId: string
  /** Author display name — already resolved via users.info / cache. */
  userDisplayName?: string
  /** Bot user id — stripped from the text. */
  botUserId: string
}

export interface InboundTurn {
  /** Channel id the message came from. */
  channel: string
  /** ts of THIS message — useful for status reactions on the trigger. */
  triggerTs: string
  /** Anchor ts for replies — either the thread parent or the triggering ts. */
  parentTs: string
  /** The user's text with bot mention removed and authorship prefix added. */
  text: string
  /** Author info for downstream attribution (audit log, banner). */
  author: {
    userId: string
    displayName?: string
  }
}

export function buildInboundTurn(opts: TurnBuildOpts): InboundTurn {
  const stripped = stripBotMention(opts.text, opts.botUserId)
  const name = opts.userDisplayName ?? opts.userId
  const prefixed = stripped.length > 0 ? `@${name}: ${stripped}` : `@${name}:`
  return {
    channel: opts.channel,
    triggerTs: opts.ts,
    parentTs: opts.threadTs ?? opts.ts,
    text: prefixed,
    author: {
      userId: opts.userId,
      displayName: opts.userDisplayName,
    },
  }
}
