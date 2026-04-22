import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildStdioMcpServer,
  parseStdioEnv,
} from "../../../../src/frontends/slack/mcp/slack-upload-stdio"
import {
  buildSlackUploadStdioSpec,
  DEFAULT_MAX_BYTES,
} from "../../../../src/frontends/slack/mcp/slack-upload-stdio-spec"
import type { SlackFileClient } from "../../../../src/frontends/slack/view/upload"
import { buildSlackFileClientFromToken } from "../../../../src/frontends/slack/view/upload"

// ---------------------------------------------------------------------------
// parseStdioEnv
// ---------------------------------------------------------------------------

describe("parseStdioEnv", () => {
  it("parses a full valid env", () => {
    const parsed = parseStdioEnv({
      BANTAI_SLACK_CHANNEL: "C1",
      BANTAI_SLACK_THREAD_TS: "1.0",
      BANTAI_SLACK_BOT_TOKEN: "xoxb-test",
      BANTAI_SLACK_CWD: "/tmp/x",
      BANTAI_SLACK_MAX_BYTES: "1048576",
      BANTAI_SLACK_API_BASE: "http://localhost:3102/api",
    })
    expect(parsed.channel).toBe("C1")
    expect(parsed.threadTs).toBe("1.0")
    expect(parsed.botToken).toBe("xoxb-test")
    expect(parsed.cwd).toBe("/tmp/x")
    expect(parsed.maxBytes).toBe(1048576)
    expect(parsed.apiBase).toBe("http://localhost:3102/api")
  })

  it("treats empty BANTAI_SLACK_CWD as cwd=null (opt-out)", () => {
    const parsed = parseStdioEnv({
      BANTAI_SLACK_CHANNEL: "C1",
      BANTAI_SLACK_THREAD_TS: "1.0",
      BANTAI_SLACK_BOT_TOKEN: "xoxb",
      BANTAI_SLACK_CWD: "",
    })
    expect(parsed.cwd).toBeNull()
    expect(parsed.maxBytes).toBe(DEFAULT_MAX_BYTES)
  })

  it("reports all missing required vars in a single error", () => {
    expect(() =>
      parseStdioEnv({ BANTAI_SLACK_THREAD_TS: "1.0" }),
    ).toThrow(/BANTAI_SLACK_CHANNEL.*BANTAI_SLACK_BOT_TOKEN/)
  })

  it("rejects non-integer BANTAI_SLACK_MAX_BYTES", () => {
    expect(() =>
      parseStdioEnv({
        BANTAI_SLACK_CHANNEL: "C1",
        BANTAI_SLACK_THREAD_TS: "1.0",
        BANTAI_SLACK_BOT_TOKEN: "xoxb",
        BANTAI_SLACK_MAX_BYTES: "-1",
      }),
    ).toThrow(/positive integer/)
    expect(() =>
      parseStdioEnv({
        BANTAI_SLACK_CHANNEL: "C1",
        BANTAI_SLACK_THREAD_TS: "1.0",
        BANTAI_SLACK_BOT_TOKEN: "xoxb",
        BANTAI_SLACK_MAX_BYTES: "1.5",
      }),
    ).toThrow(/positive integer/)
  })
})

// ---------------------------------------------------------------------------
// buildStdioMcpServer — the McpServer the stdio subprocess exposes
// ---------------------------------------------------------------------------

