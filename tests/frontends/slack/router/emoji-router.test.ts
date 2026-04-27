/**
 * Unit tests for the emoji-based backend router.
 *
 * The router is pure (`text → EmojiRoute | null`), so these tests drive it
 * directly without going through Bolt or minislack. End-to-end coverage
 * (event → routing.ts → SessionHost backend) lives in
 * `tests/frontends/slack/integration/emoji-routing.test.ts`.
 */

import { describe, expect, it } from "bun:test"
import {
  describeEmojiRoute,
  EMOJI_ROUTE_RULES,
  parseEmojiRoute,
} from "../../../../src/frontends/slack/router/emoji-router"

describe("parseEmojiRoute", () => {
  // ------------------------------------------------------------------
  // Happy paths — each backend has at least one literal-emoji case.
  // ------------------------------------------------------------------

  it("routes :claude: to the claude backend", () => {
    const route = parseEmojiRoute(":claude: please review")
    expect(route).not.toBeNull()
    expect(route?.backend).toBe("claude")
    expect(route?.matchedEmoji).toBe(":claude:")
    expect(route?.matchedKeyword).toBe("claude")
    // Bare-Claude rule has no model — defer to project default.
    expect(route?.model).toBeUndefined()
  })

  it("routes :anthropic: to the claude backend", () => {
    const route = parseEmojiRoute("use :anthropic: this time")
    expect(route?.backend).toBe("claude")
    expect(route?.matchedKeyword).toBe("anthropic")
  })

  it("routes :openai: to the codex backend", () => {
    const route = parseEmojiRoute(":openai: switch please")
    expect(route?.backend).toBe("codex")
    expect(route?.matchedKeyword).toBe("openai")
  })

  it("routes :codex-loop: to the codex backend (substring match)", () => {
    const route = parseEmojiRoute("hey :codex-loop: try this")
    expect(route?.backend).toBe("codex")
    expect(route?.matchedKeyword).toBe("codex")
  })

  it("routes :gpt-5: to the codex backend", () => {
    const route = parseEmojiRoute(":gpt-5: solve this")
    expect(route?.backend).toBe("codex")
    expect(route?.matchedKeyword).toBe("gpt")
  })

  it("routes :gemini: to the gemini backend", () => {
    const route = parseEmojiRoute(":gemini: hi")
    expect(route?.backend).toBe("gemini")
    expect(route?.matchedKeyword).toBe("gemini")
  })

  it("routes :google-gemini: to the gemini backend (gemini wins over google)", () => {
    // Both `google` and `gemini` match — `gemini` is more specific and
    // listed first in the rule table, so it wins.
    const route = parseEmojiRoute(":google-gemini: please")
    expect(route?.backend).toBe("gemini")
    expect(route?.matchedKeyword).toBe("gemini")
  })

  it("routes :google: alone to the gemini backend", () => {
    const route = parseEmojiRoute(":google: search this")
    expect(route?.backend).toBe("gemini")
    expect(route?.matchedKeyword).toBe("google")
  })

  it("routes :copilot: to the copilot backend", () => {
    const route = parseEmojiRoute(":copilot: assist")
    expect(route?.backend).toBe("copilot")
  })

  it("routes :qwen: to the qwen backend", () => {
    const route = parseEmojiRoute(":qwen: hi")
    expect(route?.backend).toBe("qwen")
  })

  // ------------------------------------------------------------------
  // Model-specific Claude aliases
  // ------------------------------------------------------------------

  it("routes :opus: to claude with the latest opus model", () => {
    const route = parseEmojiRoute(":opus: analyse this")
    expect(route?.backend).toBe("claude")
    expect(route?.matchedKeyword).toBe("opus")
    expect(route?.model).toBe("claude-opus-4-7")
  })

  it("routes :sonnet: to claude with the latest sonnet model", () => {
    const route = parseEmojiRoute(":sonnet: ship it")
    expect(route?.backend).toBe("claude")
    expect(route?.model).toBe("claude-sonnet-4-6")
  })

  it("routes :haiku: to claude with the latest haiku model", () => {
    const route = parseEmojiRoute(":haiku: small task")
    expect(route?.backend).toBe("claude")
    expect(route?.model).toBe("claude-haiku-4-5-20251001")
  })

  // ------------------------------------------------------------------
  // Negative paths
  // ------------------------------------------------------------------

  it("returns null for plain text with no emojis", () => {
    expect(parseEmojiRoute("just a normal message")).toBeNull()
  })

  it("returns null for emojis that don't match any rule", () => {
    expect(parseEmojiRoute(":wave: :tada: :eyes: hello")).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(parseEmojiRoute("")).toBeNull()
  })

  it("ignores non-emoji `:` punctuation", () => {
    // A literal "code:" or "ratio 1:1" shouldn't trigger the parser.
    expect(parseEmojiRoute("ratio 1:1 in the code:foo")).toBeNull()
  })

  it("returns null when the text contains only the bot mention", () => {
    // After mention stripping the text might be empty; the parser must
    // gracefully no-op on whitespace / empty input.
    expect(parseEmojiRoute("   ")).toBeNull()
  })

  // ------------------------------------------------------------------
  // First-match ordering
  // ------------------------------------------------------------------

  it("first emoji in document order wins when several rules match", () => {
    // `:claude:` appears first → backend=claude. `:gemini:` later is ignored.
    const route = parseEmojiRoute(":claude: but not :gemini: today")
    expect(route?.backend).toBe("claude")
  })

  it("prefers the more specific keyword listed earlier in the rule table", () => {
    // :opus-anthropic: matches both `opus` (with model) and `anthropic` —
    // `opus` is listed first and IS more specific, so the model is
    // attached.
    const route = parseEmojiRoute(":opus-anthropic: ship it")
    expect(route?.backend).toBe("claude")
    expect(route?.model).toBe("claude-opus-4-7")
    expect(route?.matchedKeyword).toBe("opus")
  })

  // ------------------------------------------------------------------
  // Slack syntax edge cases
  // ------------------------------------------------------------------

  it("matches emoji with hyphens, digits, and underscores in the name", () => {
    const a = parseEmojiRoute(":claude_v2:")
    expect(a?.backend).toBe("claude")
    const b = parseEmojiRoute(":openai-2:")
    expect(b?.backend).toBe("codex")
    const c = parseEmojiRoute(":gemini-flash:")
    expect(c?.backend).toBe("gemini")
  })

  it("is case-insensitive on the emoji name", () => {
    const route = parseEmojiRoute(":Claude:")
    expect(route?.backend).toBe("claude")
  })

  it("works when the routing emoji is preceded by a bot mention", () => {
    // Real Slack messages arrive with `<@UBOT>` still in the text at the
    // routing-decision point; emoji parsing must not be confused by it.
    const route = parseEmojiRoute("<@UBOT> :openai: hi")
    expect(route?.backend).toBe("codex")
  })

  it("works when the routing emoji is at the very end of the message", () => {
    const route = parseEmojiRoute("please run all the tests :claude:")
    expect(route?.backend).toBe("claude")
  })

  it("custom rule sets override the defaults", () => {
    // Belt-and-braces — proves a future caller can hand a custom table
    // (e.g. a workspace-specific override). Use a single deterministic
    // rule so the assertion is unambiguous.
    const customRules = [
      { keyword: "ship", backend: "mock", label: "Mock ship-mode" },
    ] as const
    const route = parseEmojiRoute(":shipit:", customRules)
    expect(route?.backend).toBe("mock")
    expect(route?.matchedKeyword).toBe("ship")
  })
})

