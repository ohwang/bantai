/**
 * Emoji-based backend router.
 *
 * When a Slack thread's *root message* contains a workspace emoji whose name
 * matches one of our backend keywords (e.g. `:claude:`, `:openai:`,
 * `:codex-loop:`, `:google-gemini:`), the routing layer can use that signal
 * to override the channel's default backend (and optionally its model) for
 * the lifetime of that thread.
 *
 * Why this lives in its own module:
 *
 *   - Pure data + parsing (no Slack/Bolt deps), so unit tests can drive it
 *     directly without spinning up minislack.
 *   - Single source of truth for the keyword → backend map. Adding a new
 *     trigger keyword (e.g. `mistral`, `qwen`, …) is a one-line change.
 *   - Designed to grow into a richer routing layer later (thinking effort,
 *     skill bundles, model-routing). Today we map keyword → backend (+
 *     optional model). Tomorrow the same parse step can return a richer
 *     `RouteDirective` carrying e.g. `{ thinkingEffort: "high" }`.
 *
 * Scope:
 *
 *   - Only the *first* matching emoji wins. Order in `EMOJI_ROUTE_RULES`
 *     determines priority — list specific rules (e.g. `opus`) before
 *     generic ones (e.g. `claude`) so `:opus-orange:` routes to Opus
 *     specifically rather than collapsing to "claude default".
 *   - Substring match against the emoji name, case-insensitive. Slack
 *     workspaces use a wide variety of emoji aliases (`:openai:`, `:openai-1:`,
 *     `:claude-anthropic:`, `:google-gemini:`); a substring rule covers
 *     them all without needing the workspace's literal emoji list at
 *     runtime.
 *   - Bantai's own UI emojis (`:bantai:`, status reactions like `:eyes:`)
 *     don't trigger routing because the keyword list contains only
 *     vendor-/model-specific tokens.
 *
 * Non-goals:
 *
 *   - We do NOT validate the emoji exists in the workspace. A typo like
 *     `:claudd:` simply won't match any rule and routing falls through to
 *     the channel default — same as if the user hadn't typed an emoji at
 *     all. (A future iteration could surface "did you mean :claude:?" via
 *     a hint card; today's behaviour is silent fall-through.)
 *   - We do NOT mutate channel-scoped state. Emoji routing is per-thread:
 *     the caller (`routing.ts → dispatchMessageBatch`) clones the resolved
 *     `ProjectConfig` and applies the route to the clone before handing it
 *     to the registry.
 */

import type { BackendId } from "../../../protocol/registry"

/**
 * Priority-ordered list of routing rules. The parser walks this list IN
 * ORDER for each emoji it finds in the message, so:
 *
 *   - More specific keywords (`opus`, `sonnet`, `haiku`, `codex`) come
 *     before broader ones (`claude`, `openai`).
 *   - Within a backend, model-bearing rules come before model-less ones,
 *     so `:opus-anthropic:` routes to Opus rather than "claude default".
 *
 * Adding a new backend or model alias is a one-line addition here. Keep
 * keywords lowercase — the parser lower-cases the emoji name before
 * comparison.
 */
export interface EmojiRouteRule {
  /**
   * Substring to look for inside the `:emoji_name:` token, case-insensitive.
   * Must be a sequence of `[a-z0-9_-]` characters that can plausibly appear
   * in a Slack emoji shortcode. Don't include the leading/trailing colons.
   */
  keyword: string
  /** Backend the rule routes to. */
  backend: BackendId
  /**
   * Optional model the keyword implies. When omitted the route only sets
   * the backend; the model resolves through the usual project-config /
   * runtime-override / backend-default chain.
   */
  model?: string
  /**
   * Short, user-facing label for banners and logs. Used as
   * `routed via {emoji} → {label}` in the session banner. Defaults to the
   * backend id when omitted.
   */
  label?: string
}

/**
 * Default rule table. Exported so tests (and future config-driven
 * extensions) can introspect or override it.
 *
 * Model picks track the latest shipped versions via `protocol/models.ts`'s
 * MODEL_NAMES — keep these in lockstep when bumping a default model.
 */
