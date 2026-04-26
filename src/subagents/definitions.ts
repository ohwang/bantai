import { existsSync, readdirSync, readFileSync as _readFileSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"
import type { AgentDefinition } from "./types"
import type { EffortLevel } from "../protocol/types"
import { isKnownPermissionMode } from "../protocol/permission-modes"
import { isKnownBackendId, knownBackendIds } from "../protocol/registry"
import { log } from "../utils/logger"

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

const VALID_EFFORT_LEVELS = new Set<string>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

interface FrontmatterResult {
  fields: Record<string, string | string[]>
  body: string
}

/**
 * Split a file into YAML frontmatter fields and markdown body.
 * Returns null if the file does not start with a valid `---` fence.
 */
function parseFrontmatter(content: string): FrontmatterResult | null {
  // Must start with --- on its own line
  if (!content.startsWith("---")) return null

  const firstNewline = content.indexOf("\n")
  if (firstNewline === -1) return null

  // The opening --- line may have trailing whitespace but nothing else
  const openingLine = content.slice(0, firstNewline).trim()
  if (openingLine !== "---") return null

  // Find the closing ---
  const rest = content.slice(firstNewline + 1)
  const closingIndex = findClosingFence(rest)
  if (closingIndex === -1) return null

  const yamlBlock = rest.slice(0, closingIndex)
  const body = rest.slice(closingIndex).replace(/^---[^\n]*\n?/, "")

  const fields = parseYamlFields(yamlBlock)

  return { fields, body }
}

/**
 * Find the index of the closing `---` line in the remaining content.
 */
function findClosingFence(text: string): number {
  let pos = 0
  while (pos < text.length) {
    const lineEnd = text.indexOf("\n", pos)
    const line = lineEnd === -1 ? text.slice(pos) : text.slice(pos, lineEnd)
    if (line.trim() === "---") return pos
    if (lineEnd === -1) break
    pos = lineEnd + 1
  }
  return -1
}

/**
 * Parse flat YAML key-value pairs and simple arrays (no nesting, no YAML library).
 *
 * Handles:
 *   key: value
 *   key:
 *     - item1
 *     - item2
 */
function parseYamlFields(
  block: string,
): Record<string, string | string[]> {
  const fields: Record<string, string | string[]> = {}
  const lines = block.split("\n")
  let currentKey: string | null = null
  let currentArray: string[] | null = null

  for (const line of lines) {
    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) continue

    // Array item: starts with whitespace then `- `
    const arrayMatch = line.match(/^\s+- (.*)$/)
    if (arrayMatch && currentKey !== null) {
      if (currentArray === null) {
        currentArray = []
      }
      currentArray.push(arrayMatch[1]!.trim())
      continue
    }

    // Flush any pending array
    if (currentKey !== null && currentArray !== null) {
      fields[currentKey] = currentArray
      currentArray = null
      currentKey = null
    }

    // Key-value pair: `key: value` or `key:` (value on next lines as array)
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (kvMatch) {
      const key = kvMatch[1]!
      const value = kvMatch[2]!.trim()

      if (value === "") {
        // Value will come as array items on subsequent lines
        currentKey = key
        currentArray = null
      } else {
        fields[key] = value
        currentKey = key
        currentArray = null
      }
    }
  }

  // Flush trailing array
  if (currentKey !== null && currentArray !== null) {
    fields[currentKey] = currentArray
  }

  return fields
}

// ---------------------------------------------------------------------------
// Definition builder
// ---------------------------------------------------------------------------

/**
 * Parse a single markdown file's content into an AgentDefinition.
 * Returns null if the file lacks valid frontmatter.
 */
export function parseDefinition(
  content: string,
  filePath: string,
): AgentDefinition | null {
  const parsed = parseFrontmatter(content)
  if (parsed === null) return null

  const { fields, body } = parsed

  // Derive name: frontmatter `name` field, or filename without extension
  const name =
    typeof fields.name === "string" && fields.name !== ""
      ? fields.name
      : basename(filePath, ".md")

  const def: AgentDefinition = {
    name,
    systemPrompt: body,
    filePath,
  }

  // Optional string fields
  if (typeof fields.description === "string") {
    def.description = fields.description
  }
  if (typeof fields.backend === "string") {
    if (isKnownBackendId(fields.backend)) {
      def.backend = fields.backend
    } else {
      log.warn(`Unknown backend "${fields.backend}" in ${filePath} — valid options: ${knownBackendIds().join(", ")}`)
    }
  }
  if (typeof fields.model === "string") {
    def.model = fields.model
  }
  if (typeof fields.color === "string") {
    def.color = fields.color
  }
  if (typeof fields.acpCommand === "string") {
    def.acpCommand = fields.acpCommand
  }

  // PermissionMode (validated)
  if (
    typeof fields.permissionMode === "string" &&
    isKnownPermissionMode(fields.permissionMode)
  ) {
    def.permissionMode = fields.permissionMode
  }

  // EffortLevel (validated)
  if (
    typeof fields.effort === "string" &&
    VALID_EFFORT_LEVELS.has(fields.effort)
  ) {
    def.effort = fields.effort as EffortLevel
  }

  // maxTurns (number)
  if (typeof fields.maxTurns === "string") {
    const n = parseInt(fields.maxTurns, 10)
    if (!isNaN(n) && n > 0) {
      def.maxTurns = n
    }
  }

  // Array fields
  const toolsVal = fields.tools
  if (Array.isArray(toolsVal)) {
    def.tools = toolsVal
  }
  const disallowedVal = fields.disallowedTools
  if (Array.isArray(disallowedVal)) {
    def.disallowedTools = disallowedVal
  }
  const acpArgsVal = fields.acpArgs
  if (Array.isArray(acpArgsVal)) {
    def.acpArgs = acpArgsVal
  }

  return def
}

// ---------------------------------------------------------------------------
// Directory loading
// ---------------------------------------------------------------------------

/**
 * Load all `.md` agent definitions from a single directory.
 * Returns an empty array if the directory does not exist.
 */
export function loadDefinitionsFromDir(dir: string): AgentDefinition[] {
  if (!existsSync(dir)) return []

  // Use synchronous readdir via Bun.file for simplicity
  // readdir is async but we need sync behavior for the public API
  const results: AgentDefinition[] = []
  const entries = readdirSync(dir)

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    const filePath = join(dir, entry)
    try {
      const content = readFileSync(filePath)
      const def = parseDefinition(content, filePath)
      if (def !== null) {
        results.push(def)
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return results
}

/**
 * Load all agent definitions with proper load order:
 * 1. User-level: ~/.claude/agents/
 * 2. Project-level: ${cwd}/.claude/agents/
 *
 * Project definitions override user definitions with the same name.
 */
export function loadAllDefinitions(cwd?: string): AgentDefinition[] {
  const resolvedCwd = cwd ?? process.cwd()

  const userDir = join(homedir(), ".claude", "agents")
  const projectDir = join(resolvedCwd, ".claude", "agents")

  const userDefs = loadDefinitionsFromDir(userDir)
  const projectDefs = loadDefinitionsFromDir(projectDir)

  // Build map: user first, project overrides
  const byName = new Map<string, AgentDefinition>()

  for (const def of userDefs) {
    byName.set(def.name, def)
  }
  for (const def of projectDefs) {
    byName.set(def.name, def)
  }

  return Array.from(byName.values())
}

// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------

function readFileSync(filePath: string): string {
  return _readFileSync(filePath, "utf-8")
}
