import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadOrGenerateAdminToken } from "../../../../src/frontends/slack/admin/token"

describe("loadOrGenerateAdminToken", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  function mkTmp(): string {
    const d = mkdtempSync(join(tmpdir(), "bantai-admin-token-"))
    dirs.push(d)
    return d
  }

  it("generates a fresh token at a non-existent path with mode 0600", () => {
    const d = mkTmp()
    const p = join(d, "nested", "admin-token")
    const r = loadOrGenerateAdminToken(p)
    expect(r.generated).toBe(true)
    expect(r.path).toBe(p)
    expect(r.token.length).toBeGreaterThanOrEqual(40)
    const disk = readFileSync(p, "utf8")
    expect(disk).toBe(r.token)
    const mode = statSync(p).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it("reads an existing non-empty token, trimming whitespace", () => {
    const d = mkTmp()
    const p = join(d, "t")
    writeFileSync(p, "  xyz-secret-value\n", { encoding: "utf8", mode: 0o600 })
    const r = loadOrGenerateAdminToken(p)
    expect(r.generated).toBe(false)
    expect(r.token).toBe("xyz-secret-value")
  })

  it("regenerates when the file exists but is blank", () => {
    const d = mkTmp()
    const p = join(d, "t")
    writeFileSync(p, "   \n\n", { encoding: "utf8", mode: 0o600 })
    const r = loadOrGenerateAdminToken(p)
    expect(r.generated).toBe(true)
    expect(r.token.length).toBeGreaterThanOrEqual(40)
    expect(readFileSync(p, "utf8")).toBe(r.token)
  })

  it("throws with a useful message when the path is empty", () => {
    expect(() => loadOrGenerateAdminToken("")).toThrow(/tokenPath/)
  })
})
