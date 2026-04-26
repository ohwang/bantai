/**
 * /thinking — View or change thinking effort level.
 *
 * Consistent with Claude Code's effort control:
 *   /thinking           — show current effort level
 *   /thinking low       — minimal thinking, fastest responses
 *   /thinking medium    — moderate thinking
 *   /thinking high      — deep reasoning (default)
 */

import type { SlashCommand } from "../registry"
import {
  EFFORT_LEVELS,
  RUNTIME_EFFORT_LEVELS,
  isKnownEffortLevel,
  isRuntimeEffortLevel,
  listRuntimeEffortLevelsForCli,
} from "../../protocol/effort-levels"

// Help text built at call-site from the registry — keeps `/thinking` and
// `--effort` in sync with the central source of truth (Cluster 5).
const RUNTIME_HELP_LINES = RUNTIME_EFFORT_LEVELS
  .map((id) => {
    const desc = EFFORT_LEVELS.find((l) => l.id === id)?.description ?? ""
    const padded = id.padEnd(6)
    return `  ${padded} — ${desc}`
  })
  .join("\n")

export const thinkingCommand: SlashCommand = {
  name: "thinking",
  description: "View or change thinking effort level",
  aliases: ["effort"],
  argumentHint: `<${RUNTIME_EFFORT_LEVELS.join("|")}>`,
  execute: async (args, ctx) => {
    const current = ctx.getSessionState?.().currentEffort || "high"

    if (!args.trim()) {
      ctx.pushEvent({
        type: "system_message",
        text: `Thinking effort: ${current}\n\nUsage: /thinking <${RUNTIME_EFFORT_LEVELS.join("|")}>\n${RUNTIME_HELP_LINES}`,
        ephemeral: true,
      })
      return
    }

    const level = args.trim().toLowerCase()

    if (!isKnownEffortLevel(level)) {
      ctx.pushEvent({
        type: "system_message",
        text: `Unknown effort level: ${level}\n\nValid runtime levels: ${listRuntimeEffortLevelsForCli()}`,
        ephemeral: true,
      })
      return
    }

    if (!isRuntimeEffortLevel(level)) {
      ctx.pushEvent({
        type: "system_message",
        text: `Cannot set effort to '${level}' at runtime. Use --effort ${level} at startup.`,
        ephemeral: true,
      })
      return
    }

    if (level === current) {
      ctx.pushEvent({
        type: "system_message",
        text: `Thinking effort is already ${level}`,
        ephemeral: true,
      })
      return
    }

    const caps = ctx.backend.capabilities()

    try {
      await ctx.backend.setEffort(level)

      if (caps.supportsThinking) {
        // Backend supports thinking — emit event and confirm
        ctx.pushEvent({
          type: "effort_changed",
          effort: level,
        })
        ctx.pushEvent({
          type: "system_message",
          text: `Thinking effort set to ${level}`,
          ephemeral: true,
        })
      } else {
        // Backend may not support effort control — inform the user
        ctx.pushEvent({
          type: "system_message",
          text: `Requested thinking effort: ${level}\n(This backend may not support thinking control)`,
          ephemeral: true,
        })
      }
    } catch (error) {
      ctx.pushEvent({
        type: "system_message",
        text: `Error: Could not set effort level. ${error instanceof Error ? error.message : "Unknown error"}`,
        ephemeral: true,
      })
    }
  },
}
