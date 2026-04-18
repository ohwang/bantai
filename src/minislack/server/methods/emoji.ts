/**
 * emoji.list — returns the workspace's custom emoji map.
 *
 * https://api.slack.com/methods/emoji.list
 *
 * Slack returns only CUSTOM emojis here (uploaded by admins), NOT the
 * standard unicode set — those are universal and don't need the server.
 * We match the shape: `{ ok, emoji: { name → url_or_alias }, categories }`.
 *
 * Seed the map by passing `--emojis <file>` to the launcher, where the
 * file is either:
 *   - raw emoji.list output from real Slack (`{ ok:true, emoji: {...} }`)
 *   - a flat `{ name: url, ... }` object (we wrap it)
 */

import type { Workspace } from "../../types/slack"

export interface EmojiListResponse {
  ok: true
  emoji: Record<string, string>
  categories_version: string
  categories: Array<{ name: string; emoji_names: string[] }>
}

/** Set at boot by the launcher. Empty by default (no custom emoji). */
const emojiStore = new WeakMap<Workspace, Record<string, string>>()

export function setWorkspaceEmoji(ws: Workspace, emoji: Record<string, string>): void {
  emojiStore.set(ws, emoji)
}

export function getWorkspaceEmoji(ws: Workspace): Record<string, string> {
  return emojiStore.get(ws) ?? {}
}

export function emojiList(ws: Workspace): EmojiListResponse {
  const emoji = getWorkspaceEmoji(ws)
  return {
    ok: true,
    emoji,
    categories_version: "1",
    categories: [
      { name: "Custom", emoji_names: Object.keys(emoji) },
    ],
  }
}
