/**
 * HotkeysPanel — show all keyboard shortcuts as a rich modal overlay.
 *
 * Groups shortcuts by category with aligned columns. Consumed by the TUI
 * `FrontendBridge` when a command calls `ctx.frontend?.openPanel("hotkeys")`.
 */

import { For } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { colors } from "../theme/tokens"

interface ShortcutEntry {
  key: string
  desc: string
}

interface ShortcutGroup {
  title: string
  entries: ShortcutEntry[]
}

const groups: ShortcutGroup[] = [
  {
    title: "Emacs Editing",
    entries: [
      { key: "Ctrl+A",     desc: "Beginning of line" },
      { key: "Ctrl+E",     desc: "End of line" },
      { key: "Ctrl+F",     desc: "Forward one character" },
      { key: "Ctrl+B",     desc: "Backward one character" },
      { key: "Ctrl+N",     desc: "Next line" },
      { key: "Ctrl+P",     desc: "Previous line" },
      { key: "Ctrl+D",     desc: "Delete character forward" },
      { key: "Ctrl+H",     desc: "Delete character backward" },
      { key: "Ctrl+T",     desc: "Transpose characters" },
      { key: "Ctrl+U",     desc: "Kill to start of line" },
      { key: "Ctrl+W",     desc: "Kill word backward" },
      { key: "Ctrl+Y",     desc: "Yank (paste from clipboard)" },
      { key: "Alt+F",      desc: "Forward one word" },
      { key: "Alt+B",      desc: "Backward one word" },
      { key: "Alt+D",      desc: "Delete word forward" },
    ],
  },
  {
    title: "View Controls",
    entries: [
      { key: "Ctrl+O",       desc: "Toggle collapsed / expanded tool view" },
      { key: "Ctrl+Shift+E", desc: "Toggle show-all / collapsed view" },
      { key: "Ctrl+Shift+T", desc: "Toggle thinking blocks" },
    ],
  },
  {
    title: "Model & Mode",
    entries: [
      { key: "Ctrl+Shift+P", desc: "Cycle to next model" },
      { key: "Shift+Tab",    desc: "Cycle permission mode" },
    ],
  },
  {
    title: "Navigation",
    entries: [
      { key: "Ctrl+K",           desc: "Scroll up one line" },
      { key: "Ctrl+J",           desc: "Scroll down one line" },
      { key: "Ctrl+,",           desc: "Previous message" },
      { key: "Ctrl+.",           desc: "Next message" },
      { key: "Ctrl+Shift+K",     desc: "Previous message (alias)" },
      { key: "Ctrl+Shift+J",     desc: "Next message (alias)" },
      { key: "Ctrl+Shift+Cmd+K", desc: "Prev user msg / turn-end reply" },
      { key: "Ctrl+Shift+Cmd+J", desc: "Next user msg / turn-end reply" },
      { key: "Ctrl+L",           desc: "Scroll to bottom" },
    ],
  },
  {
    title: "Other Editing",
    entries: [
      { key: "Ctrl+G",         desc: "Open external editor ($EDITOR)" },
      { key: "Ctrl+Shift+G",   desc: "Edit last assistant response in $EDITOR" },
      { key: "Ctrl+V",         desc: "Paste from system clipboard" },
      { key: "Ctrl+Shift+X",   desc: "Clear image attachments" },
    ],
  },
  {
    title: "Session",
    entries: [
      { key: "Ctrl+C",         desc: "Interrupt task / clear input" },
      { key: "Ctrl+D x2",      desc: "Exit application (double-press)" },
      { key: "Ctrl+R",         desc: "History search" },
      { key: "Ctrl+Shift+B",   desc: "Background / foreground toggle" },
    ],
  },
]

// Fixed width for the key column to ensure alignment.
// Keep narrow enough to fit at 100-col terminals (border+padding = ~12 cols
// overhead). Set to 16 so the widest entry ("Ctrl+Shift+Cmd+K") fits without
// overflowing into the description column.
const KEY_COL_WIDTH = 16

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length)
}

function ShortcutGroupView(props: { group: ShortcutGroup }) {
  return (
    <box flexDirection="column" marginTop={1}>
      <text
        fg={colors.accent.primary}
        attributes={TextAttributes.BOLD}
      >
        {"  "}{props.group.title}
      </text>
      <box marginTop={0} flexDirection="column">
        <For each={props.group.entries}>
          {(entry) => (
            <text fg={colors.text.secondary}>{"    "}{padRight(entry.key, KEY_COL_WIDTH + 2)}{entry.desc}</text>
          )}
        </For>
      </box>
    </box>
  )
}

export function HotkeysPanel() {
  return (
    <box flexDirection="column" padding={2}>
      <box
        borderStyle="single"
        borderColor={colors.border.default}
        flexDirection="column"
        padding={2}
      >
        <text
          fg={colors.accent.primary}
          attributes={TextAttributes.BOLD}
        >
          {"Keyboard Shortcuts"}
        </text>

        <scrollbox flexGrow={1}>
          <For each={groups}>
            {(group) => <ShortcutGroupView group={group} />}
          </For>

          <box marginTop={1}>
            <text fg={colors.text.muted}>
              {"  Press Escape to close"}
            </text>
          </box>
        </scrollbox>
      </box>
    </box>
  )
}