describe("describeEmojiRoute", () => {
  it("renders the emoji + label without model when model is absent", () => {
    const route = parseEmojiRoute(":claude:")
    expect(route).not.toBeNull()
    expect(describeEmojiRoute(route!)).toBe(":claude: → Claude")
  })

  it("appends the model in parens when present", () => {
    const route = parseEmojiRoute(":opus:")
    expect(route).not.toBeNull()
    expect(describeEmojiRoute(route!)).toBe(":opus: → Claude Opus 4.7 (claude-opus-4-7)")
  })
})

describe("EMOJI_ROUTE_RULES", () => {
  it("covers every backend bantai exposes today", () => {
    const backends = new Set(EMOJI_ROUTE_RULES.map((r) => r.backend))
    expect(backends.has("claude")).toBe(true)
    expect(backends.has("codex")).toBe(true)
    expect(backends.has("gemini")).toBe(true)
    expect(backends.has("copilot")).toBe(true)
    expect(backends.has("qwen")).toBe(true)
  })

  it("uses lowercase keywords (the parser lowercases before matching)", () => {
    for (const rule of EMOJI_ROUTE_RULES) {
      expect(rule.keyword).toBe(rule.keyword.toLowerCase())
    }
  })

  it("places the more-specific 'gemini' rule before the broader 'google'", () => {
    // Order matters: see the test above where :google-gemini: must
    // resolve via `gemini`. This guards against an accidental reorder.
    const idxGemini = EMOJI_ROUTE_RULES.findIndex((r) => r.keyword === "gemini")
    const idxGoogle = EMOJI_ROUTE_RULES.findIndex((r) => r.keyword === "google")
    expect(idxGemini).toBeGreaterThanOrEqual(0)
    expect(idxGoogle).toBeGreaterThanOrEqual(0)
    expect(idxGemini).toBeLessThan(idxGoogle)
  })

  it("places model-bearing claude rules before the bare claude rule", () => {
    // Same guard for opus/sonnet/haiku precedence over plain claude.
    const idxOpus = EMOJI_ROUTE_RULES.findIndex((r) => r.keyword === "opus")
    const idxClaude = EMOJI_ROUTE_RULES.findIndex((r) => r.keyword === "claude")
    expect(idxOpus).toBeGreaterThanOrEqual(0)
    expect(idxClaude).toBeGreaterThanOrEqual(0)
    expect(idxOpus).toBeLessThan(idxClaude)
  })
})
