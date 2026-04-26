import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  parseDefinition,
  loadDefinitionsFromDir,
  loadAllDefinitions,
} from "../../src/subagents/definitions"

// ---------------------------------------------------------------------------
// parseDefinition
// ---------------------------------------------------------------------------

describe("parseDefinition", () => {
  it("parses valid frontmatter with all fields", () => {
    const content = `---
name: researcher
description: Research agent for deep investigation
backend: gemini
model: gemini-2.5-pro
permissionMode: bypassPermissions
maxTurns: 10
effort: high
tools:
  - Read
  - Grep
  - WebSearch
disallowedTools:
  - Edit
  - Write
color: cyan
acpCommand: /path/to/agent
acpArgs:
  - --flag
  - value
---

System prompt content here.
This is the body of the markdown file.
`

    const def = parseDefinition(content, "/agents/researcher.md")
    expect(def).not.toBeNull()
    expect(def!.name).toBe("researcher")
    expect(def!.description).toBe("Research agent for deep investigation")
    expect(def!.backend).toBe("gemini")
    expect(def!.model).toBe("gemini-2.5-pro")
    expect(def!.permissionMode).toBe("bypassPermissions")
    expect(def!.maxTurns).toBe(10)
    expect(def!.effort).toBe("high")
    expect(def!.tools).toEqual(["Read", "Grep", "WebSearch"])
    expect(def!.disallowedTools).toEqual(["Edit", "Write"])
    expect(def!.color).toBe("cyan")
    expect(def!.acpCommand).toBe("/path/to/agent")
    expect(def!.acpArgs).toEqual(["--flag", "value"])
    expect(def!.filePath).toBe("/agents/researcher.md")
    expect(def!.systemPrompt).toContain("System prompt content here.")
    expect(def!.systemPrompt).toContain("This is the body of the markdown file.")
  })

  it("parses frontmatter with minimal fields (just name)", () => {
    const content = `---
name: minimal
---

Do the thing.
`

    const def = parseDefinition(content, "/agents/minimal.md")
    expect(def).not.toBeNull()
    expect(def!.name).toBe("minimal")
    expect(def!.systemPrompt).toContain("Do the thing.")
    expect(def!.description).toBeUndefined()
    expect(def!.backend).toBeUndefined()
    expect(def!.model).toBeUndefined()
    expect(def!.permissionMode).toBeUndefined()
    expect(def!.maxTurns).toBeUndefined()
    expect(def!.effort).toBeUndefined()
    expect(def!.tools).toBeUndefined()
    expect(def!.disallowedTools).toBeUndefined()
    expect(def!.color).toBeUndefined()
    expect(def!.acpCommand).toBeUndefined()
    expect(def!.acpArgs).toBeUndefined()
  })

  it("uses filename as name when name is not in frontmatter", () => {
    const content = `---
description: A helper agent
---

Help with things.
`

    const def = parseDefinition(content, "/agents/my-helper.md")
    expect(def).not.toBeNull()
    expect(def!.name).toBe("my-helper")
  })

  it("prefers frontmatter name over filename", () => {
    const content = `---
name: custom-name
---

Prompt.
`

    const def = parseDefinition(content, "/agents/filename.md")
    expect(def).not.toBeNull()
    expect(def!.name).toBe("custom-name")
  })

  it("parses tools array correctly", () => {
    const content = `---
name: tooled
tools:
  - Read
  - Grep
  - Bash
---

Prompt.
`

    const def = parseDefinition(content, "/agents/tooled.md")
    expect(def).not.toBeNull()
    expect(def!.tools).toEqual(["Read", "Grep", "Bash"])
  })

  it("parses disallowedTools array correctly", () => {
    const content = `---
name: restricted
disallowedTools:
  - Edit
  - Write
  - Bash
---

Prompt.
`

    const def = parseDefinition(content, "/agents/restricted.md")
    expect(def).not.toBeNull()
    expect(def!.disallowedTools).toEqual(["Edit", "Write", "Bash"])
  })

  it("parses acpArgs array correctly", () => {
    const content = `---
name: acp-agent
acpCommand: /usr/bin/my-agent
acpArgs:
  - --verbose
  - --timeout
  - 30
---

Prompt.
`

    const def = parseDefinition(content, "/agents/acp-agent.md")
    expect(def).not.toBeNull()
    expect(def!.acpArgs).toEqual(["--verbose", "--timeout", "30"])
  })

  it("parses maxTurns as a number", () => {
    const content = `---
name: limited
maxTurns: 25
---

Prompt.
`

    const def = parseDefinition(content, "/agents/limited.md")
    expect(def).not.toBeNull()
    expect(def!.maxTurns).toBe(25)
  })

  it("ignores invalid maxTurns values", () => {
    const content = `---
name: bad-turns
maxTurns: notanumber
---

Prompt.
`

    const def = parseDefinition(content, "/agents/bad-turns.md")
    expect(def).not.toBeNull()
    expect(def!.maxTurns).toBeUndefined()
  })

  it("ignores negative maxTurns", () => {
    const content = `---
name: neg-turns
maxTurns: -5
---

Prompt.
`

    const def = parseDefinition(content, "/agents/neg-turns.md")
    expect(def).not.toBeNull()
    expect(def!.maxTurns).toBeUndefined()
  })

  it("returns null for content without frontmatter", () => {
    const content = "Just some plain markdown content."
    const def = parseDefinition(content, "/agents/plain.md")
    expect(def).toBeNull()
  })

  it("returns null for content with only opening fence", () => {
    const content = `---
name: broken
no closing fence here
`
    const def = parseDefinition(content, "/agents/broken.md")
    expect(def).toBeNull()
  })

  it("returns null for empty string", () => {
    const def = parseDefinition("", "/agents/empty.md")
    expect(def).toBeNull()
  })

  it("allows empty body (systemPrompt = empty string)", () => {
    const content = `---
name: nobody
---
`

    const def = parseDefinition(content, "/agents/nobody.md")
    expect(def).not.toBeNull()
    expect(def!.name).toBe("nobody")
    expect(def!.systemPrompt).toBe("")
  })

  it("silently ignores unknown frontmatter keys", () => {
    const content = `---
name: with-extras
unknownField: some value
anotherUnknown: 42
memory: true
---

Prompt.
`

    const def = parseDefinition(content, "/agents/with-extras.md")
    expect(def).not.toBeNull()
    expect(def!.name).toBe("with-extras")
    // Unknown fields should not appear on the definition
    const raw = def as unknown as Record<string, unknown>
    expect(raw["unknownField"]).toBeUndefined()
    expect(raw["anotherUnknown"]).toBeUndefined()
    expect(raw["memory"]).toBeUndefined()
  })

  it("validates permissionMode values", () => {
    const content = `---
name: bad-perm
permissionMode: invalidMode
---

Prompt.
`

    const def = parseDefinition(content, "/agents/bad-perm.md")
    expect(def).not.toBeNull()
    expect(def!.permissionMode).toBeUndefined()
  })

  it("validates effort values", () => {
    const content = `---
name: bad-effort
effort: extreme
---

Prompt.
`

    const def = parseDefinition(content, "/agents/bad-effort.md")
    expect(def).not.toBeNull()
    expect(def!.effort).toBeUndefined()
  })

  it("accepts all valid permissionMode values", () => {
    const modes = [
      "default",
      "acceptEdits",
      "bypassPermissions",
      "plan",
      "dontAsk",
    ] as const
    for (const mode of modes) {
      const content = `---
name: perm-${mode}
permissionMode: ${mode}
---

Prompt.
`
      const def = parseDefinition(content, `/agents/perm-${mode}.md`)
      expect(def).not.toBeNull()
      expect(def!.permissionMode).toBe(mode)
    }
  })

  it("accepts all valid effort values", () => {
    const levels = ["low", "medium", "high", "max"] as const
    for (const level of levels) {
      const content = `---
name: effort-${level}
effort: ${level}
---

Prompt.
`
      const def = parseDefinition(content, `/agents/effort-${level}.md`)
      expect(def).not.toBeNull()
      expect(def!.effort).toBe(level)
    }
  })

  it("accepts valid backend values", () => {
    const backends = ["claude", "codex", "gemini", "copilot", "qwen", "acp", "mock"] as const
    for (const backend of backends) {
      const content = `---
name: backend-${backend}
backend: ${backend}
---

Prompt.
`
      const def = parseDefinition(content, `/agents/backend-${backend}.md`)
      expect(def).not.toBeNull()
      expect(def!.backend).toBe(backend)
    }
  })

  it("rejects invalid backend values", () => {
    const content = `---
name: bad-backend
backend: gpt5
---

Prompt.
`

    const def = parseDefinition(content, "/agents/bad-backend.md")
    expect(def).not.toBeNull()
    expect(def!.backend).toBeUndefined()
  })

  it("leaves backend undefined when not specified", () => {
    const content = `---
name: no-backend
---

Prompt.
`

    const def = parseDefinition(content, "/agents/no-backend.md")
    expect(def).not.toBeNull()
    expect(def!.backend).toBeUndefined()
  })

  it("preserves multiline system prompt", () => {
    const content = `---
name: multiline
---

# First heading

Some paragraph text.

- List item 1
- List item 2

\`\`\`typescript
const x = 42
\`\`\`
`

    const def = parseDefinition(content, "/agents/multiline.md")
    expect(def).not.toBeNull()
    expect(def!.systemPrompt).toContain("# First heading")
    expect(def!.systemPrompt).toContain("- List item 1")
    expect(def!.systemPrompt).toContain("const x = 42")
  })
})

