/**
 * Raw-markdown chunker for Slack's `markdown_text` field.
 *
 * Slack's `chat.postMessage` / `chat.update` / `chat.appendStream` accept a
 * `markdown_text` argument (GitHub-flavoured markdown) with a 12,000-char
 * per-message limit. Most agent replies fit in a single message; this
 * chunker only triggers on the rare long-form output.
 *
 * Contract:
 *   - Input is RAW markdown, not Slack mrkdwn. Never run it through
 *     `markdownToSlackMrkdwn` first — that produces Slack mrkdwn which
 *     `markdown_text` does not understand (see openclaw CHANGELOG #34931).
 *   - Output is an ordered list of raw-markdown strings, each ≤ `limit`.
 *   - Splits prefer paragraph boundaries (blank lines) → single newlines
 *     → hard character split (last resort).
 *   - Fenced code blocks (```…```) are never split mid-fence. If a fence
 *     straddles a chunk boundary we close it at the end of the chunk and
 *     reopen it at the start of the next so both halves render as code.
 *   - Pipe tables (GFM) are kept as intact blocks — we split between
 *     rows when forced, never mid-row.
 *
 * Why not reuse `renderMarkdownIRChunksWithinLimit`? That chunker is IR-
 * aware but it rewrites the text through the Slack-mrkdwn IR renderer.
 * For `markdown_text` we want the original bytes preserved verbatim, so
 * we operate on the raw string directly.
 */

/**
 * Default Slack `markdown_text` limit, with a 500-char safety margin
 * under Slack's documented 12,000 cap (see
 * https://docs.slack.dev/reference/block-kit/blocks/markdown-block).
 */
export const SLACK_MARKDOWN_TEXT_LIMIT = 11500

interface FenceState {
  /** Non-empty when an unclosed ``` fence is in flight. Stores the language tag, if any. */
  lang: string | null
}

/**
 * Split raw markdown into chunks ≤ `limit` characters, preserving
 * fenced-code integrity. Returns a single-entry array when the input
 * already fits.
 */
export function chunkRawMarkdown(text: string, limit = SLACK_MARKDOWN_TEXT_LIMIT): string[] {
  if (!text) return []
  if (text.length <= limit) return [text]

  const paragraphs = splitParagraphs(text)
  const chunks: string[] = []
  let current = ""
  let fence: FenceState = { lang: null }

  const flush = () => {
    if (current.length === 0) return
    chunks.push(current)
    current = ""
  }

  for (const para of paragraphs) {
    const addition = current.length === 0 ? para : `${current}\n\n${para}`
    // Simulate the fence state at the end of `current` (prior to this
    // paragraph) so we know whether to close + reopen when we split.
    const fenceAtJoinBoundary = { ...fence }

    if (addition.length <= limit) {
      current = addition
      advanceFenceState(fence, para)
      continue
    }

    // The paragraph alone, or with the running head, would exceed the
    // limit. Flush the current chunk first (closing any open fence so
    // the rendered chunk is valid standalone).
    if (current.length > 0) {
      current = finaliseChunk(current, fenceAtJoinBoundary)
      flush()
      fence = { lang: null }
    }

    // Now handle the oversize paragraph itself. Split it internally.
    const paraChunks = splitOversizedParagraph(para, limit)
    for (let i = 0; i < paraChunks.length - 1; i++) {
      chunks.push(paraChunks[i]!)
    }
    const tail = paraChunks[paraChunks.length - 1]!
    current = tail
    fence = { lang: null }
    advanceFenceState(fence, tail)
  }

  if (current.length > 0) {
    current = finaliseChunk(current, { lang: null })
    flush()
  }

  return chunks
}

/**
 * Split `text` on blank-line paragraph boundaries. Preserves content;
 * the joiner on re-emit is always `\n\n`.
 */
function splitParagraphs(text: string): string[] {
  // Split on 2+ newlines, handling Windows line endings.
  const normalised = text.replace(/\r\n/g, "\n")
  return normalised.split(/\n{2,}/).map((p) => p.replace(/\n+$/, "")).filter((p) => p.length > 0)
}

