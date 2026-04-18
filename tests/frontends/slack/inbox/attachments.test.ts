import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createAttachmentFetcher,
  renderTextHint,
  type InboundFile,
} from "../../../../src/frontends/slack/inbox/attachments"

function mkStagingDir(): string {
  return mkdtempSync(join(tmpdir(), "bantai-attach-"))
}

function makeFakeFetch(map: Map<string, { status: number; bytes?: Uint8Array }>) {
  const calls: Array<{ url: string; auth?: string }> = []
  async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input.toString()
    const auth =
      typeof init?.headers === "object" &&
      init.headers !== null &&
      "Authorization" in (init.headers as Record<string, string>)
        ? (init.headers as Record<string, string>).Authorization
        : undefined
    calls.push({ url, auth })
    const entry = map.get(url)
    if (!entry) {
      return new Response("not found", { status: 404 })
    }
    const body: ArrayBuffer = entry.bytes
      ? (entry.bytes.buffer as ArrayBuffer).slice(
          entry.bytes.byteOffset,
          entry.bytes.byteOffset + entry.bytes.byteLength,
        )
      : new ArrayBuffer(0)
    return new Response(body, { status: entry.status })
  }
  return { fakeFetch, calls }
}

describe("renderTextHint", () => {
  it("returns empty string for no paths", () => {
    expect(renderTextHint([])).toBe("")
  })
  it("joins paths as bullet hints", () => {
    const hint = renderTextHint(["/tmp/a.log", "/tmp/b.diff"])
    expect(hint).toContain("[attached: /tmp/a.log]")
    expect(hint).toContain("[attached: /tmp/b.diff]")
  })
})

