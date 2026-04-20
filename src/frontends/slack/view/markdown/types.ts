/**
 * Markdown table rendering mode. Copied verbatim from openclaw's
 * `src/config/types.base.ts` to avoid pulling the whole config base
 * into the slack frontend.
 *
 *   - "off":     no table handling (table rows flow through as text)
 *   - "bullets": emit key/value bullet lists (human-readable)
 *   - "code":    emit a markdown pipe table inside a `code_block` span
 *   - "block":   collect table placeholder for a separate block-kit render
 */
export type MarkdownTableMode = "off" | "bullets" | "code" | "block";
