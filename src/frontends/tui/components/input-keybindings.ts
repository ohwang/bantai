/**
 * Input keybinding handlers — extracted from InputArea component.
 *
 * Exports a `createKeyHandler()` factory that takes reactive dependencies
 * and returns the `handleKeyDown` function. This keeps keybinding logic
 * testable in isolation from SolidJS component wiring.
 */

import type { KeyEvent, TextareaRenderable, CliRenderer } from "@opentui/core"
import type { AgentEvent, Block } from "../../../protocol/types"
import { findLongestCommonPrefix, matchAtTrigger, parsePathPrefix } from "./file-autocomplete"

/** Discriminated union for autocomplete modes */
export type AutocompleteMode = "slash" | "file" | null

/** Shape of items in the autocomplete dropdown */
export interface AutocompleteItem {
  name: string
  description: string
  argumentHint?: string
  type?: string
  /** For file mode: true when the entry is a directory (path ends with `/`). */
  isDirectory?: boolean
}

/** Which action was taken on a file-mode suggestion. */
export type FileAcceptAction = "enter" | "tab"
import { readClipboard, readClipboardImage, isImageFilePath, readImageFile } from "../../../utils/clipboard"
import { log } from "../../../utils/logger"
import { toast } from "../context/toast"
import {
  _scrollToBottom,
  imageAttachments,
  resetImageCounter,
  pasteStore,
  inputHistory,
  getHistoryIndex,
  setHistoryIndex,
  getSavedInput,
  setSavedInput,
  isSubmitKey,
  truncatePastedText,
  openExternalEditor,
  getLastAssistantText,
  attachImage,
} from "./input-utils"

// ---------------------------------------------------------------------------
// Dependency interfaces — what the factory needs from the component
// ---------------------------------------------------------------------------

/** Reactive signal accessors passed from the component */
export interface KeyHandlerSignals {
  isDisabled: () => boolean
  showAutocomplete: () => boolean
  autocompleteItems: () => AutocompleteItem[]
  autocompleteMode: () => AutocompleteMode
  selectedIndex: () => number
  setSelectedIndex: (n: number) => void
  setCompletionHint: (s: string) => void
  setLineCount: (n: number) => void
  setAttachedImageCount: (n: number) => void
}

/** Mutable state container for paste guard and tab completion */
export interface KeyHandlerMutableState {
  isPasting: boolean
  isPastingTimer: ReturnType<typeof setTimeout> | undefined
  lastCtrlVTime: number
  tabIndex: number
  tabMatches: string[]
  lastTabText: string
}

/** Callback functions passed from the component */
export interface KeyHandlerCallbacks {
  getTextareaRef: () => TextareaRenderable | undefined
  updateLineCount: () => void
  updateAutocomplete: (text: string) => void
  dismissAutocomplete: (options?: { preserveText?: boolean }) => void
  setTextareaContent: (text: string) => void
  /** Accept a file-mode suggestion. `action` controls dir drill-in vs dismiss. */
  acceptFile: (item: AutocompleteItem, action: FileAcceptAction) => void
  selectCommand: (command: { name: string }) => void
  submit: () => void
  startPasteGuard: () => void
  pushEvent: (event: AgentEvent) => void
  searchCommands: (query: string) => { name: string }[]
  getCwd: () => string
  getBlocks: () => Block[]
}

/**
 * Create a `handleKeyDown` function bound to the component's reactive state.
 *
 * This factory captures the dependencies once and returns a stable function
 * reference suitable for passing to `onKeyDown`.
 */
