/**
 * Tests for the open-in-Slack deep link helper.
 *
 * The spawn itself is platform-dependent and tough to assert against in
 * CI, so we exercise the three pure steps — key parsing, URL building,
 * command resolution — plus the orchestrator via an injected launcher.
 */

import { describe, expect, it } from "bun:test"
import {
  buildSlackDeepLink,
  openSlackThread,
  parseSlackSessionKey,
  resolveOpenCommand,
} from "../../../src/frontends/slack-monitor/utils/open-in-slack"

describe("parseSlackSessionKey", () => {
  it("parses a thread key", () => {
    const parsed = parseSlackSessionKey("slack:T01ABC:C02XYZ:1700000000.123456")
    expect(parsed).toEqual({
      workspace: "T01ABC",
      channelId: "C02XYZ",
      threadTs: "1700000000.123456",
    })
  })

  it("parses a main/top-level key with null threadTs", () => {
    const parsed = parseSlackSessionKey("slack:T01ABC:C02XYZ:main")
    expect(parsed).toEqual({
      workspace: "T01ABC",
      channelId: "C02XYZ",
      threadTs: null,
    })
  })

  it("rejects non-slack schemes", () => {
    expect(parseSlackSessionKey("http:T:C:main")).toBeNull()
  })

  it("rejects malformed keys", () => {
    expect(parseSlackSessionKey("slack:T:C")).toBeNull()
    expect(parseSlackSessionKey("slack:T:C:main:extra")).toBeNull()
    expect(parseSlackSessionKey("")).toBeNull()
    expect(parseSlackSessionKey("slack::C:main")).toBeNull()
  })
})

describe("buildSlackDeepLink", () => {
  it("builds a channel-only link for a main thread", () => {
    const url = buildSlackDeepLink({
      workspace: "T01ABC",
      channelId: "C02XYZ",
      threadTs: null,
    })
    expect(url).toBe("slack://channel?team=T01ABC&id=C02XYZ")
  })

  it("builds a thread link with message + thread_ts", () => {
    const url = buildSlackDeepLink({
      workspace: "T01ABC",
      channelId: "C02XYZ",
      threadTs: "1700000000.123456",
    })
    // URLSearchParams encodes `.` as `.` (unreserved); exact form matters
    // because Slack parses this string verbatim.
    expect(url).toBe(
      "slack://channel?team=T01ABC&id=C02XYZ&message=1700000000.123456&thread_ts=1700000000.123456",
    )
  })
})

describe("resolveOpenCommand", () => {
  it("uses `open` on macOS", () => {
    expect(resolveOpenCommand("slack://x", "darwin")).toEqual({
      cmd: "open",
      args: ["slack://x"],
    })
  })

  it("uses `xdg-open` on linux", () => {
    expect(resolveOpenCommand("slack://x", "linux")).toEqual({
      cmd: "xdg-open",
      args: ["slack://x"],
    })
  })

  it("uses `cmd /c start` on win32", () => {
    expect(resolveOpenCommand("slack://x", "win32")).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", "slack://x"],
    })
  })
})

describe("openSlackThread", () => {
  it("launches the correct URL for a thread key", async () => {
    const launched: string[] = []
    const result = await openSlackThread(
      "slack:T01ABC:C02XYZ:1700000000.123456",
      (url) => {
        launched.push(url)
      },
    )
    expect(result.ok).toBe(true)
    expect(result.url).toBe(
      "slack://channel?team=T01ABC&id=C02XYZ&message=1700000000.123456&thread_ts=1700000000.123456",
    )
    expect(launched).toHaveLength(1)
  })

  it("launches a channel-only URL for a main key", async () => {
    const launched: string[] = []
    const result = await openSlackThread("slack:T:C:main", (url) => {
      launched.push(url)
    })
    expect(result.ok).toBe(true)
    expect(launched[0]).toBe("slack://channel?team=T&id=C")
  })

  it("returns invalid-key without launching on a malformed key", async () => {
    const launched: string[] = []
    const result = await openSlackThread("not-a-slack-key", (url) => {
      launched.push(url)
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("invalid-key")
    expect(launched).toHaveLength(0)
  })

  it("reports launch-failed when the launcher throws", async () => {
    const boom = new Error("xdg-open missing")
    const result = await openSlackThread("slack:T:C:main", () => {
      throw boom
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("launch-failed")
    expect(result.error).toBe(boom)
    expect(result.url).toBe("slack://channel?team=T&id=C")
  })
})
