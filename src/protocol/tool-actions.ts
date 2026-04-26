/**
 * Tool → file-action map — single source of truth for translating a
 * tool block's name into a `TurnFileChange.action`.
 *
 * Used by the reducer at `turn_complete` to summarise which files this
 * turn touched (create / edit / write / read), which the TUI surfaces in
 * the "lastTurnFiles" panel and the resume banner.
 *
 * Cluster 13 (anti-drift sprint): the mapping used to be three lines of
 * inline ternary in `protocol/reducer.ts`:
 *
 *     const action: TurnFileChange["action"] =
 *       block.tool === "Write" ? "create"
 *       : block.tool === "Edit" ? "edit"
 *       : "read"
 *
 * That hardcoded Claude's tool vocabulary (`Write`, `Edit`) into the
 * reducer and silently demoted every other write-style tool — `MultiEdit`,
 * `NotebookEdit`, `Update` — to `"read"`. Codex normalises its
 * `fileChange` item to `"Edit"` so it survives by accident; ACP normalises
 * its `kind: "edit"` to `"Edit"` likewise; but anything new (a sub-agent
 * tool, a future Claude SDK tool, a custom MCP tool that wraps writes)
 * silently mis-categorised.
 *
 * Centralising the table follows the drift-contract recipe:
 *
 *   - Source of truth = `TOOL_ACTION_MAP` (Record).
 *   - `actionForTool(toolName)` is the single helper consumers use.
 *   - Adding a new file-mutating tool is one line.
 *
 * Tool names are deliberately NOT a closed enum: the reducer sees raw
 * strings from many backends (Claude, Codex, ACP normalisations, MCP
 * tool names like `mcp:server/tool`, sub-agent tools) so the table maps
 * known names to actions and falls back to `"read"` for everything else.
 */

import type { TurnFileChange } from "./types"

export type FileAction = TurnFileChange["action"]

/**
 * Known tool names → resulting `TurnFileChange.action`.
 *
 * Keys are Bantai's *normalised* tool names — the same values that show
 * up on `block.tool` after Claude/Codex/ACP event mappers run. Backend
 * adapters are responsible for normalising their wire-level tool names
 * (e.g. ACP's `kind: "edit"` → `"Edit"`) before the reducer sees them.
 */
export const TOOL_ACTION_MAP: Record<string, FileAction> = {
  // Creates
  Write: "create",

  // Edits — every flavour of mutation that overwrites or patches an
  // existing file lands here. Pre-Cluster-13 only `Edit` was recognised
  // and the rest silently became `"read"`.
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Update: "edit",

  // Explicit reads — listed here for documentation rather than necessity
  // (anything not in the map already falls back to `"read"`).
  Read: "read",
  NotebookRead: "read",
}

/**
 * Resolve a tool name to its `TurnFileChange.action`. Unknown tools fall
 * back to `"read"` — the reducer's downstream filter (`if (filePath)…`)
 * means tools without a file_path input never appear in the result, so
 * the fallback is only consumed when a tool both touches a file and
 * isn't in the table. Logging the fallback would spam the live event
 * loop, so we silently default and rely on tests to catch the case.
 */
export function actionForTool(toolName: string): FileAction {
  return TOOL_ACTION_MAP[toolName] ?? "read"
}
