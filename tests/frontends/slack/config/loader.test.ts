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

describe("loadSlackConfig — defaults.system_prompt array form", () => {
  it("accepts a plain string (backwards compatible)", async () => {
    const resolved = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        defaults: { system_prompt: "single-line prompt" },
      },
      env: {},
    })
    expect(resolved.defaults.system_prompt).toBe("single-line prompt")
  })

  it("joins an array of strings with blank-line separators", async () => {
    const resolved = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        defaults: {
          system_prompt: [
            "First paragraph about Slack context.",
            "Second paragraph about concision.",
            "Third paragraph about tool use.",
          ],
        },
      },
      env: {},
    })
    expect(resolved.defaults.system_prompt).toBe(
      "First paragraph about Slack context.\n\n" +
        "Second paragraph about concision.\n\n" +
        "Third paragraph about tool use.",
    )
  })

  it("single-element array behaves like a plain string", async () => {
    const resolved = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        defaults: { system_prompt: ["only-entry"] },
      },
      env: {},
    })
    expect(resolved.defaults.system_prompt).toBe("only-entry")
  })

  it("empty array normalises to undefined (no prompt set)", async () => {
    const resolved = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        defaults: { system_prompt: [] },
      },
      env: {},
    })
    expect(resolved.defaults.system_prompt).toBeUndefined()
  })

  it("array of only empty strings normalises to undefined", async () => {
    const resolved = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        defaults: { system_prompt: ["", ""] },
      },
      env: {},
    })
    expect(resolved.defaults.system_prompt).toBeUndefined()
  })

  it("array entries that are empty strings are skipped", async () => {
    const resolved = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        defaults: { system_prompt: ["first", "", "third"] },
      },
      env: {},
    })
    expect(resolved.defaults.system_prompt).toBe("first\n\nthird")
  })

  it("rejects non-string array entries", async () => {
    await expect(
      loadSlackConfig({
        inline: {
          workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
          defaults: { system_prompt: ["ok", 42] },
        },
        env: {},
      }),
    ).rejects.toThrow(/Invalid slack config/)
  })
})

describe("loadSlackConfig — defaults.system_prompt_file", () => {
  it("reads the prompt from an absolute path (inline mode)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bantai-sp-file-"))
    const promptPath = path.join(dir, "system-prompt.md")
    await writeFile(promptPath, "prompt-from-file\n\nline two", "utf8")
    const resolved = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        defaults: { system_prompt_file: promptPath },
      },
      env: {},
    })
    expect(resolved.defaults.system_prompt).toBe("prompt-from-file\n\nline two")
  })

  it("resolves a relative path against the config file directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bantai-sp-file-"))
    const cfgDir = path.join(dir, ".bantai")
    await mkdir(cfgDir, { recursive: true })
    // Prompt lives alongside the config file.
    await writeFile(path.join(cfgDir, "prompt.md"), "hello from sibling", "utf8")
    await writeFile(
      path.join(cfgDir, "slack.json"),
      JSON.stringify({
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        defaults: { system_prompt_file: "./prompt.md" },
      }),
      "utf8",
    )
    const resolved = await loadSlackConfig({ cwd: dir, env: {} })
    expect(resolved.defaults.system_prompt).toBe("hello from sibling")
  })

  it("expands ~ against HOME", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "bantai-sp-home-"))
    await writeFile(path.join(home, "prompt.md"), "tilde-resolved", "utf8")
    const resolved = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        defaults: { system_prompt_file: "~/prompt.md" },
      },
      env: { HOME: home },
    })
    expect(resolved.defaults.system_prompt).toBe("tilde-resolved")
  })

  it("rejects a relative path under inline mode (no config dir)", async () => {
    await expect(
      loadSlackConfig({
        inline: {
          workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
          defaults: { system_prompt_file: "./prompts/base.md" },
        },
        env: {},
      }),
    ).rejects.toThrow(/relative.*inline configs have no config-file directory/s)
  })

  it("rejects when system_prompt and system_prompt_file are both set", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bantai-sp-file-"))
    const promptPath = path.join(dir, "p.md")
    await writeFile(promptPath, "x", "utf8")
    await expect(
      loadSlackConfig({
        inline: {
          workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
          defaults: {
            system_prompt: "inline",
            system_prompt_file: promptPath,
          },
        },
        env: {},
      }),
    ).rejects.toThrow(/mutually exclusive/)
  })

  it("errors with the attempted path when the file is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bantai-sp-file-"))
    const missing = path.join(dir, "nope.md")
    await expect(
      loadSlackConfig({
        inline: {
          workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
          defaults: { system_prompt_file: missing },
        },
        env: {},
      }),
    ).rejects.toThrow(new RegExp(`failed to read .*${missing.replace(/[.]/g, "\\.")}`))
  })

  it("flows the file contents into resolveProjectForChannel", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bantai-sp-file-"))
    const promptPath = path.join(dir, "p.md")
    await writeFile(promptPath, "base-from-file", "utf8")
    const { resolveProjectForChannel } = await import(
      "../../../../src/frontends/slack/router/resolver"
    )
    const cfg = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        defaults: { system_prompt_file: promptPath },
        channels: [{ id: "C0FILE", system_prompt_append: "channel-extra" }],
      },
      env: {},
    })
    const proj = resolveProjectForChannel(cfg, "C0FILE", { launchCwd: "/cwd" })
    expect(proj.systemPrompt).toBe("base-from-file\n\nchannel-extra")
  })
})

