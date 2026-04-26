/**
 * UserBlock — renders a user message with prompt indicator and optional image count.
 *
 * Non-human-origin badge:
 *   When the SDK reports a user message that didn't come from keyboard input
 *   (peer agent, coordinator, channel — see `SDKMessageOrigin` in
 *   protocol/types.ts), we prepend a small dim tag line so the user can tell
 *   at a glance whose words these are. `human` and missing-origin render
 *   identically to the pre-badge UX (no extra row).
 *
 *   `task-notification` is intentionally NOT badged today — it represents an
 *   internal SDK plumbing turn the user can't act on. We still propagate the
 *   field on the block in case a future UX wants it.
 */

import { Show, type Accessor } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { colors } from "../../theme/tokens"
import type { Block, SDKMessageOrigin } from "../../../../protocol/types"

type UserBlockType = Extract<Block, { type: "user" }>

/** Format a non-human origin as a short tag, or null when no badge should
 *  render (`human`, `task-notification`, missing). */
function formatOriginBadge(origin: SDKMessageOrigin | undefined): string | null {
  if (!origin) return null
  switch (origin.kind) {
    case "human":
    case "task-notification":
      return null
    case "peer":
      // `name` is the human-readable label; fall back to the agent id.
      return origin.name ? `peer: ${origin.name}` : `peer: ${origin.from || "unknown"}`
    case "channel":
      return origin.server ? `channel: ${origin.server}` : "channel"
    case "coordinator":
      return "coordinator"
  }
}

export function UserBlock(props: { block: UserBlockType }) {
  const b = () => props.block
  const badge = () => formatOriginBadge(b().origin)
  const errorText = () => {
    const err = b().error
    if (!err) return ""
    const msg = err.message.split("\n").filter((l: string) => !l.match(/^\s+at\s/)).join("\n").trim()
    const capped = msg.length > 500 ? msg.slice(0, 497) + "..." : msg
    return capped
  }
  return (
    <box flexDirection="column">
      <Show when={badge()}>
        {(label: Accessor<string>) => (
          <box paddingLeft={2}>
            <text fg={colors.accent.secondary} attributes={TextAttributes.DIM}>
              {`[${label()}]`}
            </text>
          </box>
        )}
      </Show>
      <box flexDirection="row" width="100%" backgroundColor={colors.bg.surface}>
        <box width={2} flexShrink={0} />
        <box flexGrow={1}>
          <text fg={colors.text.primary}>{b().text}</text>
        </box>
      </box>
      <Show when={b().images && b().images!.length > 0}>
        <box paddingLeft={2}>
          <text fg={colors.accent.primary} attributes={TextAttributes.DIM}>
            {`\uD83D\uDCCE ${b().images!.length} image${b().images!.length === 1 ? "" : "s"} attached`}
          </text>
        </box>
      </Show>
      <Show when={b().error}>
        <box flexDirection="row" paddingLeft={2}>
          <box width={2} flexShrink={0}>
            <text fg={colors.text.muted}>{"\u2514"}</text>
          </box>
          <box flexGrow={1}>
            <text fg={colors.status.error}>{errorText()}</text>
          </box>
        </box>
      </Show>
    </box>
  )
}
