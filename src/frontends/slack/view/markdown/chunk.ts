/**
 * Minimal text chunker used by `ir.ts`. Openclaw's original `chunkText`
 * lives in `auto-reply/chunk.ts` and pulls in configuration / channel
 * registry dependencies we don't want here. The only entrypoint
 * `ir.ts` calls is `chunkText(text, limit)`, and it only needs the
 * paren-aware newline/whitespace break resolution — no fence awareness,
 * no channel config. So this is a self-contained copy of that slice.
 */

function chunkTextByBreakResolver(
  text: string,
  limit: number,
  resolveBreakIndex: (window: string) => number,
): string[] {
  if (!text) {
    return [];
  }
  if (limit <= 0 || text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const candidateBreak = resolveBreakIndex(window);
    const breakIdx =
      Number.isFinite(candidateBreak) && candidateBreak > 0 && candidateBreak <= limit
        ? candidateBreak
        : limit;
    const rawChunk = remaining.slice(0, breakIdx);
    const chunk = rawChunk.trimEnd();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx] ?? "");
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
    remaining = remaining.slice(nextStart).trimStart();
  }
  if (remaining.length) {
    chunks.push(remaining);
  }
  return chunks;
}

function scanParenAwareBreakpoints(
  text: string,
  start: number,
  end: number,
): { lastNewline: number; lastWhitespace: number } {
  let lastNewline = -1;
  let lastWhitespace = -1;
  let depth = 0;

  for (let i = start; i < end; i++) {
    const char = text[i];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (char === "\n") {
      lastNewline = i;
    } else if (char !== undefined && /\s/.test(char)) {
      lastWhitespace = i;
    }
  }

  return { lastNewline, lastWhitespace };
}

function resolveChunkEarlyReturn(text: string, limit: number): string[] | undefined {
  if (!text) {
    return [];
  }
  if (limit <= 0) {
    return [text];
  }
  if (text.length <= limit) {
    return [text];
  }
  return undefined;
}

export function chunkText(text: string, limit: number): string[] {
  const early = resolveChunkEarlyReturn(text, limit);
  if (early) {
    return early;
  }
  return chunkTextByBreakResolver(text, limit, (window) => {
    const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(window, 0, window.length);
    return lastNewline > 0 ? lastNewline : lastWhitespace;
  });
}
