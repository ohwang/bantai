/**
 * S6 — long tool output auto-upload path on the event-renderer.
 */

import { describe, expect, it } from "bun:test"
import type { App } from "@slack/bolt"
import type { ConversationEvent } from "../../../../src/protocol/types"
import { createEventRenderer } from "../../../../src/frontends/slack/view/event-renderer"
import type { SendAdapter } from "../../../../src/frontends/slack/view/outbox"
import type { ReactionAdapter } from "../../../../src/frontends/slack/view/reactions"
import type { SlackFileClient } from "../../../../src/frontends/slack/view/upload"

function makeStubApp(): App {
  return {} as App
}

interface Send {
  kind: "post" | "update"
  text: string
  ts?: string
  blocks?: unknown[]
}

function blocksText(blocks: unknown[] | undefined): string {
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

function harness(opts: { toolOutputFileLines?: number; fileClient?: SlackFileClient }) {
  const sends: Send[] = []
  let counter = 0
  const sendAdapter: SendAdapter = {
    async postMessage(args) {
      counter++
      const ts = `ts${counter}`
      sends.push({ kind: "post", text: args.text, ts, blocks: args.blocks })
      return { ts, channel: args.channel }
    },
    async updateMessage(args) {
      sends.push({ kind: "update", text: args.text, ts: args.ts, blocks: args.blocks })
    },
  }
  const reactionAdapter: ReactionAdapter = {
    async addReaction() {},
    async removeReaction() {},
  }
  const renderer = createEventRenderer({
    app: makeStubApp(),
    binding: { channel: "C01", threadTs: "100.001", triggerTs: "t1" },
    sendAdapter,
    reactionAdapter,
    verbosity: "normal",
    ...(opts.toolOutputFileLines !== undefined
      ? { toolOutputFileLines: opts.toolOutputFileLines }
      : {}),
    ...(opts.fileClient ? { fileClient: opts.fileClient } : {}),
  })
  function push(events: ConversationEvent[]) {
    for (const e of events) renderer.onEvent(e)
  }
  return { sends, push, renderer }
}

function makeFileClient(overrides: Partial<SlackFileClient> = {}) {
  const calls = {
    reserve: 0,
    post: 0,
    complete: 0,
    lastFilename: "",
  }
  const client: SlackFileClient = {
    async getUploadURLExternal(args) {
      calls.reserve++
      calls.lastFilename = args.filename
      return { ok: true, upload_url: "https://up/token", file_id: "F_up" }
    },
    async postUploadBytes() {
      calls.post++
    },
    async completeUploadExternal(args) {
      calls.complete++
      return {
        ok: true,
        files: [
          {
            id: "F_up",
            name: args.files[0]?.title ?? calls.lastFilename,
            permalink: "https://slack/files/F_up",
          },
        ],
      }
    },
    ...overrides,
  }
  return { client, calls }
}

async function drain(ms = 80) {
  await new Promise((r) => setTimeout(r, ms))
}

describe("event-renderer — long tool output auto-upload", () => {
  it("uploads the full output when it exceeds the line threshold", async () => {
    const big = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n")
    const { client, calls } = makeFileClient()
    const h = harness({ toolOutputFileLines: 200, fileClient: client })
    h.push([
      { type: "turn_start" },
      { type: "tool_use_start", id: "u1", tool: "Bash", input: { command: "seq 250" } },
      { type: "tool_use_end", id: "u1", output: big },
      { type: "turn_complete" },
    ])
    await drain(150)
    expect(calls.reserve).toBe(1)
    expect(calls.post).toBe(1)
    expect(calls.complete).toBe(1)
    expect(calls.lastFilename.startsWith("bash-")).toBe(true)
    expect(calls.lastFilename.endsWith(".txt")).toBe(true)

    // The tool card's blocks should include a :paperclip: permalink.
    const updates = h.sends.filter((s) => s.kind === "update" && s.text === "Bash — done")
    expect(updates.length).toBeGreaterThanOrEqual(1)
    const lastBlocks = updates.at(-1)!.blocks as unknown[]
    const footer = blocksText(lastBlocks)
    expect(footer).toContain(":paperclip:")
    expect(footer).toContain("slack/files/F_up")
    // Preview should be truncated with the "full output in attached file" hint.
    expect(footer).toContain("full output (250 lines) in attached file")
  })

  it("does NOT upload when output is below the threshold", async () => {
    const small = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")
    const { client, calls } = makeFileClient()
    const h = harness({ toolOutputFileLines: 200, fileClient: client })
    h.push([
      { type: "turn_start" },
      { type: "tool_use_start", id: "u1", tool: "Bash", input: { command: "seq 20" } },
      { type: "tool_use_end", id: "u1", output: small },
      { type: "turn_complete" },
    ])
    await drain(120)
    expect(calls.reserve).toBe(0)

    const updates = h.sends.filter((s) => s.kind === "update" && s.text === "Bash — done")
    expect(blocksText(updates.at(-1)!.blocks as unknown[])).not.toContain(":paperclip:")
  })

  it("does NOT upload when the tool errored (errors stay inline for urgency)", async () => {
    const big = "x\n".repeat(500)
    const { client, calls } = makeFileClient()
    const h = harness({ toolOutputFileLines: 100, fileClient: client })
    h.push([
      { type: "turn_start" },
      { type: "tool_use_start", id: "u1", tool: "Bash", input: { command: "fail" } },
      { type: "tool_use_end", id: "u1", output: big, error: "boom" },
      { type: "turn_complete" },
    ])
    await drain(120)
    expect(calls.reserve).toBe(0)
    const updates = h.sends.filter((s) => s.kind === "update" && s.text === "Bash — error")
    expect(updates.length).toBeGreaterThanOrEqual(1)
  })

  it("falls back to inline preview when upload fails silently", async () => {
    const big = "x\n".repeat(500)
    const { client } = makeFileClient({
      async getUploadURLExternal() {
        return { ok: false, error: "missing_scope" }
      },
    })
    const h = harness({ toolOutputFileLines: 100, fileClient: client })
    h.push([
      { type: "turn_start" },
      { type: "tool_use_start", id: "u1", tool: "Bash", input: { command: "seq 500" } },
      { type: "tool_use_end", id: "u1", output: big },
      { type: "turn_complete" },
    ])
    await drain(120)
    const updates = h.sends.filter((s) => s.kind === "update" && s.text === "Bash — done")
    expect(updates.length).toBeGreaterThanOrEqual(1)
    const blockText = blocksText(updates.at(-1)!.blocks as unknown[])
    // No paperclip — upload was rejected.
    expect(blockText).not.toContain(":paperclip:")
  })

  it("no-ops silently when no file client is available (stub app)", async () => {
    const big = Array.from({ length: 250 }, () => "x").join("\n")
    const h = harness({ toolOutputFileLines: 100 })
    h.push([
      { type: "turn_start" },
      { type: "tool_use_start", id: "u1", tool: "Bash", input: { command: "seq 250" } },
      { type: "tool_use_end", id: "u1", output: big },
      { type: "turn_complete" },
    ])
    await drain(120)
    const updates = h.sends.filter((s) => s.kind === "update" && s.text === "Bash — done")
    expect(updates.length).toBeGreaterThanOrEqual(1)
    const blockText = blocksText(updates.at(-1)!.blocks as unknown[])
    expect(blockText).not.toContain(":paperclip:")
  })
})
