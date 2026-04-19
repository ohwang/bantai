import { describe, expect, it } from "bun:test"
import {
  BOT_SCOPES,
  SUBSCRIBED_EVENTS,
  buildManifest,
  manifestToJson,
  manifestToYaml,
} from "../../../src/frontends/slack/manifest"

describe("buildManifest", () => {
  it("socket mode default — bot_events present, no request_url on event subs", () => {
    const m = buildManifest()
    expect(m.settings.socket_mode_enabled).toBe(true)
    expect(m.settings.event_subscriptions?.bot_events).toEqual([...SUBSCRIBED_EVENTS])
    expect(m.settings.event_subscriptions?.request_url).toBeUndefined()
    expect(m.settings.interactivity.is_enabled).toBe(true)
    // Interactivity request_url is always emitted (defaults to a placeholder)
    // so operators can flip socket mode off without re-editing the manifest.
    expect(m.settings.interactivity.request_url).toBe(
      "https://example.com/slack/interactive",
    )
    expect(m.settings.is_mcp_enabled).toBe(true)
  })

  it("http mode — request_url required, surfaced on interactivity too", () => {
    const m = buildManifest({
      socketMode: false,
      requestUrl: "https://example.com/slack/events",
    })
    expect(m.settings.socket_mode_enabled).toBe(false)
    expect(m.settings.event_subscriptions?.request_url).toBe(
      "https://example.com/slack/events",
    )
    expect(m.settings.interactivity.request_url).toBe(
      "https://example.com/slack/events",
    )
  })

  it("carries the bot scopes in the manifest", () => {
    const m = buildManifest()
    expect(m.oauth_config.scopes.bot).toEqual([...BOT_SCOPES])
  })

  it("respects custom display name", () => {
    const m = buildManifest({ displayName: "mybot" })
    expect(m.display_information.name).toBe("mybot")
    expect(m.features.bot_user.display_name).toBe("mybot")
  })
})

describe("manifestToJson", () => {
  it("produces parseable JSON", () => {
    const m = buildManifest()
    const out = manifestToJson(m)
    expect(() => JSON.parse(out)).not.toThrow()
    const parsed = JSON.parse(out) as typeof m
    expect(parsed.settings.socket_mode_enabled).toBe(true)
  })
})

describe("manifestToYaml", () => {
  it("emits a YAML document with nested blocks + arrays", () => {
    const m = buildManifest()
    const out = manifestToYaml(m)
    expect(out).toContain("display_information:")
    expect(out).toContain("  name: bantai")
    expect(out).toContain("oauth_config:")
    expect(out).toContain("scopes:")
    expect(out).toContain("      - \"app_mentions:read\"")
    expect(out).toContain("socket_mode_enabled: true")
  })

  it("quotes strings with URL characters", () => {
    const m = buildManifest({
      socketMode: false,
      requestUrl: "https://example.com/slack/events",
    })
    const out = manifestToYaml(m)
    expect(out).toContain("\"https://example.com/slack/events\"")
  })

  it("emits empty arrays / objects inline", () => {
    const out = manifestToYaml({ key: "v", arr: [], nested: {} } as never)
    expect(out).toContain("arr: []")
    expect(out).toContain("nested: {}")
  })
})
