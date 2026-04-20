/**
 * Slack mrkdwn formatter — vendored from openclaw/extensions/slack/src/format.ts
 * with minimal adaptations:
 *   - `MarkdownTableMode` now comes from `./markdown/types` (local type)
 *     instead of `openclaw/plugin-sdk/config-runtime`.
 *   - `markdownToIR` / `renderMarkdownIRChunksWithinLimit` /
 *     `renderMarkdownWithMarkers` come from the vendored `./markdown/*`
 *     modules instead of `openclaw/plugin-sdk/text-runtime`.
 *
 * Behaviour is identical. See openclaw's upstream source for
 * the original docstring + history.
 */

import {
  markdownToIR,
  type MarkdownLinkSpan,
} from "./markdown/ir";
import { renderMarkdownIRChunksWithinLimit } from "./markdown/render-aware-chunking";
import { renderMarkdownWithMarkers } from "./markdown/render";
import type { MarkdownTableMode } from "./markdown/types";

// Escape special characters for Slack mrkdwn format.
// Preserve Slack's angle-bracket tokens so mentions and links stay intact.
function escapeSlackMrkdwnSegment(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g;

function isAllowedSlackAngleToken(token: string): boolean {
  if (!token.startsWith("<") || !token.endsWith(">")) {
    return false;
  }
  const inner = token.slice(1, -1);
  return (
    inner.startsWith("@") ||
    inner.startsWith("#") ||
    inner.startsWith("!") ||
    inner.startsWith("mailto:") ||
    inner.startsWith("tel:") ||
    inner.startsWith("http://") ||
    inner.startsWith("https://") ||
    inner.startsWith("slack://")
  );
}

function escapeSlackMrkdwnContent(text: string): string {
  if (!text) {
    return "";
  }
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  SLACK_ANGLE_TOKEN_RE.lastIndex = 0;
  const out: string[] = [];
  let lastIndex = 0;

  for (
    let match = SLACK_ANGLE_TOKEN_RE.exec(text);
    match;
    match = SLACK_ANGLE_TOKEN_RE.exec(text)
  ) {
    const matchIndex = match.index ?? 0;
    out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex, matchIndex)));
    const token = match[0] ?? "";
    out.push(isAllowedSlackAngleToken(token) ? token : escapeSlackMrkdwnSegment(token));
    lastIndex = matchIndex + token.length;
  }

  out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex)));
  return out.join("");
}

function escapeSlackMrkdwnText(text: string): string {
  if (!text) {
    return "";
  }
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("> ")) {
        return `> ${escapeSlackMrkdwnContent(line.slice(2))}`;
      }
      return escapeSlackMrkdwnContent(line);
    })
    .join("\n");
}

function buildSlackLink(link: MarkdownLinkSpan, text: string) {
  const href = link.href.trim();
  if (!href) {
    return null;
  }
  const label = text.slice(link.start, link.end);
  const trimmedLabel = label.trim();
  const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
  const useMarkup =
    trimmedLabel.length > 0 && trimmedLabel !== href && trimmedLabel !== comparableHref;
  if (!useMarkup) {
    return null;
  }
  const safeHref = escapeSlackMrkdwnSegment(href);
  return {
    start: link.start,
    end: link.end,
    open: `<${safeHref}|`,
    close: ">",
  };
}

type SlackMarkdownOptions = {
  tableMode?: MarkdownTableMode;
};

function buildSlackRenderOptions() {
  return {
    styleMarkers: {
      bold: { open: "*", close: "*" },
      italic: { open: "_", close: "_" },
      strikethrough: { open: "~", close: "~" },
      code: { open: "`", close: "`" },
      code_block: { open: "```\n", close: "```" },
    },
    escapeText: escapeSlackMrkdwnText,
    buildLink: buildSlackLink,
  };
}

/**
 * @deprecated Prefer Slack's `markdown_text` API field (see
 *   `view/outbox.ts` → `markdownText`, and `view/send-adapter.ts` →
 *   `compileBody`). `markdown_text` accepts raw GitHub-flavoured markdown
 *   with a 12,000-char limit and renders tables, fenced code, headers,
 *   and task lists natively — lossless compared to Slack's mrkdwn
 *   dialect. This mrkdwn converter is retained only for short strings
 *   that rely on mrkdwn-only affordances (`<@U…>` mentions, `<!date^…>`,
 *   `<#C…>` channel refs) in banners, approvals, and elicitation copy.
 *   Do not use for new code paths that carry agent reply bodies.
 */
export function markdownToSlackMrkdwn(
  markdown: string,
  options: SlackMarkdownOptions = {},
): string {
  const ir = markdownToIR(markdown ?? "", {
    linkify: false,
    autolink: false,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  return renderMarkdownWithMarkers(ir, buildSlackRenderOptions());
}

/**
 * @deprecated See `markdownToSlackMrkdwn`. New outbound surfaces should
 *   pass raw markdown through `markdownText` instead of running it
 *   through this mrkdwn normalizer.
 */
export function normalizeSlackOutboundText(markdown: string): string {
  return markdownToSlackMrkdwn(markdown ?? "");
}

/**
 * @deprecated See `markdownToSlackMrkdwn`. For raw-markdown chunking
 *   use `view/markdown-chunk.ts → chunkRawMarkdown`, which targets
 *   Slack's 12k `markdown_text` limit and preserves fenced-code
 *   integrity without lossy mrkdwn conversion.
 */
export function markdownToSlackMrkdwnChunks(
  markdown: string,
  limit: number,
  options: SlackMarkdownOptions = {},
): string[] {
  const ir = markdownToIR(markdown ?? "", {
    linkify: false,
    autolink: false,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  const renderOptions = buildSlackRenderOptions();
  return renderMarkdownIRChunksWithinLimit({
    ir,
    limit,
    renderChunk: (chunk) => renderMarkdownWithMarkers(chunk, renderOptions),
    measureRendered: (rendered) => rendered.length,
  }).map(({ rendered }) => rendered);
}
