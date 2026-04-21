/**
 * Stale-resume integration test — the end-to-end shape of the
 * "previous session unavailable" recovery flow.
 *
 * Scenarios:
 *   1. A SQLite row pre-seeded with a foreign backend id (codex-era) gets
 *      detected on the next @mention. The bot posts the Block Kit recovery
 *      card INSTEAD of spinning up a doomed session.
 *   2. Clicking "Cancel turn" resolves the card in place and DOES NOT
 *      create a live session.
 *   3. Clicking "Start fresh" clears the stale backend_session_id, creates
 *      a new session on the current backend, and replays the queued turn
 *      (the backend receives the original user text).
 *
 * The test uses a capturing host-factory (same pattern as persistence.test.ts)
 * so we can assert the backend sees the exact SessionConfig + UserMessage
 * sequence the coordinator produced.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startMinislack, type MinislackHandle } from "../../../../src/minislack/testing/harness"
import { joinChannel } from "../../../../src/minislack/core/channels"
import {
  launchSlack,
  type SlackLaunchHandle,
} from "../../../../src/frontends/slack/launcher"
import { createSessionStore } from "../../../../src/frontends/slack/store/sessions"
import type { CLIFlags } from "../../../../src/cli/options"
import type { Message } from "../../../../src/minislack/types/slack"
import type { BlockActionsPayload } from "../../../../src/minislack/types/interactive"
import type {
  AgentBackend,
  BackendCapabilities,
  ConversationEvent,
  ModelInfo,
  SessionConfig,
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

interface CapturedStart {
  sessionConfig: SessionConfig
  messages: UserMessage[]
}

function createCapturingBackend(args: {
  sessionIdToEmit: string
  hosts: CapturedStart[]
}): AgentBackend {
  const state = { messages: [] as UserMessage[], closed: false }
  let resolveEnd: (() => void) | null = null

  async function* start(config: SessionConfig): AsyncGenerator<ConversationEvent> {
    args.hosts.push({ sessionConfig: config, messages: state.messages })
    const endPromise = new Promise<void>((r) => {
      resolveEnd = r
    })
    yield {
      type: "session_init",
      tools: [],
      models: [],
      sessionId: args.sessionIdToEmit,
    }
    while (!state.closed) {
      await Promise.race([
        new Promise((r) => setTimeout(r, 50)),
        endPromise,
      ])
    }
  }

  const backend: AgentBackend = {
    capabilities(): BackendCapabilities {
      return {
        name: "fake",
        supportsThinking: false,
        supportsToolApproval: false,
        supportsResume: true,
        supportsContinue: false,
        supportsFork: false,
        supportsStreaming: true,
        supportsSubagents: false,
        supportsCompact: false,
        supportedPermissionModes: ["default"],
      }
    },
    start,
    resume() { throw new Error("resume via separate method not supported") },
    sendMessage(msg) { state.messages.push(msg) },
    interrupt() {},
    approveToolUse() {},
    denyToolUse() {},
    respondToElicitation() {},
    cancelElicitation() {},
    async setModel() {},
    async setPermissionMode() {},
    async setEffort() {},
    async availableModels(): Promise<ModelInfo[]> { return [] },
    async listSessions(): Promise<SessionInfo[]> { return [] },
    async forkSession(): Promise<string> { throw new Error("fork not supported") },
    close() {
      state.closed = true
      resolveEnd?.()
    },
  }
  return backend
}

describe("slack frontend — stale-resume recovery", () => {
  let mini: MinislackHandle
  let storeDir: string
  let storePath: string
  let botUserId: string
  let aliceId: string
  let generalId: string
  let appId: string
  let registered: ReturnType<MinislackHandle["registerApp"]>

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    registered = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history"],
      subscribed_events: ["message", "app_mention"],
    })
    appId = registered.app.id
    const general = Array.from(mini.workspace.channels.values()).find(
      (c) => "name" in c && c.name === "general",
    )!
    generalId = general.id
    aliceId = Array.from(mini.workspace.users.values()).find((u) => u.name === "alice")!.id
    joinChannel(mini.workspace, generalId, registered.botUser.id)

    storeDir = mkdtempSync(join(tmpdir(), "bantai-stale-resume-"))
    storePath = join(storeDir, "slack.db")
  })

  afterAll(async () => {
    await mini?.stop()
    await new Promise((r) => setTimeout(r, 50))
    try {
      rmSync(storeDir, { recursive: true, force: true })
    } catch {}
  })

  /**
   * Helper: pre-seed a row with a foreign backend + sessionId so the
   * coordinator will fire on the next inbound.
   */
  function seedStaleRow(args: {
    workspace: string
    channelId: string
    threadTs: string
    priorBackend: string
    priorSessionId: string
  }): void {
    const key = `slack:${args.workspace}:${args.channelId}:${args.threadTs}`
    const s = createSessionStore({ path: storePath })
    s.upsert({
      key,
      workspace: args.workspace,
      channelId: args.channelId,
      threadTs: args.threadTs,
      backendId: args.priorBackend,
    })
    s.setBackendSessionId(key, args.priorSessionId)
    s.recordTurn(key, 0.5)
    s.close()
  }

  function findStaleCard(
    channelId: string,
    parentTs?: string,
  ): Message | undefined {
    const ch = mini.workspace.channels.get(channelId)
    if (!ch) return undefined
    for (const msg of ch.messages.values()) {
      if (parentTs && msg.thread_ts !== parentTs) continue
      const blocks = (msg as { blocks?: unknown[] }).blocks
      if (!Array.isArray(blocks)) continue
      for (const b of blocks) {
        if (typeof b !== "object" || b === null) continue
        const block = b as { type?: string; elements?: unknown[] }
        if (block.type !== "actions" || !Array.isArray(block.elements)) continue
        for (const el of block.elements) {
          const aid = (el as { action_id?: string }).action_id
          if (typeof aid === "string" && aid.startsWith("bantai:stale_resume:")) {
            return msg
          }
        }
      }
    }
    return undefined
  }

  function findStaleButton(msg: Message, decision: string): { actionId: string; value?: string } | undefined {
    const blocks = (msg as { blocks?: unknown[] }).blocks
    if (!Array.isArray(blocks)) return undefined
    for (const b of blocks) {
      if (typeof b !== "object" || b === null) continue
      const block = b as { type?: string; elements?: unknown[] }
      if (block.type !== "actions" || !Array.isArray(block.elements)) continue
      for (const el of block.elements) {
        const aid = (el as { action_id?: string; value?: string }).action_id
        if (
          typeof aid === "string" &&
          aid.startsWith("bantai:stale_resume:") &&
          aid.endsWith(`:${decision}`)
        ) {
          return { actionId: aid, value: (el as { value?: string }).value }
        }
      }
    }
    return undefined
  }

  function blockActionPayload(args: {
    userId: string
    channelId: string
    messageTs: string
    actionId: string
    value?: string
  }): BlockActionsPayload {
    return {
      type: "block_actions",
      team: { id: "T1", domain: "minislack" },
      user: { id: args.userId, username: "alice", name: "alice", team_id: "T1" },
      api_app_id: appId,
      token: "test",
      container: {
        type: "message",
        message_ts: args.messageTs,
        channel_id: args.channelId,
      },
      trigger_id: `tr_${Date.now()}`,
      channel: { id: args.channelId, name: "general" },
      message: {
        type: "message",
        user: "B1",
        ts: args.messageTs,
        text: "",
      },
      response_url: "http://minislack.invalid/response",
      actions: [
        {
          action_id: args.actionId,
          block_id: "b1",
          type: "button",
          text: { type: "plain_text", text: "click" },
          ...(args.value ? { value: args.value } : {}),
          action_ts: `${Date.now() / 1000}`,
        },
      ],
      is_enterprise_install: false,
      enterprise: null,
    }
  }

  async function waitFor(
    cond: () => boolean,
    opts: { timeoutMs: number; message: string },
  ): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < opts.timeoutMs) {
      if (cond()) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`waitFor timed out after ${opts.timeoutMs}ms: ${opts.message}`)
  }

  it("detects a stale persisted row and posts the recovery card instead of starting a session", async () => {
    // Seed a row whose backendId is codex — the slack config below pins the
    // default backend to mock, so detect() returns backend_mismatch.
    //
    // Session keys are anchored on the thread root ts. For top-level
    // messages the anchor IS the message's own ts, which we can't know
    // until the user posts. So we set up a real thread: Alice plants a
    // seed message BEFORE the launcher boots (the launcher never sees
    // it), we record the seed ts, pre-seed the DB row against that ts,
    // THEN boot the launcher and have Alice @mention in a thread reply.
    // The routing anchor resolves to seed.ts → session key matches.
    const workspaceId = mini.workspace.team.id
    const seedMsg = await mini
      .asUser(aliceId)
      .sendMessage(generalId, "seed-only, not an @mention")
    const seedTs = seedMsg.ts
    seedStaleRow({
      workspace: workspaceId,
      channelId: generalId,
      threadTs: seedTs,
      priorBackend: "codex",
      priorSessionId: "codex-era-uuid",
    })

    const hosts: CapturedStart[] = []
    const slack = (await launchSlack({
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
          session_banner: false,
          debounce_ms: 0,
        },
        store_path: storePath,
      },
      buildHost: ({ project, sessionConfig }) => {
        void project
        const backend = createCapturingBackend({
          sessionIdToEmit: "mock-session-1",
          hosts,
        })
        const host = createSessionHost({
          backend,
          config: sessionConfig,
          subagentManager: new SubagentManager(),
          currentBackend: "claude",
          close: () => backend.close(),
        })
        return { host, backend }
      },
    })) as SlackLaunchHandle
    botUserId = slack.botUserId
    slack.userCache.seed(aliceId, "alice")
    await new Promise((r) => setTimeout(r, 150))

    try {
      // Alice replies to the seed with a @mention — anchor resolves to
      // seedTs, which matches the pre-seeded row.
      await mini
        .asUser(aliceId)
        .sendMessage(generalId, `<@${botUserId}> run the tests`, {
          thread_ts: seedTs,
        })

      // Expect the recovery card to land on the thread root.
      await waitFor(() => findStaleCard(generalId, seedTs) !== undefined, {
        timeoutMs: 5000,
        message: "expected stale-resume card",
      })
      const card = findStaleCard(generalId, seedTs)!
      expect(card).toBeDefined()

      // The queued message preview should appear in the card body.
      const cardText = JSON.stringify(card.blocks ?? [])
      expect(cardText).toContain("run the tests")

      // The inject button should be HIDDEN — we haven't planted a real
      // codex session file, so `canInject` + the disk check in
      // buildReplayContext would fail. `fresh` + `cancel` must be present.
      expect(findStaleButton(card, "fresh")).toBeTruthy()
      expect(findStaleButton(card, "cancel")).toBeTruthy()

      // NO backend host should have been constructed — the dispatch was
      // intercepted BEFORE getOrCreate.
      expect(hosts.length).toBe(0)

      // ---- Click "Cancel turn" — card updates, store prompt row gone. ----
      const cancelBtn = findStaleButton(card, "cancel")!
      await mini.fireInteractive(appId, blockActionPayload({
        userId: aliceId,
        channelId: generalId,
        messageTs: card.ts!,
        actionId: cancelBtn.actionId,
        value: cancelBtn.value,
      }))
      await waitFor(() => {
        const updated = mini.workspace.channels.get(generalId)?.messages.get(card.ts!)
        return JSON.stringify(updated?.blocks ?? []).includes("cancelled")
      }, { timeoutMs: 5000, message: "expected card text to update to 'cancelled'" })

      // Cancel does NOT start a session.
      expect(hosts.length).toBe(0)
      // Pending prompts row cleared.
      const s = createSessionStore({ path: storePath })
      expect(s.listPendingResumePrompts()).toHaveLength(0)
      s.close()
    } finally {
      await slack.stop()
      await new Promise((r) => setTimeout(r, 200))
    }
  }, 30_000)

  it("clicking 'Start fresh' clears the stale id, spins a new session, and replays the queued turn", async () => {
    // Fresh DB file so this case doesn't inherit state from the previous one.
    const caseDir = mkdtempSync(join(tmpdir(), "bantai-stale-fresh-"))
    const casePath = join(caseDir, "slack.db")
    try {
      const workspaceId = mini.workspace.team.id
      // Plant a seed thread + seed the stale row under that ts.
      const seedMsg = await mini
        .asUser(aliceId)
        .sendMessage(generalId, "seed-only, not an @mention (fresh case)")
      const seedTs = seedMsg.ts
      const s = createSessionStore({ path: casePath })
      const key = `slack:${workspaceId}:${generalId}:${seedTs}`
      s.upsert({
        key,
        workspace: workspaceId,
        channelId: generalId,
        threadTs: seedTs,
        backendId: "codex",
      })
      s.setBackendSessionId(key, "codex-era-uuid")
      s.close()

      const hosts: CapturedStart[] = []
      const slack = (await launchSlack({
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
            session_banner: false,
            debounce_ms: 0,
          },
          store_path: casePath,
        },
        buildHost: ({ project, sessionConfig }) => {
          void project
          const backend = createCapturingBackend({
            sessionIdToEmit: "mock-session-fresh",
            hosts,
          })
          const host = createSessionHost({
            backend,
            config: sessionConfig,
            subagentManager: new SubagentManager(),
            currentBackend: "claude",
            close: () => backend.close(),
          })
          return { host, backend }
        },
      })) as SlackLaunchHandle
      slack.userCache.seed(aliceId, "alice")
      await new Promise((r) => setTimeout(r, 150))

      try {
        await mini
          .asUser(aliceId)
          .sendMessage(generalId, `<@${slack.botUserId}> fresh run please`, {
            thread_ts: seedTs,
          })

        await waitFor(() => findStaleCard(generalId, seedTs) !== undefined, {
          timeoutMs: 5000,
          message: "expected stale-resume card",
        })
        const card = findStaleCard(generalId, seedTs)!

        // Click "Start fresh".
        const freshBtn = findStaleButton(card, "fresh")!
        await mini.fireInteractive(appId, blockActionPayload({
          userId: aliceId,
          channelId: generalId,
          messageTs: card.ts!,
          actionId: freshBtn.actionId,
          value: freshBtn.value,
        }))

        // Card updates in-place.
        await waitFor(() => {
          const updated = mini.workspace.channels.get(generalId)?.messages.get(card.ts!)
          return JSON.stringify(updated?.blocks ?? []).includes("started fresh")
        }, { timeoutMs: 5000, message: "expected card text to show 'started fresh'" })

        // A brand-new host was built — replay fired.
        await waitFor(() => hosts.length === 1, {
          timeoutMs: 5000,
          message: "expected a new session host after replay",
        })
        // Resume must be undefined — we cleared the stale id.
        expect(hosts[0]!.sessionConfig.resume).toBeUndefined()
        // No replayContext for the fresh path.
        expect(hosts[0]!.sessionConfig.replayContext).toBeUndefined()
        // The original user text reached the backend.
        await waitFor(() => hosts[0]!.messages.length >= 1, {
          timeoutMs: 5000,
          message: "expected the queued turn to replay to the backend",
        })
        const replayed = hosts[0]!.messages[0]!
        expect(replayed.text).toContain("fresh run please")

        // The DB row's backend_session_id was cleared. Counters + backendId
        // were preserved (counters reflect thread activity; backendId still
        // says "codex" because the registry only flips it to the current
        // backend when the in-memory session is constructed — which DID
        // happen in this test, so the row now says "mock").
        const after = createSessionStore({ path: casePath })
        const row = after.get(key)!
        expect(row.backendId).toBe("mock")
        // After the new session emits session_init, the id is the fresh
        // mock one, not the codex stale one.
        expect(row.backendSessionId).toBe("mock-session-fresh")
        expect(after.listPendingResumePrompts()).toHaveLength(0)
        after.close()
      } finally {
        await slack.stop()
        await new Promise((r) => setTimeout(r, 200))
      }
    } finally {
      rmSync(caseDir, { recursive: true, force: true })
    }
  }, 30_000)
})