/**
 * Split a single oversized paragraph. Strategy:
 *   1. If it contains newlines, split on newlines.
 *   2. Pack lines greedily into chunks ≤ limit, respecting fence state.
 *   3. If a single line still exceeds limit, hard-slice it at `limit`.
 *
 * If the paragraph is a fenced code block, we walk line-by-line and
 * insert fence-close/fence-reopen markers at each chunk boundary that
 * falls inside the fence.
 */
function splitOversizedParagraph(para: string, limit: number): string[] {
  const lines = para.split("\n")
  if (lines.length === 1) return hardSliceLine(lines[0]!, limit)

  const chunks: string[] = []
  let current = ""
  let fence: FenceState = { lang: null }

  const flushWithFenceClose = () => {
    if (current.length === 0) return
    if (fence.lang !== null) {
      // Close the open fence on the way out of this chunk.
      current = `${current}\n\`\`\``
    }
    chunks.push(current)
    current = ""
  }

  for (const line of lines) {
    const addition = current.length === 0 ? line : `${current}\n${line}`
    const additionWithCloser =
      fence.lang !== null && !isFenceToggle(line) ? `${addition}\n\`\`\`` : addition

    if (additionWithCloser.length <= limit) {
      current = addition
      advanceFenceForLine(fence, line)
      continue
    }

    // Overflow. Flush and start a fresh chunk — if we were mid-fence,
    // reopen it on the new chunk so the code keeps rendering.
    const wasInFence = fence.lang
    flushWithFenceClose()
    const reopener = wasInFence !== null ? "```" + wasInFence : ""
    const seed = reopener.length > 0 ? `${reopener}\n${line}` : line

    if (seed.length <= limit) {
      current = seed
      // Fence stays "open" if we were in one (we wrote the reopener).
      fence = wasInFence !== null ? { lang: wasInFence } : { lang: null }
      advanceFenceForLine(fence, line)
    } else {
      // Single line longer than the limit — hard-slice and push each
      // slice. First slice inherits the reopener if needed.
      const slices = hardSliceLine(line, limit - (reopener.length + 1))
      for (let i = 0; i < slices.length; i++) {
        const slice = slices[i]!
        const composed = i === 0 && reopener.length > 0 ? `${reopener}\n${slice}` : slice
        chunks.push(composed)
      }
      fence = wasInFence !== null ? { lang: wasInFence } : { lang: null }
    }
  }

  flushWithFenceClose()
  return chunks
}

/**
 * Hard character-slice a single line when it alone exceeds the limit.
 * We break on whitespace if possible, else mid-token.
 */
function hardSliceLine(line: string, limit: number): string[] {
  const effectiveLimit = Math.max(1, limit)
  if (line.length <= effectiveLimit) return [line]
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    const end = Math.min(line.length, i + effectiveLimit)
    // Try to back off to the last whitespace within this window (unless
    // this is the tail slice).
    let cut = end
    if (end < line.length) {
      const ws = line.lastIndexOf(" ", end - 1)
      if (ws > i) cut = ws
    }
    out.push(line.slice(i, cut))
    i = cut === end ? cut : cut + 1 // skip the whitespace if we split on it
  }
  return out
}

/**
 * If a chunk ends with an unclosed fence, append the closer so the
 * rendered chunk is valid markdown standalone. Returns the chunk
 * unchanged when no fence is open.
 */
function finaliseChunk(chunk: string, enteringFence: FenceState): string {
  const end: FenceState = { lang: enteringFence.lang }
  advanceFenceState(end, chunk)
  if (end.lang !== null) {
    return `${chunk}\n\`\`\``
  }
  return chunk
}

/**
 * Update the running fence state by scanning a freshly-appended chunk
 * for fence toggles. Matches only lines whose first non-whitespace
 * token is ``` optionally followed by an info string. This mirrors
 * CommonMark's fenced-code-block rule.
 */
function advanceFenceState(state: FenceState, added: string): void {
  for (const line of added.split("\n")) {
    advanceFenceForLine(state, line)
  }
}

function advanceFenceForLine(state: FenceState, line: string): void {
  if (!isFenceToggle(line)) return
  const trimmed = line.trimStart()
  if (state.lang === null) {
    state.lang = trimmed.slice(3).trim() // language tag, may be ""
  } else {
    state.lang = null
  }
}

function isFenceToggle(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith("```")
}