describe("loadSlackConfig — channels[].project_dir path resolution", () => {
  it("resolves a relative project_dir against the config file directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bantai-proj-dir-"))
    const cfgDir = path.join(dir, ".bantai")
    await mkdir(cfgDir, { recursive: true })
    await writeFile(
      path.join(cfgDir, "slack.json"),
      JSON.stringify({
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        channels: [
          { id: "C_SIBLING", project_dir: "./sibling" },
          { id: "C_PARENT", project_dir: "../peer" },
          { id: "C_SELF", project_dir: "." },
        ],
      }),
      "utf8",
    )
    const resolved = await loadSlackConfig({ cwd: dir, env: {} })
    expect(resolved.channels[0]!.project_dir).toBe(path.join(cfgDir, "sibling"))
    expect(resolved.channels[1]!.project_dir).toBe(path.join(dir, "peer"))
    expect(resolved.channels[2]!.project_dir).toBe(cfgDir)
  })

  it("leaves absolute project_dir untouched", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bantai-proj-dir-"))
    const cfgDir = path.join(dir, ".bantai")
    await mkdir(cfgDir, { recursive: true })
    await writeFile(
      path.join(cfgDir, "slack.json"),
      JSON.stringify({
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        channels: [{ id: "C_ABS", project_dir: "/tmp/abs-project" }],
      }),
      "utf8",
    )
    const resolved = await loadSlackConfig({ cwd: dir, env: {} })
    expect(resolved.channels[0]!.project_dir).toBe("/tmp/abs-project")
  })

  it("expands ~ in project_dir against HOME", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "bantai-home-"))
    const resolved = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        channels: [{ id: "C_TILDE", project_dir: "~/work/repo" }],
      },
      env: { HOME: home },
    })
    expect(resolved.channels[0]!.project_dir).toBe(`${home}/work/repo`)
  })

  it("passes relative project_dir through unchanged for inline configs", async () => {
    const resolved = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        channels: [{ id: "C_INLINE", project_dir: "./rel" }],
      },
      env: {},
    })
    expect(resolved.channels[0]!.project_dir).toBe("./rel")
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

describe("loadSlackConfig — admin section", () => {
  it("fills admin defaults when the key is omitted (disabled + loopback)", async () => {
    const resolved = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      },
      env: {},
    })
    expect(resolved.admin.enabled).toBe(false)
    expect(resolved.admin.host).toBe("127.0.0.1")
    expect(resolved.admin.port).toBe(4242)
    expect(resolved.admin.readOnly).toBe(false)
    expect(resolved.admin.sessionRingSize).toBe(200)
    // Default token_path is tilde-expanded against HOME when present; with an
    // empty env the leading `~` may survive — we don't assert the literal value
    // here, just that the path is a string and non-empty.
    expect(typeof resolved.admin.tokenPath).toBe("string")
    expect(resolved.admin.tokenPath.length).toBeGreaterThan(0)
  })

  it("expands ~ in admin.token_path against HOME", async () => {
    const resolved = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        admin: { enabled: true, token_path: "~/admin-token" },
      },
      env: { HOME: "/home/op" },
    })
    expect(resolved.admin.enabled).toBe(true)
    expect(resolved.admin.tokenPath).toBe("/home/op/admin-token")
  })

  it("accepts enabled + host override + ring size override", async () => {
    const resolved = await loadSlackConfig({
      inline: {
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        admin: {
          enabled: true,
          host: "0.0.0.0",
          port: 5151,
          read_only: true,
          session_ring_size: 1000,
        },
      },
      env: { HOME: "/home/op" },
    })
    expect(resolved.admin.enabled).toBe(true)
    expect(resolved.admin.host).toBe("0.0.0.0")
    expect(resolved.admin.port).toBe(5151)
    expect(resolved.admin.readOnly).toBe(true)
    expect(resolved.admin.sessionRingSize).toBe(1000)
  })

  it("rejects out-of-range port", async () => {
    await expect(
      loadSlackConfig({
        inline: {
          workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
          admin: { port: 70000 },
        },
        env: {},
      }),
    ).rejects.toThrow(/Invalid slack config/)
  })

  it("rejects unknown keys inside admin (strict)", async () => {
    await expect(
      loadSlackConfig({
        inline: {
          workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
          admin: { enabled: true, extra_key: "nope" },
        },
        env: {},
      }),
    ).rejects.toThrow(/unrecognized|Unrecognized|Invalid/)
  })

  it("rejects out-of-range session_ring_size", async () => {
    await expect(
      loadSlackConfig({
        inline: {
          workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
          admin: { session_ring_size: 5 },
        },
        env: {},
      }),
    ).rejects.toThrow(/Invalid slack config/)
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
