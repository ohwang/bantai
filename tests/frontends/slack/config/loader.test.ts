import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadSlackConfig } from "../../../../src/frontends/slack/config/loader"
import { resolveSecret } from "../../../../src/frontends/slack/config/schema"

describe("loadSlackConfig — inline", () => {
  it("parses a minimal workspace config and fills defaults", async () => {
    const resolved = await loadSlackConfig({
      inline: {
        workspace: {
          mode: "socket",
          bot_token: "xoxb-test",
          app_token: "xapp-test",
        },
      },
      env: {},
    })
    expect(resolved.workspace.mode).toBe("socket")
    expect(resolved.workspace.botToken).toBe("xoxb-test")
    expect(resolved.workspace.appToken).toBe("xapp-test")
    expect(resolved.workspace.webhookPath).toBe("/slack/events")
    expect(resolved.defaults.backend).toBe("claude")
    expect(resolved.defaults.require_mention).toBe(true)
    expect(resolved.defaults.verbosity).toBe("normal")
    expect(resolved.channels).toEqual([])
    expect(resolved.source).toBe("<inline>")
  })

  it("resolves { env: 'VAR' } indirections", async () => {
    const resolved = await loadSlackConfig({
      inline: {
        workspace: {
          mode: "socket",
          bot_token: { env: "SLACK_TEST_BOT" },
          app_token: { env: "SLACK_TEST_APP" },
        },
      },
      env: { SLACK_TEST_BOT: "xoxb-from-env", SLACK_TEST_APP: "xapp-from-env" },
    })
    expect(resolved.workspace.botToken).toBe("xoxb-from-env")
    expect(resolved.workspace.appToken).toBe("xapp-from-env")
  })

  it("leaves the resolved token undefined when env var is missing", async () => {
    const resolved = await loadSlackConfig({
      inline: {
        workspace: {
          mode: "socket",
          bot_token: { env: "SLACK_NOT_SET" },
        },
      },
      env: {},
    })
    expect(resolved.workspace.botToken).toBeUndefined()
  })

  it("rejects invalid config shape with a useful error", async () => {
    const bad = {
      workspace: { mode: "bogus-mode" },
    }
    await expect(loadSlackConfig({ inline: bad, env: {} })).rejects.toThrow(
      /Invalid slack config/,
    )
  })

  it("rejects unknown top-level keys (strict mode)", async () => {
    const bad = {
      workspace: { mode: "socket" },
      unknown: true,
    }
    await expect(loadSlackConfig({ inline: bad, env: {} })).rejects.toThrow(
      /unrecognized|Unrecognized|Invalid/,
    )
  })
})

describe("loadSlackConfig — filesystem", () => {
  it("loads from <cwd>/.bantai/slack.json when present (with JSONC comments + trailing commas)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bantai-slack-cfg-"))
    const cfgDir = path.join(dir, ".bantai")
    await mkdir(cfgDir, { recursive: true })
    const cfgPath = path.join(cfgDir, "slack.json")
    await writeFile(
      cfgPath,
      [
        "// bantai slack config — JSONC (JSON + comments + trailing commas).",
        "{",
        '  "workspace": {',
        '    "mode": "socket",',
        '    "bot_token": "xoxb-file",',
        '    "app_token": "xapp-file", // trailing comma tolerated',
        "  },",
        "  /* block comments work too */",
        '  "defaults": {',
        '    "verbosity": "verbose",',
        '    "trigger_name": "jarvis",',
        "  },",
        "}",
        "",
      ].join("\n"),
      "utf8",
    )
    const resolved = await loadSlackConfig({ cwd: dir, env: {} })
    expect(resolved.workspace.botToken).toBe("xoxb-file")
    expect(resolved.defaults.verbosity).toBe("verbose")
    expect(resolved.defaults.trigger_name).toBe("jarvis")
    expect(resolved.source).toBe(cfgPath)
  })

  it("surfaces JSONC syntax errors with file + line info", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bantai-slack-cfg-"))
    const cfgDir = path.join(dir, ".bantai")
    await mkdir(cfgDir, { recursive: true })
    const cfgPath = path.join(cfgDir, "slack.json")
    // Missing closing brace — guaranteed parse error.
    await writeFile(cfgPath, '{ "workspace": { "mode": "socket" ', "utf8")
    await expect(
      loadSlackConfig({ cwd: dir, env: {} }),
    ).rejects.toThrow(/Invalid JSONC in slack config/)
  })

  it("throws when no slack.json is found anywhere", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bantai-slack-cfg-"))
    await expect(
      loadSlackConfig({ cwd: dir, env: { HOME: dir } }),
    ).rejects.toThrow(/slack\.json not found/)
  })
})

describe("resolveSecret", () => {
  it("passes through literal strings", () => {
    expect(resolveSecret("xoxb-literal", {})).toBe("xoxb-literal")
  })
  it("resolves env indirection", () => {
    expect(resolveSecret({ env: "FOO" }, { FOO: "bar" })).toBe("bar")
  })
  it("returns undefined for undefined input", () => {
    expect(resolveSecret(undefined, {})).toBeUndefined()
  })
  it("returns undefined for empty env var", () => {
    expect(resolveSecret({ env: "FOO" }, { FOO: "" })).toBeUndefined()
  })
})
