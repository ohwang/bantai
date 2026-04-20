/**
 * Integration test — thread-history prefetch.
 *
 * Scenario: two users (alice, bob) discuss a topic in a thread. The bot
 * isn't mentioned at first. Several turns in, alice @-mentions @bantai.
 * The agent should receive a first-turn message that includes a
 * `<slack_thread_history>` preamble with every prior message rendered
 * (author, role, timestamp), followed by the triggering message.
 *
 * We also check two negative cases:
 *   1. A top-level @-mention (no thread_ts) gets no preamble — there's
 *      no thread to backfill.
 *   2. Once the session is live, a follow-up in-thread message does NOT
 *      trigger another prefetch (the live session already knows the
 *      history from the first turn).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { startMinislack, type MinislackHandle } from "../../../../src/minislack/testing/harness"
import { joinChannel } from "../../../../src/minislack/core/channels"
import {
  launchSlack,
  type SlackLaunchHandle,
} from "../../../../src/frontends/slack/launcher"
import type { CLIFlags } from "../../../../src/cli/options"
import type {
  AgentBackend,
  BackendCapabilities,
  ConversationEvent,
  ModelInfo,
  SessionInfo,
  UserMessage,
} from "../../../../src/protocol/types"
import { createSessionHost } from "../../../../src/session/host"
import { SubagentManager } from "../../../../src/subagents/manager"

const BASE_FLAGS: CLIFlags = {
  config: {},
  backend: "claude",
  help: false,
  version: false,
  debug: false,
  debugBackend: false,
  noDiagnosticsMcp: true,
}

/**
 * A minimal AgentBackend that records every UserMessage passed to it
 * and emits only `session_init` + a no-op stream. Lets the test assert
 * on exactly what text the router shoved into the session.
 */
function createRecordingBackend(): {
  backend: AgentBackend
  messages: UserMessage[]
  close: () => void
} {
  const state = { messages: [] as UserMessage[], closed: false }
  let resolveEnd: (() => void) | null = null

  async function* start(): AsyncGenerator<ConversationEvent> {
    const endPromise = new Promise<void>((r) => {
      resolveEnd = r
    })
    yield {
      type: "session_init",
      tools: [],
      models: [],
      sessionId: "recording-session",
    }
    while (!state.closed) {
      await Promise.race([endPromise, new Promise((r) => setTimeout(r, 50))])
    }
  }

  const backend: AgentBackend = {
    capabilities(): BackendCapabilities {
      return {
        name: "recording",
        supportsThinking: false,
        supportsToolApproval: false,
        supportsResume: false,
        supportsContinue: false,
        supportsFork: false,
        supportsStreaming: true,
        supportsSubagents: false,
        supportsCompact: false,
        supportedPermissionModes: ["default"],
      }
    },
    start,
    resume() {
      throw new Error("resume not supported")
    },
    sendMessage(msg) {
      state.messages.push(msg)
    },
    interrupt() {},
    approveToolUse() {},
    denyToolUse() {},
    respondToElicitation() {},
    cancelElicitation() {},
    async setModel() {},
    async setPermissionMode() {},
    async setEffort() {},
    async availableModels(): Promise<ModelInfo[]> {
      return []
    },
    async listSessions(): Promise<SessionInfo[]> {
      return []
    },
    async forkSession(): Promise<string> {
      throw new Error("fork not supported")
    },
    close() {
      state.closed = true
      resolveEnd?.()
    },
  }

  return {
    backend,
    get messages() {
      return state.messages
    },
    close: () => {
      state.closed = true
      resolveEnd?.()
    },
  }
}

