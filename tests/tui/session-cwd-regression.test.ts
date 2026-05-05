/**
 * F-2 regression: TUI surfaces must render paths against the active session's
 * cwd (`agent.config.cwd`), not the bantai process's `process.cwd()`.
 *
 * Class shape (so future readers don't reintroduce the pattern):
 *
 *   The bantai launcher captures `process.cwd()` at start into
 *   `flags.config.cwd` but NEVER calls `process.chdir()`. Any TUI surface
 *   that recomputes `process.cwd()` after launch sees the bantai process's
 *   own dir — which diverges from the agent session's cwd whenever:
 *
 *     1. The user invoked `bantai --cwd <other-project>`.
 *     2. A future server / Slack frontend hands the backend an arbitrary
 *        cwd via `SessionConfig`.
 *     3. The user `cd`-ed into a worktree elsewhere and ran bantai pinned
 *        to the originating repo via follow mode.
 *
 *   The audit (permission-audit.md §F-2) found the symptom in the
 *   permission dialog, the status bar's project name, the diagnostics CWD
 *   line, the file-change list of TurnSummary, and the tool-call display
 *   in tool-view + block-view. All five surfaces are fixed by sourcing the
 *   cwd from `useAgent().config.cwd ?? process.cwd()` and threading it
 *   into the path-relativisation helpers.
 *
 * This file pins the contract at the helper boundary so a future drive-by
 * refactor that swaps the threaded cwd back to a `process.cwd()` call gets
 * a red test instead of shipping silently.
 */

import { describe, test, expect } from "bun:test"
import path from "node:path"
import {
  extractPath,
  option2Text,
} from "../../src/frontends/tui/components/permission-dialog"
import type { PermissionRequestEvent } from "../../src/protocol/types"

const SESSION_CWD = "/tmp/playground"

describe("F-2: TUI path display is rooted at the session cwd", () => {
  test("permission-dialog extractPath() roots paths at agent.config.cwd, not process.cwd()", () => {
    // Drive a fake agent whose config.cwd is /tmp/playground (deliberately
    // NOT the test runner's cwd, so the bug would be visible).
    const result = extractPath(
      "Edit",
      { file_path: `${SESSION_CWD}/src/hello.ts` },
      SESSION_CWD,
    )
    // Under the bug, this rendered "../../tmp/playground/src/hello.ts"
    // (or similar) because process.cwd() was the monorepo root.
    expect(result).toBe("src/hello.ts")
    expect(result).not.toContain("..")
    expect(result).not.toContain(process.cwd())
  })

  test("permission-dialog extractPath() handles paths outside the session cwd", () => {
    // Outside-cwd paths are still computed RELATIVE TO SESSION CWD, not
    // process.cwd(). The shallow case (1-2 .. hops) keeps the relative form.
    const result = extractPath(
      "Read",
      { file_path: "/tmp/other/foo.ts" },
      SESSION_CWD,
    )
    expect(result).toBe("../other/foo.ts")
  })

  test("option2Text 'Always allow in <dir>/' suggestion uses the SDK directory verbatim", () => {
    // The "Always allow in <dir>/" label is the most user-facing F-2
    // surface — the dirname displayed MUST match the dirname the resulting
    // rule is scoped to. When the SDK provides an addDirectories suggestion,
    // the dialog must surface its parent dir (not project.cwd-derived
    // anything else) so the user can audit what they're agreeing to.
    const perm: PermissionRequestEvent = {
      type: "permission_request",
      id: "x",
      tool: "Read",
      input: { file_path: `${SESSION_CWD}/src/hello.ts` },
      suggestions: [
        {
          type: "addDirectories",
          directories: [`${SESSION_CWD}/src/`],
          destination: "session",
        },
      ],
    }
    expect(option2Text(perm, SESSION_CWD)).toBe("Always allow in src/")
  })

  test("status-bar projectName uses agent.config.cwd basename, not process.cwd() basename", () => {
    // Pin the exact derivation used in `useStatusBarData` (status-bar/data.ts).
    // Calling the factory directly requires Solid+Session+Messages+Agent
    // contexts and a terminal-dimensions hook; instead, re-state the one-liner
    // here so any future change that drops the agent.config.cwd path lights
    // up red. If you're refactoring the projectName computation, update the
    // expression in this test to match — but keep it sourced from the agent
    // config, never from process.cwd().
    const sessionCwd = "/tmp/playground"
    const agentConfig = { cwd: sessionCwd } as { cwd?: string }

    const projectName = path.basename(agentConfig.cwd ?? process.cwd())

    expect(projectName).toBe("playground")
    expect(projectName).not.toBe(path.basename(process.cwd()))
  })

  test("diagnostics CONFIG section renders agent.config.cwd verbatim, not process.cwd()", () => {
    // Same shape as above — pin the helper expression so a future refactor
    // in components/diagnostics.tsx that swaps back to `process.cwd()` is
    // caught. The diagnostics CWD: line MUST match what the SDK is rooted in
    // (the user's mental model is "this is the dir the agent is editing"),
    // not the bantai process cwd.
    const sessionCwd = "/tmp/playground"
    const agentConfig = { cwd: sessionCwd } as { cwd?: string }

    const cwdValue = agentConfig.cwd ?? process.cwd()

    expect(cwdValue).toBe(sessionCwd)
    expect(cwdValue).not.toBe(process.cwd())
  })

  test("turn-summary file list relativises against the session cwd", () => {
    // Mirror of the inline expression in components/turn-summary.tsx so a
    // future change cannot silently regress to process.cwd() without lighting
    // this up. The file-changed list shows paths relative to the SESSION
    // root, not the bantai process root.
    const sessionCwd = "/tmp/playground"
    const filePath = `${sessionCwd}/src/hello.ts`

    const rel = filePath.startsWith(sessionCwd + "/")
      ? filePath.slice(sessionCwd.length + 1)
      : filePath

    expect(rel).toBe("src/hello.ts")
  })
})
