/**
 * Input utilities — shared refs, cursor/focus management, history, and pure helpers.
 *
 * Extracted from input-area.tsx so the InputArea component stays under ~500 lines.
 * Module-level mutable state lives here; the component wires it up on mount.
 */

import type { TextareaRenderable, CliRenderer } from "@opentui/core"
import type { Block, ImageContent } from "../../../protocol/types"
import { tmpdir } from "os"
import { join } from "path"
import { writeFileSync, readFileSync, unlinkSync } from "fs"
import { log } from "../../../utils/logger"
import { parseCommandString } from "./command-parser"

// ---------------------------------------------------------------------------
// Module-level shared refs — set by InputArea on mount
// ---------------------------------------------------------------------------

/** Module-level ref so exported functions can access the textarea */
export let _sharedTextareaRef: TextareaRenderable | undefined

/** Set the shared textarea ref (called by InputArea on mount) */
export function setSharedTextareaRef(ref: TextareaRenderable | undefined): void {
  _sharedTextareaRef = ref
}

/** Module-level callback to reset line count when clearInput() is called externally */
export let _resetLineCount: (() => void) | undefined

/** Register the reset callback (called by InputArea on mount) */
export function setResetLineCount(fn: (() => void) | undefined): void {
  _resetLineCount = fn
}

/** Module-level callback to recalculate line count after programmatic text changes */
let _updateLineCount: (() => void) | undefined

/** Register the update callback (called by InputArea on mount) */
export function setUpdateLineCount(fn: (() => void) | undefined): void {
  _updateLineCount = fn
}

// ---------------------------------------------------------------------------
// Cursor visibility — single source of truth
// ---------------------------------------------------------------------------
// The textarea shows a cursor whenever it has focus. Rather than fighting
// between the reactive `focused` prop and imperative `.blur()`/`.focus()`
// calls, we track intent via a module-level flag that the `focused` prop
// reads. `hideCursor()` / `showCursor()` toggle this flag AND immediately
// call `.blur()`/`.focus()` for instant effect.
// ---------------------------------------------------------------------------
export let _cursorHidden = false

/**
 * Hide the textarea cursor. The textarea remains mounted but loses focus
 * so the terminal cursor disappears. Keyboard events still reach
 * useKeyboard() handlers — only text insertion is paused.
 */
export function hideCursor(): void {
  _cursorHidden = true
  _sharedTextareaRef?.blur()
}

/**
 * Show the textarea cursor. Restores focus so text insertion and the
 * terminal cursor both work again.
 */
export function showCursor(): void {
  _cursorHidden = false
  _sharedTextareaRef?.focus()
}

/** Whether the cursor is intentionally hidden. */
export function isCursorHidden(): boolean {
  return _cursorHidden
}

// ---------------------------------------------------------------------------
// Scroll-to-bottom callback — set by ConversationView via registerScrollToBottom
// ---------------------------------------------------------------------------
export let _scrollToBottom: (() => void) | undefined

/**
 * Register a callback to scroll the viewport to bottom.
 * Called by ConversationView to avoid circular imports.
 */
export function registerScrollToBottom(fn: () => void): void {
  _scrollToBottom = fn
}

// ---------------------------------------------------------------------------
// Image attachments for current message (cleared on submit)
// ---------------------------------------------------------------------------
export let imageAttachments: ImageContent[] = []
let _imageCounter = 0

/** Get the current image counter value */
export function getImageCounter(): number {
  return _imageCounter
}

/** Increment the image counter and return the new value */
export function nextImageCounter(): number {
  return ++_imageCounter
}

/** Reset the image counter to zero */
export function resetImageCounter(): void {
  _imageCounter = 0
}

/** Module-level setter so exported functions can update the reactive signal */
export let _setAttachedImageCount: ((n: number) => void) | undefined

/** Register the reactive setter (called by InputArea on mount) */
export function setAttachedImageCountSetter(fn: ((n: number) => void) | undefined): void {
  _setAttachedImageCount = fn
}

/** Get the current number of attached images */
export function getImageAttachmentCount(): number {
  return imageAttachments.length
}

/** Clear all image attachments */
export function clearImageAttachments(): void {
  imageAttachments = []
  _imageCounter = 0
  _setAttachedImageCount?.(0)
}

/** Reset image attachment state (called on submit) */
export function resetImageAttachments(): void {
  imageAttachments = []
  _imageCounter = 0
}

// ---------------------------------------------------------------------------
// Smart paste truncation
// ---------------------------------------------------------------------------
export const PASTE_TRUNCATION_THRESHOLD = 10_000
export const PASTE_PREVIEW_LENGTH = 500
export const pasteStore = new Map<number, string>()
export let pasteRefCounter = 0

/**
 * If text exceeds PASTE_TRUNCATION_THRESHOLD, store the full content in
 * pasteStore and return a truncated preview with a reference marker.
 * Otherwise return the text unchanged.
 */
