import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadSlackConfig } from "../../../../src/frontends/slack/config/loader"
import type { ResolvedSlackConfig } from "../../../../src/frontends/slack/config/schema"
import {
  createConfigReloader,
  diffConfigs,
  formatDiffSummary,
  formatRejectionSummary,
  restartRequiredFieldsFromDiff,
} from "../../../../src/frontends/slack/config/reloader"

async function buildResolved(inline: unknown): Promise<ResolvedSlackConfig> {
  return loadSlackConfig({ inline, env: {} })
}

/**
 * Wait until `predicate` returns a truthy value or `timeoutMs` elapses. Used
 * to give the real fs.watch event loop a beat without sleeping for a fixed
 * duration that inflates test wall-clock.
 */
async function waitUntil<T>(
  predicate: () => T | undefined,
  timeoutMs = 4000,
  step = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = predicate()
    if (v) return v
    await new Promise((r) => setTimeout(r, step))
  }
  const last = predicate()
  if (last) return last
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
}

describe("diffConfigs", () => {
  it("returns empty=true when configs match", async () => {
    const a = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
    })
    const b = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
    })
    const d = diffConfigs(a, b)
    expect(d.empty).toBe(true)
    expect(restartRequiredFieldsFromDiff(d)).toEqual([])
  })

  it("detects added and removed channels", async () => {
    const a = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      channels: [{ id: "C1", name: "alpha" }],
    })
    const b = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      channels: [
        { id: "C1", name: "alpha" },
        { id: "C2", name: "beta", project_dir: "/tmp/beta" },
      ],
    })
    const d = diffConfigs(a, b)
    expect(d.channels.added).toEqual(["C2"])
    expect(d.channels.removed).toEqual([])
    expect(d.empty).toBe(false)

    const dRev = diffConfigs(b, a)
    expect(dRev.channels.added).toEqual([])
    expect(dRev.channels.removed).toEqual(["C2"])
  })

  it("distinguishes rename (name-only) from body change", async () => {
    const a = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      channels: [{ id: "C1", name: "old-name", project_dir: "/tmp/x" }],
    })
    const b = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      channels: [{ id: "C1", name: "new-name", project_dir: "/tmp/x" }],
    })
    const d = diffConfigs(a, b)
    expect(d.channels.renamed).toEqual(["C1"])
    expect(d.channels.changed).toEqual([])
  })

  it("detects changed channel body (project_dir edit)", async () => {
    const a = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      channels: [{ id: "C1", name: "a", project_dir: "/tmp/x" }],
    })
    const b = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      channels: [{ id: "C1", name: "a", project_dir: "/tmp/y" }],
    })
    const d = diffConfigs(a, b)
    expect(d.channels.changed).toEqual(["C1"])
    expect(d.channels.renamed).toEqual([])
  })

  it("flags workspace + store_path changes as restart-required", async () => {
    const a = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      store_path: "/tmp/a.db",
    })
    const b = await buildResolved({
      workspace: {
        mode: "socket",
        bot_token: "xoxb-rotated",
        app_token: "xapp",
        port: 5555,
      },
      store_path: "/tmp/b.db",
    })
    const d = diffConfigs(a, b)
    const restart = restartRequiredFieldsFromDiff(d)
    expect(restart).toContain("workspace.bot_token")
    expect(restart).toContain("workspace.port")
    expect(restart).toContain("store_path")
    expect(d.storeChanged).toBe(true)
  })

  it("detects defaults field changes with dotted paths", async () => {
    const a = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      defaults: { verbosity: "normal" },
    })
    const b = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      defaults: { verbosity: "concise", trigger_name: "jarvis" },
    })
    const d = diffConfigs(a, b)
    expect(d.defaultsChanged).toContain("defaults.verbosity")
    expect(d.defaultsChanged).toContain("defaults.trigger_name")
  })

  it("detects mcp_servers registry changes", async () => {
    const a = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      mcp_servers: { git: { command: "bun", args: ["run", "git"] } },
    })
    const b = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      mcp_servers: {
        git: { command: "bun", args: ["run", "git-v2"] },
        brave: { command: "brave" },
      },
    })
    const d = diffConfigs(a, b)
    expect(d.mcpServers.added).toEqual(["brave"])
    expect(d.mcpServers.changed).toEqual(["git"])
  })
})

describe("formatDiffSummary", () => {
  it("renders channel adds + removes with friendly labels", async () => {
    const a = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      channels: [{ id: "C_OLD", name: "old-proj" }],
    })
    const b = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      channels: [{ id: "C_NEW", name: "new-proj", project_dir: "/tmp/new" }],
    })
    const diff = diffConfigs(a, b)
    const rendered = formatDiffSummary(diff, {
      source: "/etc/slack.json",
      mrkdwn: true,
      next: b,
      previous: a,
      restartRequired: restartRequiredFieldsFromDiff(diff),
    })
    expect(rendered).toContain("+1 channel: #new-proj")
    expect(rendered).toContain("/tmp/new")
    expect(rendered).toContain("-1 channel: #old-proj (C_OLD)")
  })

  it("calls out restart-required fields", async () => {
    const a = await buildResolved({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
    })
    const b = await buildResolved({
      workspace: {
        mode: "socket",
        bot_token: "xoxb-rotated",
        app_token: "xapp",
      },
    })
    const diff = diffConfigs(a, b)
    const rendered = formatDiffSummary(diff, {
      source: "slack.json",
      next: b,
      previous: a,
      restartRequired: restartRequiredFieldsFromDiff(diff),
    })
    expect(rendered).toContain("restart required")
    expect(rendered).toContain("workspace.bot_token")
  })
})

