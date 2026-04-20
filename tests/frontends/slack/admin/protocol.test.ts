import { describe, expect, it } from "bun:test"
import {
  ADMIN_PROTOCOL_VERSION,
  AdminApproveBodySchema,
  AdminCommandSchema,
  AdminDenyBodySchema,
  SESSION_PHASES,
  type AdminCommand,
  type AdminFrame,
  type PendingApproval,
  type SessionDetail,
  type SessionSummary,
} from "../../../../src/frontends/slack/admin/protocol"

/**
 * Round-trip helper — JSON.stringify + JSON.parse and assert deep equality.
 * If this ever fails for a frame, it's because the frame carries a value
 * that doesn't survive JSON (Map, Date, undefined in arrays, etc.). The
 * protocol contract says "everything is JSON," so fixing that upstream is
 * the right call — don't loosen this test.
 */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const sampleSummary: SessionSummary = {
  key: "slack:T0TEAM:C01ABC:1234.5",
  channelId: "C01ABC",
  threadTs: "1234.5",
  backend: "claude",
  projectName: "acme-api",
  phase: "RUNNING",
  turns: 3,
  totalCostUsd: 0.07,
  lastEventAt: 1_700_000_000_000,
  resumed: false,
}

const sampleDetail: SessionDetail = {
  ...sampleSummary,
  cwd: "/Users/odin/dev/repos/acme-api",
  model: "claude-sonnet-4-5",
  permissionMode: "default",
  openedAt: 1_699_999_900_000,
}

const samplePending: PendingApproval = {
  id: "perm-1",
  sessionKey: sampleSummary.key,
  channelId: "C01ABC",
  threadTs: "1234.5",
  tool: "Bash",
  input: { command: "rm -rf build/" },
  displayName: "Run shell command",
  title: "Claude wants to run a shell command",
  description: "The build directory will be removed.",
  approvers: ["U0DEV1", "U0DEV2"],
  requestedAt: 1_700_000_000_000,
  ttlMs: 60_000,
}

describe("AdminFrame round-trip", () => {
  const frames: AdminFrame[] = [
    {
      type: "hello",
      protocol: ADMIN_PROTOCOL_VERSION,
      serverVersion: "0.1.0",
    },
    {
      type: "snapshot",
      sessions: [sampleSummary],
      pendingApprovals: [samplePending],
    },
    { type: "session_opened", summary: sampleSummary },
    {
      type: "session_closed",
      key: sampleSummary.key,
      reason: "idle",
    },
    {
      type: "session_phase",
      key: sampleSummary.key,
      phase: "WAITING_FOR_PERM",
    },
    {
      type: "session_event",
      key: sampleSummary.key,
      event: { type: "text_delta", text: "hello" },
    },
    { type: "approval_requested", approval: samplePending },
    {
      type: "approval_resolved",
      id: "perm-1",
      decision: "allow",
      by: "admin",
    },
    {
      type: "config_changed",
      config: {
        mode: "socket",
        storePath: "/home/op/.bantai/slack.db",
        admin: {
          host: "127.0.0.1",
          port: 4242,
          readOnly: false,
          sessionRingSize: 200,
        },
        projects: [
          { channelId: "C01ABC", name: "acme-api", backend: "claude" },
        ],
      },
    },
    { type: "error", code: "backpressure", message: "queue overflow" },
    { type: "pong", at: 1_700_000_000_000 },
  ]

  for (const frame of frames) {
    it(`survives JSON round-trip for type=${frame.type}`, () => {
      expect(roundTrip(frame)).toEqual(frame)
    })
  }
})

describe("AdminCommandSchema", () => {
  it("accepts a bare subscribe without filters", () => {
    const res = AdminCommandSchema.safeParse({ op: "subscribe" })
    expect(res.success).toBe(true)
  })

  it("accepts subscribe with keys + eventTypes filters", () => {
    const res = AdminCommandSchema.safeParse({
      op: "subscribe",
      keys: ["slack:T:C:main"],
      eventTypes: ["text_delta", "turn_complete"],
    } satisfies AdminCommand)
    expect(res.success).toBe(true)
  })

  it("accepts unsubscribe", () => {
    expect(
      AdminCommandSchema.safeParse({ op: "unsubscribe", keys: ["k1"] }).success,
    ).toBe(true)
  })

  it("accepts ping with a numeric at", () => {
    expect(
      AdminCommandSchema.safeParse({ op: "ping", at: 123 }).success,
    ).toBe(true)
  })

  it("rejects unknown op", () => {
    const res = AdminCommandSchema.safeParse({ op: "nope" })
    expect(res.success).toBe(false)
  })

  it("rejects unknown fields on subscribe (strict)", () => {
    const res = AdminCommandSchema.safeParse({
      op: "subscribe",
      nope: true,
    })
    expect(res.success).toBe(false)
  })

  it("rejects ping with a non-numeric at", () => {
    const res = AdminCommandSchema.safeParse({ op: "ping", at: "now" })
    expect(res.success).toBe(false)
  })

  it("rejects subscribe with empty-string keys", () => {
    const res = AdminCommandSchema.safeParse({
      op: "subscribe",
      keys: [""],
    })
    expect(res.success).toBe(false)
  })
})

describe("approve/deny body schemas", () => {
  it("accepts alwaysAllow true|false|absent on approve body", () => {
    expect(AdminApproveBodySchema.safeParse({}).success).toBe(true)
    expect(
      AdminApproveBodySchema.safeParse({ alwaysAllow: true }).success,
    ).toBe(true)
    expect(
      AdminApproveBodySchema.safeParse({ alwaysAllow: false }).success,
    ).toBe(true)
  })

  it("rejects extra keys on approve body", () => {
    expect(
      AdminApproveBodySchema.safeParse({ alwaysAllow: true, nope: 1 }).success,
    ).toBe(false)
  })

  it("accepts an absent or short reason on deny body", () => {
    expect(AdminDenyBodySchema.safeParse({}).success).toBe(true)
    expect(
      AdminDenyBodySchema.safeParse({ reason: "not safe" }).success,
    ).toBe(true)
  })

  it("rejects an overly long reason on deny body", () => {
    const longReason = "x".repeat(501)
    expect(AdminDenyBodySchema.safeParse({ reason: longReason }).success).toBe(
      false,
    )
  })
})

describe("session detail + summary are JSON-safe", () => {
  it("round-trips sessionSummary", () => {
    expect(roundTrip(sampleSummary)).toEqual(sampleSummary)
  })
  it("round-trips sessionDetail", () => {
    expect(roundTrip(sampleDetail)).toEqual(sampleDetail)
  })
})

describe("SESSION_PHASES catalogue", () => {
  it("lists every state-machine phase plus UNKNOWN", () => {
    expect(SESSION_PHASES).toEqual([
      "INITIALIZING",
      "IDLE",
      "RUNNING",
      "WAITING_FOR_PERM",
      "WAITING_FOR_ELIC",
      "INTERRUPTING",
      "ERROR",
      "SHUTTING_DOWN",
      "UNKNOWN",
    ])
  })
})
