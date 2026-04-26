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
import { friendlyModelName, resolveContextWindow } from "../../../protocol/models"
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
    const model = state.session?.models?.[0]
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

    // Build the model info line
    const parts = [friendly, `(${ctxLabel})`]

    const plan = state.session?.account?.plan
    if (plan) parts.push(`- ${plan}`)

    return parts.join(" ")
  }

  // Text info lines aligned to logo rows (3 rows)
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
    </box>
  )
}