describe("createAttachmentFetcher", () => {
  let stagingDir: string

  beforeEach(() => {
    stagingDir = mkStagingDir()
  })
  afterEach(() => {
    try {
      rmSync(stagingDir, { recursive: true, force: true })
    } catch {}
  })

  it("downloads an image and embeds it as base64 in images[], no disk write", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const { fakeFetch, calls } = makeFakeFetch(
      new Map([["https://slack/files/F1/download", { status: 200, bytes: png }]]),
    )
    const fetcher = createAttachmentFetcher({
      botToken: "xoxb-abc",
      stagingDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    })

    const files: InboundFile[] = [
      {
        id: "F1",
        name: "screenshot.png",
        mimetype: "image/png",
        url_private_download: "https://slack/files/F1/download",
      },
    ]
    const out = await fetcher.fetch(files, { channelId: "C01", ts: "100.001" })

    expect(out.images).toHaveLength(1)
    expect(out.images[0]!.mediaType).toBe("image/png")
    // Base64 of the 8-byte PNG magic = "iVBORw0KGgo="
    expect(out.images[0]!.data).toBe("iVBORw0KGgo=")
    expect(out.paths).toEqual([])
    expect(out.textHint).toBe("")

    // Called with the bearer token.
    expect(calls[0]!.auth).toBe("Bearer xoxb-abc")
    // Staging dir was not created because no non-image files landed.
    expect(existsSync(join(stagingDir, "C01"))).toBe(false)
  })

  it("writes non-image attachments to the channel/ts staging dir and returns paths", async () => {
    const log = new TextEncoder().encode("line1\nline2\nline3\n")
    const { fakeFetch } = makeFakeFetch(
      new Map([["https://slack/files/F2", { status: 200, bytes: log }]]),
    )
    const fetcher = createAttachmentFetcher({
      botToken: "xoxb",
      stagingDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    })
    const files: InboundFile[] = [
      {
        id: "F2",
        name: "failure.log",
        mimetype: "text/plain",
        url_private: "https://slack/files/F2",
      },
    ]
    const out = await fetcher.fetch(files, { channelId: "C01", ts: "100.001" })

    expect(out.images).toHaveLength(0)
    expect(out.paths).toHaveLength(1)
    const abs = out.paths[0]!
    expect(abs.startsWith(stagingDir)).toBe(true)
    expect(abs.endsWith("failure.log")).toBe(true)
    expect(readFileSync(abs, "utf8")).toBe("line1\nline2\nline3\n")
    expect(out.textHint).toContain(`[attached: ${abs}]`)
  })

  it("mixes image + non-image on one message without cross-contaminating", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const log = new TextEncoder().encode("hello")
    const { fakeFetch } = makeFakeFetch(
      new Map([
        ["https://s/png", { status: 200, bytes: png }],
        ["https://s/log", { status: 200, bytes: log }],
      ]),
    )
    const fetcher = createAttachmentFetcher({
      botToken: "xoxb",
      stagingDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    })
    const out = await fetcher.fetch(
      [
        { id: "F1", name: "a.png", mimetype: "image/png", url_private: "https://s/png" },
        { id: "F2", name: "b.log", mimetype: "text/plain", url_private: "https://s/log" },
      ],
      { channelId: "C01", ts: "100.001" },
    )
    expect(out.images).toHaveLength(1)
    expect(out.paths).toHaveLength(1)
  })

  it("drops files with unreadable URLs (skipped, not thrown)", async () => {
    const { fakeFetch } = makeFakeFetch(new Map())
    const fetcher = createAttachmentFetcher({
      botToken: "xoxb",
      stagingDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    })
    const out = await fetcher.fetch(
      [
        { id: "F1", name: "x.png", mimetype: "image/png", url_private: "https://nope" },
        { id: "F2", name: "y" }, // no URL at all
      ],
      { channelId: "C01", ts: "100.001" },
    )
    expect(out.images).toEqual([])
    expect(out.paths).toEqual([])
  })

  it("respects maxFilesPerTurn", async () => {
    const { fakeFetch } = makeFakeFetch(
      new Map([
        ["https://s/a", { status: 200, bytes: new Uint8Array([1]) }],
        ["https://s/b", { status: 200, bytes: new Uint8Array([2]) }],
        ["https://s/c", { status: 200, bytes: new Uint8Array([3]) }],
      ]),
    )
    const fetcher = createAttachmentFetcher({
      botToken: "xoxb",
      stagingDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      maxFilesPerTurn: 2,
    })
    const out = await fetcher.fetch(
      [
        { id: "a", name: "a.bin", url_private: "https://s/a" },
        { id: "b", name: "b.bin", url_private: "https://s/b" },
        { id: "c", name: "c.bin", url_private: "https://s/c" },
      ],
      { channelId: "C01", ts: "100.001" },
    )
    // Third file was dropped.
    expect(out.paths).toHaveLength(2)
  })

  it("respects maxFileBytes", async () => {
    const big = new Uint8Array(100).fill(1)
    const { fakeFetch } = makeFakeFetch(
      new Map([["https://s/big", { status: 200, bytes: big }]]),
    )
    const fetcher = createAttachmentFetcher({
      botToken: "xoxb",
      stagingDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      maxFileBytes: 10,
    })
    const out = await fetcher.fetch(
      [{ id: "big", name: "big.bin", url_private: "https://s/big" }],
      { channelId: "C01", ts: "100.001" },
    )
    expect(out.paths).toEqual([])
  })

  it("rewriteUrl hook lets tests redirect Slack URLs at minislack", async () => {
    const bytes = new TextEncoder().encode("redirected")
    const { fakeFetch, calls } = makeFakeFetch(
      new Map([["http://localhost/ok", { status: 200, bytes }]]),
    )
    const fetcher = createAttachmentFetcher({
      botToken: "xoxb",
      stagingDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      rewriteUrl: (_u) => "http://localhost/ok",
    })
    const out = await fetcher.fetch(
      [{ id: "F1", name: "x.txt", url_private: "https://slack.com/files/x" }],
      { channelId: "C01", ts: "100.001" },
    )
    expect(calls[0]!.url).toBe("http://localhost/ok")
    expect(out.paths).toHaveLength(1)
  })

  it("returns an empty bundle for zero files", async () => {
    const fetcher = createAttachmentFetcher({
      botToken: "xoxb",
      stagingDir,
    })
    const out = await fetcher.fetch([], { channelId: "C01", ts: "100.001" })
    expect(out).toEqual({ images: [], paths: [], textHint: "" })
  })

  it("sanitises filenames that contain spaces or unsafe characters", async () => {
    const bytes = new TextEncoder().encode("ok")
    const { fakeFetch } = makeFakeFetch(
      new Map([["https://s/x", { status: 200, bytes }]]),
    )
    const fetcher = createAttachmentFetcher({
      botToken: "xoxb",
      stagingDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    })
    const out = await fetcher.fetch(
      [
        {
          id: "F1",
          name: "my cool file?.log",
          mimetype: "text/plain",
          url_private: "https://s/x",
        },
      ],
      { channelId: "C01", ts: "100.001" },
    )
    expect(out.paths).toHaveLength(1)
    expect(out.paths[0]!.endsWith("my_cool_file.log")).toBe(true)
  })
})
