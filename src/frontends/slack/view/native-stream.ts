/**
 * Native Slack text streaming via `chat.startStream` / `chat.appendStream` /
 * `chat.stopStream`.
 *
 * Slack's AI-app surface exposes a `ChatStreamer` (see
 * `@slack/web-api/dist/chat-stream`) that streams markdown tokens into a
 * single updating message. This is the tier-1 delivery path in plan §6
 * — noticeably better UX than our tier-2 draft+update loop because
 * Slack handles the streaming rate server-side and the message lights
 * up in the Assistant-thread UI.
 *
 * Constraints we inherit from Slack:
 *   - Requires `thread_ts` on every stream start. Top-level posts can't
 *     stream natively; the outbox falls back to tier-2 for those.
 *   - `recipient_team_id` needed at stop-time; obtain from `auth.test`.
 *   - DMs require `recipient_user_id` or the stop call 400s with
 *     `missing_recipient_user_id`. Socket-mode workspaces without the
 *     AI-apps capability get a generic error back and the outbox
 *     falls back.
 *
 * Requires live Slack workspace validation (see slack-int-gap.md §4).
 * minislack does not implement `chat.startStream` / `appendStream` /
 * `stopStream` — the outbox auto-falls-back on the 400 return code, so
 * local dogfood remains safe with this module loaded.
 *
 * Ported from openclaw/extensions/slack/src/streaming.ts (MIT). Bantai
 * changes: swap `logVerbose` for our `log.debug` singleton; drop the
 * SDK-provided proxy-agent helper (unused in bantai today).
 */

import type { App } from "@slack/bolt"
import { log } from "../../../utils/logger"

// The `ChatStreamer` type lives in `@slack/web-api` but isn't exported
// through the bolt `App.client` typings. We shape the minimal surface
// we use here to avoid reaching into SDK internals.
interface ChatStreamerLike {
  append(args: { markdown_text: string }): Promise<unknown>
  stop(args?: { markdown_text: string }): Promise<unknown>
}

interface AppClientWithChatStream {
  chatStream(args: {
    channel: string
    thread_ts: string
    recipient_team_id?: string
    recipient_user_id?: string
  }): ChatStreamerLike
}

export interface NativeStreamSession {
  channel: string
  threadTs: string
  streamer: ChatStreamerLike
  stopped: boolean
}

export interface StartNativeStreamOpts {
  app: App
  channel: string
  threadTs: string
  text?: string
  teamId?: string
  userId?: string
}

export async function startNativeSlackStream(
  opts: StartNativeStreamOpts,
): Promise<NativeStreamSession> {
  const { app, channel, threadTs, text, teamId, userId } = opts
  const client = app.client as unknown as {
    chatStream?: AppClientWithChatStream["chatStream"]
  }
  if (typeof client.chatStream !== "function") {
    throw new Error(
      "slack native streaming: app.client.chatStream is not available — upgrade @slack/web-api",
    )
  }
  log.debug(
    `slack native-stream: start channel=${channel} thread=${threadTs}` +
      `${teamId ? ` team=${teamId}` : ""}${userId ? ` user=${userId}` : ""}`,
  )
  const streamer = client.chatStream({
    channel,
    thread_ts: threadTs,
    ...(teamId ? { recipient_team_id: teamId } : {}),
    ...(userId ? { recipient_user_id: userId } : {}),
  })
  const session: NativeStreamSession = {
    channel,
    threadTs,
    streamer,
    stopped: false,
  }
  if (text) {
    await streamer.append({ markdown_text: text })
    log.debug(`slack native-stream: appended initial ${text.length} chars`)
  }
  return session
}

export async function appendNativeSlackStream(
  session: NativeStreamSession,
  text: string,
): Promise<void> {
  if (session.stopped) {
    log.debug("slack native-stream: append after stop, ignoring")
    return
  }
  if (!text) return
  await session.streamer.append({ markdown_text: text })
  log.debug(`slack native-stream: appended ${text.length} chars`)
}

export async function stopNativeSlackStream(
  session: NativeStreamSession,
  text?: string,
): Promise<void> {
  if (session.stopped) {
    log.debug("slack native-stream: duplicate stop ignored")
    return
  }
  session.stopped = true
  log.debug(
    `slack native-stream: stop channel=${session.channel}` +
      `${text ? ` (final ${text.length} chars)` : ""}`,
  )
  await session.streamer.stop(text ? { markdown_text: text } : undefined)
}
