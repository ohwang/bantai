import { describe, expect, it } from "bun:test"
import {
  guessContentType,
  uploadFile,
  uploadFileBestEffort,
  type SlackFileClient,
} from "../../../../src/frontends/slack/view/upload"

function makeClient(overrides: Partial<SlackFileClient> = {}): {
  client: SlackFileClient
  calls: {
    reserve: Array<{ filename: string; length: number }>
    post: Array<{ uploadUrl: string; contentType: string; filename: string; bytes: number }>
    complete: Array<{ files: unknown; channel_id?: string; thread_ts?: string; initial_comment?: string }>
  }
} {
  const calls = { reserve: [] as unknown[], post: [] as unknown[], complete: [] as unknown[] } as {
    reserve: Array<{ filename: string; length: number }>
    post: Array<{ uploadUrl: string; contentType: string; filename: string; bytes: number }>
    complete: Array<{ files: unknown; channel_id?: string; thread_ts?: string; initial_comment?: string }>
  }
  const client: SlackFileClient = {
    async getUploadURLExternal(args) {
      calls.reserve.push(args)
      return { ok: true, upload_url: "https://minislack/_upload/tok", file_id: "F123" }
    },
    async postUploadBytes(args) {
      calls.post.push({
        uploadUrl: args.uploadUrl,
        contentType: args.contentType,
        filename: args.filename,
        bytes: args.content.byteLength,
      })
    },
    async completeUploadExternal(args) {
      calls.complete.push({
        files: args.files,
        ...(args.channel_id ? { channel_id: args.channel_id } : {}),
        ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
        ...(args.initial_comment ? { initial_comment: args.initial_comment } : {}),
      })
      return {
        ok: true,
        files: [{ id: "F123", name: args.files[0]?.title ?? "file", permalink: "https://minislack/files/F123" }],
      }
    },
    ...overrides,
  }
  return { client, calls }
}

describe("guessContentType", () => {
  it("maps common text extensions", () => {
    expect(guessContentType("notes.txt")).toBe("text/plain")
    expect(guessContentType("README.md")).toBe("text/markdown")
    expect(guessContentType("data.json")).toBe("application/json")
    expect(guessContentType("patch.diff")).toBe("text/x-diff")
    expect(guessContentType("screen.png")).toBe("image/png")
  })

  it("falls back to application/octet-stream for unknown / missing", () => {
    expect(guessContentType("data.weird")).toBe("application/octet-stream")
    expect(guessContentType("README")).toBe("application/octet-stream")
  })
})

describe("uploadFile", () => {
  it("runs the 3-step flow in order with the correct arguments", async () => {
    const { client, calls } = makeClient()
    const result = await uploadFile(client, {
      filename: "out.txt",
      content: "hello world",
      channel: "C01",
      threadTs: "100.001",
      initialComment: "here's the output",
      title: "big output",
    })

    expect(calls.reserve).toHaveLength(1)
    expect(calls.reserve[0]).toEqual({ filename: "out.txt", length: 11 })

    expect(calls.post).toHaveLength(1)
    expect(calls.post[0]!.uploadUrl).toBe("https://minislack/_upload/tok")
    expect(calls.post[0]!.contentType).toBe("text/plain")
    expect(calls.post[0]!.filename).toBe("out.txt")
    expect(calls.post[0]!.bytes).toBe(11)

    expect(calls.complete).toHaveLength(1)
    const completeCall = calls.complete[0]!
    const files = completeCall.files as Array<{ id: string; title: string }>
    expect(files).toEqual([{ id: "F123", title: "big output" }])
    expect(completeCall.channel_id).toBe("C01")
    expect(completeCall.thread_ts).toBe("100.001")
    expect(completeCall.initial_comment).toBe("here's the output")

    expect(result.fileId).toBe("F123")
    expect(result.permalink).toBe("https://minislack/files/F123")
  })

  it("uploads without a channel (returns the fileId for caller to reference)", async () => {
    const { client, calls } = makeClient()
    const res = await uploadFile(client, {
      filename: "hidden.log",
      content: new Uint8Array([1, 2, 3]),
    })
    expect(calls.complete[0]!.channel_id).toBeUndefined()
    expect(calls.complete[0]!.thread_ts).toBeUndefined()
    expect(res.fileId).toBe("F123")
  })

  it("passes Uint8Array content through unchanged", async () => {
    const { client, calls } = makeClient()
    await uploadFile(client, {
      filename: "bytes.bin",
      content: new Uint8Array([7, 8, 9, 10, 11]),
    })
    expect(calls.post[0]!.bytes).toBe(5)
  })

  it("throws when files.getUploadURLExternal reports !ok", async () => {
    const { client } = makeClient({
      async getUploadURLExternal() {
        return { ok: false, error: "forbidden" }
      },
    })
    await expect(
      uploadFile(client, { filename: "x.txt", content: "hi" }),
    ).rejects.toThrow(/forbidden/)
  })

  it("throws when completeUploadExternal reports !ok", async () => {
    const { client } = makeClient({
      async completeUploadExternal() {
        return { ok: false, error: "bad_file_id" }
      },
    })
    await expect(
      uploadFile(client, { filename: "x.txt", content: "hi" }),
    ).rejects.toThrow(/bad_file_id/)
  })
})

describe("uploadFileBestEffort", () => {
  it("returns undefined instead of throwing on failure", async () => {
    const { client } = makeClient({
      async getUploadURLExternal() {
        return { ok: false, error: "missing_scope" }
      },
    })
    const res = await uploadFileBestEffort(client, { filename: "x.txt", content: "hi" })
    expect(res).toBeUndefined()
  })

  it("returns the upload result on success", async () => {
    const { client } = makeClient()
    const res = await uploadFileBestEffort(client, { filename: "x.txt", content: "hi" })
    expect(res?.fileId).toBe("F123")
  })
})