export function truncatePastedText(text: string): string {
  if (text.length <= PASTE_TRUNCATION_THRESHOLD) return text

  pasteRefCounter++
  const refNum = pasteRefCounter
  pasteStore.set(refNum, text)

  const lineCount = text.split("\n").length
  const preview = text.slice(0, PASTE_PREVIEW_LENGTH)
  const truncatedLines = lineCount - preview.split("\n").length
  const marker = `\n[...Pasted text #${refNum}: +${truncatedLines} more lines, ${text.length.toLocaleString()} chars total...]`

  log.info("Large paste truncated", { refNum, chars: text.length, lines: lineCount })

  return preview + marker
}

/**
 * Expand paste reference markers in message text back to the full pasted
 * content before sending to the backend.  Each marker has the form:
 *   [...Pasted text #N: +M more lines, C chars total...]
 * The preview text preceding it (first 500 chars of the paste) is kept;
 * the marker is replaced with the remaining content.
 */
export function expandPasteRefs(text: string): string {
  let expanded = text
  for (const [refNum, fullContent] of pasteStore.entries()) {
    const markerRegex = new RegExp(`\\[\\.\\.\\.Pasted text #${refNum}:[^\\]]*\\]`)
    if (markerRegex.test(expanded)) {
      expanded = expanded.replace(markerRegex, fullContent.slice(PASTE_PREVIEW_LENGTH))
    }
  }
  return expanded
}

// ---------------------------------------------------------------------------
// Input history for Up/Down arrow recall
// ---------------------------------------------------------------------------
export const inputHistory: string[] = []
let _historyIndex = -1
let _savedInput = ""

export function getHistoryIndex(): number {
  return _historyIndex
}

export function setHistoryIndex(n: number): void {
  _historyIndex = n
}

export function getSavedInput(): string {
  return _savedInput
}

export function setSavedInput(s: string): void {
  _savedInput = s
}

// ---------------------------------------------------------------------------
// Pure utility functions
// ---------------------------------------------------------------------------

/**
 * Calculate the number of visual lines a text occupies given a column width.
 * Used to set the textarea height — must match the textarea's actual wrapping.
 *
 * @param text - The raw text content
 * @param availableWidth - The textarea's column width (terminal width minus prefix and padding)
 * @returns Number of visual lines (minimum 1)
 */
export function computeVisualLineCount(text: string, availableWidth: number): number {
  const width = Math.max(availableWidth, 1)
  let totalLines = 0
  for (const line of text.split("\n")) {
    totalLines += Math.max(1, Math.ceil(line.length / width))
  }
  return totalLines
}

/** Plain Enter submits; Shift+Enter / Cmd+Enter insert a newline instead. */
export function isSubmitKey(event: Pick<import("@opentui/core").KeyEvent, "name" | "shift" | "meta" | "super">): boolean {
  return event.name === "return" && !event.shift && !event.meta && !event.super
}

/**
 * Whether a cursor is on the first visual (display) row of the document.
 *
 * `visualRow` from OpenTUI's `VisualCursor` is viewport-relative; we add
 * the viewport's `offsetY` (lines scrolled out above) to get the absolute
 * visual row. Wrapped long lines and explicit `\n` newlines both produce
 * additional visual rows, so this is the correct boundary to gate
 * "up arrow recalls history" on.
 */
export function isOnFirstVisualLine(visualRow: number, viewportOffsetY: number): boolean {
  return visualRow + viewportOffsetY <= 0
}

/**
 * Whether a cursor is on the last visual (display) row of the document.
 *
 * Mirror of `isOnFirstVisualLine`; gates "down arrow steps forward in
 * history". `totalVisualLines` is `editorView.getTotalVirtualLineCount()`.
 */
export function isOnLastVisualLine(
  visualRow: number,
  viewportOffsetY: number,
  totalVisualLines: number,
): boolean {
  return visualRow + viewportOffsetY >= Math.max(totalVisualLines, 1) - 1
}

/**
 * Read the textarea's cursor + viewport state and decide whether the cursor
 * is on the first visual line. Returns `true` when the ref is missing — the
 * caller's up-arrow path then falls through to history recall, matching the
 * pre-fix behavior on a freshly mounted (or torn down) textarea.
 */
export function textareaCursorOnFirstVisualLine(textareaRef: import("@opentui/core").TextareaRenderable | undefined): boolean {
  if (!textareaRef) return true
  const vc = textareaRef.visualCursor
  const vp = textareaRef.editorView.getViewport()
  return isOnFirstVisualLine(vc.visualRow, vp.offsetY)
}

/** Mirror of {@link textareaCursorOnFirstVisualLine} for the bottom edge. */
export function textareaCursorOnLastVisualLine(textareaRef: import("@opentui/core").TextareaRenderable | undefined): boolean {
  if (!textareaRef) return true
  const vc = textareaRef.visualCursor
  const vp = textareaRef.editorView.getViewport()
  const total = textareaRef.editorView.getTotalVirtualLineCount()
  return isOnLastVisualLine(vc.visualRow, vp.offsetY, total)
}

/** Truncate a file path to fit the terminal, showing the tail end */
export function truncatePath(path: string, maxLen: number = 70): string {
  if (path.length <= maxLen) return path
  return "..." + path.slice(-(maxLen - 3))
}