describe("formatRejectionSummary", () => {
  it("renders a rejection header with errors", () => {
    const rendered = formatRejectionSummary(
      ["channels[0].backend: expected claude|codex|…"],
      { source: "slack.json", mrkdwn: true },
    )
    expect(rendered).toContain("config reload rejected")
    expect(rendered).toContain("expected claude|codex")
  })
})

describe("createConfigReloader — filesystem watcher", () => {
  async function setupTmp(body: string): Promise<{ dir: string; cfgPath: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), "bantai-reload-"))
    const cfgPath = path.join(dir, "slack.json")
    await writeFile(cfgPath, body, "utf8")
    return { dir, cfgPath }
  }

  it("applies changes made to the watched file", async () => {
    const initialBody = JSON.stringify({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      channels: [],
    })
    const { dir, cfgPath } = await setupTmp(initialBody)
    try {
      const initial = await loadSlackConfig({ path: cfgPath, env: {} })
      const reloader = createConfigReloader({
        path: cfgPath,
        initial,
        env: {},
        debounceMs: 50,
        pollIntervalMs: 0,
      })
      const events: Array<{ added: string[] }> = []
      reloader.onApplied((e) => {
        events.push({ added: e.diff.channels.added })
      })

      await new Promise((r) => setTimeout(r, 60))

      const nextBody = JSON.stringify({
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        channels: [{ id: "C_NEW", name: "fresh", project_dir: "/tmp/fresh" }],
      })
      await writeFile(cfgPath, nextBody, "utf8")

      const applied = await waitUntil(() => (events.length > 0 ? events : undefined))
      expect(applied[0]!.added).toEqual(["C_NEW"])
      expect(reloader.current().channels.length).toBe(1)

      reloader.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects invalid edits without breaking current config", async () => {
    const initialBody = JSON.stringify({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      channels: [{ id: "C1", name: "alpha" }],
    })
    const { dir, cfgPath } = await setupTmp(initialBody)
    try {
      const initial = await loadSlackConfig({ path: cfgPath, env: {} })
      const reloader = createConfigReloader({
        path: cfgPath,
        initial,
        env: {},
        debounceMs: 50,
        pollIntervalMs: 0,
      })
      const rejects: string[][] = []
      reloader.onRejected((e) => rejects.push(e.errors))

      await new Promise((r) => setTimeout(r, 60))

      await writeFile(cfgPath, '{ "workspace": { "mode": "bogus"', "utf8")
      await waitUntil(() => (rejects.length > 0 ? rejects : undefined))

      // Current config still reflects the prior valid state.
      expect(reloader.current().channels).toHaveLength(1)
      expect(reloader.current().channels[0]!.id).toBe("C1")
      reloader.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("reloadNow bypasses the debouncer", async () => {
    const initialBody = JSON.stringify({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      channels: [],
    })
    const { dir, cfgPath } = await setupTmp(initialBody)
    try {
      const initial = await loadSlackConfig({ path: cfgPath, env: {} })
      const reloader = createConfigReloader({
        path: cfgPath,
        initial,
        env: {},
        debounceMs: 5000, // long — reloadNow should bypass this
        pollIntervalMs: 0,
      })
      // Give the initial hash read a beat so byte-identical short-circuit works.
      await new Promise((r) => setTimeout(r, 40))

      const nextBody = JSON.stringify({
        workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
        channels: [{ id: "C_NEW", name: "now" }],
      })
      await writeFile(cfgPath, nextBody, "utf8")

      const outcome = await reloader.reloadNow("manual")
      expect(outcome.kind).toBe("applied")
      if (outcome.kind === "applied") {
        expect(outcome.diff.channels.added).toEqual(["C_NEW"])
      }
      reloader.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("collapses byte-identical edits to noop", async () => {
    const body = JSON.stringify({
      workspace: { mode: "socket", bot_token: "xoxb", app_token: "xapp" },
      channels: [],
    })
    const { dir, cfgPath } = await setupTmp(body)
    try {
      const initial = await loadSlackConfig({ path: cfgPath, env: {} })
      const reloader = createConfigReloader({
        path: cfgPath,
        initial,
        env: {},
        debounceMs: 10,
        pollIntervalMs: 0,
      })
      await new Promise((r) => setTimeout(r, 50))

      const applied: number[] = []
      reloader.onApplied(() => applied.push(Date.now()))
      // Re-write the exact same bytes; watcher fires but content matches.
      await writeFile(cfgPath, body, "utf8")
      await new Promise((r) => setTimeout(r, 200))
      expect(applied).toHaveLength(0)
      reloader.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
