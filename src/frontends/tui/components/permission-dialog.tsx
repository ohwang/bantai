/**
 * Permission Dialog — Claude Code-style inline permission prompt
 *
 * Renders within the conversation flow when WAITING_FOR_PERM.
 * Features:
 * - Action label header (displayName or tool name)
 * - File/command content preview between dashed borders
 * - Color-coded diff preview for Edit operations (red/green)
 * - 4-option radio selector: Allow (y), Always allow (a), Deny (n), Deny for session (d)
 * - Wrap-around arrow key + Tab navigation (matching claude-go)
 * - ❯ selection indicator with periwinkle accent
 * - Context-specific question and option text from SDK metadata/suggestions
 * - Esc to cancel, Enter to confirm, y/a/n/d single-key shortcuts
 * - "Deny for session" tracks tool name in adapter for auto-deny on future calls
 */

import { createSignal, createEffect, createMemo, Show, For, onCleanup, type Accessor } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { usePermissions } from "../context/permissions"
import { useAgent } from "../context/agent"
import { useSession } from "../context/session"
import { useSync } from "../context/sync"
import { colors } from "../theme/tokens"
import { Divider, ShortcutBar, ShortcutHint } from "./primitives"
import { truncatePathMiddle } from "../../../utils/truncate"
import type { PermissionRequestEvent, PermissionUpdate } from "../../../protocol/types"
import { log } from "../../../utils/logger"

// Max lines to show in content preview
const MAX_PREVIEW_LINES = 20

// Max characters to process from input content before splitting into lines.
// Prevents multi-megabyte payloads from freezing the TUI during string splitting.
const MAX_CONTENT_CHARS = 10_000

