import { describe, expect, it } from "bun:test"
import type { App } from "@slack/bolt"
import {
  attachFatalAuthGuard,
  isFatalSlackAuthError,
} from "../../../../src/frontends/slack/transport/bolt"

describe("isFatalSlackAuthError", () => {
  it("matches a Slack WebAPI error with parsed data.error", () => {
    const err = new Error("An API error occurred: invalid_auth") as Error & {
      data?: { error?: string }
    }
    err.data = { error: "invalid_auth" }
    expect(isFatalSlackAuthError(err)).toBe(true)
  })

  it("matches account_inactive", () => {
    const err = { data: { error: "account_inactive" }, message: "failed" }
    expect(isFatalSlackAuthError(err)).toBe(true)
  })

  it("matches token_revoked in the message string", () => {
    const err = new Error("socket closed: token_revoked")
    expect(isFatalSlackAuthError(err)).toBe(true)
  })

  it("matches not_authed when surfaced on `code`", () => {
    expect(isFatalSlackAuthError({ code: "not_authed" })).toBe(true)
  })

  it("matches errors wrapped via `original.data.error`", () => {
    // Bolt wraps some errors in `AuthorizationError` with the raw Web
    // API error attached as `original`. Make sure we look there too.
    expect(
      isFatalSlackAuthError({
        message: "Authorization failed",
        original: { data: { error: "token_revoked" } },
      }),
    ).toBe(true)
  })

  it("does NOT match transient errors (rate_limited, network)", () => {
    expect(isFatalSlackAuthError({ data: { error: "rate_limited" } })).toBe(false)
    expect(isFatalSlackAuthError(new Error("ECONNRESET"))).toBe(false)
    expect(isFatalSlackAuthError({ code: "ETIMEDOUT" })).toBe(false)
  })

  it("does NOT match missing_scope (caller should log + continue)", () => {
    // Missing-scope isn't fatal — the operator can add the scope and
    // restart. Treating it as fatal would deny them the log message.
    expect(isFatalSlackAuthError({ data: { error: "missing_scope" } })).toBe(false)
  })

  it("rejects non-object errors defensively", () => {
    expect(isFatalSlackAuthError(undefined)).toBe(false)
    expect(isFatalSlackAuthError(null)).toBe(false)
    expect(isFatalSlackAuthError("invalid_auth")).toBe(false)
  })
})

describe("attachFatalAuthGuard", () => {
  function makeApp(): { app: App; trigger: (err: unknown) => Promise<void> } {
    let handler: ((err: unknown) => Promise<void>) | undefined
    const app = {
      error(h: (err: unknown) => Promise<void>) {
        handler = h
      },
    } as unknown as App
    return {
      app,
      trigger: async (err) => {
        if (!handler) throw new Error("no handler attached")
        await handler(err)
      },
    }
  }

  it("fires onFatal exactly once for the first fatal error", async () => {
    const { app, trigger } = makeApp()
    let fatals = 0
    attachFatalAuthGuard(app, { onFatal: () => void fatals++ })
    await trigger({ data: { error: "invalid_auth" } })
    await trigger({ data: { error: "invalid_auth" } }) // second fatal
    expect(fatals).toBe(1)
  })

  it("rethrows non-fatal errors so Bolt's default logging kicks in", async () => {
    const { app, trigger } = makeApp()
    attachFatalAuthGuard(app, { onFatal: () => {} })
    await expect(
      trigger({ data: { error: "rate_limited" }, message: "rate limited" }),
    ).rejects.toBeDefined()
  })

  it("swallows a throwing onFatal without breaking the handler", async () => {
    const { app, trigger } = makeApp()
    attachFatalAuthGuard(app, {
      onFatal: () => {
        throw new Error("supervisor down")
      },
    })
    // Should not throw — the guard logs + continues.
    await trigger({ data: { error: "token_revoked" } })
  })
})
