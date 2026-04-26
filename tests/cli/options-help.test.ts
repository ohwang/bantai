import { describe, expect, it } from "bun:test"
import { Command } from "commander"
import { addTuiOptions } from "../../src/cli/options"
import { listThemes } from "../../src/frontends/tui/theme/registry"
import { listStatusBars } from "../../src/frontends/tui/status-bar/registry"

/**
 * L4 regression tests — `bantai --help` used to advertise a hand-typed list
 * of themes and status bar presets that drifted from the registries:
 *
 *   - `--theme solarized` was the old (broken) id; the registry exposes
 *     `solarized-dark`. So `--help` told users to type a value the
 *     resolver would soft-fall-back to default.
 *   - `--theme` help string omitted `snazzy`.
 *   - `--status-bar` help string omitted `claude-compat` (which is in
 *     fact the DEFAULT_STATUS_BAR_ID — invisible from the help).
 *
 * Fix: build the comma list at call site from the registry's list helpers.
 *
 * These tests are anchored on the registry, not on a copy of the strings,
 * so adding/removing a preset automatically passes the assertion.
 */

function captureHelp(): string {
  const cmd = new Command()
  addTuiOptions(cmd)
  return cmd.helpInformation()
}

describe("CLI --help drift contract (L4)", () => {
  it("--theme help advertises every registered theme id", () => {
    const help = captureHelp()
    for (const t of listThemes()) {
      expect(help).toContain(t.id)
    }
  })

  it("--theme help no longer advertises the removed `solarized` id", () => {
    const help = captureHelp()
    // The registry exposes `solarized-dark`, never bare `solarized`. A
    // word-boundary regex ensures we don't false-positive on the longer id.
    const ids = listThemes().map((t) => t.id)
    expect(ids).not.toContain("solarized")
    // The help line says "Theme preset (..., solarized-dark, ...)". Make
    // sure we're not advertising bare "solarized" in the comma list.
    expect(help).toMatch(/solarized-dark/)
    // No bare-word "solarized" appears outside of "solarized-dark".
    expect(help.replace(/solarized-dark/g, "")).not.toMatch(/\bsolarized\b/)
  })

  it("--theme help includes the snazzy preset", () => {
    const ids = listThemes().map((t) => t.id)
    expect(ids).toContain("snazzy")
    expect(captureHelp()).toContain("snazzy")
  })

  it("--status-bar help advertises every registered preset id", () => {
    const help = captureHelp()
    for (const p of listStatusBars()) {
      expect(help).toContain(p.id)
    }
  })

  it("--status-bar help includes claude-compat (the default preset)", () => {
    const ids = listStatusBars().map((p) => p.id)
    expect(ids).toContain("claude-compat")
    expect(captureHelp()).toContain("claude-compat")
  })

  it("--permission-mode help lists every registered mode", () => {
    const help = captureHelp()
    for (const id of [
      "default",
      "acceptEdits",
      "bypassPermissions",
      "plan",
      "dontAsk",
      "auto",
    ]) {
      expect(help).toContain(id)
    }
  })
})