// Max characters per preview line before truncation
const MAX_LINE_LENGTH = 200

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert absolute paths to relative (from the agent session's cwd) for
 *  compact display, then truncate long paths with smart middle-truncation.
 *
 *  IMPORTANT: `cwd` MUST be the *session's* cwd (`agent.config.cwd`), not
 *  `process.cwd()`. The bantai launcher captures the user's launch dir into
 *  `flags.config.cwd` but never `process.chdir()`s, so the bantai process
 *  cwd and the agent's cwd diverge whenever the user runs e.g.
 *  `bantai --cwd <other-project>` or whenever a future server frontend hands
 *  the backend an arbitrary cwd. Computing paths off `process.cwd()` makes
 *  the dialog render `../../proj-test/src/hello.ts` instead of
 *  `src/hello.ts` — see permission-audit.md §F-2.
 */
function relativePath(absPath: string, cwd: string): string {
  let rel: string
  if (absPath.startsWith(cwd + "/")) {
    rel = absPath.slice(cwd.length + 1)
  } else {
    // For paths outside cwd, compute relative
    rel = require("node:path").relative(cwd, absPath)
    // If the relative path is too deep, just show the filename
    const upCount = (rel.match(/\.\.\//g) || []).length
    if (upCount > 2) {
      rel = require("node:path").basename(absPath)
    }
  }
  return truncatePathMiddle(rel, 60)
}

/** Extract the filename from a path */
function fileName(filePath: string): string {
  const parts = filePath.split("/")
  return parts[parts.length - 1] || filePath
}

/** Extract the parent directory name from a path */
function parentDir(filePath: string): string {
  const parts = filePath.replace(/\/$/, "").split("/")
  return parts[parts.length - 1] || filePath
}

/** Get a human-readable action label for the tool */
function actionLabel(tool: string, displayName?: string): string {
  if (displayName) return displayName
  switch (tool) {
    case "Read": return "Read file"
    case "Edit": return "Edit file"
    case "Write": return "Create file"
    case "Bash": return "Bash command"
    case "Glob": return "Search files"
    case "Grep": return "Search content"
    case "Agent": return "Launch agent"
    case "WebFetch": return "Fetch URL"
    case "WebSearch": return "Web search"
    default: return tool
  }
}

/** Extract path string from tool input.
 *
 *  `cwd` MUST be the active session's cwd (`agent.config.cwd`), not the
 *  bantai process cwd. See `relativePath` above for why — same root cause.
 */
export function extractPath(_tool: string, input: unknown, cwd: string): string {
  const inp = input as Record<string, unknown> | null
  if (!inp) return ""
  if (typeof inp.file_path === "string" && inp.file_path) return relativePath(inp.file_path, cwd)
  if (typeof inp.command === "string" && inp.command) return inp.command
  if (inp.pattern) {
    const dir = inp.path ? relativePath(String(inp.path), cwd) : ""
    return `${inp.pattern}${dir ? ` in ${dir}` : ""}`
  }
  if (inp.path) return relativePath(String(inp.path), cwd)
  return ""
}

/** A preview line with optional diff prefix for coloring */
export interface PreviewLine {
  text: string
  /** "+" for added, "-" for removed, " " for context/neutral */
  prefix?: "+" | "-" | " "
}

/** Cap a string to MAX_CONTENT_CHARS to prevent expensive splitting */
export function capContent(s: string): string {
  return s.length > MAX_CONTENT_CHARS ? s.slice(0, MAX_CONTENT_CHARS) : s
}

/** Truncate a single line to MAX_LINE_LENGTH */
export function capLine(rawLine: string): string {
  return rawLine.length > MAX_LINE_LENGTH ? rawLine.slice(0, MAX_LINE_LENGTH - 3) + "..." : rawLine
}

export function extractPreviewLines(tool: string, input: unknown): PreviewLine[] | null {
  const inp = input as Record<string, unknown> | null
  if (!inp) return null

  switch (tool) {
    case "Write": {
      const content = inp.content
      if (typeof content === "string" && content.trim()) {
        return capContent(content).split("\n").map(l => ({ text: capLine(l), prefix: "+" as const }))
      }
      return null
    }
    case "Edit": {
      // Show old_string (removed) and new_string (added) as diff
      const oldStr = inp.old_string
      const newStr = inp.new_string
      const lines: PreviewLine[] = []
      if (typeof oldStr === "string" && oldStr.trim()) {
        for (const l of capContent(oldStr).split("\n")) {
          lines.push({ text: capLine(l), prefix: "-" })
        }
      }
      if (typeof newStr === "string" && newStr.trim()) {
        for (const l of capContent(newStr).split("\n")) {
          lines.push({ text: capLine(l), prefix: "+" })
        }
      }
      return lines.length > 0 ? lines : null
    }
    case "Bash": {
      const cmd = inp.command
      if (typeof cmd === "string" && cmd.trim()) {
        return capContent(cmd).split("\n").map(l => ({ text: capLine(l) }))
      }
      return null
    }
    default:
      return null
  }
}

/** Build the question text from SDK title or tool context */
function questionText(perm: PermissionRequestEvent): string {
  if (perm.title) return perm.title
  const inp = perm.input as Record<string, unknown> | null
  const filePath = inp?.file_path ? String(inp.file_path) : ""
  const name = filePath ? fileName(filePath) : ""
  switch (perm.tool) {
    case "Write": return name ? `Do you want to create ${name}?` : "Do you want to proceed?"
    case "Edit": return name ? `Do you want to edit ${name}?` : "Do you want to proceed?"
    case "Bash": return "Do you want to run this command?"
    default: return "Do you want to proceed?"
  }
}

/** Detect if a path is within a .claude/ directory */
function isClaudePath(filePath: string): boolean {
  return filePath.includes("/.claude/")
}

/** Detect if a path is within the global ~/.claude/ directory */
function isGlobalClaudePath(filePath: string): boolean {
  const home = process.env.HOME ?? ""
  if (!home) return false
  return filePath.startsWith(home + "/.claude/")
}

/** Generate a readable label from a Bash ruleContent pattern.
 *
 * Examples:
 *   "npm*"     -> "npm commands"
 *   "git*"     -> "git commands"
 *   "npx *"    -> "npx commands"
 *   "yarn *"   -> "yarn commands"
 *   "bun *"    -> "bun commands"
 *   "cargo *"  -> "cargo commands"
 *   "make*"    -> "make commands"
 */
function bashPatternLabel(ruleContent: string): string | null {
  // Strip trailing glob wildcards to get the command name
  const cleaned = ruleContent.replace(/[\s*]+$/, "")
  if (!cleaned) return null
  // Only generate labels for simple single-word patterns (avoid complex globs)
  if (/^[a-zA-Z0-9_-]+$/.test(cleaned)) {
    return `${cleaned} commands`
  }
  return null
}

/** Generate a readable label from suggestion ruleContent for a tool */
function suggestionLabel(toolName: string, ruleContent: string): string | null {
  if (toolName === "Bash" && ruleContent) {
    return bashPatternLabel(ruleContent)
  }
  return null
}

/** Build option 2 text from SDK suggestions or derive from context.
 *
 * Always uses `perm.tool` as the authoritative tool name — suggestions may
 * reference a different tool (e.g. a parent category), which caused Bug #1
 * where the label showed "Always allow Read" for a Bash tool.
 *
 * `sessionCwd` is used as the dirname fallback when SDK suggestions don't
 * carry an `addDirectories` entry. The dirname displayed here MUST match
 * the dirname the resulting "always allow" rule actually scopes to —
 * historically this read `process.cwd()` and could mislead the user about
 * where the rule was being applied (see permission-audit.md §F-2).
 */
export function option2Text(perm: PermissionRequestEvent, _sessionCwd?: string): string {
  // 1. Check for .claude/ path edits — specialized label
  const inp = perm.input as Record<string, unknown> | null
  const filePath = typeof inp?.file_path === "string" ? inp.file_path : ""
  if (filePath && isClaudePath(filePath)) {
    if (isGlobalClaudePath(filePath)) {
      return "Always allow editing global Claude settings"
    }
    return "Always allow editing Claude settings"
  }

  // 2. Check if suggestions include an addDirectories entry
  if (perm.suggestions && perm.suggestions.length > 0) {
    for (const s of perm.suggestions) {
      if (s.type === "addDirectories" && s.directories.length > 0 && s.directories[0]) {
        const dir = parentDir(s.directories[0])
        return `Always allow in ${dir}/`
      }
    }
  }

  // 3. Check for richer suggestion labels from addRules with ruleContent
  if (perm.suggestions && perm.suggestions.length > 0) {
    for (const s of perm.suggestions) {
      if (s.type === "addRules" || s.type === "replaceRules") {
        for (const rule of s.rules) {
          if (rule.ruleContent) {
            const label = suggestionLabel(rule.toolName, rule.ruleContent)
            if (label) return `Always allow ${label}`
          }
        }
      }
    }
  }

  // 4. Tool-specific fallback labels
  if (perm.tool === "Read") return "Always allow reading files"

  // 5. Use the actual tool name — never derive from suggestions[].rules[].toolName
  const toolName = perm.tool.length > 30 ? perm.tool.slice(0, 27) + "\u2026" : perm.tool
  return `Always allow ${toolName}`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// Number of options in the permission dialog
const NUM_OPTIONS = 4

/**
 * Keyed-remount shell — see `bantai/CLAUDE.md` §"Per-entity dialog state".
 *
 * Every per-permission piece of UI state (radio selection, `justActed`
 * debounce, the 200ms timer, the `useKeyboard` handler) lives in
 * `PermissionDialogInner`. Wrapping it in `<Show when={...} keyed>` makes
 * Solid tear down the inner component when the pending permission's
 * identity changes (or it goes away) and mount a fresh instance with
 * fresh signals. That structurally prevents the F-9 class of bug —
 * stale `selectedOption` / `justActed` carrying over from the previous
 * permission. Don't replace this with a non-keyed `<Show>` plus a
 * `createRenderEffect` reset; the structural form removes the foot-gun
 * (no helper to forget) and the regression risk (no helper to drift).
 */
export function PermissionDialog() {
  const { state } = usePermissions()
  return (
    <Show when={state.pendingPermission} keyed>
      {(perm: PermissionRequestEvent) => <PermissionDialogInner permission={perm} />}
    </Show>
  )
}

function PermissionDialogInner(props: { permission: PermissionRequestEvent }) {
  const { state: session } = useSession()
  const agent = useAgent()
  const sync = useSync()
  const dims = useTerminalDimensions()

  // Radio selector state: 0 = Allow, 1 = Always allow, 2 = Deny, 3 = Deny for session
  const [selectedOption, setSelectedOption] = createSignal(0)

  // Guard against buffered keystrokes leaking into THIS dialog from typing
  // that landed during the 200ms window after the user actioned the previous
  // dialog. Each new dialog gets a fresh Inner via the keyed `<Show>` above,
  // so this flag starts `false` per-permission — matching the F-9 invariant
  // that a fresh permission accepts input immediately rather than inheriting
  // the previous dialog's debounce window.
  let justActed = false
  let justActedTimer: ReturnType<typeof setTimeout> | undefined

  // Clear debounce timer on unmount to prevent leak. With keyed remount
  // this fires on every permission transition, not just the final close —
  // ensuring no stray timer survives into the next Inner instance.
  onCleanup(() => clearTimeout(justActedTimer))

  function markActed() {
    justActed = true
    clearTimeout(justActedTimer)
    justActedTimer = setTimeout(() => { justActed = false }, 200)
  }

  // Dev assertion: a permission dialog must never open in read-only follow
  // mode. The FollowBackend translator never emits permission_request, so
  // reaching this branch means something is broken upstream (spurious
  // event, stale state). Log loudly — cheaper to catch than to debug.
  createEffect(() => {
    if (agent.config.readOnly) {
      log.error(
        "Permission dialog opened in read-only follow mode — this should not happen",
        { permissionId: props.permission.id },
      )
    }
  })

  useKeyboard((event) => {
    if (session.sessionState !== "WAITING_FOR_PERM") return

    // Ignore buffered keystrokes that arrive shortly after an action.
    // This prevents a rapid "a" then "d" from denying the NEXT permission.
    if (justActed) return

    // Consume ALL key events while permission dialog is active to prevent
    // scrollbox from handling arrow keys as scroll commands.
    event.preventDefault()

    const id = props.permission.id
    const perm = props.permission

    // No selection reset to worry about: a fresh permission id arrives via a
    // fresh `PermissionDialogInner` instance (keyed `<Show>` in the outer
    // `PermissionDialog`), so `selectedOption` already starts at 0. (F-9)

    // Arrow key navigation (wraps around, matching claude-go)
    if (event.name === "up") {
      setSelectedOption((selectedOption() - 1 + NUM_OPTIONS) % NUM_OPTIONS)
      return
    }
    if (event.name === "down") {
      setSelectedOption((selectedOption() + 1) % NUM_OPTIONS)
      return
    }

    // Tab / Shift+Tab navigation (matching claude-go)
    if (event.name === "tab") {
      if (event.shift) {
        setSelectedOption((selectedOption() - 1 + NUM_OPTIONS) % NUM_OPTIONS)
      } else {
        setSelectedOption((selectedOption() + 1) % NUM_OPTIONS)
      }
      return
    }

    // Number keys for direct selection + immediate action
    if (event.name === "1") {
      setSelectedOption(0)
      approveOnce(id)
      return
    }
    if (event.name === "2") {
      setSelectedOption(1)
      approveAlways(id, perm)
      return
    }
    if (event.name === "3") {
      setSelectedOption(2)
      deny(id, perm.tool)
      return
    }
    if (event.name === "4") {
      setSelectedOption(3)
      denyForSession(id, perm.tool)
      return
    }

    // Enter confirms selected option
    if (event.name === "return") {
      const sel = selectedOption()
      if (sel === 0) approveOnce(id)
      else if (sel === 1) approveAlways(id, perm)
      else if (sel === 2) deny(id, perm.tool)
      else denyForSession(id, perm.tool)
      return
    }

    // Single-key shortcuts (matching claude-go: y/a/n/d)
    if (event.name === "y") {
      approveOnce(id)
      return
    }
    if (event.name === "a") {
      approveAlways(id, perm)
      return
    }
    if (event.name === "n" || event.name === "escape") {
      deny(id, perm.tool)
      return
    }
    if (event.name === "d") {
      denyForSession(id, perm.tool)
      return
    }
  })

  function approveOnce(id: string) {
    markActed()
    agent.backend.approveToolUse(id)
  }

  function approveAlways(id: string, perm: PermissionRequestEvent) {
    markActed()
    // Build updatedPermissions for "always allow":
    // 1. Include SDK suggestions if available (echoed back per SDK docs).
    //    These may be command-specific (e.g., Bash "ls:*") and are persisted
    //    to localSettings by the CLI.
    // 2. Always include a tool-wide rule (no ruleContent) at session scope.
    //    This ensures the CLI's JTY → wTY check auto-allows ALL subsequent
    //    calls to the same tool for the rest of the session, not just the
    //    specific command pattern in the suggestions.
    const permissions: PermissionUpdate[] = []

    // Echo SDK suggestions (command-specific, persisted to localSettings)
    if (perm.suggestions && perm.suggestions.length > 0) {
      permissions.push(...perm.suggestions)
    }

    // Always add a tool-wide session rule so wTY matches on next call.
    // Without this, the suggestions' ruleContent-based matching only
    // covers the specific command/file pattern, not the tool in general.
    const hasToolWideRule = permissions.some(
      (p) =>
        (p.type === "addRules" || p.type === "replaceRules") &&
        p.rules.some((r) => r.toolName === perm.tool && !r.ruleContent),
    )
    if (!hasToolWideRule) {
      permissions.push({
        type: "addRules" as const,
        rules: [{ toolName: perm.tool }],
        behavior: "allow" as const,
        destination: "session" as const,
      })
    }

    agent.backend.approveToolUse(id, {
      alwaysAllow: true,
      updatedPermissions: permissions,
    })
  }

  function deny(id: string, toolName: string) {
    markActed()
    agent.backend.denyToolUse(id, "User denied")
    sync.pushEvent({
      type: "system_message",
      text: `Tool "${toolName}" denied by user`,
      ephemeral: true,
    })
  }

  function denyForSession(id: string, toolName: string) {
    markActed()
    agent.backend.denyToolUse(id, "Denied for session", { denyForSession: true })
    sync.pushEvent({
      type: "system_message",
      text: `Tool "${toolName}" denied for session`,
      ephemeral: true,
    })
  }

  // `props.permission` is stable for the lifetime of this Inner instance —
  // a fresh permission id arrives via a fresh keyed-Show mount in the outer
  // `PermissionDialog`. So we can read it directly instead of through an
  // accessor.
  const perm = props.permission
  const label = () => actionLabel(perm.tool, perm.displayName)
  const allPreviewLines = createMemo(() => extractPreviewLines(perm.tool, perm.input))

  // Fixed chrome lines outside the scrollable preview area:
  // border top/bottom (2) + action label (1) + question (1) + 4 options (4)
  // + footer with margin (2) + padding (2) + dashed borders (2) = 14 lines.
  // Additional optional metadata lines (path, description, etc.) add up to ~4.
  // Use a generous estimate so the preview scrollbox never overflows.
  const FIXED_CHROME_LINES = 18

  // Max height for the scrollable content preview area.
  // Ensures the question + options + footer are always visible.
  const maxPreviewHeight = () => {
    const termHeight = dims()?.height ?? 80
    const available = termHeight - FIXED_CHROME_LINES
    // Always allow at least 3 lines, cap at MAX_PREVIEW_LINES
    return Math.max(3, Math.min(available, MAX_PREVIEW_LINES))
  }

  const previewLines = () => {
    const all = allPreviewLines()
    if (!all) return null
    return all
  }

  // Resolve session cwd from the active agent (NOT process.cwd() — see
  // F-2: bantai never process.chdir()s, so process.cwd() can differ from
  // the cwd the SDK is actually rooted in).
  const sessionCwd = () => agent.config.cwd ?? process.cwd()

  // Don't show path separately for Bash (command is shown in preview)
  const pathStr = () => {
    if (perm.tool === "Bash" && previewLines()) return ""
    return extractPath(perm.tool, perm.input, sessionCwd())
  }
  const question = () => questionText(perm)
  const opt2 = () => option2Text(perm, sessionCwd())
  const description = perm.description

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={colors.border.permission}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Action label */}
      <box height={1} paddingLeft={1}>
        <text fg={colors.border.permission} attributes={TextAttributes.BOLD}>
          {label()}
        </text>
      </box>

      {/* Path / primary content info */}
      <Show when={pathStr()}>
        <box paddingLeft={1}>
          <text fg={colors.text.muted}>{pathStr()}</text>
        </box>
      </Show>

      {/* Blocked path warning */}
      <Show when={perm.blockedPath}>
        <box paddingLeft={1}>
          <text fg={colors.status.warning} attributes={TextAttributes.DIM}>
            {"\u26A0 Blocked path: " + perm.blockedPath}
          </text>
        </box>
      </Show>

      {/* Description from SDK */}
      <Show when={description}>
        <box paddingLeft={1}>
          <text fg={colors.text.muted}>{description}</text>
        </box>
      </Show>

      {/* Decision reason hint */}
      <Show when={perm.decisionReason}>
        <box paddingLeft={1}>
          <text fg={colors.text.muted}>
            {"Reason: " + perm.decisionReason}
          </text>
        </box>
      </Show>

      {/* Content preview between dashed borders — scrollable to fit small terminals */}
      <Show when={previewLines()}>
        {(lines: Accessor<PreviewLine[]>) => {
          const lineCount = createMemo(() => lines().length)
          const isTruncated = createMemo(() => lineCount() > maxPreviewHeight())
          const extraLineCount = createMemo(() => lineCount() - maxPreviewHeight())
          const scrollHeight = createMemo(() => Math.min(lineCount(), maxPreviewHeight()))
          return (
          <box flexDirection="column">
            <Divider char={"\u254C"} fg={colors.border.permission} paddingLeft={0} />
            <scrollbox
              height={scrollHeight()}
              maxHeight={maxPreviewHeight()}
              stickyScroll={false}
            >
              <box flexDirection="column">
                <For each={lines()}>
                  {(line, _idx) => {
                    const lineColor = () => {
                      if (line.prefix === "+") return colors.diff.added
                      if (line.prefix === "-") return colors.diff.removed
                      return colors.text.primary
                    }
                    return (
                      <box height={1} paddingLeft={1}>
                        <text fg={lineColor()}>{line.prefix ? `${line.prefix} ${line.text || " "}` : (line.text || " ")}</text>
                      </box>
                    )
                  }}
                </For>
              </box>
            </scrollbox>
            <Show when={isTruncated()}>
              <box height={1} paddingLeft={2}>
                <text fg={colors.text.muted} attributes={TextAttributes.DIM}>{`... ${extraLineCount()} more line${extraLineCount() === 1 ? "" : "s"}`}</text>
              </box>
            </Show>
            <Divider char={"\u254C"} fg={colors.border.permission} paddingLeft={0} />
          </box>
          )
        }}
      </Show>

      {/* Question prompt — always visible */}
      <box height={1} paddingLeft={1} marginTop={previewLines() ? 0 : 1}>
        <text fg={colors.text.primary}>
          {question()}
        </text>
      </box>

      {/* Option 1: Allow (y) */}
      <box height={1} paddingLeft={1}>
        <Show when={selectedOption() === 0}
          fallback={
            <text fg={colors.text.primary}>{"  y. Allow"}</text>
          }
        >
          <text fg={colors.border.permission}>
            {"\u276F y. Allow"}
          </text>
        </Show>
      </box>

      {/* Option 2: Always allow (a) — with lock icon */}
      <box height={1} paddingLeft={1}>
        <Show when={selectedOption() === 1}
          fallback={
            <text fg={colors.text.primary} attributes={TextAttributes.BOLD}>
              {"  a. \uD83D\uDD12 " + opt2()}
            </text>
          }
        >
          <text fg={colors.border.permission} attributes={TextAttributes.BOLD}>
            {"\u276F a. \uD83D\uDD12 " + opt2()}
          </text>
        </Show>
      </box>

      {/* Option 3: Deny (n) */}
      <box height={1} paddingLeft={1}>
        <Show when={selectedOption() === 2}
          fallback={
            <text fg={colors.text.muted}>{"  n. Deny"}</text>
          }
        >
          <text fg={colors.border.permission}>{"\u276F n. Deny"}</text>
        </Show>
      </box>

      {/* Option 4: Deny for session (d) */}
      <box height={1} paddingLeft={1}>
        <Show when={selectedOption() === 3}
          fallback={
            <text fg={colors.text.muted}>{"  d. Deny for session"}</text>
          }
        >
          <text fg={colors.border.permission}>{"\u276F d. Deny for session"}</text>
        </Show>
      </box>

      {/* Footer hints */}
      <box paddingLeft={1} marginTop={1}>
        <ShortcutBar>
          <ShortcutHint shortcut={"\u2191\u2193"} action="navigate" />
          <ShortcutHint shortcut="y/a/n/d" action="shortcut" />
          <ShortcutHint shortcut="Enter" action="confirm" />
        </ShortcutBar>
      </box>
    </box>
  )
}
