/**
 * TUI `FrontendBridge` — the OpenTUI-backed implementation of
 * `FrontendBridge` from `src/commands/frontend.ts`.
 *
 * Exports a stable singleton `tuiFrontendBridge` that slash commands
 * receive via `CommandContext.frontend`. The renderer is resolved lazily
 * through a module-level setter because `useRenderer()` only returns a
 * value once the SolidJS tree has mounted.
 *
 * Maps panel kinds to concrete SolidJS components in `src/tui/panels/`,
 * implements screenshot via the renderer's `currentRenderBuffer`, and
 * routes clipboard copy to the shared `copyToClipboard` helper.
 *
 * This file lives in the TUI frontend — frontend-neutral command code
 * must never import from here.
 */

import type { CliRenderer, CapturedLine } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { join } from "path"
import { mkdirSync, writeFileSync } from "fs"
import { homedir } from "os"
import type {
  ApplyStatusBarResult,
  ApplyThemeResult,
  FrontendBridge,
  HelpPanelData,
  AbPanelData,
  PanelKind,
  StatusBarSummary,
  ThemeSummary,
} from "../../commands/frontend"
import { log } from "../../utils/logger"
import { copyToClipboard } from "../../utils/clipboard"
import { showModal, dismissModal } from "./context/modal"
import { HelpPanel } from "./panels/help-panel"
import { HotkeysPanel } from "./panels/hotkeys-panel"
import { AboutPanel } from "./panels/about-panel"
import { AbPanel } from "./panels/ab-panel"
import { listThemes, getTheme } from "./theme/registry"
import { applyTheme, getCurrentThemeId } from "./theme/tokens"
import {
  listStatusBars,
  getStatusBar,
} from "./status-bar/registry"
import {
  applyStatusBar,
  getCurrentStatusBarId,
} from "./status-bar/active"
import { openSideChatOverlay } from "./components/side-chat-overlay"
import type { AgentBackend } from "../../protocol/types"

const SCREENSHOT_DIR = join(homedir(), ".bantai", "screenshots")

// ---------------------------------------------------------------------------
// Module-level renderer slot — set by the TUI app after `useRenderer()`
// ---------------------------------------------------------------------------

let _renderer: CliRenderer | null = null

/** Wire the current CliRenderer so `screenshot()` can access the buffer. */
export function setTuiBridgeRenderer(renderer: CliRenderer | null): void {
  _renderer = renderer
}

// ---------------------------------------------------------------------------
// Screenshot helpers — ANSI serialisation of the OpenTUI render buffer
// ---------------------------------------------------------------------------

function rgbaToAnsi(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`
}

function bgRgbaToAnsi(r: number, g: number, b: number): string {
  return `\x1b[48;2;${r};${g};${b}m`
}

function attrsToAnsi(attributes: number): string {
  const base = attributes & 0xff
  const codes: number[] = []
  if (base & TextAttributes.BOLD) codes.push(1)
  if (base & TextAttributes.DIM) codes.push(2)
  if (base & TextAttributes.ITALIC) codes.push(3)
  if (base & TextAttributes.UNDERLINE) codes.push(4)
  if (base & TextAttributes.BLINK) codes.push(5)
  if (base & TextAttributes.INVERSE) codes.push(7)
  if (base & TextAttributes.HIDDEN) codes.push(8)
  if (base & TextAttributes.STRIKETHROUGH) codes.push(9)
  return codes.length ? `\x1b[${codes.join(";")}m` : ""
}

function spanLinesToAnsi(lines: CapturedLine[]): string {
  const result: string[] = []
  for (const line of lines) {
    const parts: string[] = []
    for (const span of line.spans) {
      const [fr, fg, fb] = span.fg.toInts()
      const [br, bg, bb] = span.bg.toInts()
      parts.push(
        `${attrsToAnsi(span.attributes)}${rgbaToAnsi(fr!, fg!, fb!)}${bgRgbaToAnsi(br!, bg!, bb!)}${span.text}\x1b[0m`,
      )
    }
    result.push(parts.join(""))
  }
  return result.join("\n")
}

function spanLinesToPlainText(lines: CapturedLine[]): string {
  return lines.map((line) => line.spans.map((s) => s.text).join("")).join("\n")
}

// ---------------------------------------------------------------------------
// The singleton bridge
// ---------------------------------------------------------------------------

export const tuiFrontendBridge: FrontendBridge = {
  openPanel(kind: PanelKind, data?: unknown): void {
    switch (kind) {
      case "help":
        showModal(() => <HelpPanel {...(data as HelpPanelData)} />)
        return
      case "hotkeys":
        showModal(HotkeysPanel)
        return
      case "about":
        showModal(AboutPanel)
        return
      case "ab":
        showModal(() => <AbPanel {...(data as AbPanelData)} />)
        return
      default:
        log.warn("TuiFrontendBridge: unknown panel kind", { kind })
    }
  },

  dismissPanel(): void {
    dismissModal()
  },

  async screenshot(o): Promise<{ txtPath: string; ansPath: string } | null> {
    if (!_renderer) {
      log.warn("TuiFrontendBridge.screenshot: no renderer available")
      return null
    }
    const buffer = _renderer.currentRenderBuffer
    const lines = buffer.getSpanLines()
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const baseName = o?.baseName?.trim() || `screenshot-${timestamp}`
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    const txtPath = join(SCREENSHOT_DIR, `${baseName}.txt`)
    const ansPath = join(SCREENSHOT_DIR, `${baseName}.ans`)
    writeFileSync(txtPath, spanLinesToPlainText(lines))
    writeFileSync(ansPath, spanLinesToAnsi(lines))
    return { txtPath, ansPath }
  },

  async copy(text: string): Promise<boolean> {
    try {
      await copyToClipboard(text)
      return true
    } catch (err) {
      log.warn("TuiFrontendBridge.copy failed", { error: String(err) })
      return false
    }
  },

  listThemes(): ThemeSummary[] {
    return listThemes().map((t) => ({ id: t.id, name: t.name }))
  },

  applyTheme(id: string): ApplyThemeResult {
    const theme = getTheme(id)
    if (!theme) {
      const available = listThemes().map((t) => t.id).join(", ")
      return {
        ok: false,
        error: `Unknown theme: "${id}". Available: ${available}`,
      }
    }
    if (id === getCurrentThemeId()) {
      return { ok: true, appliedName: theme.name }
    }
    applyTheme(theme)
    return { ok: true, appliedName: theme.name }
  },

  currentThemeId(): string | undefined {
    return getCurrentThemeId()
  },

  listStatusBars(): StatusBarSummary[] {
    return listStatusBars().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
    }))
  },

  applyStatusBar(id: string): ApplyStatusBarResult {
    const result = applyStatusBar(id)
    const preset = getStatusBar(result.id)
    return {
      id: result.id,
      appliedName: preset?.name,
      fellBack: result.fellBack,
      requestedId: result.requestedId,
    }
  },

  currentStatusBarId(): string | undefined {
    return getCurrentStatusBarId()
  },

  openSideChat(backend: AgentBackend, question: string): boolean {
    return openSideChatOverlay(backend, question)
  },
}