export const EMOJI_ROUTE_RULES: readonly EmojiRouteRule[] = [
  // ---- Claude-family aliases (model-specific first) ------------------
  // `:opus:` should reach Opus specifically, not just the channel's
  // default Claude model. Likewise `:sonnet:` and `:haiku:`.
  { keyword: "opus", backend: "claude", model: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { keyword: "sonnet", backend: "claude", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { keyword: "haiku", backend: "claude", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  // Bare-Claude / Anthropic — backend only; let the channel's configured
  // model win. `anthropic` covers `:anthropic-logo:` etc.
  { keyword: "anthropic", backend: "claude", label: "Claude" },
  { keyword: "claude", backend: "claude", label: "Claude" },

  // ---- OpenAI / Codex ------------------------------------------------
  // `:codex-loop:` and `:codex:` always route to the Codex backend.
  // `:gpt:`, `:gpt-5:`, `:openai:` likewise — Codex is the only OpenAI-
  // family backend bantai exposes today.
  { keyword: "codex", backend: "codex", label: "Codex" },
  { keyword: "openai", backend: "codex", label: "Codex (OpenAI)" },
  { keyword: "gpt", backend: "codex", label: "Codex" },

  // ---- Google / Gemini ----------------------------------------------
  // `gemini` first (more specific than `google`) so `:google-gemini:`
  // matches `gemini` rather than the broader `google` keyword.
  { keyword: "gemini", backend: "gemini", label: "Gemini" },
  { keyword: "google", backend: "gemini", label: "Gemini (Google)" },

  // ---- GitHub Copilot ------------------------------------------------
  { keyword: "copilot", backend: "copilot", label: "GitHub Copilot" },

  // ---- Qwen ----------------------------------------------------------
  { keyword: "qwen", backend: "qwen", label: "Qwen" },
] as const

/**
 * Result of a successful parse. Returned to the caller (routing.ts) which
 * is responsible for applying it to a project clone.
 */
export interface EmojiRoute {
  /** Resolved backend id (matches `BackendId` in `protocol/registry.ts`). */
  backend: BackendId
  /** Optional model override. Undefined → keep project's existing model. */
  model?: string
  /** The literal `:name:` token that triggered the match (with colons). */
  matchedEmoji: string
  /** The keyword from the rule table that matched. */
  matchedKeyword: string
  /** Human-readable label for banners + logs. */
  label: string
}

/**
 * Slack message text contains custom emojis as literal `:short_code:`
 * substrings (Slack does NOT expand them to Unicode at the wire level; the
 * client renders them via `emoji.list`). The shortcode grammar Slack
 * accepts is `[a-z0-9_+-]+` plus an optional `::skin-tone-N` suffix; we
 * match the basic shape and lowercase-fold the captured name before
 * looking it up.
 *
 * Made non-anchored on purpose — the emoji can appear anywhere in the
 * message body, e.g. "fix this bug :claude:" or ":codex-loop: please
 * check tests".
 */
const EMOJI_TOKEN_PATTERN = /:([a-z0-9_+-]+):/gi

/**
 * Parse a routing directive from raw Slack message text.
 *
 * Returns the FIRST match in document order — emojis appearing earlier in
 * the message take priority over later ones. This matters for messages
 * like ":codex: but actually use :claude:" — we route to Codex (which
 * matches the user's intent better than guessing).
 *
 * Returns `null` when:
 *   - The text contains no `:emoji:` tokens at all.
 *   - The text contains emojis, but none match a known keyword (e.g.
 *     `:wave:`, `:tada:`, `:eyes:`).
 *
 * The caller treats `null` as "no routing override — use channel defaults".
 */
export function parseEmojiRoute(
  text: string,
  rules: readonly EmojiRouteRule[] = EMOJI_ROUTE_RULES,
): EmojiRoute | null {
  if (!text) return null
  for (const match of text.matchAll(EMOJI_TOKEN_PATTERN)) {
    const raw = match[0]
    const name = (match[1] ?? "").toLowerCase()
    if (!name) continue
    for (const rule of rules) {
      if (name.includes(rule.keyword)) {
        return {
          backend: rule.backend,
          ...(rule.model !== undefined ? { model: rule.model } : {}),
          matchedEmoji: raw,
          matchedKeyword: rule.keyword,
          label: rule.label ?? rule.backend,
        }
      }
    }
  }
  return null
}

/**
 * Compose a one-line summary of a route for log lines and banner text.
 *
 * Kept here (not in view/format.ts) so the renderer side can be refactored
 * without churning the router contract. Format is deliberately compact —
 * banners are tight on real estate and the matched emoji visually
 * communicates intent already.
 */
export function describeEmojiRoute(route: EmojiRoute): string {
  const modelSuffix = route.model ? ` (${route.model})` : ""
  return `${route.matchedEmoji} → ${route.label}${modelSuffix}`
}
