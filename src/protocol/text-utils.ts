/**
 * Cross-cutting text utilities shared by the protocol reducer and the
 * Claude session reader.
 *
 * Anything in this file should be:
 *   - pure (no I/O, no logging)
 *   - frontend-agnostic (no SolidJS, no OpenTUI)
 *   - small enough that duplicating it would be silly
 *
 * Cluster 12 from anti-drift-sprint-todo: `stripImagePlaceholders` lived
 * once in `protocol/reducer.ts` and once in
 * `backends/claude/session-reader.ts` with byte-identical regex literals.
 * Hoisted here.
 */

/**
 * Strip the SDK's `[Image]` / `[Image #1]` placeholder markers that native
 * Claude Code doesn't display. Also collapses 3+ consecutive newlines to a
 * pair so the resulting transcript doesn't gain visible vertical gaps where
 * the placeholders used to be.
 */
export function stripImagePlaceholders(text: string): string {
  return text
    .replace(/\[Image(?:\s*#?\s*\d+)?\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