// ---------------------------------------------------------------------------
// loadDefinitionsFromDir
// ---------------------------------------------------------------------------

describe("loadDefinitionsFromDir", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `agent-def-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns empty array for non-existent directory", () => {
    const defs = loadDefinitionsFromDir("/nonexistent/path/that/does/not/exist")
    expect(defs).toEqual([])
  })

  it("returns empty array for directory with no .md files", () => {
    writeFileSync(join(tmpDir, "readme.txt"), "not markdown")
    const defs = loadDefinitionsFromDir(tmpDir)
    expect(defs).toEqual([])
  })

  it("loads .md files with valid frontmatter", () => {
    writeFileSync(
      join(tmpDir, "agent-a.md"),
      `---
name: agent-a
---

Prompt A.
`,
    )
    writeFileSync(
      join(tmpDir, "agent-b.md"),
      `---
name: agent-b
backend: claude
---

Prompt B.
`,
    )

    const defs = loadDefinitionsFromDir(tmpDir)
    expect(defs).toHaveLength(2)
    const names = defs.map((d) => d.name).sort()
    expect(names).toEqual(["agent-a", "agent-b"])
  })

  it("skips .md files without valid frontmatter", () => {
    writeFileSync(
      join(tmpDir, "good.md"),
      `---
name: good
---

Prompt.
`,
    )
    writeFileSync(join(tmpDir, "bad.md"), "No frontmatter here.")

    const defs = loadDefinitionsFromDir(tmpDir)
    expect(defs).toHaveLength(1)
    expect(defs[0]!.name).toBe("good")
  })

  it("skips non-.md files", () => {
    writeFileSync(
      join(tmpDir, "agent.md"),
      `---
name: agent
---

Prompt.
`,
    )
    writeFileSync(join(tmpDir, "notes.txt"), "not an agent")
    writeFileSync(join(tmpDir, "config.yaml"), "key: value")

    const defs = loadDefinitionsFromDir(tmpDir)
    expect(defs).toHaveLength(1)
    expect(defs[0]!.name).toBe("agent")
  })

  it("sets filePath to the full path of each file", () => {
    writeFileSync(
      join(tmpDir, "my-agent.md"),
      `---
name: my-agent
---

Prompt.
`,
    )

    const defs = loadDefinitionsFromDir(tmpDir)
    expect(defs).toHaveLength(1)
    expect(defs[0]!.filePath).toBe(join(tmpDir, "my-agent.md"))
  })
})

// ---------------------------------------------------------------------------
// loadAllDefinitions (load order)
// ---------------------------------------------------------------------------

describe("loadAllDefinitions", () => {
  let tmpRoot: string
  let userAgentsDir: string
  let projectAgentsDir: string

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `agent-all-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    // We can't easily mock homedir(), so we test loadDefinitionsFromDir
    // directly for the override behavior and test loadAllDefinitions
    // with a project dir only
    projectAgentsDir = join(tmpRoot, "project", ".claude", "agents")
    userAgentsDir = join(tmpRoot, "user", ".claude", "agents")
    mkdirSync(projectAgentsDir, { recursive: true })
    mkdirSync(userAgentsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("project definitions override user definitions with the same name", () => {
    // Simulate the override logic using loadDefinitionsFromDir directly
    writeFileSync(
      join(userAgentsDir, "shared.md"),
      `---
name: shared
description: User version
---

User prompt.
`,
    )
    writeFileSync(
      join(projectAgentsDir, "shared.md"),
      `---
name: shared
description: Project version
---

Project prompt.
`,
    )

    const userDefs = loadDefinitionsFromDir(userAgentsDir)
    const projectDefs = loadDefinitionsFromDir(projectAgentsDir)

    // Replicate the merge logic from loadAllDefinitions
    const byName = new Map<string, (typeof userDefs)[number]>()
    for (const def of userDefs) byName.set(def.name, def)
    for (const def of projectDefs) byName.set(def.name, def)

    const merged = Array.from(byName.values())
    expect(merged).toHaveLength(1)
    expect(merged[0]!.description).toBe("Project version")
    expect(merged[0]!.systemPrompt).toContain("Project prompt.")
  })

  it("keeps unique definitions from both directories", () => {
    writeFileSync(
      join(userAgentsDir, "user-only.md"),
      `---
name: user-only
---

User agent.
`,
    )
    writeFileSync(
      join(projectAgentsDir, "project-only.md"),
      `---
name: project-only
---

Project agent.
`,
    )

    const userDefs = loadDefinitionsFromDir(userAgentsDir)
    const projectDefs = loadDefinitionsFromDir(projectAgentsDir)

    const byName = new Map<string, (typeof userDefs)[number]>()
    for (const def of userDefs) byName.set(def.name, def)
    for (const def of projectDefs) byName.set(def.name, def)

    const merged = Array.from(byName.values())
    expect(merged).toHaveLength(2)
    const names = merged.map((d) => d.name).sort()
    expect(names).toEqual(["project-only", "user-only"])
  })

  it("loadAllDefinitions loads from project cwd", () => {
    const projectRoot = join(tmpRoot, "project")
    writeFileSync(
      join(projectAgentsDir, "proj-agent.md"),
      `---
name: proj-agent
---

Project prompt.
`,
    )

    // loadAllDefinitions will look at ${cwd}/.claude/agents/
    // and ~/.claude/agents/ (which may or may not have files)
    const defs = loadAllDefinitions(projectRoot)
    const projAgent = defs.find((d) => d.name === "proj-agent")
    expect(projAgent).not.toBeUndefined()
    expect(projAgent!.systemPrompt).toContain("Project prompt.")
  })
})
