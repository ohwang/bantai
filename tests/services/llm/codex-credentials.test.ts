import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"

import {
  assertCodexTokenFresh,
  codexAuthPath,
  readCodexAuth,
} from "../../../src/services/llm/codex-credentials"
import { LlmAuthError } from "../../../src/services/llm/types"

/**
 * Filesystem fixture pattern mirrors tests/config/settings.test.ts — we
 * spin up a fake $HOME under tmpdir so the real ~/.codex is never touched.
 */
function makeTmpHome() {
  const home = path.join(
    os.tmpdir(),
    `bantai-codexauth-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  mkdirSync(home, { recursive: true })
  return home
}

function writeAuthJson(home: string, body: unknown) {
  const dir = path.join(home, ".codex")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify(body, null, 2), "utf-8")
}

/**
 * Build a fake JWT with arbitrary payload claims. Signature segment is left
 * as the literal "sig" — these tests never validate signatures, only decode
 * the payload.
 */
function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${header}.${payload}.sig`
}

let savedHome: string | undefined
let tmpHome: string

beforeEach(() => {
  savedHome = process.env.HOME
  tmpHome = makeTmpHome()
  process.env.HOME = tmpHome
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe("codexAuthPath", () => {
  it("uses $HOME by default", () => {
    expect(codexAuthPath()).toBe(path.join(tmpHome, ".codex", "auth.json"))
  })

  it("honors an explicit override", () => {
    expect(codexAuthPath("/elsewhere")).toBe(path.join("/elsewhere", ".codex", "auth.json"))
  })
})

describe("readCodexAuth", () => {
  it("throws LlmAuthError with file path when missing", async () => {
    let caught: unknown
    try {
      await readCodexAuth()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(LlmAuthError)
    expect((caught as Error).message).toContain(path.join(tmpHome, ".codex", "auth.json"))
    expect((caught as Error).message).toContain("codex login")
  })

  it("throws on invalid JSON", async () => {
    const dir = path.join(tmpHome, ".codex")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "auth.json"), "{not json", "utf-8")
    let caught: unknown
    try {
      await readCodexAuth()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(LlmAuthError)
    expect((caught as Error).message).toContain("not valid JSON")
  })

  it("parses ChatGPT mode and decodes the JWT exp", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const access = fakeJwt({ exp, sub: "user-x" })
    writeAuthJson(tmpHome, {
      auth_mode: "ChatGPT",
      last_refresh: "2026-04-24T15:40:33.786346Z",
      tokens: {
        access_token: access,
        refresh_token: "rt-x",
        id_token: fakeJwt({ email: "x@example.com" }),
        account_id: "acct-1",
      },
    })

    const creds = await readCodexAuth()
    expect(creds.authMode).toBe("ChatGPT")
    expect(creds.oauth?.accessToken).toBe(access)
    expect(creds.oauth?.accountId).toBe("acct-1")
    expect(creds.oauth?.accessTokenExpiresAt).toBe(exp)
    expect(creds.lastRefresh).toBe("2026-04-24T15:40:33.786346Z")
  })

  it("parses ApiKey mode", async () => {
    writeAuthJson(tmpHome, {
      OPENAI_API_KEY: "sk-test-123",
      auth_mode: "ApiKey",
      tokens: { access_token: "ignored" },
    })

    const creds = await readCodexAuth()
    expect(creds.authMode).toBe("ApiKey")
    expect(creds.apiKey).toBe("sk-test-123")
    expect(creds.oauth).toBeUndefined()
  })

  it("rejects ApiKey mode missing the key", async () => {
    writeAuthJson(tmpHome, { auth_mode: "ApiKey" })
    let caught: unknown
    try {
      await readCodexAuth()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(LlmAuthError)
    expect((caught as Error).message).toContain("ApiKey mode")
  })

  it("rejects ChatGPT mode without an access_token", async () => {
    writeAuthJson(tmpHome, {
      auth_mode: "ChatGPT",
      tokens: { refresh_token: "rt-x" },
    })
    let caught: unknown
    try {
      await readCodexAuth()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(LlmAuthError)
    expect((caught as Error).message).toContain("access_token")
  })
})

describe("assertCodexTokenFresh", () => {
  it("passes when the JWT exp is in the future", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    expect(() =>
      assertCodexTokenFresh({
        path: "fake",
        authMode: "ChatGPT",
        oauth: { accessToken: fakeJwt({ exp }), accessTokenExpiresAt: exp },
      }),
    ).not.toThrow()
  })

  it("throws LlmAuthError when the JWT has expired", () => {
    const exp = Math.floor(Date.now() / 1000) - 60
    expect(() =>
      assertCodexTokenFresh({
        path: "fake",
        authMode: "ChatGPT",
        oauth: { accessToken: fakeJwt({ exp }), accessTokenExpiresAt: exp },
      }),
    ).toThrow(LlmAuthError)
  })

  it("is a no-op for ApiKey mode", () => {
    expect(() =>
      assertCodexTokenFresh({ path: "fake", authMode: "ApiKey", apiKey: "sk-x" }),
    ).not.toThrow()
  })

  it("is a no-op when exp can't be decoded (server is the arbiter)", () => {
    expect(() =>
      assertCodexTokenFresh({
        path: "fake",
        authMode: "ChatGPT",
        oauth: { accessToken: "not-a-jwt" },
      }),
    ).not.toThrow()
  })
})
