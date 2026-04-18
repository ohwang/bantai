import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSlackUploadMcpServer } from "../../../../src/frontends/slack/mcp/slack-upload"
import type { SlackFileClient } from "../../../../src/frontends/slack/view/upload"

interface FakeClientHandle {
  client: SlackFileClient
  calls: string[]
  completeArgs: {
    channel_id?: string
    thread_ts?: string
    initial_comment?: string
  }
}

function makeFakeClient(opts?: { reserveFails?: boolean }): FakeClientHandle {
  const state: FakeClientHandle = {
    calls: [],
    completeArgs: {},
    // Assigned below to avoid forward-reference noise in the literal.
    client: null as unknown as SlackFileClient,
  }
  state.client = {
    async getUploadURLExternal({ filename }) {
      state.calls.push(`reserve:${filename}`)
      if (opts?.reserveFails) return { ok: false, error: "forbidden" }
      return { ok: true, upload_url: "https://fake/upload", file_id: "F0UP" }
    },
    async postUploadBytes({ filename }) {
      state.calls.push(`post:${filename}`)
    },
    async completeUploadExternal(args) {
      state.calls.push("complete")
      state.completeArgs = {}
      if (args.channel_id !== undefined) state.completeArgs.channel_id = args.channel_id
      if (args.thread_ts !== undefined) state.completeArgs.thread_ts = args.thread_ts
      if (args.initial_comment !== undefined)
        state.completeArgs.initial_comment = args.initial_comment
      return {
        ok: true,
        files: [
          { id: "F0UP", name: args.files[0]!.title, permalink: "https://slack/F0UP" },
        ],
      }
    },
  }
  return state
}

/**
 * Invoke the MCP tool via the SDK's internal registry. `createSdkMcpServer`
 * returns `{ name, instance, type: "sdk" }`; `instance` holds the registered
 * tools at `_registeredTools[name].handler`. This is an SDK-internal shape
 * — it's the only way to drive the handler without standing up a full MCP
 * client transport, which would drag a socket into the unit tests.
 */
async function callTool(
  mcp: ReturnType<typeof createSlackUploadMcpServer>,
  args: { path: string; title?: string; comment?: string },
): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  const instance = mcp.instance as unknown as {
    _registeredTools?: Record<
      string,
      { handler: (args: unknown) => Promise<unknown> }
    >
  }
  const tools = instance._registeredTools ?? {}
  const tool = tools["slack_upload"]
  if (!tool) {
    throw new Error(
      `slack_upload tool not registered; keys=${Object.keys(tools).join(",")}`,
    )
  }
  return (await tool.handler(args)) as {
    content: Array<{ text: string }>
    isError?: boolean
  }
}

describe("createSlackUploadMcpServer", () => {
  let tmp: string
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "bantai-mcp-upload-"))
  })
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("exposes a slack_upload tool with the expected name + cwd binding", () => {
    const { client } = makeFakeClient()
    const mcp = createSlackUploadMcpServer({
      binding: { channel: "C1", threadTs: "1.0" },
      fileClient: client,
      cwd: tmp,
    })
    expect(mcp.name).toBe("bantai-slack-upload")
    expect(mcp.instance).toBeDefined()
  })

  it("rejects paths that escape the session cwd", async () => {
    const { client } = makeFakeClient()
    const mcp = createSlackUploadMcpServer({
      binding: { channel: "C1", threadTs: "1.0" },
      fileClient: client,
      cwd: tmp,
    })
    const res = await callTool(mcp, { path: "/etc/passwd" })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("refusing to upload outside session cwd")
  })

  it("enforces the byte cap by consulting stat() before readFile()", async () => {
    writeFileSync(join(tmp, "huge.bin"), "A".repeat(16))
    const fake = makeFakeClient()
    const mcp = createSlackUploadMcpServer({
      binding: { channel: "C1", threadTs: "1.0" },
      fileClient: fake.client,
      cwd: tmp,
      maxBytes: 8,
      statImpl: async () => ({ size: 999 }),
    })
    const res = await callTool(mcp, { path: "huge.bin" })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("exceeds cap")
    expect(fake.calls).toEqual([])
  })

  it("uploads the file and returns a permalink line on success", async () => {
    writeFileSync(join(tmp, "report.md"), "# hi\n")
    const fake = makeFakeClient()
    const mcp = createSlackUploadMcpServer({
      binding: { channel: "C1", threadTs: "1.0" },
      fileClient: fake.client,
      cwd: tmp,
    })
    const res = await callTool(mcp, { path: "report.md", comment: "here you go" })
    expect(res.isError).toBeFalsy()
    expect(res.content[0]!.text).toContain("Uploaded report.md")
    expect(res.content[0]!.text).toContain("https://slack/F0UP")
    expect(fake.calls).toEqual(["reserve:report.md", "post:report.md", "complete"])
    expect(fake.completeArgs.channel_id).toBe("C1")
    expect(fake.completeArgs.thread_ts).toBe("1.0")
    expect(fake.completeArgs.initial_comment).toBe("here you go")
  })

  it("surfaces upstream upload errors as MCP isError results", async () => {
    writeFileSync(join(tmp, "x.txt"), "hi")
    const { client } = makeFakeClient({ reserveFails: true })
    const mcp = createSlackUploadMcpServer({
      binding: { channel: "C1", threadTs: "1.0" },
      fileClient: client,
      cwd: tmp,
    })
    const res = await callTool(mcp, { path: "x.txt" })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("upload failed")
  })

  it("allows absolute paths inside the cwd", async () => {
    const file = join(tmp, "inside.txt")
    writeFileSync(file, "ok")
    const { client } = makeFakeClient()
    const mcp = createSlackUploadMcpServer({
      binding: { channel: "C1", threadTs: "1.0" },
      fileClient: client,
      cwd: tmp,
    })
    const res = await callTool(mcp, { path: file })
    expect(res.isError).toBeFalsy()
  })

  it("allows any path when cwd is null (opt-out)", async () => {
    writeFileSync("/tmp/bantai-mcp-escape.txt", "ok")
    const { client } = makeFakeClient()
    const mcp = createSlackUploadMcpServer({
      binding: { channel: "C1", threadTs: "1.0" },
      fileClient: client,
      cwd: null,
    })
    const res = await callTool(mcp, { path: "/tmp/bantai-mcp-escape.txt" })
    expect(res.isError).toBeFalsy()
    rmSync("/tmp/bantai-mcp-escape.txt", { force: true })
  })
})