describe("buildStdioMcpServer", () => {
  let tmp: string
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "bantai-stdio-mcp-"))
  })
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function makeFakeClient(): { client: SlackFileClient; calls: string[] } {
    const calls: string[] = []
    const client: SlackFileClient = {
      async getUploadURLExternal({ filename }) {
        calls.push(`reserve:${filename}`)
        return { ok: true, upload_url: "https://fake/upload", file_id: "F0UP" }
      },
      async postUploadBytes({ filename }) {
        calls.push(`post:${filename}`)
      },
      async completeUploadExternal() {
        calls.push("complete")
        return {
          ok: true,
          files: [{ id: "F0UP", name: "r.md", permalink: "https://slack/F0UP" }],
        }
      },
    }
    return { client, calls }
  }

  /**
   * Reach through the McpServer to its `_registeredTools` map so tests
   * can invoke the handler without standing up a full stdio transport.
   * Mirrors the pattern in `slack-upload.test.ts`.
   */
  async function callTool(
    server: ReturnType<typeof buildStdioMcpServer>,
    args: { path: string; title?: string; comment?: string },
  ): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
    const anyServer = server as unknown as {
      _registeredTools?: Record<
        string,
        { handler: (args: unknown, extra: unknown) => Promise<unknown> }
      >
    }
    const tools = anyServer._registeredTools ?? {}
    const tool = tools["slack_upload"]
    if (!tool) {
      throw new Error(
        `slack_upload not registered; keys=${Object.keys(tools).join(",")}`,
      )
    }
    return (await tool.handler(args, {})) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
  }

  it("registers the slack_upload tool and uploads via the injected client", async () => {
    writeFileSync(join(tmp, "report.md"), "# hi\n")
    const fake = makeFakeClient()
    const server = buildStdioMcpServer({
      parsed: {
        channel: "C1",
        threadTs: "1.0",
        botToken: "xoxb-test",
        cwd: tmp,
        maxBytes: DEFAULT_MAX_BYTES,
      },
      fileClient: fake.client,
    })
    const res = await callTool(server, { path: "report.md" })
    expect(res.isError).toBeFalsy()
    expect(res.content[0]!.text).toContain("Uploaded report.md")
    expect(fake.calls).toEqual(["reserve:report.md", "post:report.md", "complete"])
  })

  it("honours the cwd containment rule from the shared core", async () => {
    const fake = makeFakeClient()
    const server = buildStdioMcpServer({
      parsed: {
        channel: "C1",
        threadTs: "1.0",
        botToken: "xoxb-test",
        cwd: tmp,
        maxBytes: DEFAULT_MAX_BYTES,
      },
      fileClient: fake.client,
    })
    const res = await callTool(server, { path: "/etc/passwd" })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("refusing to upload outside session cwd")
  })

  it("honours the byte cap via stat() before readFile()", async () => {
    writeFileSync(join(tmp, "huge.bin"), "AAAA")
    const fake = makeFakeClient()
    const server = buildStdioMcpServer({
      parsed: {
        channel: "C1",
        threadTs: "1.0",
        botToken: "xoxb-test",
        cwd: tmp,
        maxBytes: 3,
      },
      fileClient: fake.client,
      statImpl: async () => ({ size: 999 }),
    })
    const res = await callTool(server, { path: "huge.bin" })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("exceeds cap")
  })
})

// ---------------------------------------------------------------------------
// buildSlackFileClientFromToken — HTTP-based client used by the subprocess
// ---------------------------------------------------------------------------

