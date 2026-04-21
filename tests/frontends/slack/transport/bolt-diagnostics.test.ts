import { describe, expect, it } from "bun:test"
import { runBootDiagnostics } from "../../../../src/frontends/slack/transport/bolt"
import type { App } from "@slack/bolt"

function fakeApp(
  responses: Record<
    string,
    | { ok?: boolean; error?: string; response_metadata?: { scopes?: string[] } }
    | Error
  >,
): App {
  return {
    client: {
      conversations: {
        list: async () => unwrap(responses["conversations.list"]),
      },
      users: {
        list: async () => unwrap(responses["users.list"]),
      },
      reactions: {
        list: async () => unwrap(responses["reactions.list"]),
      },
      auth: {
        test: async () =>
          unwrap(responses["auth.test"] ?? { ok: true }),
      },
    },
  } as unknown as App
}

function unwrap<T>(v: T | Error): T {
  if (v instanceof Error) throw v
  return v
}

describe("runBootDiagnostics", () => {
  it("returns no findings when all probes return ok:true", async () => {
    const findings = await runBootDiagnostics(
      fakeApp({
        "conversations.list": { ok: true },
        "users.list": { ok: true },
        "reactions.list": { ok: true },
      }),
    )
    expect(findings).toEqual([])
  })

  it("records a finding per failing probe (error response)", async () => {
    const findings = await runBootDiagnostics(
      fakeApp({
        "conversations.list": { ok: false, error: "missing_scope" },
        "users.list": { ok: true },
        "reactions.list": { ok: false, error: "invalid_auth" },
      }),
    )
    const codes = findings.map((f) => f.code)
    expect(codes).toContain("channels.read")
    expect(codes).toContain("reactions.read")
    expect(codes).not.toContain("users.read")
    const channelsFinding = findings.find((f) => f.code === "channels.read")!
    expect(channelsFinding.message).toContain("missing_scope")
  })

  it("catches thrown errors and records them as findings too", async () => {
    const findings = await runBootDiagnostics(
      fakeApp({
        "conversations.list": { ok: true },
        "users.list": Object.assign(new Error("network down"), {
          data: { error: "ratelimited" },
        }) as unknown as { ok?: boolean; error?: string },
        "reactions.list": { ok: true },
      }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe("users.read")
    expect(findings[0]!.message).toContain("ratelimited")
  })

  it("flags commands.scope when auth.test scopes don't include `commands`", async () => {
    const findings = await runBootDiagnostics(
      fakeApp({
        "conversations.list": { ok: true },
        "users.list": { ok: true },
        "reactions.list": { ok: true },
        "auth.test": {
          ok: true,
          response_metadata: {
            scopes: ["chat:write", "channels:history", "reactions:read"],
          },
        },
      }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe("commands.scope")
    expect(findings[0]!.message).toMatch(/missing the `commands`/)
  })

  it("does not flag commands.scope when `commands` is present", async () => {
    const findings = await runBootDiagnostics(
      fakeApp({
        "conversations.list": { ok: true },
        "users.list": { ok: true },
        "reactions.list": { ok: true },
        "auth.test": {
          ok: true,
          response_metadata: {
            scopes: ["chat:write", "commands", "reactions:read"],
          },
        },
      }),
    )
    expect(findings.find((f) => f.code === "commands.scope")).toBeUndefined()
  })

  it("does not flag commands.scope when the transport doesn't expose scopes", async () => {
    // Older minislack / legacy receivers don't surface x-oauth-scopes.
    // We only warn on POSITIVE evidence of a missing scope.
    const findings = await runBootDiagnostics(
      fakeApp({
        "conversations.list": { ok: true },
        "users.list": { ok: true },
        "reactions.list": { ok: true },
        "auth.test": { ok: true },
      }),
    )
    expect(findings.find((f) => f.code === "commands.scope")).toBeUndefined()
  })
})
