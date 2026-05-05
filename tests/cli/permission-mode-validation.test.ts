import { describe, expect, it } from "bun:test"
import { Command, CommanderError } from "commander"
import { addTuiOptions } from "../../src/cli/options"
import {
  knownPermissionModeIds,
  listPermissionModesForCli,
} from "../../src/protocol/permission-modes"

/**
 * F-1 regression tests — `--permission-mode` used to silently accept any
 * string (e.g. `--permission-mode planm` mapped through to backend
 * default, then the SDK crashed downstream with no hint that the user
 * had typo'd a mode name). See `bantai-team/permission-audit.md` § F-1.
 *
 * Fix per the drift-contract recipe (CLAUDE.md § "The drift-contract
 * recipe"): wire `.choices(knownPermissionModeIds())` on the commander
 * option so the registry is the single source of truth for the help
 * string, the validator, and the error message.
 *
 * The same `addTuiOptions` is attached to the root program and to the
 * `bantai run` headless subcommand — so this validation also covers
 * `bantai run --permission-mode <bad>`.
 *
 * These tests anchor on the registry (`knownPermissionModeIds`), not on
 * a hard-coded copy of the modes — adding a new mode automatically
 * extends coverage.
 */

interface ParseResult {
  ok: boolean
  err?: CommanderError
  stderr: string
  stdout: string
  permissionMode?: unknown
}

/**
 * Parse argv against a commander program wired with addTuiOptions, with
 * stdout/stderr captured and process.exit suppressed via exitOverride().
 */
function parsePermissionMode(argv: string[]): ParseResult {
  const program = new Command()
  program.argument("[prompt]")
  let parsedOpts: Record<string, unknown> | undefined
  program.action((_prompt: string | undefined, _opts, cmd: Command) => {
    parsedOpts = cmd.opts() as Record<string, unknown>
  })
  addTuiOptions(program)

  let stdout = ""
  let stderr = ""
  program.exitOverride()
  program.configureOutput({
    writeOut: (s) => {
      stdout += s
    },
    writeErr: (s) => {
      stderr += s
    },
  })

  try {
    program.parse(["node", "bantai", ...argv], { from: "node" })
    return {
      ok: true,
      stderr,
      stdout,
      permissionMode: parsedOpts?.permissionMode,
    }
  } catch (err) {
    if (err instanceof CommanderError) {
      return { ok: false, err, stderr, stdout }
    }
    throw err
  }
}

describe("--permission-mode validation (F-1)", () => {
  // -----------------------------------------------------------------------
  // Accept path: every registered mode is honoured
  // -----------------------------------------------------------------------
  describe("accepts every registered mode", () => {
    for (const id of knownPermissionModeIds()) {
      it(`accepts --permission-mode ${id}`, () => {
        const result = parsePermissionMode(["--permission-mode", id])
        expect(result.ok).toBe(true)
        expect(result.permissionMode).toBe(id)
      })
    }
  })

  // -----------------------------------------------------------------------
  // Reject path: garbage strings fail with a non-zero exit code and an
  // error message that points at the registry-derived choice list.
  // -----------------------------------------------------------------------
  describe("rejects unknown values", () => {
    const garbage = [
      "planm", // typo of `plan` — the F-1 motivating example
      "LOW", // wrong case (modes are camelCase, no upper-case alias)
      "", // empty string
      "definitely-not-a-mode",
    ]

    for (const value of garbage) {
      it(`rejects --permission-mode ${JSON.stringify(value)}`, () => {
        const result = parsePermissionMode(["--permission-mode", value])
        expect(result.ok).toBe(false)
        expect(result.err).toBeDefined()
        // commander's invalidArgument carries a non-zero exit code.
        expect(result.err!.exitCode).not.toBe(0)
        expect(result.err!.code).toBe("commander.invalidArgument")

        // Error message must list the valid choices so the user knows
        // what to type. Anchored on the registry so adding a new mode
        // extends coverage automatically.
        for (const id of knownPermissionModeIds()) {
          expect(result.stderr).toContain(id)
        }
        // Sanity-check that the helper used in the help string still
        // produces a non-empty list of the same shape.
        expect(listPermissionModesForCli().length).toBeGreaterThan(0)
      })
    }
  })
})
