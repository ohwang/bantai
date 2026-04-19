/**
 * S6 exit criterion — "user posts a PNG → agent OCRs it; agent writes a
 * 500-line diff → Slack shows a file snippet with preview."
 *
 * We stand up minislack + the launcher with a stub backend we control, so
 * we can observe:
 *
 *   (A) inbound file: alice uploads a PNG via minislack's files.upload,
 *       attached to a message that mentions the bot. The launcher ingests
 *       the attachment and passes it to the backend as UserMessage.images.
 *       We assert on the captured message.
 *
 *   (B) outbound long tool output: the stub backend emits a tool_use_end
 *       with 300 lines of output. The renderer uploads it via files
 *       completeUploadExternal; we assert a new file appears in the
 *       minislack workspace and the card has a :paperclip: permalink.
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

function createCapturingBackend(): {
  backend: AgentBackend
  emit: (e: ConversationEvent) => void
  close: () => void
  messages: UserMessage[]
} {
  const state = {
    messages: [] as UserMessage[],
    closed: false,
  }
  let pushEvent: ((e: ConversationEvent) => void) | null = null
  let resolveEnd: (() => void) | null = null

  async function* start(): AsyncGenerator<ConversationEvent> {
    const queue: ConversationEvent[] = []
    let waiter: ((e: ConversationEvent) => void) | null = null
    pushEvent = (e) => {
      if (waiter) {
        const w = waiter
        waiter = null
        w(e)
      } else queue.push(e)
    }
    const endPromise = new Promise<void>((r) => {
      resolveEnd = r
    })
    // Announce a session_init immediately so the launcher's banner /
    // approvals layer sees a running session.
    yield {
      type: "session_init",
      tools: [],
      models: [],
      sessionId: "fake-session",
    }
    while (!state.closed) {
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      const next = await Promise.race([
        new Promise<ConversationEvent>((r) => {
          waiter = r
        }),
        endPromise.then(() => null),
      ])
      if (next === null) return
      yield next
    }
  }

  const backend: AgentBackend = {
    capabilities(): BackendCapabilities {
      return {
        name: "fake",
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
    async availableModels(): Promise<ModelInfo[]> { return [] },
    async listSessions(): Promise<SessionInfo[]> { return [] },
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
    emit: (e) => pushEvent?.(e),
    close: () => {
      state.closed = true
      resolveEnd?.()
    },
    get messages() { return state.messages },
  }
}

describe("slack frontend S6 — file round-trip", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle
  let botUserId: string
  let aliceId: string
  let generalId: string
  let capturing!: ReturnType<typeof createCapturingBackend>
  let botToken: string

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    const registered = mini.registerApp({
      name: "bantai",
      scopes: [
        "chat:write",
        "app_mentions:read",
        "channels:history",
        "files:read",
        "files:write",
      ],
      subscribed_events: ["message", "app_mention", "file_shared"],
    })
    botToken = registered.botToken
    const general = Array.from(mini.workspace.channels.values()).find(
      (c) => (c.is_channel === true || c.is_group === true) && "name" in c && c.name === "general",
    )
    if (!general) throw new Error("fixture missing #general")
    generalId = general.id
    aliceId = Array.from(mini.workspace.users.values()).find((u) => u.name === "alice")!.id
    joinChannel(mini.workspace, general.id, registered.botUser.id)

    capturing = createCapturingBackend()

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
          session_banner: false,
        },
        store_path: "",
      },
      buildHost: ({ project, sessionConfig }) => {
        void project
        const subagentManager = new SubagentManager()
        const host = createSessionHost({
          backend: capturing.backend,
          config: sessionConfig,
          subagentManager,
          currentBackend: "claude",
          close: () => capturing.close(),
        })
        return { host, backend: capturing.backend }
      },
    })) as SlackLaunchHandle
    botUserId = slack.botUserId
    slack.userCache.seed(aliceId, "alice")

    await new Promise((r) => setTimeout(r, 150))
  })

  afterAll(async () => {
    await slack?.stop()
    await new Promise((r) => setTimeout(r, 250))
    await mini?.stop()
    await new Promise((r) => setTimeout(r, 50))
  })

  it("inbound image → agent receives UserMessage.images with base64 data", async () => {
    // Upload a tiny PNG via minislack's v1 multipart API, attached to
    // #general with an initial_comment that mentions the bot. That posts
    // a message event with files[] on it, which our handler ingests.
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])
    const form = new FormData()
    form.append(
      "file",
      new Blob([pngBytes.buffer as ArrayBuffer], { type: "image/png" }),
      "pixel.png",
    )
    form.append("channels", generalId)
    form.append("initial_comment", `<@${botUserId}> please look at this`)
    form.append("filename", "pixel.png")
    form.append("filetype", "png")

    // Use alice's token so the message's `user` field is alice.
    const aliceToken = `xoxp-${aliceId}`
    const resp = await fetch(`${mini.url}/api/files.upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: form,
    })
    const body = (await resp.json()) as { ok?: boolean; error?: string }
    expect(body.ok).toBe(true)

    // Wait for the backend to see the UserMessage with images.
    const start = Date.now()
    while (Date.now() - start < 10_000) {
      const msg = capturing.messages.find((m) => (m.images?.length ?? 0) > 0)
      if (msg) {
        expect(msg.images).toHaveLength(1)
        expect(msg.images![0]!.mediaType).toBe("image/png")
        // PNG magic base64.
        expect(msg.images![0]!.data).toBe("iVBORw0KGgo=")
        return
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(
      `timed out waiting for UserMessage.images. Captured messages: ${JSON.stringify(
        capturing.messages,
        null,
        2,
      )}`,
    )
  })

  it("outbound long tool output → Slack shows a file snippet with preview + paperclip link", async () => {
    // Extend the default 5s — we wait on the renderer event loop + the
    // three-step upload flow, both of which hit real setTimeouts.
    // Drive a turn. Alice mentions → the launcher forwards to our stub
    // backend. We then emit events to drive the tool card → file upload.
    const before = capturing.messages.length
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> please run the diff`)

    // Wait until the stub backend receives its inbound turn (there may be
    // a previous one from the inbound-image test).
    const startMs = Date.now()
    while (capturing.messages.length <= before && Date.now() - startMs < 5_000) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(capturing.messages.length).toBeGreaterThan(before)

    // Now emit a tool turn ending with a 300-line payload.
    capturing.emit({ type: "turn_start" })
    capturing.emit({
      type: "tool_use_start",
      id: "tool_1",
      tool: "Bash",
      input: { command: "git diff" },
    })
    const longOutput = Array.from({ length: 300 }, (_, i) => `diff line ${i + 1}`).join("\n")
    capturing.emit({
      type: "tool_use_end",
      id: "tool_1",
      output: longOutput,
    })
    capturing.emit({ type: "text_delta", text: "done" })
    capturing.emit({ type: "text_complete", text: "done" })
    capturing.emit({ type: "turn_complete" })

    // Wait until a file with name bash-tool_1.txt lands in minislack.
    const fileStartMs = Date.now()
    let uploaded: { name?: string } | undefined
    while (Date.now() - fileStartMs < 15_000) {
      for (const f of mini.workspace.files.values()) {
        if (f.name?.startsWith("bash-tool_1")) {
          uploaded = f
          break
        }
      }
      if (uploaded) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(uploaded).toBeTruthy()

    // The tool card in #general should end with a :paperclip: context
    // block pointing at the uploaded file.
    const channel = mini.workspace.channels.get(generalId)!
    const toolCard = Array.from(channel.messages.values()).find(
      (m) =>
        m.thread_ts === parent.ts &&
        (m.text ?? "").includes("Bash — done"),
    ) as { blocks?: unknown[] } | undefined
    expect(toolCard).toBeTruthy()
    const blockJson = JSON.stringify(toolCard!.blocks)
    expect(blockJson).toContain(":paperclip:")
    expect(blockJson).toContain("Full output")

    // botToken is resolved for the download path and used by the fetcher
    // for inbound images; keep the reference in scope so the test is
    // self-contained.
    expect(botToken).toMatch(/^xoxb-/)
  }, 30_000)
})
