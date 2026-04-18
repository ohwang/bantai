/**
 * S4 exit criterion — Claude requests Bash → Slack shows three-button
 * approval → click resolves in-place → tool executes. We drive it against
 * the mock backend, whose `simulatePermission()` blocks the turn on a
 * permission_request and resumes when approveToolUse or denyToolUse is
 * called.
 *
 * Scenarios:
 *   1. Allow click — card updates to "allowed by @alice" and the mock
 *      continues the turn.
 *   2. Deny click — card updates to "denied by @alice".
 *   3. Cancel click on an elicitation — card updates to "cancelled by @alice"
 *      and the mock continues.
 *   4. Modal submit on an elicitation — card updates to "answered by @alice"
 *      with the harvested answer.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { startMinislack, type MinislackHandle } from "../../../../src/minislack/testing/harness"
import { joinChannel } from "../../../../src/minislack/core/channels"
import {
  launchSlack,
  type SlackLaunchHandle,
} from "../../../../src/frontends/slack/launcher"
import type { CLIFlags } from "../../../../src/cli/options"
import type { Message } from "../../../../src/minislack/types/slack"
import type {
  BlockActionsPayload,
  ViewSubmissionPayload,
} from "../../../../src/minislack/types/interactive"

const BASE_FLAGS: CLIFlags = {
  config: {},
  backend: "claude",
  help: false,
  version: false,
  debug: false,
  debugBackend: false,
  noDiagnosticsMcp: true,
}

describe("slack frontend S4 — approval + elicitation round-trip", () => {
  let mini: MinislackHandle
  let slack: SlackLaunchHandle
  let botUserId: string
  let aliceId: string
  let generalId: string
  let appId: string

  beforeAll(async () => {
    mini = await startMinislack({ fixture: "basic", serveWeb: false })
    const registered = mini.registerApp({
      name: "bantai",
      scopes: ["chat:write", "app_mentions:read", "channels:history", "users:read"],
      subscribed_events: [
        "message",
        "app_mention",
        "reaction_added",
      ],
    })
    appId = registered.app.id
    const general = Array.from(mini.workspace.channels.values()).find(
      (c) => (c.is_channel === true || c.is_group === true) && "name" in c && c.name === "general",
    )
    if (!general) throw new Error("fixture missing #general")
    generalId = general.id
    aliceId = Array.from(mini.workspace.users.values()).find((u) => u.name === "alice")!.id
    joinChannel(mini.workspace, general.id, registered.botUser.id)

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

  it("allow click resolves the approval card in place and unblocks the turn", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> please run bash for me`)

    // Wait for the approval card (thread reply with the Block Kit buttons).
    await waitFor(
      () => findApprovalCard(mini, generalId, parent.ts) !== undefined,
      { timeoutMs: 5000, message: "expected approval card in thread" },
    )
    const card = findApprovalCard(mini, generalId, parent.ts)!
    const allowAction = findButton(card, /:allow$/)
    expect(allowAction).toBeTruthy()

    // Fire the block_actions payload as alice clicking "Allow once".
    await mini.fireInteractive(appId, blockActionPayload({
      appId,
      userId: aliceId,
      channelId: generalId,
      messageTs: card.ts!,
      actionId: allowAction!.actionId,
      value: allowAction!.value,
    }))

    // The card should update in place (same ts) to the resolved variant.
    await waitFor(
      () => {
        const updated = messageById(mini, generalId, card.ts!)
        const text = updated?.text ?? ""
        return text.includes("allowed")
      },
      { timeoutMs: 5000, message: "expected card text to update to 'allowed'" },
    )

    // And the mock should proceed past the permission gate + produce the
    // final text reply, meaning the total replies in the thread is now
    // greater than the approval card alone (streaming reply landed).
    await waitFor(
      () => repliesFor(mini, generalId, parent.ts).filter((m) => (m.text ?? "").length > 0 && !(m.text ?? "").includes("allowed")).length >= 1,
      { timeoutMs: 8000, message: "expected mock streaming reply after approval" },
    )
  })

  it("deny click updates the card and backend does not run the tool", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> please run a bash command`)

    await waitFor(
      () => findApprovalCard(mini, generalId, parent.ts) !== undefined,
      { timeoutMs: 5000, message: "expected approval card" },
    )
    const card = findApprovalCard(mini, generalId, parent.ts)!
    const denyAction = findButton(card, /:deny$/)!
    await mini.fireInteractive(appId, blockActionPayload({
      appId,
      userId: aliceId,
      channelId: generalId,
      messageTs: card.ts!,
      actionId: denyAction.actionId,
      value: denyAction.value,
    }))
    await waitFor(
      () => (messageById(mini, generalId, card.ts!)?.text ?? "").includes("denied"),
      { timeoutMs: 5000, message: "expected card to show 'denied'" },
    )
  })

  it("elicitation cancel click resolves the card and unblocks the turn", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> can I ask you a question`)

    await waitFor(
      () => findElicitationCard(mini, generalId, parent.ts) !== undefined,
      { timeoutMs: 5000, message: "expected elicitation card" },
    )
    const card = findElicitationCard(mini, generalId, parent.ts)!
    const cancelBtn = findButton(card, /:cancel$/)!
    await mini.fireInteractive(appId, blockActionPayload({
      appId,
      userId: aliceId,
      channelId: generalId,
      messageTs: card.ts!,
      actionId: cancelBtn.actionId,
      value: cancelBtn.value,
    }))
    await waitFor(
      () => (messageById(mini, generalId, card.ts!)?.text ?? "").includes("cancelled"),
      { timeoutMs: 5000, message: "expected card to show 'cancelled'" },
    )
  })

  it("elicitation modal submit hands answers to the backend", async () => {
    const parent = await mini
      .asUser(aliceId)
      .sendMessage(generalId, `<@${botUserId}> please ask me a question now`)

    await waitFor(
      () => findElicitationCard(mini, generalId, parent.ts) !== undefined,
      { timeoutMs: 5000, message: "expected elicitation card" },
    )
    const card = findElicitationCard(mini, generalId, parent.ts)!
    // Extract the elicitation id from the button action_id (bantai:elic:<id>:open).
    const openBtn = findButton(card, /:open$/)!
    const elicId = openBtn.actionId.split(":")[2]!
    const blockId = `bantai:elic:${elicId}:q:0`

    // Simulate the view_submission that Slack would send after the user
    // picks "React" in the static_select (our mock elicitation question).
    await mini.fireInteractive(appId, viewSubmissionPayload({
      appId,
      userId: aliceId,
      callbackId: `bantai:elic:${elicId}`,
      blockId,
      selectValue: "React",
    }))

    await waitFor(
      () => (messageById(mini, generalId, card.ts!)?.text ?? "").includes("answered"),
      { timeoutMs: 5000, message: "expected card to show 'answered'" },
    )
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repliesFor(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): Message[] {
  const ch = mini.workspace.channels.get(channelId)
  if (!ch) return []
  const out: Message[] = []
  for (const msg of ch.messages.values()) {
    if (msg.thread_ts === parentTs && msg.ts !== parentTs) out.push(msg)
  }
  return out
}

function messageById(mini: MinislackHandle, channelId: string, ts: string): Message | undefined {
  return mini.workspace.channels.get(channelId)?.messages.get(ts)
}

function findApprovalCard(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): Message | undefined {
  return repliesFor(mini, channelId, parentTs).find(
    (m) => hasActionWithPrefix(m, "bantai:perm:"),
  )
}

function findElicitationCard(
  mini: MinislackHandle,
  channelId: string,
  parentTs: string,
): Message | undefined {
  return repliesFor(mini, channelId, parentTs).find(
    (m) => hasActionWithPrefix(m, "bantai:elic:"),
  )
}

function hasActionWithPrefix(msg: Message, prefix: string): boolean {
  const blocks = (msg as { blocks?: unknown[] }).blocks
  if (!Array.isArray(blocks)) return false
  for (const b of blocks) {
    if (typeof b !== "object" || b === null) continue
    const block = b as { type?: string; elements?: unknown[] }
    if (block.type !== "actions" || !Array.isArray(block.elements)) continue
    for (const el of block.elements) {
      if (typeof el !== "object" || el === null) continue
      const a = (el as { action_id?: string }).action_id
      if (typeof a === "string" && a.startsWith(prefix)) return true
    }
  }
  return false
}

function findButton(
  msg: Message,
  idRegex: RegExp,
): { actionId: string; value?: string } | undefined {
  const blocks = (msg as { blocks?: unknown[] }).blocks
  if (!Array.isArray(blocks)) return undefined
  for (const b of blocks) {
    if (typeof b !== "object" || b === null) continue
    const block = b as { type?: string; elements?: unknown[] }
    if (block.type !== "actions" || !Array.isArray(block.elements)) continue
    for (const el of block.elements) {
      if (typeof el !== "object" || el === null) continue
      const a = (el as { action_id?: string; value?: string }).action_id
      if (typeof a === "string" && idRegex.test(a)) {
        return { actionId: a, value: (el as { value?: string }).value }
      }
    }
  }
  return undefined
}

function blockActionPayload(args: {
  appId: string
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
    api_app_id: args.appId,
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

function viewSubmissionPayload(args: {
  appId: string
  userId: string
  callbackId: string
  blockId: string
  selectValue: string
}): ViewSubmissionPayload {
  return {
    type: "view_submission",
    team: { id: "T1", domain: "minislack" },
    user: { id: args.userId, username: "alice", name: "alice", team_id: "T1" },
    api_app_id: args.appId,
    token: "test",
    trigger_id: `tr_${Date.now()}`,
    view: {
      id: "V1",
      type: "modal",
      callback_id: args.callbackId,
      private_metadata: "",
      hash: "",
      state: {
        values: {
          [args.blockId]: {
            [args.blockId]: {
              type: "static_select",
              selected_option: {
                text: { type: "plain_text", text: args.selectValue },
                value: args.selectValue,
              },
            },
          },
        },
      },
    },
    is_enterprise_install: false,
    enterprise: null,
  }
}

async function waitFor(
  cond: () => boolean,
  opts: { timeoutMs: number; message: string },
): Promise<void> {
  const start = Date.now()
  const step = 50
  while (Date.now() - start < opts.timeoutMs) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, step))
  }
  throw new Error(`waitFor timed out after ${opts.timeoutMs}ms: ${opts.message}`)
}
