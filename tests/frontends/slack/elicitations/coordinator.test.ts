import { beforeEach, describe, expect, it } from "bun:test"
import {
  createElicitationCoordinator,
  type ElicitationBackendCallbacks,
  type ElicitationCoordinator,
} from "../../../../src/frontends/slack/elicitations/coordinator"
import type { SendAdapter } from "../../../../src/frontends/slack/view/outbox"
import type { ElicitationRequestEvent } from "../../../../src/protocol/types"
import {
  encodeBlockId,
  encodeCancelActionId,
  encodeModalCallbackId,
  encodeOpenActionId,
} from "../../../../src/frontends/slack/view/blocks/elicitation"

function makeAdapter() {
  const posts: Array<{ channel: string; threadTs?: string; text: string; blocks?: unknown[] }> = []
  const updates: Array<{ channel: string; ts: string; text: string; blocks?: unknown[] }> = []
  let autoTs = 2000
  const adapter: SendAdapter = {
    async postMessage(args) {
      const body = args.markdownText ?? args.text ?? ""
      posts.push({
        channel: args.channel,
        ...(args.threadTs !== undefined ? { threadTs: args.threadTs } : {}),
        text: body,
        ...(args.blocks ? { blocks: args.blocks } : {}),
      })
      return { ts: String(autoTs++), channel: args.channel }
    },
    async updateMessage(args) {
      const body = args.markdownText ?? args.text ?? ""
      updates.push({
        channel: args.channel,
        ts: args.ts,
        text: body,
        ...(args.blocks ? { blocks: args.blocks } : {}),
      })
    },
  }
  return { adapter, posts, updates }
}

function makeFakeApp() {
  const opens: Array<{ trigger_id: string; view: unknown }> = []
  const app = {
    client: {
      views: {
        async open(args: { trigger_id: string; view: unknown }) {
          opens.push(args)
          return { ok: true, view: { id: "view_1" } }
        },
      },
    },
  } as unknown as Parameters<typeof createElicitationCoordinator>[0]["app"]
  return { app, opens }
}

function makeBackend() {
  const responded: Array<{ id: string; answers: Record<string, string> }> = []
  const cancelled: string[] = []
  const cb: ElicitationBackendCallbacks = {
    respond(id, answers) {
      responded.push({ id, answers })
    },
    cancel(id) {
      cancelled.push(id)
    },
  }
  return { cb, responded, cancelled }
}

function req(overrides: Partial<ElicitationRequestEvent> = {}): ElicitationRequestEvent {
  return {
    type: "elicitation_request",
    id: "elic1",
    questions: [
      {
        question: "Which framework?",
        options: [{ label: "React" }, { label: "Solid" }],
        allowFreeText: false,
      },
    ],
    ...overrides,
  }
}

