import { describe, expect, it } from "bun:test"
import { Command } from "commander"
import { addGlobalOptions, addTuiOptions, resolveFlags } from "../../src/cli/options"

/**
 * Tests for the run/sub-command option wiring in program.ts.
 *
 * These don't boot the real launchers — they reproduce the same option
 * setup (addGlobalOptions + addTuiOptions on both the program and the
 * subcommand) and assert that values typed AFTER the subcommand survive
 * intact. The bug they guard against:
 *
 *   `bantai run --backend acp --acp-command gemini --acp-args --acp ...`
 *
 * Commander binds those options to the parent program because the parent
 * also defines them, so `runCmd.opts()` only returns the empty-array
 * default for `--acp-args`. A naive `{ ...program.opts(), ...runCmd.opts() }`
 * spread therefore wipes the actually-parsed value back to []. The fix
 * is to read merged opts via `cmd.optsWithGlobals()`.
 */
describe("program subcommand option merging", () => {
  type Capture = { messageParts: string[]; opts: Record<string, unknown> }

  function buildHarness(): {
    program: Command
    runCmd: Command
    captured: Capture | null
  } {
    const program = new Command()
    program.argument("[prompt]")
    addGlobalOptions(program)
    addTuiOptions(program)
    program.action(() => {})

    const runCmd = new Command("run").argument("<message...>")
    addGlobalOptions(runCmd)
    addTuiOptions(runCmd)

    const harness: { program: Command; runCmd: Command; captured: Capture | null } = {
      program,
      runCmd,
      captured: null,
    }
    runCmd.action(((messageParts: string[], _opts: unknown, cmd: Command) => {
      harness.captured = {
        messageParts,
        opts: cmd.optsWithGlobals() as Record<string, unknown>,
      }
    }) as never)
    program.addCommand(runCmd)
    return harness
  }

  it("preserves --acp-args when typed after the run subcommand", async () => {
    const harness = buildHarness()
    await harness.program.parseAsync([
      "node",
      "bantai",
      "run",
      "--backend",
      "acp",
      "--acp-command",
      "gemini",
      "--acp-args",
      "--acp",
      "test message",
    ])

    expect(harness.captured).not.toBeNull()
    const opts = harness.captured!.opts
    expect(opts.acpArgs).toEqual(["--acp"])
    expect(opts.acpCommand).toBe("gemini")
    expect(opts.backend).toBe("acp")

    const flags = resolveFlags(opts)
    expect(flags.acpArgs).toEqual(["--acp"])
    expect(flags.acpCommand).toBe("gemini")
    expect(flags.backend).toBe("acp")
  })

  it("preserves repeated --acp-args entries", async () => {
    const harness = buildHarness()
    await harness.program.parseAsync([
      "node",
      "bantai",
      "run",
      "--backend",
      "acp",
      "--acp-command",
      "my-agent",
      "--acp-args",
      "--flag-a",
      "--acp-args",
      "value-b",
      "test",
    ])

    expect(harness.captured!.opts.acpArgs).toEqual(["--flag-a", "value-b"])
  })
})
