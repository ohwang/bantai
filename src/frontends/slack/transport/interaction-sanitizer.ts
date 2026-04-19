/**
 * Slack interaction-payload sanitiser (OpenClaw gap 9).
 *
 * When bantai forwards a raw `block_actions` / `view_submission` /
 * `view_closed` payload to an agent as text, two things go wrong
 * without sanitisation:
 *
 *   1. Secrets leak. Slack embeds short-lived credentials in
 *      interaction payloads that can be used to post as the bot for
 *      up to 30 min: `trigger_id` (modal open), `response_url`
 *      (post-as-user for 30 min), `workflow_trigger_url`,
 *      `private_metadata` (opaque app state), `view.hash` (CSRF
 *      token). Redact them hard.
 *
 *   2. Context blows out. A modal with 80 input blocks + 2KB each,
 *      or a multi-select with 500 options, easily exceeds the
 *      agent's tool-output budget. Truncate strings to 160 chars,
 *      arrays to 64 items, and apply a hard compaction when the
 *      serialised payload still exceeds 2400 chars.
 *
 * The current bantai flow routes interactions through purpose-built
 * handlers (approval clicks, interactive-reply clicks, elicitation
 * submits) that only touch the fields they need, so no consumer
 * forwards raw payloads today. This sanitiser is the defensive
 * primitive for a future "forward unknown interactions to the agent"
 * path, and for debugging dumps in audit logs.
 *
 * Ported from openclaw/extensions/slack/src/events/interactions.ts:
 *   15-152 (MIT).
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SanitizeOpts {
  /** Max length for any string field. Default 160. */
  maxStringLen?: number
  /** Max entries in any array field. Default 64. */
  maxArrayLen?: number
  /**
   * Once the sanitised payload's JSON string exceeds this length,
   * drop everything outside the essentials (`type`, `callback_id`,
   * `actions`, `view.state.values`) and serialise that compact view.
   * Default 2400.
   */
  compactBudget?: number
  /**
   * Override the redact list. Defaults to the hardcoded short-lived-
   * credential keys below.
   */
  redactKeys?: Iterable<string>
}

/**
 * Fields we redact even when they appear deep in the tree. These are
 * either short-lived credentials or CSRF-ish server state — an agent
 * acting on them could post as the bot or replay modal submissions.
 */
const DEFAULT_REDACT_KEYS = new Set<string>([
  "trigger_id",
  "response_url",
  "response_urls", // plural variant seen on some surfaces
  "workflow_trigger_url",
  "private_metadata",
  "view_hash", // snake_case (REST payloads)
  "viewHash", // camelCase (post-Bolt)
  "hash", // on view objects — same thing, shorter name
  "bot_access_token",
  "app_installed_team",
])

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Recursively sanitise a Slack interaction payload. Input is an
 * `unknown` because Slack's shape varies per surface and per app
 * install; output is a JSON-safe value (string, number, boolean,
 * null, plain object, or array of same).
 */
export function sanitizeSlackInteractionPayload(
  payload: unknown,
  opts: SanitizeOpts = {},
): unknown {
  const maxStringLen = opts.maxStringLen ?? 160
  const maxArrayLen = opts.maxArrayLen ?? 64
  const compactBudget = opts.compactBudget ?? 2400
  const redactKeys = new Set(opts.redactKeys ?? DEFAULT_REDACT_KEYS)

  const sanitised = walk(payload, {
    maxStringLen,
    maxArrayLen,
    redactKeys,
    depth: 0,
  })
  const serialised = jsonLengthOf(sanitised)
  if (serialised > compactBudget) {
    return compactForm(sanitised)
  }
  return sanitised
}

/**
 * Render a sanitised payload as the compact "Slack interaction: {…}"
 * system message. Useful for agents that consume interaction payloads
 * as plain text instead of a tool-result object.
 */
export function renderSlackInteractionMessage(payload: unknown, opts: SanitizeOpts = {}): string {
  const clean = sanitizeSlackInteractionPayload(payload, opts)
  return `Slack interaction: ${JSON.stringify(clean)}`
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface WalkCtx {
  maxStringLen: number
  maxArrayLen: number
  redactKeys: Set<string>
  depth: number
}

const MAX_DEPTH = 8

function walk(value: unknown, ctx: WalkCtx): unknown {
  if (ctx.depth > MAX_DEPTH) return "[depth-limit]"
  if (value === null || value === undefined) return value
  if (typeof value === "string") return truncateString(value, ctx.maxStringLen)
  if (typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) {
    const out: unknown[] = []
    const limit = Math.min(value.length, ctx.maxArrayLen)
    for (let i = 0; i < limit; i++) {
      out.push(walk(value[i], { ...ctx, depth: ctx.depth + 1 }))
    }
    if (value.length > ctx.maxArrayLen) {
      out.push(`[+${value.length - ctx.maxArrayLen} more]`)
    }
    return out
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (ctx.redactKeys.has(k)) {
        out[k] = "[redacted]"
        continue
      }
      out[k] = walk(v, { ...ctx, depth: ctx.depth + 1 })
    }
    return out
  }
  // Functions / bigints / symbols shouldn't appear in JSON, but if
  // they do, stringify defensively.
  return String(value)
}

function truncateString(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

function jsonLengthOf(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    // Circular / unstringifiable — treat as huge so we fall through to compact.
    return Number.POSITIVE_INFINITY
  }
}

/**
 * When the full sanitised payload is still too big, cut it down to
 * the fields an agent would actually care about:
 *   - `type` / `callback_id` — what kind of interaction is this?
 *   - `actions[]` — what did the user click / select?
 *   - `view.state.values` — what did they fill in?
 *   - `user.id` + `user.name` — who did it?
 *   - `channel.id` — where did it come from?
 *
 * Everything else is summarised as "[…N keys elided]" so the shape
 * is still discoverable but the byte count is bounded.
 */
function compactForm(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload
  const p = payload as Record<string, unknown>
  const view = p.view as Record<string, unknown> | undefined
  const state = view?.state as Record<string, unknown> | undefined
  const user = p.user as Record<string, unknown> | undefined
  const channel = p.channel as Record<string, unknown> | undefined
  const out: Record<string, unknown> = {
    type: p.type,
    ...(p.callback_id ? { callback_id: p.callback_id } : {}),
    ...(Array.isArray(p.actions) ? { actions: p.actions } : {}),
    ...(state?.values ? { view: { state: { values: state.values } } } : {}),
    ...(user
      ? {
          user: {
            id: user.id,
            ...(user.name ? { name: user.name } : {}),
          },
        }
      : {}),
    ...(channel ? { channel: { id: channel.id } } : {}),
    _compacted: true,
  }
  return out
}
