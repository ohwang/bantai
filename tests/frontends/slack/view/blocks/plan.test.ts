import { describe, expect, it } from "bun:test"
import { buildPlanBlocks } from "../../../../../src/frontends/slack/view/blocks/plan"

function textAt(blocks: readonly unknown[], idx: number): string {
  return (blocks[idx] as { text: { text: string } }).text.text
}

describe("buildPlanBlocks", () => {
  it("returns null for empty input", () => {
    expect(buildPlanBlocks({ entries: [] })).toBeNull()
  })

  it("renders header + one section with bullet lines per entry", () => {
    const { blocks, text } = buildPlanBlocks({
      entries: [
        { content: "Read the config", status: "completed" },
        { content: "Write the patch", status: "in_progress", priority: "high" },
        { content: "Run tests", status: "pending" },
      ],
    })!

    expect(blocks.length).toBe(2)
    expect(textAt(blocks, 0)).toContain(":clipboard:")
    expect(textAt(blocks, 0)).toContain("1 of 3 done")

    const body = textAt(blocks, 1)
    expect(body).toContain(":heavy_check_mark:")
    expect(body).toContain(":arrows_counterclockwise:")
    expect(body).toContain(":hourglass_flowing_sand:")
    expect(body).toContain("~Read the config~") // completed is strikethrough
    expect(body).toContain("_(high)_")

    expect(text).toContain("1/3 done")
  })

  it("truncates individual bullet content beyond the per-line cap", () => {
    const long = "x".repeat(500)
    const { blocks } = buildPlanBlocks({
      entries: [{ content: long, status: "pending" }],
    })!
    const body = textAt(blocks, 1)
    expect(body.endsWith("…")).toBe(true)
    expect(body.length).toBeLessThan(300)
  })

  it("truncates overflow entries beyond the rendered cap", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      content: `step ${i}`,
      status: "pending" as const,
    }))
    const { blocks, text } = buildPlanBlocks({ entries: many })!
    const body = textAt(blocks, 1)
    expect(body).toContain("step 0")
    expect(body).toContain("step 39") // last in slice
    expect(body).not.toContain("step 40")
    expect(body).toContain("+20 more")
    // Header count reflects the FULL list, not the truncated slice.
    expect(text).toContain("0/60 done")
  })

  it("fallback bullet for entries with no status", () => {
    const { blocks } = buildPlanBlocks({
      entries: [{ content: "think about it" }],
    })!
    const body = textAt(blocks, 1)
    expect(body).toContain(":white_small_square:")
  })
})