// ---------------------------------------------------------------------------
// Exported functions for external callers
// ---------------------------------------------------------------------------

/**
 * Clear the input area text. Called by the global Ctrl+C handler in Layout
 * when the session is IDLE.
 * Returns true if there was text to clear, false if already empty.
 */
export function clearInput(): boolean {
  if (!_sharedTextareaRef) return false
  const text = _sharedTextareaRef.plainText?.trim()
  if (!text && imageAttachments.length === 0) return false
  _sharedTextareaRef.clear()
  _resetLineCount?.()
  imageAttachments = []
  pasteStore.clear()
  return true
}

/**
 * Re-focus the textarea. Called after scroll or any event that may have
 * shifted OpenTUI focus away from the input area.
 *
 * In native Claude Code the textarea always captures keyboard input —
 * the user can scroll up to read history, then just start typing.
 * This function ensures the same behavior by reclaiming focus.
 *
 * Only reclaims focus when the cursor is not intentionally hidden.
 */
export function refocusInput(): void {
  if (!_cursorHidden) {
    _sharedTextareaRef?.focus()
  }
}

/**
 * Blur the textarea so the cursor disappears.
 * Called when the user scrolls away from the input area (Ctrl+Up).
 */
export function blurInput(): void {
  _sharedTextareaRef?.blur()
}

/**
 * Check whether the input textarea currently has non-whitespace text.
 * Used by the Ctrl+D handler to only trigger exit when the editor is empty.
 */
export function hasInputText(): boolean {
  if (!_sharedTextareaRef) return false
  return Boolean(_sharedTextareaRef.plainText?.trim())
}

/**
 * Get a copy of the input history array (for history search).
 * Returns entries in chronological order (oldest first).
 */
export function getInputHistory(): string[] {
  return inputHistory.slice()
}

/**
 * Set the textarea content programmatically (e.g., from history search selection).
 * Clears existing text and inserts the new text.
 */
export function setInputText(text: string): void {
  if (!_sharedTextareaRef) return
  _sharedTextareaRef.clear()
  if (text) _sharedTextareaRef.insertText(text)
  _updateLineCount?.()
}

// ---------------------------------------------------------------------------
// Helper functions extracted from InputArea component
// ---------------------------------------------------------------------------

/**
 * Extract the full text of the most recent assistant message from the block list.
 * Iterates in reverse to find the last block with `type === "assistant"`.
 * Returns undefined if no assistant block exists.
 */
export function getLastAssistantText(blocks: Block[]): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!
    if (block.type === "assistant") {
      return block.text
    }
  }
  return undefined
}

/**
 * Open the user's preferred editor ($VISUAL or $EDITOR, falling back to vi)
 * with initial content. On save+quit, the edited content replaces the
 * textarea input. The TUI renderer is suspended while the editor runs.
 *
 * When `initialContent` is provided, the editor starts with that text
 * (used by Ctrl+Shift+G to pre-fill with the last assistant response).
 * Otherwise, the editor starts with the current textarea contents
 * (used by Ctrl+G).
 */
export async function openExternalEditor(
  textareaRef: TextareaRenderable | undefined,
  renderer: CliRenderer,
  initialContent?: string,
): Promise<void> {
  const editor = process.env["VISUAL"] || process.env["EDITOR"] || "vi"
  const tmpFile = join(tmpdir(), `bantai-${Date.now()}.md`)

  try {
    const currentText = initialContent ?? textareaRef?.plainText ?? ""
    writeFileSync(tmpFile, currentText)
    renderer.suspend()

    try {
      renderer.currentRenderBuffer.clear()
      const parts = parseCommandString(editor)
      const proc = Bun.spawn([...parts, tmpFile], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })
      await proc.exited

      const newText = readFileSync(tmpFile, "utf-8").trimEnd()
      if (textareaRef) {
        textareaRef.clear()
        if (newText) {
          textareaRef.insertText(newText)
        }
      }
    } finally {
      renderer.currentRenderBuffer.clear()
      renderer.resume()
      renderer.requestRender()
    }
  } catch (err) {
    log.warn("External editor failed", { error: String(err) })
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
}

/** Helper: attach an image and insert a pill into the textarea */
export function attachImage(
  image: ImageContent,
  textareaRef: TextareaRenderable | undefined,
  setAttachedImageCount: (n: number) => void,
  updateLineCount: () => void,
  startPasteGuard: () => void,
) {
  const imgNum = nextImageCounter()
  imageAttachments.push(image)
  setAttachedImageCount(imageAttachments.length)
  if (textareaRef) {
    startPasteGuard()
    textareaRef.insertText(`[Image #${imgNum}]`)
    updateLineCount()
  }
}

/** Helper: reset all input state after submit or shell command */
export function resetInputState(
  textareaRef: TextareaRenderable,
  setLineCount: (n: number) => void,
  setAttachedImageCount: (n: number) => void,
) {
  textareaRef.clear()
  setLineCount(1)
  imageAttachments.length = 0
  resetImageCounter()
  setAttachedImageCount(0)
  pasteStore.clear()
}
