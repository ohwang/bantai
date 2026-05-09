import { describe, expect, it } from "bun:test"
import {
  isOnFirstVisualLine,
  isOnLastVisualLine,
  textareaCursorOnFirstVisualLine,
  textareaCursorOnLastVisualLine,
} from "../../src/frontends/tui/components/input-utils"
import type { TextareaRenderable } from "@opentui/core"

describe("isOnFirstVisualLine", () => {
  it("returns true at top of unscrolled buffer", () => {
    expect(isOnFirstVisualLine(0, 0)).toBe(true)
  })

  it("returns false on second visual line of unscrolled buffer", () => {
    expect(isOnFirstVisualLine(1, 0)).toBe(false)
  })

  it("returns false when viewport is scrolled, even if visualRow is 0", () => {
    // The viewport has scrolled 3 lines down; the cursor sitting at the top
    // of the visible viewport is actually on absolute row 3 of the document.
    expect(isOnFirstVisualLine(0, 3)).toBe(false)
  })

  it("treats negative drift defensively as 'at top'", () => {
    // Should never happen in practice but guard against off-by-one feeding
    // negative values back through the gate.
    expect(isOnFirstVisualLine(-1, 0)).toBe(true)
  })
})

describe("isOnLastVisualLine", () => {
  it("returns true for a single-line buffer", () => {
    expect(isOnLastVisualLine(0, 0, 1)).toBe(true)
  })

  it("returns false on the first of two visual lines", () => {
    expect(isOnLastVisualLine(0, 0, 2)).toBe(false)
  })

  it("returns true on the last of two visual lines", () => {
    expect(isOnLastVisualLine(1, 0, 2)).toBe(true)
  })

  it("accounts for viewport scroll", () => {
    // Buffer has 25 visual lines, viewport scrolled 5 down.
    // Cursor at viewportRow=19 → absolute row 24 → last line.
    expect(isOnLastVisualLine(19, 5, 25)).toBe(true)
    // Same scroll, cursor one visual row higher → not last.
    expect(isOnLastVisualLine(18, 5, 25)).toBe(false)
  })

  it("treats zero or empty totals defensively as 'at bottom'", () => {
    // An empty buffer should still report 'at last line' so up/down arrow
    // history navigation works without content.
    expect(isOnLastVisualLine(0, 0, 0)).toBe(true)
  })
})

// Build a minimal TextareaRenderable stub exposing only the surface we use.
function makeStubTextarea(args: {
  visualRow: number
  offsetY: number
  totalLines: number
}): TextareaRenderable {
  return {
    visualCursor: {
      visualRow: args.visualRow,
      visualCol: 0,
      logicalRow: 0,
      logicalCol: 0,
      offset: 0,
    },
    editorView: {
      getViewport: () => ({
        offsetX: 0,
        offsetY: args.offsetY,
        width: 80,
        height: 20,
      }),
      getTotalVirtualLineCount: () => args.totalLines,
    },
  } as unknown as TextareaRenderable
}

describe("textareaCursorOnFirstVisualLine", () => {
  it("returns true when ref is undefined (defensive default)", () => {
    expect(textareaCursorOnFirstVisualLine(undefined)).toBe(true)
  })

  it("reads visualCursor and viewport offset correctly", () => {
    expect(
      textareaCursorOnFirstVisualLine(
        makeStubTextarea({ visualRow: 0, offsetY: 0, totalLines: 5 }),
      ),
    ).toBe(true)

    expect(
      textareaCursorOnFirstVisualLine(
        makeStubTextarea({ visualRow: 1, offsetY: 0, totalLines: 5 }),
      ),
    ).toBe(false)

    expect(
      textareaCursorOnFirstVisualLine(
        makeStubTextarea({ visualRow: 0, offsetY: 2, totalLines: 5 }),
      ),
    ).toBe(false)
  })
})

describe("textareaCursorOnLastVisualLine", () => {
  it("returns true when ref is undefined (defensive default)", () => {
    expect(textareaCursorOnLastVisualLine(undefined)).toBe(true)
  })

  it("reads totalVirtualLineCount, visualCursor, and viewport offset", () => {
    // Single-line buffer, cursor at top → also at bottom.
    expect(
      textareaCursorOnLastVisualLine(
        makeStubTextarea({ visualRow: 0, offsetY: 0, totalLines: 1 }),
      ),
    ).toBe(true)

    // Multi-line, cursor at top → not last.
    expect(
      textareaCursorOnLastVisualLine(
        makeStubTextarea({ visualRow: 0, offsetY: 0, totalLines: 5 }),
      ),
    ).toBe(false)

    // Multi-line, cursor at bottom → last.
    expect(
      textareaCursorOnLastVisualLine(
        makeStubTextarea({ visualRow: 4, offsetY: 0, totalLines: 5 }),
      ),
    ).toBe(true)

    // Scrolled multi-line, absolute row = total - 1 → last.
    expect(
      textareaCursorOnLastVisualLine(
        makeStubTextarea({ visualRow: 19, offsetY: 5, totalLines: 25 }),
      ),
    ).toBe(true)
  })
})
