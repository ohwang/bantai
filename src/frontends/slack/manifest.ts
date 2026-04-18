/**
 * Slack app manifest generator for bantai.
 *
 * Operators run `bantai slack init-manifest` and paste the output into
 * https://api.slack.com/apps → Create New App → From an app manifest. This
 * avoids the 20-click app setup where every missing scope or event subscription
 * is a separate round-trip.
 *
 * The manifest lists the scopes + event subscriptions the launcher actually
 * uses. Keep it in sync with `transport/events.ts` (subscriptions) and the
 * block-kit surfaces in `view/blocks/*.ts` (interactivity).
 *
 * Format: the manifest spec is documented at
 *   https://api.slack.com/reference/manifests
 * We emit it as either `json` (safe default — Slack's UI accepts it) or
 * `yaml` (nicer to read). YAML output is hand-rolled to avoid pulling in a
 * serializer dep; the shape is flat enough that a tiny emitter covers it.
 */

/** Scopes the launcher needs on the bot user. */
export const BOT_SCOPES: readonly string[] = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.customize",
  "chat:write.public",
  "commands",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  "users:read",
  "users:read.email",
]

/** Event subscriptions on the bot. Mirrors `transport/events.ts`. */
export const SUBSCRIBED_EVENTS: readonly string[] = [
  "app_mention",
  "file_shared",
  "member_joined_channel",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "reaction_added",
]

export interface ManifestOpts {
  /** App display name (shown in workspace app directory). */
  displayName?: string
  /** Short description. */
  description?: string
  /** Bot's display user name. */
  botUserDisplayName?: string
  /** Socket Mode toggle. Off → Events API via HTTP receiver. Default: true. */
  socketMode?: boolean
  /** Request URL for Events API (required when socketMode=false). */
  requestUrl?: string
}

interface ManifestShape {
  display_information: { name: string; description: string }
  features: {
    bot_user: { display_name: string; always_online: boolean }
    app_home?: { home_tab_enabled: boolean; messages_tab_enabled: boolean; messages_tab_read_only_enabled: boolean }
  }
  oauth_config: {
    scopes: { bot: string[] }
  }
  settings: {
    event_subscriptions?: {
      request_url?: string
      bot_events: string[]
    }
    interactivity: {
      is_enabled: boolean
      request_url?: string
    }
    org_deploy_enabled: boolean
    socket_mode_enabled: boolean
    token_rotation_enabled: boolean
  }
}

export function buildManifest(opts: ManifestOpts = {}): ManifestShape {
  const socketMode = opts.socketMode ?? true
  const display = opts.displayName ?? "bantai"
  const bot = opts.botUserDisplayName ?? display
  const description =
    opts.description ?? "Pair-programming bot backed by Claude / Codex / Gemini."

  const manifest: ManifestShape = {
    display_information: { name: display, description },
    features: {
      bot_user: { display_name: bot, always_online: true },
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
    },
    oauth_config: {
      scopes: { bot: [...BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: socketMode
        ? { bot_events: [...SUBSCRIBED_EVENTS] }
        : {
            request_url: opts.requestUrl ?? "https://example.com/slack/events",
            bot_events: [...SUBSCRIBED_EVENTS],
          },
      interactivity: socketMode
        ? { is_enabled: true }
        : {
            is_enabled: true,
            request_url: opts.requestUrl ?? "https://example.com/slack/events",
          },
      org_deploy_enabled: false,
      socket_mode_enabled: socketMode,
      token_rotation_enabled: false,
    },
  }
  return manifest
}

/** Serialise the manifest as pretty-printed JSON (two-space indent). */
export function manifestToJson(manifest: ManifestShape): string {
  return JSON.stringify(manifest, null, 2)
}

/**
 * Serialise the manifest as YAML. Hand-rolled to stay dep-free — only handles
 * the flat structure we emit (strings / numbers / booleans / string arrays /
 * nested objects). Good enough for this manifest; do NOT use as a general-
 * purpose YAML serialiser.
 */
export function manifestToYaml(manifest: ManifestShape): string {
  return toYaml(manifest as unknown as Record<string, unknown>, 0)
}

function toYaml(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent)
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    return value
      .map((item) => {
        if (isObject(item)) {
          const nested = toYaml(item, indent + 1)
          return `${pad}- ${nested.trimStart()}`
        }
        return `${pad}- ${formatScalar(item)}`
      })
      .join("\n")
  }
  if (isObject(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return "{}"
    return entries
      .map(([k, v]) => {
        if (isObject(v) || Array.isArray(v)) {
          const body = toYaml(v, indent + 1)
          // Arrays-of-objects and empty-object are inlined; objects need a
          // newline-introduced block.
          if (body === "[]" || body === "{}") {
            return `${pad}${k}: ${body}`
          }
          return `${pad}${k}:\n${body}`
        }
        return `${pad}${k}: ${formatScalar(v)}`
      })
      .join("\n")
  }
  return `${pad}${formatScalar(value)}`
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function formatScalar(v: unknown): string {
  if (typeof v === "string") {
    if (v === "" || /[:#]|^-|\s/.test(v)) {
      return JSON.stringify(v)
    }
    return v
  }
  if (typeof v === "boolean" || typeof v === "number") return String(v)
  return JSON.stringify(v)
}