describe("buildSlackFileClientFromToken", () => {
  it("calls files.getUploadURLExternal with the bot token as bearer", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body?: string }> =
      []
    const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input)
      const headers = init?.headers as Record<string, string>
      seen.push({ url, headers, body: init?.body as string })
      return new Response(
        JSON.stringify({ ok: true, upload_url: "https://u", file_id: "FID" }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const client = buildSlackFileClientFromToken("xoxb-secret", {
      apiBase: "https://slack.example/api",
      fetchImpl: fakeFetch,
    })
    const res = await client.getUploadURLExternal({ filename: "a.png", length: 10 })
    expect(res).toEqual({ ok: true, upload_url: "https://u", file_id: "FID" })
    expect(seen[0]!.url).toBe("https://slack.example/api/files.getUploadURLExternal")
    expect(seen[0]!.headers["Authorization"]).toBe("Bearer xoxb-secret")
    expect(seen[0]!.body).toContain("filename=a.png")
    expect(seen[0]!.body).toContain("length=10")
  })

  it("refuses construction without a token", () => {
    expect(() => buildSlackFileClientFromToken("")).toThrow(/botToken is required/)
  })

  it("surfaces non-ok HTTP on the reserve step", async () => {
    const fakeFetch = (async () =>
      new Response("boom", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch
    const client = buildSlackFileClientFromToken("xoxb", {
      fetchImpl: fakeFetch,
    })
    await expect(
      client.getUploadURLExternal({ filename: "a", length: 1 }),
    ).rejects.toThrow(/HTTP 500/)
  })

  it("passes channel / thread / comment through completeUploadExternal", async () => {
    const bodies: string[] = []
    const fakeFetch = (async (_input: string | URL, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return new Response(
        JSON.stringify({
          ok: true,
          files: [{ id: "F", name: "x.png", permalink: "https://slack/F" }],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const client = buildSlackFileClientFromToken("xoxb", { fetchImpl: fakeFetch })
    const res = await client.completeUploadExternal({
      files: [{ id: "F", title: "X" }],
      channel_id: "C1",
      thread_ts: "1.0",
      initial_comment: "hi",
    })
    expect(res.ok).toBe(true)
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>
    expect(body["channel_id"]).toBe("C1")
    expect(body["thread_ts"]).toBe("1.0")
    expect(body["initial_comment"]).toBe("hi")
  })
})

// ---------------------------------------------------------------------------
// buildSlackUploadStdioSpec
// ---------------------------------------------------------------------------

describe("buildSlackUploadStdioSpec", () => {
  it("bakes the full per-session binding into env", () => {
    const spec = buildSlackUploadStdioSpec({
      channel: "C1",
      threadTs: "1.0",
      botToken: "xoxb-x",
      cwd: "/w",
      maxBytes: 1024,
      apiBase: "http://mini",
      cliCommand: "/usr/bin/bantai",
      cliLeadingArgs: [],
    })
    expect(spec.command).toBe("/usr/bin/bantai")
    expect(spec.args).toEqual(["slack", "mcp-upload-server"])
    expect(spec.env).toEqual({
      BANTAI_SLACK_CHANNEL: "C1",
      BANTAI_SLACK_THREAD_TS: "1.0",
      BANTAI_SLACK_BOT_TOKEN: "xoxb-x",
      BANTAI_SLACK_CWD: "/w",
      BANTAI_SLACK_MAX_BYTES: "1024",
      BANTAI_SLACK_API_BASE: "http://mini",
    })
  })

  it("serializes cwd=null as empty string (opt-out)", () => {
    const spec = buildSlackUploadStdioSpec({
      channel: "C1",
      threadTs: "1.0",
      botToken: "xoxb",
      cwd: null,
      cliCommand: "bantai",
      cliLeadingArgs: [],
    })
    expect(spec.env!["BANTAI_SLACK_CWD"]).toBe("")
    expect(spec.env!["BANTAI_SLACK_MAX_BYTES"]).toBe(String(DEFAULT_MAX_BYTES))
  })

  it("defaults command to process.argv[0] + argv[1] when no CLI override", () => {
    const spec = buildSlackUploadStdioSpec({
      channel: "C1",
      threadTs: "1.0",
      botToken: "xoxb",
      cwd: null,
    })
    expect(spec.command).toBe(process.argv[0]!)
    // args[0] is argv[1] or a bantai entrypoint fallback; then the subcommand.
    expect(spec.args!.slice(-2)).toEqual(["slack", "mcp-upload-server"])
  })

  it("rejects missing channel / thread / token", () => {
    expect(() =>
      buildSlackUploadStdioSpec({ channel: "", threadTs: "1", botToken: "x", cwd: null }),
    ).toThrow(/channel is required/)
    expect(() =>
      buildSlackUploadStdioSpec({ channel: "C", threadTs: "", botToken: "x", cwd: null }),
    ).toThrow(/threadTs is required/)
    expect(() =>
      buildSlackUploadStdioSpec({ channel: "C", threadTs: "1", botToken: "", cwd: null }),
    ).toThrow(/botToken is required/)
  })

  it("merges extraEnv alongside the bantai env block", () => {
    const spec = buildSlackUploadStdioSpec({
      channel: "C",
      threadTs: "1",
      botToken: "x",
      cwd: "/w",
      cliCommand: "bantai",
      cliLeadingArgs: [],
      extraEnv: { NODE_OPTIONS: "--enable-source-maps" },
    })
    expect(spec.env!["NODE_OPTIONS"]).toBe("--enable-source-maps")
    expect(spec.env!["BANTAI_SLACK_CHANNEL"]).toBe("C")
  })
})
