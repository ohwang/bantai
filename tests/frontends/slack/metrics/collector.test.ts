import { describe, expect, it } from "bun:test"
import {
  METRIC_DESCRIPTORS,
  createMetricsCollector,
  createNoopMetricsCollector,
  renderPrometheus,
} from "../../../../src/frontends/slack/metrics/collector"

describe("createMetricsCollector", () => {
  it("inc() adds 1 by default, respects a delta", () => {
    const m = createMetricsCollector()
    m.inc("bantai_slack_turn_started_total")
    m.inc("bantai_slack_turn_started_total")
    m.inc("bantai_slack_turn_started_total", 3)
    expect(m.snapshot().counters["bantai_slack_turn_started_total"]).toBe(5)
  })

  it("add() accumulates fractional amounts", () => {
    const m = createMetricsCollector()
    m.add("bantai_slack_cost_usd_sum", 0.01)
    m.add("bantai_slack_cost_usd_sum", 0.023)
    m.add("bantai_slack_cost_usd_sum", 0.007)
    expect(m.snapshot().counters["bantai_slack_cost_usd_sum"]).toBeCloseTo(0.04, 6)
  })

  it("setGauge() replaces the value (does not accumulate)", () => {
    const m = createMetricsCollector()
    m.setGauge("bantai_slack_sessions_active", 3)
    m.setGauge("bantai_slack_sessions_active", 7)
    m.setGauge("bantai_slack_sessions_active", 2)
    expect(m.snapshot().gauges["bantai_slack_sessions_active"]).toBe(2)
  })

  it("throws on an unknown counter name (typo-guard)", () => {
    const m = createMetricsCollector()
    expect(() => m.inc("bantai_slack_turn_starded_total")).toThrow(
      "unknown counter",
    )
    expect(() => m.add("bantai_slack_bogus", 1)).toThrow("unknown counter")
  })

  it("throws on an unknown gauge name (typo-guard)", () => {
    const m = createMetricsCollector()
    expect(() => m.setGauge("bantai_slack_sessions_alive", 1)).toThrow(
      "unknown gauge",
    )
  })
})

describe("renderPrometheus", () => {
  it("emits every declared descriptor even when zero-valued", () => {
    const text = renderPrometheus({ counters: {}, gauges: {} })
    for (const desc of METRIC_DESCRIPTORS) {
      expect(text).toContain(`# HELP ${desc.name} ${desc.help}`)
      expect(text).toContain(`# TYPE ${desc.name} ${desc.type}`)
      expect(text).toContain(`${desc.name} 0`)
    }
  })

  it("formats integer counters without a decimal suffix", () => {
    const text = renderPrometheus({
      counters: { bantai_slack_turn_started_total: 42 },
      gauges: {},
    })
    expect(text).toContain("bantai_slack_turn_started_total 42\n")
    expect(text).not.toContain("42.0")
  })

  it("formats fractional USD sums with trimmed precision", () => {
    const text = renderPrometheus({
      counters: { bantai_slack_cost_usd_sum: 0.1234567 },
      gauges: {},
    })
    expect(text).toContain("bantai_slack_cost_usd_sum 0.123457\n")
  })

  it("ends with a trailing newline per Prometheus format spec", () => {
    const text = renderPrometheus({ counters: {}, gauges: {} })
    expect(text.endsWith("\n")).toBe(true)
  })
})

describe("createNoopMetricsCollector", () => {
  it("accepts every call and renders an empty string", () => {
    const m = createNoopMetricsCollector()
    m.inc("bantai_slack_turn_started_total")
    m.add("bantai_slack_cost_usd_sum", 0.5)
    m.setGauge("bantai_slack_sessions_active", 4)
    expect(m.snapshot()).toEqual({ counters: {}, gauges: {} })
    expect(m.render()).toBe("")
  })
})
