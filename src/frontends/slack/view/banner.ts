/**
 * Session banner — posted once per new session on the first `session_init`
 * event. Gives users at a glance: which backend + model is running, which
 * project directory the session is cd'd into, the session id (for resume
 * later), the configured verbosity, and a hint on control commands.
 *
 * Block Kit: header + section (mrkdwn body) + context block. Actions
 * (change model / reset / silence) are plan §5 S4 work — the Block Kit
 * interaction layer lands with approvals.
 *
 * Pure-shape builders live in `buildSessionBanner()` so they're
 * snapshot-testable; the adapter-driven `postSessionBanner()` is a thin
 * wrapper around `chat.postMessage`.
 */

import type { KnownBlock } from "@slack/types"
import type { SendAdapter } from "./outbox"
import type { ProjectConfig } from "../router/resolver"

export interface BannerInputs {
  project: ProjectConfig
  /** Backend-reported session id (from AgentEvent.session_init.sessionId). */
  sessionId?: string
  /** Display names of known participants in the thread. */
  participants?: string[]
  /** When true, banner shows a "resumed" variant with a summary line. */
  resumed?: {
    /** Turns prior to the resume point. */
    priorTurns?: number
    /** Cost accrued prior to resume (USD). */
    priorCostUsd?: number
    /** Last-active relative string, e.g. "3 days ago". */
    lastActive?: string
  }
}

export function buildSessionBanner(input: BannerInputs): {
  text: string
  blocks: KnownBlock[]
} {
  const { project } = input
  const title = input.resumed ? ":arrows_counterclockwise: bantai session resumed" : ":rocket: bantai session started"
  const bodyLines = [
    `*backend*  \`${project.backend}\``,
    `*model*  \`${project.model ?? "<default>"}\``,
    `*project*  ${project.channelName ? `${project.channelName} — ` : ""}\`${project.projectDir}\``,
    `*session*  \`${input.sessionId ?? "<pending>"}\``,
    `*verbosity*  \`${project.verbosity}\``,
  ]
  if (input.resumed) {
    const r = input.resumed
    const parts: string[] = []
    if (typeof r.priorTurns === "number") parts.push(`${r.priorTurns} prior turns`)
    if (typeof r.priorCostUsd === "number") parts.push(`cost ~ $${r.priorCostUsd.toFixed(3)}`)
    if (r.lastActive) parts.push(`last active ${r.lastActive}`)
    if (parts.length > 0) bodyLines.push(`*resume*  ${parts.join(" · ")}`)
  }
  const participants = input.participants ?? []
  const contextText =
    participants.length > 0
      ? `Participants: ${participants.map((p) => `\`@${p}\``).join("  ")}`
      : `type \`!bantai help\` for control commands`

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: title, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: bodyLines.join("\n") },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: contextText }],
    },
  ]

  // Slack also falls back to the `text` field for notifications; keep it
  // informative for screen readers / fallbacks.
  const text = `bantai ${input.resumed ? "resumed" : "started"} — backend ${project.backend}, model ${project.model ?? "default"}, project ${project.projectDir}`

  return { text, blocks }
}

export interface PostBannerOpts {
  adapter: SendAdapter
  channel: string
  threadTs: string
  inputs: BannerInputs
}

export async function postSessionBanner(opts: PostBannerOpts): Promise<{ ts: string }> {
  const { text, blocks } = buildSessionBanner(opts.inputs)
  const res = await opts.adapter.postMessage({
    channel: opts.channel,
    threadTs: opts.threadTs,
    text,
    blocks,
  })
  return { ts: res.ts }
}
