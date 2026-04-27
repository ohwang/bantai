/**
 * HelpPanel — rich modal overlay rendering the list of slash commands plus
 * keyboard shortcut reference. Consumed by the TUI `FrontendBridge` when a
 * command calls `ctx.frontend?.openPanel("help", { commands })`.
 *
 * Single-column layout to avoid OpenTUI Zig rendering corruption with
 * flexDirection="row" layouts. All content flows vertically: title,
 * three shortcut sections, commands, footer.
 */

import { For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { colors } from "../theme/tokens"
import type { HelpPanelData } from "../../../commands/frontend"

// ---------------------------------------------------------------------------
// Shortcut data
// ---------------------------------------------------------------------------

interface ShortcutEntry {
  key: string
  label: string
}

const inputModes: ShortcutEntry[] = [
  { key: "/commands", label: "Slash commands" },
  { key: "@file", label: "File path autocomplete" },
  { key: "Ctrl+G", label: "Open external editor" },
]

const navigation: ShortcutEntry[] = [
  { key: "Ctrl+O", label: "Toggle tool detail" },
  { key: "Ctrl+E", label: "Toggle show-all" },
  { key: "Ctrl+T", label: "Toggle thinking" },
  { key: "Ctrl+Shift+P", label: "Cycle model" },
  { key: "Ctrl+Up/Down", label: "Scroll line" },
  { key: "Alt+P/N", label: "Prev / next message" },
  { key: "Ctrl+L", label: "Scroll to bottom" },
]

const actions: ShortcutEntry[] = [
  { key: "Ctrl+C", label: "Interrupt / clear" },
  { key: "Ctrl+D x2", label: "Exit" },
  { key: "Ctrl+V", label: "Paste (text/image)" },
  { key: "Shift+Tab", label: "Cycle perm. mode" },
  { key: "Up/Down", label: "Input history" },
  { key: "Ctrl+R", label: "History search" },
]

interface SectionData {
  title: string
  items: ShortcutEntry[]
}

const sections: SectionData[] = [
  { title: "Input Modes", items: inputModes },
  { title: "Navigation", items: navigation },
  { title: "Actions", items: actions },
]

function formatEntry(entry: ShortcutEntry): string {
  return `  ${entry.key} \u2014 ${entry.label}`
}

function formatCmd(cmd: HelpPanelData["commands"][number]): string {
  const alias = cmd.aliases?.length ? ` (${cmd.aliases.join(", ")})` : ""
  const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : ""
  return `  /${cmd.name}${hint}${alias} -- ${cmd.description}`
}

export function HelpPanel(props: HelpPanelData) {
  const localCmds = () => props.commands.filter((c) => c.type !== "prompt")
  const promptCmds = () => props.commands.filter((c) => c.type === "prompt")

  return (
    <box flexDirection="column" padding={2}>
      <scrollbox stickyScroll={false}>
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
            {"Help -- Keyboard Shortcuts & Commands"}
          </text>

          <For each={sections}>
            {(section) => (
              <box flexDirection="column" marginTop={1}>
                <text
                  fg={colors.accent.primary}
                  attributes={TextAttributes.BOLD}
                >
                  {section.title}
                </text>
                <For each={section.items}>
                  {(entry) => (
                    <text fg={colors.text.secondary}>{formatEntry(entry)}</text>
                  )}
                </For>
              </box>
            )}
          </For>

          <box flexDirection="column" marginTop={1}>
            <text
              fg={colors.accent.primary}
              attributes={TextAttributes.BOLD}
            >
              {"Commands"}
            </text>
            <For each={localCmds()}>
              {(cmd) => (
                <text fg={colors.text.primary}>{formatCmd(cmd)}</text>
              )}
            </For>
          </box>

          <Show when={promptCmds().length > 0}>
            <box flexDirection="column" marginTop={1}>
              <text fg={colors.text.muted}>
                {"Prompt shortcuts (sent to model)"}
              </text>
              <For each={promptCmds()}>
                {(cmd) => (
                  <text fg={colors.text.primary}>{formatCmd(cmd)}</text>
                )}
              </For>
            </box>
          </Show>

          <box flexDirection="column" marginTop={1}>
            <text fg={colors.text.muted}>
              {"  Press Escape to close"}
            </text>
          </box>
        </box>
      </scrollbox>
    </box>
  )
}
