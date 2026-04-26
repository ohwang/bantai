/**
 * Effort Level Registry — single source of truth for the closed enumeration
 * of `--effort` / `/thinking` levels.
 *
 * Cluster 5 from anti-drift-sprint-todo. The same five values were
 * re-enumerated in:
 *
 *   - protocol/types.ts                          canonical union
 *   - cli/options.ts                              || chain validator + help
 *   - subagents/definitions.ts                    VALID_EFFORT_LEVELS Set
 *   - commands/builtin/thinking.ts                TWO arrays that already
 *                                                 disagreed (3 vs 5 entries),
 *                                                 plus a hand-typed argumentHint
 *
 * Promote to one descriptor table here. The two relevant subsets are:
 *
 *   - `EFFORT_LEVELS`         — every level the backend can be configured with
 *   - `RUNTIME_EFFORT_LEVELS` — levels you can switch *at runtime* via
 *                               `/thinking <level>`. `xhigh` and `max` are
 *                               explicitly start-up-only because backends
 *                               that materialise them as thinking budgets
 *                               can't change them mid-session.
 */

export interface EffortLevelDescriptor {
  /** Stable id used at the CLI / config / API boundary. */
  id: string
  /** One-line summary suitable for `--help` and `/thinking` output. */
  description: string
  /**
   * Whether `/thinking <id>` may switch into this level at runtime.
   * `xhigh` and `max` are start-up-only because the underlying backends
   * (Claude SDK thinking budgets) bake the value into the initial spawn.
   */
  runtimeSwitchable: boolean
}

export const EFFORT_LEVELS = [
  {
    id: "low",
    description: "Minimal thinking, fastest responses",
    runtimeSwitchable: true,
  },
  {
    id: "medium",
    description: "Moderate thinking",
    runtimeSwitchable: true,
  },
  {
    id: "high",
    description: "Deep reasoning (default)",
    runtimeSwitchable: true,
  },
  {
    id: "xhigh",
    description: "Extra-high reasoning budget (start-up only)",
    runtimeSwitchable: false,
  },
  {
    id: "max",
    description: "Maximum reasoning budget (start-up only)",
    runtimeSwitchable: false,
  },
] as const satisfies readonly EffortLevelDescriptor[]

/** Closed string-literal type derived from the registry. */
export type EffortLevel = typeof EFFORT_LEVELS[number]["id"]

/** All registered effort level ids, in registration order. */
export function knownEffortLevelIds(): EffortLevel[] {
  return EFFORT_LEVELS.map((l) => l.id)
}

/** True if `id` matches a registered effort level. */
export function isKnownEffortLevel(id: string): id is EffortLevel {
  return EFFORT_LEVELS.some((l) => l.id === id)
}

/** Lookup by id. Returns undefined for unknown levels. */
export function getEffortLevelDescriptor(
  id: string,
): EffortLevelDescriptor | undefined {
  return EFFORT_LEVELS.find((l) => l.id === id)
}

/** Comma-separated list for CLI `--help` and validator errors. */
export function listEffortLevelsForCli(): string {
  return knownEffortLevelIds().join(", ")
}

/**
 * Subset of effort levels that can be switched at runtime. `/thinking`
 * uses this as its accept set; CLI `--effort` uses the full list.
 */
export const RUNTIME_EFFORT_LEVELS: readonly EffortLevel[] = EFFORT_LEVELS
  .filter((l) => l.runtimeSwitchable)
  .map((l) => l.id)

export function isRuntimeEffortLevel(id: string): id is EffortLevel {
  return RUNTIME_EFFORT_LEVELS.includes(id as EffortLevel)
}

/** Comma-separated list of runtime-switchable levels for `/thinking`. */
export function listRuntimeEffortLevelsForCli(): string {
  return RUNTIME_EFFORT_LEVELS.join(", ")
}
