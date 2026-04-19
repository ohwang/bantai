/**
 * Markdown → Slack mrkdwn + chunker.
 *
 * Slack's `text` field on `chat.postMessage` / `chat.update` accepts mrkdwn,
 * a variant of Markdown that differs from CommonMark in several places:
 *
 *   CommonMark          mrkdwn
 *   --------------      -------
 *   **bold**            *bold*
 *   *italic* / _italic_ _italic_
 *   ~~strike~~          ~strike~
 *   [text](url)         <url|text>
 *   # H1                *H1*     (mrkdwn has no headings)
 *   > quote             > quote
 *   - item              • item   (Slack renders hyphens but bullets are cleaner)
 *   ``` code ```        ``` code ```  (preserved)
 *   `code`              `code`   (preserved)
 *   | t1 | t2 |         ```\nt1  t2\n``` (Slack has no table syntax;
 *   | x  | y  |                          fixed-width fence approximates it)
 *
 * Angle-bracket tokens that Slack parses in mrkdwn — `<@U…>`, `<#C…|name>`,
 * `<!subteam^S…>`, `<mailto:…>`, `<tel:…>`, `<http://…>`, `<slack://…>` —
 * survive conversion verbatim. All other `<` / `>` / `&` characters in
 * plain text are HTML-escaped so user input like "a < b" doesn't get
 * interpreted as a token.
 *
 * Slack also hard-caps the `text` field around 3000 characters per block;
 * the whole message body gets truncated if you send a giant string as a
 * single text. Beyond that, we chunk along paragraph boundaries so nothing
 * tears a code fence or a list mid-entry.
 *
 * This module exports:
 *   - `markdownToSlackMrkdwn(text)` — single-pass conversion.
 *   - `chunkForSlack(text, maxLen)` — splits a long mrkdwn string into
 *     <maxLen chunks at paragraph/blankline boundaries (never mid-fence).
 *   - `markdownToSlackMrkdwnChunks(text, maxLen)` — pipeline helper that
 *     does both, in order.
 *
 * Inspired by openclaw/extensions/slack/src/format.ts (MIT). We stop
 * short of vendoring openclaw's full IR-based chunker (~1500 lines) —
 * the escape allowlist and table converter below capture the high-value
 * behaviour for the payload shapes bantai ships.
 *
 * Pure — no IO, no logging.
 */

// ---------------------------------------------------------------------------
// Slack mrkdwn conversion
// ---------------------------------------------------------------------------

export function markdownToSlackMrkdwn(input: string): string {
  if (input.length === 0) return input
  const withTables = convertMarkdownTables(input)
  const segments = splitAroundCodeFences(withTables)
  return segments
    .map((s) => (s.isCode ? s.text : convertNonCode(s.text)))
    .join("")
}

// ---------------------------------------------------------------------------
// Angle-token allowlist — preserve Slack's own mrkdwn tokens (mentions,
// channel refs, autolinks) while HTML-escaping everything else so user
// text like "a < b" doesn't get parsed as a token.
// ---------------------------------------------------------------------------

const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g

function isAllowedSlackAngleToken(token: string): boolean {
  if (!token.startsWith("<") || !token.endsWith(">")) return false
  const inner = token.slice(1, -1)
  return (
    inner.startsWith("@") ||
    inner.startsWith("#") ||
    inner.startsWith("!") ||
    inner.startsWith("mailto:") ||
    inner.startsWith("tel:") ||
    inner.startsWith("http://") ||
    inner.startsWith("https://") ||
    inner.startsWith("slack://")
  )
}

function escapeSlackAngles(text: string): string {
  if (!text) return ""
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text
  }
  SLACK_ANGLE_TOKEN_RE.lastIndex = 0
  const out: string[] = []
  let lastIndex = 0
  for (
    let match = SLACK_ANGLE_TOKEN_RE.exec(text);
    match;
    match = SLACK_ANGLE_TOKEN_RE.exec(text)
  ) {
    const i = match.index
    out.push(escapeAngleChars(text.slice(lastIndex, i)))
    const token = match[0]
    out.push(isAllowedSlackAngleToken(token) ? token : escapeAngleChars(token))
    lastIndex = i + token.length
  }
  out.push(escapeAngleChars(text.slice(lastIndex)))
  return out.join("")
}

function escapeAngleChars(segment: string): string {
  return segment.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// ---------------------------------------------------------------------------
// Table conversion. Slack mrkdwn has no table syntax — render tables
// inside a code fence so the monospace font aligns columns. We stop
// short of picking a pretty-print style (pipes vs. box drawing) — a
// simple "cell  cell" layout with padding-to-width is readable and
// survives round-tripping through `chunkForSlack` unchanged.
// ---------------------------------------------------------------------------

function convertMarkdownTables(input: string): string {
  if (!input.includes("|")) return input
  const lines = input.split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const start = i
    const table = detectTableAt(lines, start)
    if (table) {
      out.push(renderTable(table.rows))
      i = table.endExclusive
      continue
    }
    out.push(lines[i]!)
    i += 1
  }
  return out.join("\n")
}

