/**
 * S5 exit criterion — the four verbosity levels demonstrably differ in a
 * fixture run.
 *
 * We boot one minislack + one Slack launcher per verbosity level, @mention
 * bantai with a prompt that triggers the mock's read-sim (one tool use),
 * wait for the turn to finish, and compare thread shape:
 *
 *   silent   → no thread replies at all
 *   concise  → assistant text + one "💭 N tools" summary line
 *   normal   → assistant text + one tool card (Bash/Read) posted+updated
 *   verbose  → tool card with full input+output fences; no thinking in
 *              this specific fixture because the mock only emits a
 *              thinking_delta on long prompts
 *
 * We also run one separate "show_cost" scenario at normal verbosity to
 * prove the opt-in footer lands.
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

const BASE_FLAGS: CLIFlags = {
  config: {},
  backend: "claude",
  help: false,
  version: false,
  debug: false,
  debugBackend: false,
  noDiagnosticsMcp: true,
}

interface Fixture {
  mini: MinislackHandle
  slack: SlackLaunchHandle
  botUserId: string
  aliceId: string
  generalId: string
}

async function bootFixture(opts: {
  verbosity: "silent" | "concise" | "normal" | "verbose" | "debug"
  showCost?: boolean
}): Promise<Fixture> {
  const mini = await startMinislack({ fixture: "basic", serveWeb: false })
  const registered = mini.registerApp({
    name: "bantai",
    scopes: ["chat:write", "app_mentions:read", "channels:history", "users:read"],
    subscribed_events: ["message", "app_mention", "reaction_added"],
  })
  const general = Array.from(mini.workspace.channels.values()).find(
    (c) => (c.is_channel === true || c.is_group === true) && "name" in c && c.name === "general",
  )
  if (!general) throw new Error("fixture missing #general")
  const aliceId = Array.from(mini.workspace.users.values()).find((u) => u.name === "alice")!.id
  joinChannel(mini.workspace, general.id, registered.botUser.id)

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
        verbosity: opts.verbosity,
        require_mention: true,
        session_banner: false,
        ...(opts.showCost ? { show_cost: true } : {}),
      },
      store_path: "",
    },
  })) as SlackLaunchHandle
  slack.userCache.seed(aliceId, "alice")
  await new Promise((r) => setTimeout(r, 150))
  return { mini, slack, botUserId: slack.botUserId, aliceId, generalId: general.id }
}

async function teardown(fix: Fixture): Promise<void> {
  await fix.slack.stop()
  await new Promise((r) => setTimeout(r, 250))
  await fix.mini.stop()
  await new Promise((r) => setTimeout(r, 50))
}

function repliesFor(mini: MinislackHandle, channel: string, parentTs: string): Message[] {
  const ch = mini.workspace.channels.get(channel)
  if (!ch) return []
  return Array.from(ch.messages.values()).filter(
    (m) => m.thread_ts === parentTs && m.ts !== parentTs,
  )
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

function blocksText(m: Message): string {
  const blocks = (m as { blocks?: unknown[] }).blocks
  if (!Array.isArray(blocks)) return ""
  const parts: string[] = []
  for (const b of blocks) {
    if (typeof b !== "object" || b === null) continue
    const block = b as { type?: string; text?: { text?: string }; elements?: Array<{ text?: string }> }
    if (block.text?.text) parts.push(block.text.text)
    for (const el of block.elements ?? []) {
      if (el?.text) parts.push(el.text)
    }
  }
  return parts.join("\n")
}

async function driveToolTurn(fix: Fixture): Promise<{ parentTs: string }> {
  const parent = await fix.mini
    .asUser(fix.aliceId)
    .sendMessage(fix.generalId, `<@${fix.botUserId}> can you read the file please`)
  // Wait until the working :cyclone: reaction has been seen AND then cleared
  // from the trigger message. The bot adds :cyclone: on turn_start and
  // removes it on turn_complete — so a transition "cyclone seen → no
  // reactions" anchors us past turn_complete, which is when tool cards,
  // concise summaries, and cost footers have all landed. We never wait
  // for :white_check_mark: — the bot no longer emits it (reserved for
  // humans).
  let workingSeen = false
  await waitFor(
    () => {
      const p = fix.mini.workspace.channels.get(fix.generalId)?.messages.get(parent.ts)
      const reactions = (p as { reactions?: Array<{ name: string }> } | undefined)?.reactions
      if (reactions?.some((r) => r.name === "cyclone")) workingSeen = true
      const cleared = !reactions || reactions.length === 0
      return workingSeen && cleared
    },
    { timeoutMs: 15_000, message: "expected :cyclone: to appear then clear on trigger message" },
  )
  // Small buffer for postPerTurnAnnotations' chained posts.
  await new Promise((r) => setTimeout(r, 250))
  return { parentTs: parent.ts }
}

// ---------------------------------------------------------------------------
// silent
// ---------------------------------------------------------------------------

describe("slack frontend S5 verbosity=silent", () => {
  let fix: Fixture
  beforeAll(async () => { fix = await bootFixture({ verbosity: "silent" }) })
  afterAll(() => teardown(fix))

  it("produces no thread replies for a normal turn", async () => {
    const parent = await fix.mini
      .asUser(fix.aliceId)
      .sendMessage(fix.generalId, `<@${fix.botUserId}> can you read the file please`)
    // Wait long enough for the full turn to have happened in a louder mode.
    await new Promise((r) => setTimeout(r, 2500))
    const replies = repliesFor(fix.mini, fix.generalId, parent.ts)
    expect(replies.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// concise
// ---------------------------------------------------------------------------

describe("slack frontend S5 verbosity=concise", () => {
  let fix: Fixture
  beforeAll(async () => { fix = await bootFixture({ verbosity: "concise" }) })
  afterAll(() => teardown(fix))

  it("posts the text body + a 'N tools' summary; no per-tool card", async () => {
    const { parentTs } = await driveToolTurn(fix)
    const replies = repliesFor(fix.mini, fix.generalId, parentTs)
    // The summary lives in a context block; match against its mrkdwn text.
    const summary = replies.find((r) => blocksText(r).includes(":thought_balloon:"))
    expect(summary).toBeTruthy()
    expect(blocksText(summary!)).toMatch(/\d+ tools?:/)
    // Per-tool card text would contain "— running" or "— done" — the concise
    // path must NOT produce those.
    const toolCardLike = replies.find((r) =>
      blocksText(r).includes("— running") || blocksText(r).includes("— done"),
    )
    expect(toolCardLike).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// normal
// ---------------------------------------------------------------------------

describe("slack frontend S5 verbosity=normal", () => {
  let fix: Fixture
  beforeAll(async () => { fix = await bootFixture({ verbosity: "normal" }) })
  afterAll(() => teardown(fix))

  it("posts text + a per-tool Block Kit card with a short preview", async () => {
    const { parentTs } = await driveToolTurn(fix)
    const replies = repliesFor(fix.mini, fix.generalId, parentTs)
    const toolCard = replies.find((r) => (r.text ?? "").includes("— done"))
    expect(toolCard).toBeTruthy()
    const txt = blocksText(toolCard!)
    expect(txt).toContain(":white_check_mark:")
    // Normal verbosity only shows the one-line preview, not a full input fence.
    // The mock's Read tool input has file_path.
    expect(txt).toContain("file_path")
  })

  it("no cost footer by default", async () => {
    const { parentTs } = await driveToolTurn(fix)
    const replies = repliesFor(fix.mini, fix.generalId, parentTs)
    const cost = replies.find((r) => blocksText(r).includes(":moneybag:"))
    expect(cost).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// verbose
// ---------------------------------------------------------------------------

describe("slack frontend S5 verbosity=verbose", () => {
  let fix: Fixture
  beforeAll(async () => { fix = await bootFixture({ verbosity: "verbose" }) })
  afterAll(() => teardown(fix))

  it("posts text + full tool card with input + output fences", async () => {
    const { parentTs } = await driveToolTurn(fix)
    const replies = repliesFor(fix.mini, fix.generalId, parentTs)
    const toolCard = replies.find((r) => (r.text ?? "").includes("— done"))
    expect(toolCard).toBeTruthy()
    const txt = blocksText(toolCard!)
    // Verbose shows BOTH input and output fences — count the triple-backticks.
    const fences = (txt.match(/```/g) ?? []).length
    expect(fences).toBeGreaterThanOrEqual(4)
  })
})

// ---------------------------------------------------------------------------
// cost footer opt-in
// ---------------------------------------------------------------------------

describe("slack frontend S5 show_cost=true", () => {
  let fix: Fixture
  beforeAll(async () => {
    fix = await bootFixture({ verbosity: "normal", showCost: true })
  })
  afterAll(() => teardown(fix))

  it("posts a cost footer after turn_complete when show_cost is on", async () => {
    const { parentTs } = await driveToolTurn(fix)
    const replies = repliesFor(fix.mini, fix.generalId, parentTs)
    const cost = replies.find((r) => blocksText(r).includes(":moneybag:"))
    expect(cost).toBeTruthy()
  })
})
