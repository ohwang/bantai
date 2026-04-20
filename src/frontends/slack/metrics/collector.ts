/**
 * Prometheus metrics collector — plan §S8 "Prometheus-style metrics
 * endpoint (`/metrics` on the HTTP receiver when http mode)".
 *
 * A tiny in-process counter + gauge bag, rendered in Prometheus text
 * exposition format. No deps — we don't need a full client library
 * (e.g. `prom-client`) because our metric surface is small and flat:
 * counts of lifecycle events + a cost gauge. If the surface grows,
 * consider swapping to prom-client then.
 *
 * Scope kept deliberately small for v0:
 *   - Lifecycle counters: turn started / completed / errored.
 *   - Approval counters: requested / approved / denied.
 *   - Session gauge: currently open sessions.
 *   - Cost counter: sum of all turn_complete.usage.totalCostUsd.
 *
 * All counters are unlabelled to keep the renderer trivial. If we ever
 * want per-channel breakdowns (likely for production observability),
 * the collector gains a small label map and the renderer learns to
 * emit `{label="value"}` tuples. Not needed for plan §S8's exit.
 */

export interface MetricsCollector {
  /** Increment a named counter by 1 (or `delta` when provided). */
  inc(name: string, delta?: number): void
  /** Add `delta` to a named sum counter (allowed to be fractional). */
  add(name: string, delta: number): void
  /** Set a named gauge to `value`. */
  setGauge(name: string, value: number): void
  /** Snapshot the current counter + gauge state. */
  snapshot(): MetricsSnapshot
  /** Render the snapshot in Prometheus text-exposition format. */
  render(): string
}

export interface MetricsSnapshot {
  counters: Record<string, number>
  gauges: Record<string, number>
}

export interface MetricDescriptor {
  name: string
  type: "counter" | "gauge"
  help: string
}

/**
 * Declarative list of every metric we expose. Keeps the `# HELP` + `# TYPE`
 * lines in the output deterministic (alphabetical by name) and prevents a
 * misspelled name from silently creating a brand-new series.
 */
export const METRIC_DESCRIPTORS: MetricDescriptor[] = [
  {
    name: "bantai_slack_approval_approved_total",
    type: "counter",
    help: "Number of approval requests the operator approved.",
  },
  {
    name: "bantai_slack_config_reload_applied_total",
    type: "counter",
    help: "Number of slack.json reloads that passed validation and were applied.",
  },
  {
    name: "bantai_slack_config_reload_rejected_total",
    type: "counter",
    help: "Number of slack.json reloads rejected by parser or zod validation.",
  },
  {
    name: "bantai_slack_config_last_reload_timestamp_seconds",
    type: "gauge",
    help: "Unix timestamp (seconds) of the most recent successful config reload.",
  },
  {
    name: "bantai_slack_approval_denied_total",
    type: "counter",
    help: "Number of approval requests the operator denied.",
  },
  {
    name: "bantai_slack_approval_requested_total",
    type: "counter",
    help: "Number of approval requests the backend raised.",
  },
  {
    name: "bantai_slack_cost_usd_sum",
    type: "counter",
    help: "Cumulative USD cost across every completed turn.",
  },
  {
    name: "bantai_slack_sessions_active",
    type: "gauge",
    help: "Currently-open session count (thread-level).",
  },
  {
    name: "bantai_slack_turn_completed_total",
    type: "counter",
    help: "Number of turns that reached turn_complete.",
  },
  {
    name: "bantai_slack_turn_errored_total",
    type: "counter",
    help: "Number of fatal error events observed on sessions.",
  },
  {
    name: "bantai_slack_turn_started_total",
    type: "counter",
    help: "Number of turns the backend started (turn_start event).",
  },
]

export function createMetricsCollector(): MetricsCollector {
  const counters = new Map<string, number>()
  const gauges = new Map<string, number>()

  function knownCounter(name: string): boolean {
    return METRIC_DESCRIPTORS.some((d) => d.type === "counter" && d.name === name)
  }
  function knownGauge(name: string): boolean {
    return METRIC_DESCRIPTORS.some((d) => d.type === "gauge" && d.name === name)
  }

  return {
    inc(name, delta = 1) {
      if (!knownCounter(name)) {
        throw new Error(`metrics: unknown counter '${name}'`)
      }
      counters.set(name, (counters.get(name) ?? 0) + delta)
    },
    add(name, delta) {
      if (!knownCounter(name)) {
        throw new Error(`metrics: unknown counter '${name}'`)
      }
      counters.set(name, (counters.get(name) ?? 0) + delta)
    },
    setGauge(name, value) {
      if (!knownGauge(name)) {
        throw new Error(`metrics: unknown gauge '${name}'`)
      }
      gauges.set(name, value)
    },
    snapshot() {
      return {
        counters: Object.fromEntries(counters),
        gauges: Object.fromEntries(gauges),
      }
    },
    render() {
      return renderPrometheus({
        counters: Object.fromEntries(counters),
        gauges: Object.fromEntries(gauges),
      })
    },
  }
}

/**
 * Render the snapshot in Prometheus text format
 * (https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format).
 * Every declared descriptor appears in the output — zero-valued series
 * too — so downstream scrapers get a stable shape on every poll.
 */
export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = []
  for (const desc of METRIC_DESCRIPTORS) {
    lines.push(`# HELP ${desc.name} ${desc.help}`)
    lines.push(`# TYPE ${desc.name} ${desc.type}`)
    const value =
      desc.type === "counter"
        ? snapshot.counters[desc.name] ?? 0
        : snapshot.gauges[desc.name] ?? 0
    lines.push(`${desc.name} ${formatNumber(value)}`)
  }
  // Prometheus expects a trailing newline.
  return lines.join("\n") + "\n"
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "NaN"
  if (Number.isInteger(n)) return String(n)
  // Keep enough precision for fractional USD totals but trim trailing zeros.
  return Number(n.toFixed(6)).toString()
}

/** Noop collector for paths that don't stand up a real metrics surface. */
export function createNoopMetricsCollector(): MetricsCollector {
  return {
    inc() {},
    add() {},
    setGauge() {},
    snapshot() {
      return { counters: {}, gauges: {} }
    },
    render() {
      return ""
    },
  }
}