/**
 * Match a GFM-style table starting at `start`. Requires:
 *   - line[start] is a `| … |` header row
 *   - line[start+1] is a separator row of `-` and `:`
 *   - one or more body rows follow, same `|` shape
 * Returns the row cells and the index past the last body row.
 */
function detectTableAt(
  lines: string[],
  start: number,
): { rows: string[][]; endExclusive: number } | null {
  const header = lines[start]
  const sep = lines[start + 1]
  if (!header || !sep) return null
  if (!isTableRow(header)) return null
  if (!isSeparatorRow(sep)) return null
  const headerCells = splitRow(header)
  const sepCells = splitRow(sep)
  if (headerCells.length !== sepCells.length) return null
  const rows: string[][] = [headerCells]
  let i = start + 2
  while (i < lines.length && isTableRow(lines[i]!)) {
    const cells = splitRow(lines[i]!)
    if (cells.length !== headerCells.length) break
    rows.push(cells)
    i += 1
  }
  return { rows, endExclusive: i }
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length >= 2
}

function isSeparatorRow(line: string): boolean {
  if (!isTableRow(line)) return false
  return splitRow(line).every((cell) => /^:?-{1,}:?$/.test(cell.trim()))
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map((c) => c.trim())
}

function renderTable(rows: string[][]): string {
  const widths = rows[0]!.map((_, col) =>
    Math.max(...rows.map((r) => stringWidth(r[col] ?? ""))),
  )
  const pad = (cell: string, width: number) =>
    cell + " ".repeat(Math.max(0, width - stringWidth(cell)))
  const header = rows[0]!
  const body = rows.slice(1)
  const lines = [
    header.map((c, i) => pad(c, widths[i]!)).join("  ").trimEnd(),
    widths.map((w) => "-".repeat(w)).join("  ").trimEnd(),
    ...body.map((r) => r.map((c, i) => pad(c, widths[i]!)).join("  ").trimEnd()),
  ]
  return ["```", ...lines, "```"].join("\n")
}

/** Codepoint-ish width — good enough for ASCII tables. */
function stringWidth(s: string): number {
  return [...s].length
}

// ---------------------------------------------------------------------------
// Non-fence conversion — tokenises inline code and bold so italic +
// link rewrites don't accidentally eat them, then restores.
// ---------------------------------------------------------------------------

