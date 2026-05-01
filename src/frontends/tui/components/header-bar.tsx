/**
 * Header Bar — Pixel-art logo + app info
 *
 * Displays a pixel-art walking cat on the left with
 * app name, version, model info, and working directory on the right.
 *
 * Logo: A side-view cat walking, in warm orange (#d7875f).
 * Uses Unicode half-block characters (▀ ▄ █).
 */

import { homedir } from "node:os"
import { resolve } from "node:path"
import { TextAttributes } from "@opentui/core"
import { useSession } from "../context/session"
import { useAgent } from "../context/agent"
import { findCurrentModel, friendlyModelName, resolveContextWindow } from "../../../protocol/models"
import { colors } from "../theme/tokens"

/**
 * Logo: angular cat face in block characters.
 *
 * Visual:
 *
 *   /▛████▜\
 *    ▀████▀
 *    ▝▘  ▝▘
 *
 * 3 lines tall. Fox-eared cat — sharp ears with solid block body.
 */
const LOGO_LINES = [
  " /▛████▜\\ ",  // ears + head
  "  ▀████▀  ",  // face
  "  ▝▘  ▝▘  ",  // paws
]

export function HeaderBar() {
  const { state } = useSession()
  const agent = useAgent()

  // Prefer the live cwd (from CwdChanged hook) when available, then fall
  // back to config.cwd (captured at launch). We avoid process.cwd() because
  // the SDK or plugins may have changed it after startup.
  const projectPath = () => {
    const live = state.currentCwd
    const raw = live ?? agent.config.cwd ?? process.cwd()
    return resolve(raw).replace(homedir(), "~")
  }

  /** Short "(worktree: <name>)" badge shown when the agent is inside a
   *  worktree created via the Claude SDK's EnterWorktree tool. The name is
   *  trimmed to keep the header on one line. */
  const worktreeLabel = () => {
    const wt = state.worktree
    if (!wt) return ""
    const name = wt.name && wt.name.length > 0 ? wt.name : "active"
    return `  (worktree: ${name})`
  }

  const backendLabel = () => {
    const caps = agent.backend.capabilities()
    return caps.sdkVersion ? `${caps.name} ${caps.sdkVersion}` : caps.name
  }

  const modelInfo = () => {
    // Prefer currentModel (set by Ctrl+P model cycling), then session metadata.
    // We intentionally do NOT fall back to `agent.config.model`: it can be
    // populated from settings (e.g. `~/.claude/settings.json`) regardless of
    // the active backend, which would display a Claude model name for Codex
    // sessions before session_init arrives. Better to admit we don't know
    // yet than to pretend.
    //
    // `findCurrentModel` (rather than `models?.[0]`) because Qwen Code's ACP
    // bundle reports the user's full settings.json model list in arbitrary
    // order — the active model can be `models[1]` or later, and the wrong
    // entry's `contextWindow` would otherwise drive the status bar's % math.
    const model = findCurrentModel(state.session?.models, state.currentModel)
    const raw = state.currentModel || model?.name || ""

    // No model reported by the backend yet — show the backend name alongside
    // an honest "unknown model" label while we wait for session_init.
    if (!raw) return `unknown model (${agent.backend.capabilities().name})`

    const friendly = friendlyModelName(raw)

    // Prefer the SDK's dynamic context window (includes extended thinking),
    // fall back to the hardcoded map for pre-session-init or Ctrl+P model
    // changes. `resolveContextWindow` also tries `model.id` so ACP backends
    // whose `currentModel` is a display name (e.g. `"Gemini 3 (Auto)"` mapped
    // from id `"auto-gemini-3"`) still hit MODEL_CONTEXT_WINDOWS correctly.
    const ctxWindow = resolveContextWindow(model, raw)
    const ctxLabel = ctxWindow >= 1_000_000
      ? `${ctxWindow / 1_000_000}M context`
      : `${ctxWindow / 1_000}K context`

    return `${friendly} (${ctxLabel})`
  }

  // ---------------------------------------------------------------------
  // Account banner line
  //
  // Banner format:
  //   "Claude Pro · alice@example.com · org: Acme Inc · auth: oauth"
  //
  // The banner is a separate line below the working directory so the model
  // line can stay tight (Claude Code mixes them, which we deliberately
  // don't — bantai is multi-backend and the auth source is more relevant
  // here than next to the model name).
  //
  // Hidden until at least one field is populated. The Claude adapter's
  // out-of-band `accountInfo()` call (see ClaudeAdapter.fetchAndEmitAccountInfo)
  // emits an `account_update` event a few hundred ms after session start;
  // until then the banner is just absent rather than showing placeholder
  // text that would later flicker into real values.
  // ---------------------------------------------------------------------
  const accountBannerLine = () => {
    const a = state.session?.account
    if (!a) return ""
    const parts: string[] = []
    // Subscription tier (preferred) → falls back to legacy `plan`.
    const tier = a.subscriptionType ?? a.plan
    if (tier) parts.push(formatSubscriptionLabel(tier))
    if (a.email) parts.push(a.email)
    if (a.organization) parts.push(`org: ${a.organization}`)
    // Show OAuth / API-key source so it's obvious whether the user is on
    // a personal subscription, an org token, or a project-pinned key.
    const authLabel = a.tokenSource ?? a.apiKeySource
    if (authLabel) parts.push(`auth: ${authLabel}`)
    return parts.join("  ·  ")
  }

  // Text info lines aligned to logo rows (3 rows), plus an optional 4th
  // account-banner row that pads the logo column with spaces so the cat
  // doesn't shift when account info arrives.
  return (
    <box flexDirection="column" flexShrink={0}>
      {/* Row 0: head + tail + app name + version */}
      <box flexDirection="row">
        <text fg={colors.accent.logo}>{LOGO_LINES[0]}</text>
        <text fg={colors.accent.logo} attributes={TextAttributes.BOLD}>{"bantai"}</text>
        <text fg={colors.text.secondary}>{`  v0.0.1 (${backendLabel()})`}</text>
      </box>
      {/* Row 1: body + model info */}
      <box flexDirection="row">
        <text fg={colors.accent.logo}>{LOGO_LINES[1]}</text>
        <text fg={colors.text.secondary}>{modelInfo()}</text>
      </box>
      {/* Row 2: legs + working directory */}
      <box flexDirection="row">
        <text fg={colors.accent.logo}>{LOGO_LINES[2]}</text>
        <text fg={colors.text.secondary}>{projectPath() + worktreeLabel()}</text>
      </box>
      {/* Row 3: account banner — only when populated. The leading spaces
          align the text under the logo's right edge so the visual rhythm
          of rows 0–2 carries into row 3. */}
      {accountBannerLine() && (
        <box flexDirection="row">
          <text fg={colors.text.muted}>{"          "}</text>
          <text fg={colors.text.muted}>{accountBannerLine()}</text>
        </box>
      )}
    </box>
  )
}

/**
 * Render a friendly subscription label for the header banner. The Claude
 * SDK reports `pro` / `max` / `team` / `enterprise` as a raw lowercase id;
 * the banner reads better as "Claude Pro" / "Claude Max" etc.
 *
 * Other backends (Codex, ACP) generally don't report a subscription tier,
 * so the unknown branch returns the raw value capitalised — better than
 * dropping data we don't recognise.
 */
function formatSubscriptionLabel(tier: string): string {
  const lower = tier.toLowerCase()
  switch (lower) {
    case "pro":
      return "Claude Pro"
    case "max":
      return "Claude Max"
    case "team":
      return "Claude Team"
    case "enterprise":
      return "Claude Enterprise"
    default:
      // Capitalise the first letter so e.g. "starter" → "Starter".
      return lower.charAt(0).toUpperCase() + lower.slice(1)
  }
}