export function createKeyHandler(
  signals: KeyHandlerSignals,
  state: KeyHandlerMutableState,
  callbacks: KeyHandlerCallbacks,
  renderer: CliRenderer,
): (e: KeyEvent) => void {
  const {
    isDisabled,
    showAutocomplete,
    autocompleteItems,
    autocompleteMode,
    selectedIndex,
    setSelectedIndex,
    setCompletionHint,
    setLineCount,
    setAttachedImageCount,
  } = signals

  const {
    getTextareaRef,
    updateLineCount,
    updateAutocomplete,
    dismissAutocomplete,
    setTextareaContent,
    acceptFile,
    selectCommand,
    submit,
    startPasteGuard,
    pushEvent,
    searchCommands,
    getCwd,
    getBlocks,
  } = callbacks

  /** Schedule autocomplete + line count update after a key is processed */
  const schedulePostKeyUpdate = () => {
    queueMicrotask(() => {
      const text = getTextareaRef()?.plainText ?? ""
      updateAutocomplete(text)
      updateLineCount()
    })
  }

  /** Schedule line count + autocomplete update after a deletion */
  const scheduleDeleteUpdate = () => {
    queueMicrotask(() => {
      updateLineCount()
      updateAutocomplete(getTextareaRef()?.plainText ?? "")
    })
  }

  return (e: KeyEvent) => {
    if (isDisabled()) return

    // Snap back to bottom when the user actually types into the input — but
    // NOT for modifier shortcuts like Cmd+C (copy selection), Ctrl+A, etc.
    // Those are commands, not typed input. Snapping the viewport on Cmd+C
    // would wipe the user's scrolled-up reading position when they just
    // wanted to copy text. Kitty's keyboard protocol forwards Cmd as
    // `super`, so exclude both `meta` and `super`.
    const isTypedInput =
      !e.ctrl && !e.meta && !e.super && !e.option && e.name.length === 1
    const isEditingKey =
      e.name === "return" ||
      e.name === "backspace" ||
      e.name === "delete" ||
      e.name === "tab"
    if (isTypedInput || isEditingKey) {
      _scrollToBottom?.()
    }

    if (state.isPasting && e.name === "return") {
      e.preventDefault()
      return
    }

    // ── Ctrl+V = paste from system clipboard (image first, fall back to text) ──
    if (e.ctrl && e.name === "v") {
      e.preventDefault()
      state.lastCtrlVTime = Date.now()

      readClipboardImage().then((result) => {
        if (result.ok) {
          if (result.resized) toast.info("Image resized to fit size limit")
          attachImage(result.image, getTextareaRef(), setAttachedImageCount, updateLineCount, startPasteGuard)
          return
        }
        if (result.reason === "too_large") {
          toast.warn("Image too large (>5MB). Try a smaller screenshot.")
          return
        }
        return readClipboard().then(async (raw) => {
          if (!raw) return
          const text = raw.replace(/\r\n?/g, "\n")

          if (isImageFilePath(text)) {
            const img = await readImageFile(text)
            if (img) {
              attachImage(img, getTextareaRef(), setAttachedImageCount, updateLineCount, startPasteGuard)
              toast.success(`Attached image: ${text.split("/").pop()}`)
              return
            }
          }

          const insertText = truncatePastedText(text)
          const ref = getTextareaRef()
          if (ref) {
            startPasteGuard()
            ref.insertText(insertText)
            updateLineCount()
          }
        }).catch((err) => {
          log.warn("Ctrl+V text clipboard read failed", { error: String(err) })
          pushEvent({ type: "system_message", text: "Clipboard read failed — try pasting with your terminal's built-in paste", ephemeral: true })
        })
      }).catch((err) => {
        log.warn("Ctrl+V clipboard read failed", { error: String(err) })
        pushEvent({ type: "system_message", text: "Clipboard read failed — try pasting with your terminal's built-in paste", ephemeral: true })
      })
      return
    }

    // ── Ctrl+Shift+X = clear all image attachments ──
    if (e.ctrl && e.shift && e.name === "x") {
      e.preventDefault()
      if (imageAttachments.length > 0) {
        imageAttachments.length = 0
        resetImageCounter()
        setAttachedImageCount(0)
        toast.info("Cleared image attachments")
        const text = getTextareaRef()?.plainText ?? ""
        const cleaned = text.replace(/\[Image #\d+\]/g, "").trim()
        getTextareaRef()?.clear()
        if (cleaned) getTextareaRef()?.insertText(cleaned)
        updateLineCount()
      }
      return
    }

    // ── Escape = dismiss autocomplete (preserving text), then hint, then clear input ──
    if (e.name === "escape") {
      e.preventDefault()
      if (showAutocomplete()) {
        const wasFile = autocompleteMode() === "file"
        // Preserve the typed `@query` for file mode (matches Claude Code).
        // The dismissedForInput guard inside dismissAutocomplete prevents
        // the dropdown from immediately re-opening on the unchanged text.
        dismissAutocomplete({ preserveText: wasFile })
        if (!wasFile) {
          getTextareaRef()?.clear()
          setLineCount(1)
        }
      } else if (state.tabMatches.length > 0) {
        setCompletionHint("")
        state.tabIndex = -1
        state.tabMatches = []
      } else {
        getTextareaRef()?.clear()
        setLineCount(1)
        imageAttachments.length = 0
        resetImageCounter()
        setAttachedImageCount(0)
        pasteStore.clear()
        setHistoryIndex(-1)
        setSavedInput("")
      }
      return
    }

    // ── Emacs keybindings ──────────────────────────────────────────────

    if (e.ctrl && e.name === "a") {
      e.preventDefault()
      getTextareaRef()?.gotoLineHome()
      return
    }

    if (e.ctrl && e.name === "e") {
      e.preventDefault()
      getTextareaRef()?.gotoLineEnd()
      return
    }

    if (e.ctrl && e.name === "f") {
      e.preventDefault()
      getTextareaRef()?.moveCursorRight()
      return
    }

    if (e.ctrl && !e.shift && e.name === "b") {
      e.preventDefault()
      getTextareaRef()?.moveCursorLeft()
      return
    }

    if (e.ctrl && e.name === "n") {
      e.preventDefault()
      getTextareaRef()?.moveCursorDown()
      return
    }

    // NOTE: Ctrl+P is reserved for the global command palette (VSCode style).
    // Emacs-style previous-line in the textarea is accessible via the Up arrow.

    if (e.ctrl && !e.shift && e.name === "d") {
      e.preventDefault()
      getTextareaRef()?.deleteChar()
      scheduleDeleteUpdate()
      return
    }

    if (e.ctrl && e.name === "h") {
      e.preventDefault()
      getTextareaRef()?.deleteCharBackward()
      scheduleDeleteUpdate()
      return
    }

    if (e.ctrl && e.name === "t") {
      e.preventDefault()
      const textareaRef = getTextareaRef()
      if (!textareaRef) return
      const text = textareaRef.plainText
      const pos = textareaRef.cursorOffset
      if (pos <= 0 || text.length < 2) return
      const swapPos = pos >= text.length ? pos - 2 : pos - 1
      const chars = text.split("")
      const a = chars[swapPos]
      const b = chars[swapPos + 1]
      if (a === undefined || b === undefined) return
      chars[swapPos] = b
      chars[swapPos + 1] = a
      textareaRef.replaceText(chars.join(""))
      textareaRef.cursorOffset = swapPos + 2
      scheduleDeleteUpdate()
      return
    }

    // Ctrl+K (kill-to-end-of-line) was repurposed as a global "scroll
    // conversation up one line" binding (vim convention: j=down, k=up). The
    // global handler in conversation.tsx fires first and calls
    // `preventDefault()`, which both skips this onKeyDown chain AND skips the
    // textarea's built-in `{ name: "k", ctrl: true, action: "delete-to-line-end" }`
    // default — so no explicit no-op handler is needed here. Ctrl+J (LF) gets
    // the same treatment for symmetry. If you need kill-to-end-of-line in the
    // input area, Ctrl+U (kill-to-start) and Ctrl+W (kill-word-backward) are
    // still available.

    if (e.ctrl && e.name === "u") {
      e.preventDefault()
      getTextareaRef()?.deleteToLineStart()
      scheduleDeleteUpdate()
      return
    }

    if (e.ctrl && e.name === "w") {
      e.preventDefault()
      getTextareaRef()?.deleteWordBackward()
      scheduleDeleteUpdate()
      return
    }

    if (e.ctrl && e.name === "y") {
      e.preventDefault()
      readClipboard().then((raw) => {
        if (!raw || !getTextareaRef()) return
        const text = raw.replace(/\r\n?/g, "\n")
        getTextareaRef()!.insertText(text)
        updateLineCount()
      }).catch((err) => {
        log.warn("Ctrl+Y clipboard read failed", { error: String(err) })
      })
      return
    }

    if (e.option && e.name === "f") {
      e.preventDefault()
      getTextareaRef()?.moveWordForward()
      return
    }

    if (e.option && e.name === "b") {
      e.preventDefault()
      getTextareaRef()?.moveWordBackward()
      return
    }

    if (e.option && e.name === "d") {
      e.preventDefault()
      getTextareaRef()?.deleteWordForward()
      scheduleDeleteUpdate()
      return
    }

    // Ctrl+Shift+G = open external editor pre-filled with last assistant response
    if (e.ctrl && e.shift && e.name === "g") {
      e.preventDefault()
      const lastText = getLastAssistantText(getBlocks())
      if (!lastText) {
        pushEvent({ type: "system_message", text: "No assistant response to edit", ephemeral: true })
        return
      }
      openExternalEditor(getTextareaRef(), renderer, lastText)
        .then(() => {
          updateLineCount()
        })
        .catch((err) => {
          log.warn("openExternalEditor (edit response) promise rejected", {
            error: String(err),
          })
          pushEvent({ type: "system_message", text: `External editor failed: ${err instanceof Error ? err.message : String(err)}`, ephemeral: true })
        })
      return
    }

    // Ctrl+G = open external editor
    if (e.ctrl && e.name === "g") {
      e.preventDefault()
      openExternalEditor(getTextareaRef(), renderer)
        .then(() => {
          updateLineCount()
        })
        .catch((err) => {
          log.warn("openExternalEditor promise rejected", {
            error: String(err),
          })
          pushEvent({ type: "system_message", text: `External editor failed: ${err instanceof Error ? err.message : String(err)}`, ephemeral: true })
        })
      return
    }

    // ── Autocomplete navigation (when dropdown is open) ──────────────

    if (showAutocomplete()) {
      const items = autocompleteItems()

      if (e.name === "up") {
        e.preventDefault()
        const idx = selectedIndex()
        setSelectedIndex(idx <= 0 ? items.length - 1 : idx - 1)
        return
      }

      if (e.name === "down") {
        e.preventDefault()
        const idx = selectedIndex()
        setSelectedIndex(idx >= items.length - 1 ? 0 : idx + 1)
        return
      }

      if (isSubmitKey(e)) {
        e.preventDefault()
        const selected = items[selectedIndex()]
        if (selected) {
          if (autocompleteMode() === "file") {
            acceptFile(selected, "enter")
          } else {
            setTextareaContent(`/${selected.name}`)
            dismissAutocomplete()
            submit()
          }
        }
        return
      }

      if (e.name === "tab" && !e.shift) {
        e.preventDefault()
        if (autocompleteMode() === "file") {
          const commonPrefix = findLongestCommonPrefix(items.map((i) => i.name))
          const textareaRef = getTextareaRef()
          const text = textareaRef?.plainText ?? ""
          const cursor = textareaRef?.cursorOffset ?? text.length
          const trigger = matchAtTrigger(text.slice(0, cursor))
          const currentQuery = trigger?.query ?? ""
          const cwd = getCwd()
          const { prefix: pathPrefix, fuzzyQuery } = parsePathPrefix(currentQuery, cwd)

          if (commonPrefix && commonPrefix.length > fuzzyQuery.length) {
            const atIndex = trigger?.atIndex ?? text.length
            const beforeAt = text.slice(0, atIndex)
            const full = "@" + pathPrefix + commonPrefix
            setTextareaContent(beforeAt + full)
            queueMicrotask(() =>
              updateAutocomplete(beforeAt + full),
            )
            return
          }
          const selected = items[selectedIndex()]
          if (selected) acceptFile(selected, "tab")
        } else {
          const selected = items[selectedIndex()]
          if (selected) selectCommand(selected)
        }
        return
      }
    }

    // Clear completion hint on non-Tab keys
    if (e.name !== "tab") {
      setCompletionHint("")
      state.tabIndex = -1
      state.tabMatches = []
    }

    // Enter without shift/meta = submit
    if (isSubmitKey(e)) {
      e.preventDefault()
      submit()
      return
    }

    // Tab = slash command completion (fallback when dropdown is not showing)
    if (e.name === "tab" && !e.shift) {
      e.preventDefault()
      const text = getTextareaRef()?.plainText ?? ""
      if (text.startsWith("/")) {
        const query = text.slice(1).split(/\s/)[0] ?? ""

        if (state.lastTabText !== text || state.tabMatches.length === 0) {
          state.tabMatches = searchCommands(query).map((cmd) => `/${cmd.name}`)
          state.tabIndex = 0
          state.lastTabText = text
        } else {
          state.tabIndex = (state.tabIndex + 1) % state.tabMatches.length
        }

        if (state.tabMatches.length > 0) {
          setTextareaContent(state.tabMatches[state.tabIndex] + " ")
          const others = state.tabMatches
            .filter((_, i) => i !== state.tabIndex)
            .join("  ")
          setCompletionHint(others ? `  ${others}` : "")
        }
      }
      return
    }

    // Up arrow = recall previous history entry
    if (e.name === "up" && !e.ctrl && inputHistory.length > 0) {
      e.preventDefault()
      const hi = getHistoryIndex()
      if (hi === -1) {
        setSavedInput(getTextareaRef()?.plainText ?? "")
        setHistoryIndex(inputHistory.length - 1)
      } else if (hi > 0) {
        setHistoryIndex(hi - 1)
      }
      setTextareaContent(inputHistory[getHistoryIndex()] ?? "")
      updateLineCount()
      return
    }

    // Down arrow = move forward in history
    if (e.name === "down" && !e.ctrl && getHistoryIndex() !== -1) {
      e.preventDefault()
      const hi = getHistoryIndex()
      if (hi < inputHistory.length - 1) {
        setHistoryIndex(hi + 1)
        setTextareaContent(inputHistory[getHistoryIndex()] ?? "")
      } else {
        setHistoryIndex(-1)
        setTextareaContent(getSavedInput())
      }
      updateLineCount()
      return
    }

    // After the key is processed, schedule autocomplete + line count update
    schedulePostKeyUpdate()
  }
}