describe("slack frontend — thread-history prefetch on mid-thread mention", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle
  let botUserId: string
  let aliceId: string
  let bobId: string
  let generalId: string
  let recording!: ReturnType<typeof createRecordingBackend>

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    const registered = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history", "users:read"],
      subscribed_events: ["message", "app_mention"],
    })

    const general = Array.from(mini.workspace.channels.values()).find(
      (c) => (c.is_channel === true || c.is_group === true) && "name" in c && c.name === "general",
    )
    if (!general) throw new Error("fixture missing #general")
    generalId = general.id
    aliceId = Array.from(mini.workspace.users.values()).find((u) => u.name === "alice")!.id
    bobId = Array.from(mini.workspace.users.values()).find((u) => u.name === "bob")!.id
    joinChannel(mini.workspace, general.id, registered.botUser.id)

    recording = createRecordingBackend()

    slack = (await launchSlack({
      ...BASE_FLAGS,
      returnHandle: true,
      slackConfigInline: {
        workspace: {
          mode: "socket",
          bot_token: registered.botToken,
          app_token: registered.appToken,
          slack_api_url: mini.url,
        },
        defaults: {
          backend: "mock",
          verbosity: "normal",
          require_mention: true,
          auto_join_threads: true,
          session_banner: false,
          thread_history_limit: 10,
        },
      },
      buildHost: ({ sessionConfig }) => {
        const subagentManager = new SubagentManager()
        const host = createSessionHost({
          backend: recording.backend,
          config: sessionConfig,
          subagentManager,
          currentBackend: "claude",
          close: () => recording.close(),
        })
        return { host, backend: recording.backend }
      },
    })) as SlackLaunchHandle
    botUserId = slack.botUserId
    slack.userCache.seed(aliceId, "alice")
    slack.userCache.seed(bobId, "bob")

    await new Promise((r) => setTimeout(r, 150))
  })

  afterAll(async () => {
    await slack?.stop()
    await new Promise((r) => setTimeout(r, 250))
    await mini?.stop()
    await new Promise((r) => setTimeout(r, 50))
  })

  it("prepends <slack_thread_history> preamble on a mid-thread first mention", async () => {
    // Alice starts a thread; Bob replies; Alice replies. No bot mentions yet.
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, "I'm debugging the auth flow — seeing a 401 on /login")
    await mini.asUser(bobId).sendMessage(
      generalId,
      "Did you check the cookie domain? We had this bite us last month.",
      { thread_ts: parent.ts },
    )
    await mini
      .asUser(aliceId)
      .sendMessage(
        generalId,
        "Checked — cookie is right. The token just stops working after a refresh.",
        { thread_ts: parent.ts },
      )

    // Now Alice pulls the bot in mid-thread.
    const before = recording.messages.length
    await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> any idea what's going on?`, {
        thread_ts: parent.ts,
      })

    const firstTurn = await waitForNewMessage(recording, before)
    // Preamble wrapper and header.
    expect(firstTurn.text).toContain("<slack_thread_history>")
    expect(firstTurn.text).toContain("</slack_thread_history>")
    // Every prior message is included with display name + role.
    expect(firstTurn.text).toContain(
      "alice (user): I'm debugging the auth flow — seeing a 401 on /login",
    )
    expect(firstTurn.text).toContain(
      "bob (user): Did you check the cookie domain? We had this bite us last month.",
    )
    expect(firstTurn.text).toContain(
      "alice (user): Checked — cookie is right. The token just stops working after a refresh.",
    )
    // The triggering message itself appears after the preamble with its
    // usual `@alice:` prefix.
    const historyEnd = firstTurn.text.indexOf("</slack_thread_history>")
    const afterHistory = firstTurn.text.slice(historyEnd)
    expect(afterHistory).toContain("@alice: any idea what's going on?")
    // The triggering message must NOT also appear inside the preamble —
    // we explicitly filter `currentMessageTs` out so the agent doesn't
    // see the current request twice.
    const inHistory = firstTurn.text.slice(0, historyEnd)
    expect(inHistory).not.toContain("any idea what's going on?")
  })

  it("does NOT re-prefetch history on follow-up turns in the same thread", async () => {
    // Starting state: the previous test left a live session anchored on
    // the prior thread. Use a fresh thread here to keep the test hermetic.
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, "new discussion about caching")
    await mini
      .asUser(bobId)
      .sendMessage(generalId, "are we still hitting the DB?", { thread_ts: parent.ts })

    const before = recording.messages.length
    await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> take a look`, {
        thread_ts: parent.ts,
      })
    const firstTurn = await waitForNewMessage(recording, before)
    expect(firstTurn.text).toContain("<slack_thread_history>")

    // Second mention in the SAME thread — session is now live, no refetch.
    const before2 = recording.messages.length
    await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> also what about TTLs?`, {
        thread_ts: parent.ts,
      })
    const secondTurn = await waitForNewMessage(recording, before2)
    expect(secondTurn.text).not.toContain("<slack_thread_history>")
    expect(secondTurn.text).toContain("@alice: also what about TTLs?")
  })

  it("does NOT prepend history when the mention is a NEW top-level thread", async () => {
    const before = recording.messages.length
    await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> brand new conversation, no context`)
    const turn = await waitForNewMessage(recording, before)
    expect(turn.text).not.toContain("<slack_thread_history>")
    expect(turn.text).toContain("@alice: brand new conversation, no context")
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForNewMessage(
  recording: { messages: UserMessage[] },
  before: number,
  timeoutMs = 5000,
): Promise<UserMessage> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (recording.messages.length > before) {
      return recording.messages[before]!
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(
    `timed out waiting for a new UserMessage; captured so far: ${JSON.stringify(
      recording.messages.slice(before),
      null,
      2,
    )}`,
  )
}