async function tick() {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe("elicitation coordinator", () => {
  let coord: ElicitationCoordinator
  let adapter: ReturnType<typeof makeAdapter>
  let app: ReturnType<typeof makeFakeApp>
  let backend: ReturnType<typeof makeBackend>

  beforeEach(() => {
    adapter = makeAdapter()
    app = makeFakeApp()
    backend = makeBackend()
    coord = createElicitationCoordinator({
      adapter: adapter.adapter,
      app: app.app,
      lookupSession: () => backend.cb,
    })
  })

  it("posts a card on request and opens the modal on Answer click", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001" })
    hook.onRequest({ request: req({ id: "e1" }), channel: "C01", threadTs: "100.001" })
    await tick()

    expect(adapter.posts).toHaveLength(1)
    expect(coord.size()).toBe(1)

    const res = await coord.handleBlockAction({
      actionId: encodeOpenActionId("e1"),
      userId: "U01",
      triggerId: "tr_1",
    })
    expect(res).toEqual({ kind: "open", id: "e1" })
    expect(app.opens).toHaveLength(1)
    const view = app.opens[0]!.view as { callback_id: string; blocks: unknown[] }
    expect(view.callback_id).toBe(encodeModalCallbackId("e1"))
    expect(view.blocks.length).toBeGreaterThan(0)
    // Pending record still present — the modal is open, no answer yet.
    expect(coord.size()).toBe(1)
  })

  it("cancel click → backend.cancel + resolved card (cancelled) and removes pending", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001" })
    hook.onRequest({ request: req({ id: "e2" }), channel: "C01", threadTs: "100.001" })
    await tick()

    const res = await coord.handleBlockAction({
      actionId: encodeCancelActionId("e2"),
      userId: "U01",
      triggerId: "tr_1",
    })
    expect(res).toEqual({ kind: "cancel", id: "e2" })
    expect(backend.cancelled).toEqual(["e2"])
    expect(adapter.updates).toHaveLength(1)
    expect(adapter.updates[0]!.text).toContain("cancelled")
    expect(coord.size()).toBe(0)
  })

  it("view submission → backend.respond with harvested answers + resolved card", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001" })
    hook.onRequest({ request: req({ id: "e3" }), channel: "C01", threadTs: "100.001" })
    await tick()

    // Mock the submission values Slack would send.
    const values = {
      [encodeBlockId("e3", 0)]: {
        [encodeBlockId("e3", 0)]: {
          type: "static_select",
          selected_option: { value: "React", text: { text: "React" } },
        },
      },
    }
    const res = await coord.handleViewSubmission({
      callbackId: encodeModalCallbackId("e3"),
      userId: "U01",
      values,
    })
    expect(res.kind).toBe("submitted")
    expect(backend.responded).toEqual([{ id: "e3", answers: { "Which framework?": "React" } }])
    expect(adapter.updates[0]!.text).toContain("answered")
    expect(coord.size()).toBe(0)
  })

  it("view submission with no usable answers returns no_answers + does NOT hit backend", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001" })
    hook.onRequest({
      request: req({ id: "e4", questions: [{ question: "Q", options: [] }] }),
      channel: "C01",
      threadTs: "100.001",
    })
    await tick()

    const values = {
      [encodeBlockId("e4", 0)]: {
        [encodeBlockId("e4", 0)]: { type: "plain_text_input", value: "   " },
      },
    }
    const res = await coord.handleViewSubmission({
      callbackId: encodeModalCallbackId("e4"),
      userId: "U01",
      values,
    })
    expect(res.kind).toBe("no_answers")
    expect(backend.responded).toEqual([])
    // Record stays pending so the user can reopen & fix.
    expect(coord.size()).toBe(1)
  })

  it("unknown / malformed ids are flagged and don't touch the backend", async () => {
    expect(
      await coord.handleBlockAction({
        actionId: "bantai:perm:whatever:allow",
        userId: "U01",
        triggerId: "tr",
      }),
    ).toEqual({ kind: "malformed" })

    expect(
      await coord.handleBlockAction({
        actionId: encodeOpenActionId("never_posted"),
        userId: "U01",
        triggerId: "tr",
      }),
    ).toEqual({ kind: "open", id: "never_posted" })
    expect(app.opens).toHaveLength(0)

    expect(
      await coord.handleViewSubmission({
        callbackId: "bantai:other:x",
        userId: "U01",
        values: {},
      }),
    ).toEqual({ kind: "malformed" })
    expect(
      await coord.handleViewSubmission({
        callbackId: encodeModalCallbackId("missing"),
        userId: "U01",
        values: {},
      }),
    ).toEqual({ kind: "unknown", id: "missing" })
    expect(backend.responded).toEqual([])
  })

  it("onCancel from renderer cancels the backend + marks card as cancelled", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001" })
    hook.onRequest({ request: req({ id: "e5" }), channel: "C01", threadTs: "100.001" })
    await tick()
    hook.onCancel("e5")
    await tick()
    expect(backend.cancelled).toEqual(["e5"])
    expect(adapter.updates[0]!.text).toContain("cancelled")
    expect(coord.size()).toBe(0)
  })

  it("closeAll cancels every outstanding elicitation", async () => {
    const hook = coord.bindSession({ sessionKey: "slack:T1:C01:100.001" })
    hook.onRequest({ request: req({ id: "a" }), channel: "C01", threadTs: "100.001" })
    hook.onRequest({ request: req({ id: "b" }), channel: "C01", threadTs: "100.001" })
    await tick()
    coord.closeAll()
    await tick()
    expect(backend.cancelled.sort()).toEqual(["a", "b"])
    expect(coord.size()).toBe(0)
  })

  it("missing session at submit-time → card updates but backend.respond is skipped", async () => {
    const coord2 = createElicitationCoordinator({
      adapter: adapter.adapter,
      app: app.app,
      lookupSession: () => undefined,
    })
    const hook = coord2.bindSession({ sessionKey: "slack:T1:C01:100.001" })
    hook.onRequest({ request: req({ id: "orphan" }), channel: "C01", threadTs: "100.001" })
    await tick()
    const values = {
      [encodeBlockId("orphan", 0)]: {
        [encodeBlockId("orphan", 0)]: {
          type: "static_select",
          selected_option: { value: "React", text: { text: "React" } },
        },
      },
    }
    const res = await coord2.handleViewSubmission({
      callbackId: encodeModalCallbackId("orphan"),
      userId: "U01",
      values,
    })
    expect(res.kind).toBe("submitted")
    // Card updated visually, backend untouched (session gone).
    expect(adapter.updates.length).toBeGreaterThanOrEqual(1)
    expect(backend.responded).toEqual([])
  })
})
