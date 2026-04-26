/**
 * /ab <prompt> — launch an A/B model comparison.
 *
 * Argument parsing supports:
 *   /ab <prompt>                            (interactive target picker)
 *   /ab --a=claude --b=codex <prompt>       (skip review phase if both targets given)
 *   /ab --a=claude:opus --b=codex <prompt>  (backend:model shorthand)
 *
 * The command:
 *   1. Parses targets from flags or falls back to defaults (claude vs codex).
 *   2. Constructs an OrchestratorHandle.
 *   3. Asks the frontend to open the `ab` panel with the orchestrator.
 *   4. On settlement the panel dismisses itself and a system_message
 *      summarises the outcome in the main conversation.
 */

import { createOrchestrator } from "../../ab/orchestrator"
import type { Target } from "../../ab/types"
import { isKnownBackendId, knownBackendIds, listBackends } from "../../protocol/registry"
import { friendlyBackendName, friendlyModelName } from "../../protocol/models"
import { log } from "../../utils/logger"
import type { AbPanelData } from "../frontend"
import type { CommandContext, SlashCommand } from "../registry"

export interface ParsedAbArgs {
  prompt: string
  targetA?: Target
  targetB?: Target
  criteriaId?: string
  /** Errors collected during parsing (unknown backends, malformed flags, etc.). */
  errors: string[]
}

/** Parse a single `--a=` / `--b=` flag value of the form `backend[:model]`. */
function parseTargetSpec(spec: string, errors: string[]): Target | undefined {
  const colon = spec.indexOf(":")
  const backendId = colon === -1 ? spec : spec.slice(0, colon)
  const model = colon === -1 ? undefined : spec.slice(colon + 1)
  if (!isKnownBackendId(backendId)) {
    errors.push(
      `Unknown backend "${backendId}". Known: ${knownBackendIds().join(", ")}`,
    )
    return undefined
  }
  return { backendId, model: model || undefined }
}

/**
 * Parse the raw argument string for /ab. Public for unit testing.
 *
 * Whitespace-insensitive flag parsing — flags may appear before, after, or
 * interleaved with the prompt. Anything that isn't a recognized flag becomes
 * part of the prompt.
 */
export function parseAbArgs(raw: string): ParsedAbArgs {
  const errors: string[] = []
  const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  let targetA: Target | undefined
  let targetB: Target | undefined
  let criteriaId: string | undefined
  const promptParts: string[] = []

  for (const tokenRaw of tokens) {
    // Strip surrounding quotes
    const token = tokenRaw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
    if (token.startsWith("--a=")) {
      targetA = parseTargetSpec(token.slice(4), errors)
    } else if (token.startsWith("--b=")) {
      targetB = parseTargetSpec(token.slice(4), errors)
    } else if (token.startsWith("--criteria=")) {
      criteriaId = token.slice("--criteria=".length)
    } else {
      promptParts.push(token)
    }
  }

  return {
    prompt: promptParts.join(" ").trim(),
    targetA,
    targetB,
    criteriaId,
    errors,
  }
}

/** Pick sensible default targets when the user doesn't supply --a/--b. */
function defaultTargets(currentBackend: string): { a: Target; b: Target } {
  // Prefer current backend as A; pick first different available backend as B.
  // Fall back to the same backend for both if nothing else is available.
  const all = listBackends().filter((b) => !b.requiresExtraConfig && b.isAvailable())
  const a: Target = { backendId: currentBackend }
  const otherCandidate = all.find((b) => b.id !== currentBackend) ?? all[0]
  const b: Target = { backendId: otherCandidate?.id ?? "claude" }
  return { a, b }
}

function formatOutcome(opts: {
  winner?: "A" | "B" | "combine" | null
  mergeMethod?: string
  error?: string
  targetA: Target
  targetB: Target
}): string {
  if (opts.error) {
    return `A/B comparison aborted: ${opts.error}`
  }
  if (opts.winner === "combine") {
    return "A/B comparison: combined result written to project."
  }
  if (opts.winner === "A" || opts.winner === "B") {
    const target = opts.winner === "A" ? opts.targetA : opts.targetB
    const desc = `${friendlyBackendName(target.backendId)}${target.model ? ` (${friendlyModelName(target.model)})` : ""}`
    const method = opts.mergeMethod ? ` via ${opts.mergeMethod}` : ""
    return `A/B comparison: adopted ${opts.winner} (${desc})${method}.`
  }
  return "A/B comparison cancelled."
}

export const abCommand: SlashCommand = {
  name: "ab",
  description: "Run an A/B comparison: same prompt to two models/backends",
  argumentHint: "[--a=backend[:model]] [--b=backend[:model]] <prompt>",
  execute: async (args: string, ctx: CommandContext) => {
    const parsed = parseAbArgs(args)
    if (parsed.errors.length > 0) {
      ctx.pushEvent({
        type: "system_message",
        text: `/ab: ${parsed.errors.join("\n/ab: ")}`,
        ephemeral: true,
      })
      return
    }
    if (!parsed.prompt) {
      ctx.pushEvent({
        type: "system_message",
        text: "Usage: /ab [--a=backend[:model]] [--b=backend[:model]] <prompt>\n\nExamples:\n  /ab refactor the auth module\n  /ab --a=claude --b=codex add input validation to the API\n  /ab --a=claude:opus --b=claude:sonnet --criteria=stability tighten error handling",
        ephemeral: true,
      })
      return
    }

    if (!ctx.frontend?.openPanel) {
      ctx.pushEvent({
        type: "system_message",
        ephemeral: true,
        text: "/ab is only available in the terminal UI.",
      })
      return
    }

    const cwd = ctx.getCwd?.() ?? process.cwd()
    const currentBackend = ctx.backend.capabilities().name
    const defaults = defaultTargets(currentBackend === "claude-v1" ? "claude" : currentBackend)
    const targetA = parsed.targetA ?? defaults.a
    const targetB = parsed.targetB ?? defaults.b

    const sessionId = ctx.getSessionState?.().session?.sessionId ?? `ab-${Date.now()}`

    log.info("/ab launching orchestrator", {
      cwd,
      sessionId,
      targetA,
      targetB,
      criteriaId: parsed.criteriaId,
    })

    const orchestrator = createOrchestrator({
      projectDir: cwd,
      sessionId,
      prompt: parsed.prompt,
      targetA,
      targetB,
      criteriaId: parsed.criteriaId,
      onDone: (result) => {
        // Post the outcome into the main conversation, then dismiss the modal.
        ctx.pushEvent({
          type: "system_message",
          text: formatOutcome({
            winner: result.winner,
            mergeMethod: result.mergeMethod,
            error: result.error,
            targetA,
            targetB,
          }),
        })
        // Defer dismiss so the user gets a brief chance to see the "Done" view.
        setTimeout(() => ctx.frontend?.dismissPanel?.(), 1200)
      },
    })

    const data: AbPanelData = {
      orchestrator,
      onDismiss: () => ctx.frontend?.dismissPanel?.(),
    }
    ctx.frontend.openPanel("ab", data)
  },
}
