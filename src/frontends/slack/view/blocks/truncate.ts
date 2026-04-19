/**
 * Slack-safe text truncation.
 *
 * Slack's mrkdwn body fields have hard limits (3000 chars for section
 * text, 150 for header, 75 for button labels). Truncating with a raw
 * `slice()` can leave mrkdwn syntax unbalanced — an unpaired ```` fence,
 * a half-finished `*bold*`, or a bare `<@U123` token without its closing
 * `>`. Slack renders unbalanced syntax literally, which looks broken.
 *
 * Two helpers:
 *   - `truncateSlackText(s, max)` — raw truncation + `…`. Use for plain
 *     text fields (button labels, aria strings) where mrkdwn isn't
 *     parsed.
 *   - `truncateSlackMrkdwn(s, max)` — fence- and token-aware truncation
 *     for rendered mrkdwn bodies.
 *
 * Ported from OpenClaw's `extensions/slack/src/truncate.ts` (MIT) with
 * mrkdwn-aware extensions added for bantai's fenced-tool-card payloads.
 */

export function truncateSlackText(value: string, max: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  if (max <= 1) return trimmed.slice(0, max)
  return `${trimmed.slice(0, max - 1)}…`
}

/**
 * Truncate a mrkdwn body to <= `max` chars, preserving fence balance and
 * not leaving an unclosed angle-bracket token mid-string.
 *
 * Approach:
 *   1. If under the limit, return unchanged.
 *   2. Otherwise, slice to `max - 1` chars and append `…`.
 *   3. If the truncation left an odd number of ``` fences, close the
 *      dangling one with `\n\`\`\``.
 *   4. If the truncation ended inside an angle token (`<@U…`), back off
 *      to the last `>` or, failing that, drop the trailing fragment.
 */
export function truncateSlackMrkdwn(value: string, max: number): string {
  if (max < 4) return truncateSlackText(value, max)
  if (value.length <= max) return value

  // Step 1: naive cut with ellipsis.
  let cut = value.slice(0, max - 1)

  // Step 2: recover from a mid-token `<…>` cut. If we're inside an
  // unclosed `<…`, back off to the char before the last `<`.
  const lastOpen = cut.lastIndexOf("<")
  const lastClose = cut.lastIndexOf(">")
  if (lastOpen > lastClose) {
    cut = cut.slice(0, lastOpen)
  }

  let out = `${cut}…`

  // Step 3: close any unbalanced fence. Count ``` occurrences (triple
  // backticks only — single-backtick inline code is self-balancing at
  // line granularity and rarely survives truncation).
  const fences = (out.match(/```/g) ?? []).length
  if (fences % 2 === 1) {
    out = `${out}\n\`\`\``
  }

  return out
}
