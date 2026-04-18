/**
 * Block Kit builder for tool-use approval cards (plan §8.1).
 *
 * Emitted on `permission_request`. The message carries:
 *   - a header with the tool name + a brief description
 *   - a fenced code block of the tool input (truncated to 2600 chars so the
 *     total card stays under Slack's 3000-char-per-block limit; oversize
 *     payloads link to a file upload which S6 lands)
 *   - a context block listing authorised approvers (or "anyone" when empty)
 *   - three buttons: `Allow once`, `Allow always`, `Deny`
 *
 * action_id encoding: `bantai:perm:<permissionRequestId>:<decision>`
 *   where <decision> ∈ { "allow", "allowAlways", "deny" }.
 *
 * Pure of IO — the launcher's block-actions handler parses the same scheme.
 */

import type { KnownBlock } from "@slack/types"

export type ApprovalDecision = "allow" | "allowAlways" | "deny"

export interface ApprovalCardInput {
  /** Slack-unique id from the backend's PermissionRequestEvent. */
  id: string
  /** Tool name being requested. e.g. "Bash", "Write". */
  tool: string
  /** Tool input (stringified into a code fence). Any JSON-serialisable value. */
  input: unknown
  /** Optional display name from the SDK (e.g. "Read file"). */
  displayName?: string
  /** Optional description sentence (e.g. "Claude wants to edit foo.ts"). */
  description?: string
  /** Authorised approver user ids. Empty array → everyone can approve. */
  approvers?: string[]
  /** Auto-reject TTL in ms (rendered as context hint). */
  ttlMs?: number
}

const MAX_INPUT_CHARS = 2600

export function buildApprovalBlocks(input: ApprovalCardInput): {
  text: string
  blocks: KnownBlock[]
} {
  const serialized = serializeInput(input.input)
  const truncated = serialized.length > MAX_INPUT_CHARS
    ? serialized.slice(0, MAX_INPUT_CHARS - 1) + "…"
    : serialized

  const approversHint =
    input.approvers && input.approvers.length > 0
      ? `Approvers: ${input.approvers.map((u) => `<@${u}>`).join(", ")}`
      : "Approvers: anyone in the channel"
  const ttlHint = input.ttlMs
    ? `Auto-rejects in ${Math.round(input.ttlMs / 60000)} min`
    : undefined

  const headerText = input.displayName
    ? `:lock: ${input.tool} — ${input.displayName}`
    : `:lock: ${input.tool} — approval needed`

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText, emoji: true },
    },
  ]
  if (input.description) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: input.description },
    })
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: ["```", truncated, "```"].join("\n") },
  })
  const contextElements: Array<{ type: "mrkdwn"; text: string }> = [
    { type: "mrkdwn", text: approversHint },
  ]
  if (ttlHint) contextElements.push({ type: "mrkdwn", text: ttlHint })
  blocks.push({ type: "context", elements: contextElements })
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "Allow once", emoji: true },
        action_id: encodeActionId(input.id, "allow"),
        value: input.id,
      },
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "Allow always", emoji: true },
        action_id: encodeActionId(input.id, "allowAlways"),
        value: input.id,
      },
      {
        type: "button",
        style: "danger",
        text: { type: "plain_text", text: "Deny", emoji: true },
        action_id: encodeActionId(input.id, "deny"),
        value: input.id,
      },
    ],
  })

  const text = `approval needed: ${input.tool}${input.displayName ? ` — ${input.displayName}` : ""}`
  return { text, blocks }
}

export function buildResolvedApprovalBlocks(args: {
  previous: ApprovalCardInput
  resolver: { userId: string }
  decision: ApprovalDecision | "timeout"
}): {
  text: string
  blocks: KnownBlock[]
} {
  const { previous, resolver, decision } = args
  const serialized = serializeInput(previous.input)
  const truncated =
    serialized.length > MAX_INPUT_CHARS
      ? serialized.slice(0, MAX_INPUT_CHARS - 1) + "…"
      : serialized
  const outcomeText = decisionText(decision, resolver.userId)
  const badge = decision === "deny"
    ? ":no_entry_sign:"
    : decision === "timeout"
      ? ":hourglass:"
      : ":white_check_mark:"
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${badge} ${previous.tool} — ${outcomeText}`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: ["```", truncated, "```"].join("\n") },
    },
  ]
  return {
    text: `${previous.tool} ${outcomeText}`,
    blocks,
  }
}

// ---------------------------------------------------------------------------
// action_id codec
// ---------------------------------------------------------------------------

export function encodeActionId(id: string, decision: ApprovalDecision): string {
  return `bantai:perm:${id}:${decision}`
}

export interface ParsedApprovalAction {
  id: string
  decision: ApprovalDecision
}

export function parseApprovalActionId(actionId: string): ParsedApprovalAction | null {
  const parts = actionId.split(":")
  if (parts.length !== 4) return null
  if (parts[0] !== "bantai" || parts[1] !== "perm") return null
  const decision = parts[3] as ApprovalDecision
  if (decision !== "allow" && decision !== "allowAlways" && decision !== "deny") return null
  return { id: parts[2]!, decision }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeInput(input: unknown): string {
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    return String(input)
  }
}

function decisionText(decision: ApprovalDecision | "timeout", userId: string): string {
  switch (decision) {
    case "allow":
      return `allowed by <@${userId}>`
    case "allowAlways":
      return `allowed (always) by <@${userId}>`
    case "deny":
      return `denied by <@${userId}>`
    case "timeout":
      return `timed out, auto-denied`
  }
}