function convertNonCode(text: string): string {
  let out = text

  // Inline code spans survive verbatim — preserve them by tokenising first
  // BEFORE any escape / rewrite pass so angle-token escaping doesn't chew
  // up deliberate `<script>` documentation inside backticks.
  const codePlaceholders: string[] = []
  out = out.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    codePlaceholders.push(`\`${body}\``)
    return `\u0000C${codePlaceholders.length - 1}\u0000`
  })

  // Now safe: escape bare `<` / `>` / `&` outside code while preserving
  // Slack-recognised angle tokens (mentions, channel refs, autolinks).
  out = escapeSlackAngles(out)

  // Links [text](url) → <url|text>. Must run before bold/italic so syntax
  // inside link texts isn't double-transformed.
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, label: string, url: string) => `<${url}|${label}>`,
  )

  // Bold needs to happen BEFORE italic because a CommonMark **bold** ends up
  // as a mrkdwn *bold*, and the italic rule would otherwise pick that back
  // up and re-mark it as _bold_. Tokenise the bold bodies so italic can't
  // see them.
  const boldPlaceholders: string[] = []
  const tokenise = (body: string) => {
    boldPlaceholders.push(body)
    return `\u0000B${boldPlaceholders.length - 1}\u0000`
  }
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, (_m, body: string) => tokenise(body))
  out = out.replace(/__([^_\n]+?)__/g, (_m, body: string) => tokenise(body))

  // Strikethrough: ~~text~~ → ~text~
  out = out.replace(/~~([^~\n]+?)~~/g, (_m, body: string) => `~${body}~`)

  // Italic: *text* (CommonMark) → _text_ (mrkdwn). With bold already
  // tokenised, only genuine italics remain.
  out = out.replace(
    /(^|[^*_\w])\*([^*\n]+?)\*(?![*\w])/g,
    (_m, lead: string, body: string) => `${lead}_${body}_`,
  )

  // Headings: # / ## / ### → *H*.  Strip the '#' tokens and bold the line.
  out = out.replace(/^(#{1,6})\s+(.*)$/gm, (_m, _hashes: string, title: string) => `*${title}*`)

  // Unordered list markers: "- " / "* " → "• ".  Leave numbered lists.
  out = out.replace(/^(\s*)[-*]\s+/gm, (_m, indent: string) => `${indent}• `)

  // Restore placeholders — bold first, then inline code.
  out = out.replace(
    /\u0000B(\d+)\u0000/g,
    (_m, idx: string) => `*${boldPlaceholders[Number(idx)] ?? ""}*`,
  )
  out = out.replace(
    /\u0000C(\d+)\u0000/g,
    (_m, idx: string) => codePlaceholders[Number(idx)] ?? "",
  )
  return out
}

interface Segment {
  text: string
  isCode: boolean
}

function splitAroundCodeFences(input: string): Segment[] {
  const re = /```[\s\S]*?```/g
  const out: Segment[] = []
  let last = 0
  for (const m of input.matchAll(re)) {
    const i = m.index!
    if (i > last) out.push({ text: input.slice(last, i), isCode: false })
    out.push({ text: m[0], isCode: true })
    last = i + m[0].length
  }
  if (last < input.length) out.push({ text: input.slice(last), isCode: false })
  return out
}

// ---------------------------------------------------------------------------
// Paragraph-aware chunker
// ---------------------------------------------------------------------------

export interface ChunkOpts {
  /** Max chars per chunk (default 2900 — safely under Slack's 3000 cap). */
  maxLen?: number
}

export function chunkForSlack(text: string, opts: ChunkOpts = {}): string[] {
  const max = opts.maxLen ?? 2900
  if (text.length <= max) return text.length === 0 ? [] : [text]

  // Walk segment-by-segment; code fences are atomic (don't tear them).
  const segments = splitAroundCodeFences(text)
  const out: string[] = []
  let current = ""

  const flush = () => {
    const trimmed = current.trimEnd()
    if (trimmed.length > 0) out.push(trimmed)
    current = ""
  }

  for (const seg of segments) {
    if (seg.isCode) {
      // An oversized code fence is split into hard-chunked sub-fences so a
      // single 50kB log blob still fits in Slack-sized pieces.
      if (seg.text.length > max) {
        flush()
        for (const piece of splitFence(seg.text, max)) {
          out.push(piece)
        }
        continue
      }
      if (current.length + seg.text.length > max) flush()
      current += seg.text
      continue
    }
    // Paragraph split by double newline. Within a paragraph we fall back to
    // single-newline / sentence / hard split as needed.
    const paragraphs = seg.text.split(/\n{2,}/)
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i]!
      const withSep = (i === 0 && current.length === 0) ? para : `\n\n${para}`
      if (current.length + withSep.length <= max) {
        current += withSep
        continue
      }
      // Need to flush + maybe subdivide this paragraph.
      flush()
      if (para.length <= max) {
        current = para
      } else {
        for (const piece of hardSplit(para, max)) {
          if (current.length === 0) current = piece
          else {
            flush()
            current = piece
          }
        }
      }
    }
  }
  flush()
  return out
}

/**
 * Split oversized plain text along soft boundaries (sentence → word → hard char).
 */
function hardSplit(text: string, max: number): string[] {
  const out: string[] = []
  let remaining = text
  while (remaining.length > max) {
    // Try sentence break within the window.
    let cut = remaining.lastIndexOf(". ", max)
    if (cut < max / 2) cut = remaining.lastIndexOf("\n", max)
    if (cut < max / 2) cut = remaining.lastIndexOf(" ", max)
    if (cut <= 0) cut = max
    else cut += 1
    out.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut)
  }
  if (remaining.length > 0) out.push(remaining)
  return out
}

/**
 * Split an oversized fenced code block into multiple fenced blocks, reusing
 * the opener line so language annotations carry across pieces.
 */
function splitFence(fence: string, max: number): string[] {
  // fence is ```lang?\n...content...\n```
  const match = /^(```[^\n]*\n)([\s\S]*?)(\n```)$/.exec(fence)
  if (!match) {
    // Malformed fence — just hard-split.
    return hardSplit(fence, max)
  }
  const [, opener, body, closer] = match
  const overhead = opener!.length + closer!.length
  const innerMax = max - overhead
  if (innerMax <= 0) return hardSplit(fence, max)
  const out: string[] = []
  let remaining = body!
  while (remaining.length > innerMax) {
    let cut = remaining.lastIndexOf("\n", innerMax)
    if (cut <= 0) cut = innerMax
    out.push(`${opener}${remaining.slice(0, cut)}${closer}`)
    remaining = remaining.slice(cut + 1)
  }
  if (remaining.length > 0) out.push(`${opener}${remaining}${closer}`)
  return out
}

/** Convenience pipeline helper. */
export function markdownToSlackMrkdwnChunks(
  input: string,
  opts: ChunkOpts = {},
): string[] {
  return chunkForSlack(markdownToSlackMrkdwn(input), opts)
}
