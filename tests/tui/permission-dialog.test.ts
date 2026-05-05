import { describe, it, expect } from "bun:test"
import {
  capContent,
  capLine,
  extractPreviewLines,
  extractPath,
  option2Text,
} from "../../src/frontends/tui/components/permission-dialog"
import type { PermissionRequestEvent } from "../../src/protocol/types"

// ---------------------------------------------------------------------------
// capContent
// ---------------------------------------------------------------------------

describe("capContent", () => {
  it("returns string unchanged when under 10K chars", () => {
    const s = "hello world"
    expect(capContent(s)).toBe(s)
  })

  it("truncates string over 10K chars to exactly 10K", () => {
    const s = "x".repeat(15_000)
    const result = capContent(s)
    expect(result.length).toBe(10_000)
    expect(result).toBe("x".repeat(10_000))
  })

  it("returns empty string unchanged", () => {
    expect(capContent("")).toBe("")
  })

  it("returns string of exactly 10K chars unchanged", () => {
    const s = "a".repeat(10_000)
    expect(capContent(s)).toBe(s)
    expect(capContent(s).length).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// capLine
// ---------------------------------------------------------------------------

describe("capLine", () => {
  it("returns line unchanged when under 200 chars", () => {
    const line = "short line"
    expect(capLine(line)).toBe(line)
  })

  it("truncates line over 200 chars to 197 + '...'", () => {
    const line = "z".repeat(300)
    const result = capLine(line)
    expect(result.length).toBe(200)
    expect(result).toBe("z".repeat(197) + "...")
  })

  it("returns line of exactly 200 chars unchanged", () => {
    const line = "b".repeat(200)
    expect(capLine(line)).toBe(line)
    expect(capLine(line).length).toBe(200)
  })

  it("returns empty string unchanged", () => {
    expect(capLine("")).toBe("")
  })

  it("truncates line of 201 chars", () => {
    const line = "c".repeat(201)
    const result = capLine(line)
    expect(result.length).toBe(200)
    expect(result.endsWith("...")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// extractPreviewLines
// ---------------------------------------------------------------------------

describe("extractPreviewLines", () => {
  describe("Write tool", () => {
    it("splits content into lines with '+' prefix", () => {
      const lines = extractPreviewLines("Write", {
        file_path: "/tmp/test.ts",
        content: "line1\nline2\nline3",
      })
      expect(lines).toEqual([
        { text: "line1", prefix: "+" },
        { text: "line2", prefix: "+" },
        { text: "line3", prefix: "+" },
      ])
    })

    it("returns null for empty/whitespace content", () => {
      expect(extractPreviewLines("Write", { content: "   " })).toBeNull()
      expect(extractPreviewLines("Write", { content: "" })).toBeNull()
    })

    it("returns null when content is not a string", () => {
      expect(extractPreviewLines("Write", { content: 42 })).toBeNull()
    })
  })

  describe("Edit tool", () => {
    it("shows old_string lines with '-' and new_string lines with '+'", () => {
      const lines = extractPreviewLines("Edit", {
        file_path: "/tmp/test.ts",
        old_string: "old line",
        new_string: "new line",
      })
      expect(lines).toEqual([
        { text: "old line", prefix: "-" },
        { text: "new line", prefix: "+" },
      ])
    })

    it("handles multi-line old and new strings", () => {
      const lines = extractPreviewLines("Edit", {
        old_string: "a\nb",
        new_string: "c\nd\ne",
      })
      expect(lines).toEqual([
        { text: "a", prefix: "-" },
        { text: "b", prefix: "-" },
        { text: "c", prefix: "+" },
        { text: "d", prefix: "+" },
        { text: "e", prefix: "+" },
      ])
    })

    it("returns null when both old_string and new_string are empty", () => {
      expect(
        extractPreviewLines("Edit", { old_string: "", new_string: "" }),
      ).toBeNull()
    })

    it("shows only removal lines when new_string is missing", () => {
      const lines = extractPreviewLines("Edit", { old_string: "removed" })
      expect(lines).toEqual([{ text: "removed", prefix: "-" }])
    })

    it("shows only addition lines when old_string is missing", () => {
      const lines = extractPreviewLines("Edit", { new_string: "added" })
      expect(lines).toEqual([{ text: "added", prefix: "+" }])
    })
  })

  describe("Bash tool", () => {
    it("splits command into lines without prefix", () => {
      const lines = extractPreviewLines("Bash", {
        command: "echo hello\necho world",
      })
      expect(lines).toEqual([
        { text: "echo hello" },
        { text: "echo world" },
      ])
    })

    it("returns null for empty/whitespace command", () => {
      expect(extractPreviewLines("Bash", { command: "  " })).toBeNull()
    })
  })

  describe("null/unknown cases", () => {
    it("returns null for null input", () => {
      expect(extractPreviewLines("Write", null)).toBeNull()
    })

    it("returns null for unknown tool", () => {
      expect(
        extractPreviewLines("UnknownTool", { content: "stuff" }),
      ).toBeNull()
    })

    it("returns null when input has no relevant fields", () => {
      expect(extractPreviewLines("Write", {})).toBeNull()
    })
  })

  describe("content capping", () => {
    it("caps content before splitting for Write tool", () => {
      const bigContent = "x".repeat(15_000)
      const lines = extractPreviewLines("Write", { content: bigContent })
      // After capping to 10K, the single line should be 10K chars (no newlines)
      expect(lines).not.toBeNull()
      expect(lines!.length).toBe(1)
      // The line itself gets capLine'd to 200 chars
      expect(lines![0]!.text.length).toBe(200)
      expect(lines![0]!.prefix).toBe("+")
    })

    it("caps content before splitting for Edit tool", () => {
      const bigOld = "y".repeat(15_000)
      const lines = extractPreviewLines("Edit", {
        old_string: bigOld,
        new_string: "short",
      })
      expect(lines).not.toBeNull()
      // First line is the capped old_string (single line), then the new_string
      expect(lines![0]!.prefix).toBe("-")
      expect(lines![0]!.text.length).toBe(200) // capLine truncation
      expect(lines![lines!.length - 1]).toEqual({ text: "short", prefix: "+" })
    })

    it("caps content before splitting for Bash tool", () => {
      const bigCmd = "a".repeat(15_000)
      const lines = extractPreviewLines("Bash", { command: bigCmd })
      expect(lines).not.toBeNull()
      expect(lines!.length).toBe(1)
      expect(lines![0]!.text.length).toBe(200) // capLine truncation
    })
  })

  describe("line capping within extractPreviewLines", () => {
    it("truncates individual long lines in Write content", () => {
      const longLine = "q".repeat(300)
      const lines = extractPreviewLines("Write", {
        content: `short\n${longLine}\nshort2`,
      })
      expect(lines).not.toBeNull()
      expect(lines![0]!.text).toBe("short")
      expect(lines![1]!.text.length).toBe(200)
      expect(lines![1]!.text.endsWith("...")).toBe(true)
      expect(lines![2]!.text).toBe("short2")
    })
  })
})

// ---------------------------------------------------------------------------
// extractPath
// ---------------------------------------------------------------------------

describe("extractPath", () => {
  // The third argument (`cwd`) is the active session cwd, NOT the test
  // runner's cwd — see F-2 in permission-audit.md. We pass an explicit cwd
  // here so the dialog tests don't accidentally couple to the bantai
  // process cwd, which is what the bug was in the first place.
  const SESSION_CWD = "/tmp/playground"

  it("returns relative path for file_path string", () => {
    const result = extractPath("Write", { file_path: `${SESSION_CWD}/src/test.ts` }, SESSION_CWD)
    expect(result).toBe("src/test.ts")
  })

  it("returns command string for Bash tool", () => {
    const result = extractPath("Bash", { command: "echo hello" }, SESSION_CWD)
    expect(result).toBe("echo hello")
  })

  it("returns empty string for non-string file_path", () => {
    expect(extractPath("Write", { file_path: 42 }, SESSION_CWD)).toBe("")
    expect(extractPath("Write", { file_path: null }, SESSION_CWD)).toBe("")
    expect(extractPath("Write", { file_path: undefined }, SESSION_CWD)).toBe("")
  })

  it("returns empty string when both file_path and command are missing", () => {
    expect(extractPath("Write", {}, SESSION_CWD)).toBe("")
    expect(extractPath("Write", { other: "value" }, SESSION_CWD)).toBe("")
  })

  it("returns empty string for null input", () => {
    expect(extractPath("Write", null, SESSION_CWD)).toBe("")
  })

  it("returns pattern for Glob/Grep tools", () => {
    const result = extractPath("Glob", { pattern: "**/*.ts" }, SESSION_CWD)
    expect(result).toBe("**/*.ts")
  })

  it("returns pattern with directory for Glob tool", () => {
    const result = extractPath("Glob", {
      pattern: "**/*.ts",
      path: `${SESSION_CWD}/src`,
    }, SESSION_CWD)
    expect(result).toBe("**/*.ts in src")
  })

  // F-2 regression: extractPath must compute paths against the SESSION cwd
  // (passed by the caller from agent.config.cwd), not the test runner's
  // process.cwd(). Drive a fake session cwd of /tmp/playground; assert the
  // result is rooted there even though the test process is somewhere else.
  it("(F-2) computes path relative to session cwd, not process.cwd()", () => {
    const sessionCwd = "/tmp/playground"
    const result = extractPath(
      "Write",
      { file_path: `${sessionCwd}/src/hello.ts` },
      sessionCwd,
    )
    // Under the bug, this would render as "../../../tmp/playground/src/hello.ts"
    // (or similar) because process.cwd() != sessionCwd.
    expect(result).toBe("src/hello.ts")
    expect(result).not.toContain("..")
    expect(result).not.toContain(process.cwd())
  })
})

// ---------------------------------------------------------------------------
// option2Text
// ---------------------------------------------------------------------------

/** Helper to build a minimal PermissionRequestEvent for testing */
function makePerm(overrides: Partial<PermissionRequestEvent>): PermissionRequestEvent {
  return {
    type: "permission_request",
    id: "test-id",
    tool: "Bash",
    input: null,
    ...overrides,
  }
}

describe("option2Text", () => {
  describe(".claude/ path detection", () => {
    it("shows Claude settings label for project .claude/ paths", () => {
      const result = option2Text(makePerm({
        tool: "Edit",
        input: { file_path: "/home/user/project/.claude/settings.json" },
      }))
      expect(result).toBe("Always allow editing Claude settings")
    })

    it("shows global Claude settings label for ~/.claude/ paths", () => {
      const home = process.env.HOME ?? ""
      const result = option2Text(makePerm({
        tool: "Edit",
        input: { file_path: `${home}/.claude/CLAUDE.md` },
      }))
      expect(result).toBe("Always allow editing global Claude settings")
    })

    it("does not trigger for paths without .claude/", () => {
      const result = option2Text(makePerm({
        tool: "Edit",
        input: { file_path: "/home/user/project/src/index.ts" },
      }))
      expect(result).not.toContain("Claude settings")
    })
  })

  describe("addDirectories suggestions", () => {
    it("shows directory label from addDirectories suggestion", () => {
      const result = option2Text(makePerm({
        tool: "Read",
        suggestions: [{
          type: "addDirectories",
          directories: ["/home/user/project/src/"],
          destination: "session",
        }],
      }))
      expect(result).toBe("Always allow in src/")
    })
  })

  describe("richer suggestion labels", () => {
    it("shows 'npm commands' for Bash npm* pattern", () => {
      const result = option2Text(makePerm({
        tool: "Bash",
        input: { command: "npm install" },
        suggestions: [{
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "npm*" }],
          behavior: "allow",
          destination: "session",
        }],
      }))
      expect(result).toBe("Always allow npm commands")
    })

    it("shows 'git commands' for Bash git* pattern", () => {
      const result = option2Text(makePerm({
        tool: "Bash",
        input: { command: "git status" },
        suggestions: [{
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "git*" }],
          behavior: "allow",
          destination: "session",
        }],
      }))
      expect(result).toBe("Always allow git commands")
    })

    it("shows 'cargo commands' for Bash 'cargo *' pattern", () => {
      const result = option2Text(makePerm({
        tool: "Bash",
        input: { command: "cargo build" },
        suggestions: [{
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "cargo *" }],
          behavior: "allow",
          destination: "session",
        }],
      }))
      expect(result).toBe("Always allow cargo commands")
    })

    it("falls back to tool name for non-Bash ruleContent", () => {
      const result = option2Text(makePerm({
        tool: "Edit",
        input: { file_path: "/tmp/foo.ts" },
        suggestions: [{
          type: "addRules",
          rules: [{ toolName: "Edit", ruleContent: "*.ts" }],
          behavior: "allow",
          destination: "session",
        }],
      }))
      expect(result).toBe("Always allow Edit")
    })

    it("falls back to tool name for complex Bash patterns", () => {
      const result = option2Text(makePerm({
        tool: "Bash",
        input: { command: "find . -name '*.ts'" },
        suggestions: [{
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "find . -name*" }],
          behavior: "allow",
          destination: "session",
        }],
      }))
      // Complex pattern with spaces/dots won't match the simple word regex
      expect(result).toBe("Always allow Bash")
    })
  })

  describe("tool-specific fallback labels", () => {
    it("shows 'reading files' for Read tool", () => {
      const result = option2Text(makePerm({ tool: "Read" }))
      expect(result).toBe("Always allow reading files")
    })

    it("shows tool name for other tools", () => {
      const result = option2Text(makePerm({ tool: "Write" }))
      expect(result).toBe("Always allow Write")
    })

    it("truncates long tool names", () => {
      const longName = "VeryLongToolNameThatExceedsThirtyCharacters"
      const result = option2Text(makePerm({ tool: longName }))
      expect(result).toStartWith("Always allow ")
      expect(result).toContain("\u2026")
    })
  })
})
