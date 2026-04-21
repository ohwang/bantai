/**
 * Open the currently-selected thread in the native Slack desktop app via
 * the `slack://` deep link scheme.
 *
 * Parsing: the session key shape is
 *   `slack:<workspace>:<channelId>:<threadTs|"main">`
 * (see `src/frontends/slack/router/registry.ts → sessionKeyFor`). We do
 * NOT reach for a fresh REST round-trip — the key carries everything the
 * Slack deep link needs, and the admin `SessionSummary` already ships
 * `channelId` + `threadTs` for list rendering. Parsing the key keeps the
 * admin protocol unchanged and lets the monitor open threads on the
 * initial snapshot without any staged I/O.
 *
 * Deep link shape (per Slack's deep-linking reference):
 *   - Top-level post      → `slack://channel?team=T&id=C`
 *   - Inside a thread     → `slack://channel?team=T&id=C&message=TS&thread_ts=TS`
 *
 * Both `message` and `thread_ts` are supplied for threads so the Slack
 * client opens the thread side-panel, not just scrolls the channel.
 *
 * Side-effect isolation: `launchUrl` is injectable so tests can assert on
 * the resolved command without spawning real processes. The default
 * implementation picks the right opener per `process.platform`
 * (`open` / `xdg-open` / `cmd /c start`) and fires-and-forgets a
 * Bun subprocess — we don't wait for the GUI to come up.
 */

import { log } from "../../../utils/logger"

export interface ParsedSessionKey {
  workspace: string
  channelId: string
  /** Null for "main" / top-level posts (no thread). */
  threadTs: string | null
}

/**
 * Parse a Slack-shaped session key. Returns null when the key does not
 * match the registry's `slack:<workspace>:<channelId>:<threadTs|main>`
 * format — for example a malformed or non-Slack key that somehow slipped
 * into the admin surface.
 */
export function parseSlackSessionKey(key: string): ParsedSessionKey | null {
  // Split on ":" — the trailing threadTs is itself a dotted decimal so it
  // has no internal colons, meaning a strict 4-part split is sufficient.
  const parts = key.split(":")
  if (parts.length !== 4) return null
  const [scheme, workspace, channelId, threadSegment] = parts
  if (scheme !== "slack") return null
  if (!workspace || !channelId || !threadSegment) return null
  const threadTs = threadSegment === "main" ? null : threadSegment
  return { workspace, channelId, threadTs }
}

/**
 * Build the `slack://` deep link URL for a parsed session key. Pure — no
 * I/O, no platform branching, exported so tests can verify the shape
 * without invoking the OS opener.
 */
export function buildSlackDeepLink(parsed: ParsedSessionKey): string {
  const params = new URLSearchParams()
  params.set("team", parsed.workspace)
  params.set("id", parsed.channelId)
  if (parsed.threadTs) {
    // `message` scrolls to the parent; `thread_ts` forces the thread
    // sidebar to open. Both required for the "open thread" behaviour.
    params.set("message", parsed.threadTs)
    params.set("thread_ts", parsed.threadTs)
  }
  return `slack://channel?${params.toString()}`
}

/**
 * Resolve the OS-level command that opens a URL in the registered
 * handler (i.e. the Slack desktop app for `slack://` links). Exported
 * for tests — real launches go through {@link openSlackThread}.
 */
export function resolveOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } {
  switch (platform) {
    case "darwin":
      return { cmd: "open", args: [url] }
    case "win32":
      // `start` is a cmd builtin; the empty "" title is required when
      // the URL itself is quoted so cmd doesn't treat it as the title.
      return { cmd: "cmd", args: ["/c", "start", "", url] }
    default:
      // Linux + BSDs — xdg-open is the de-facto standard and the only
      // handler that respects the user's desktop MIME associations.
      return { cmd: "xdg-open", args: [url] }
  }
}

export type UrlLauncher = (url: string) => void | Promise<void>

/**
 * Default launcher — spawns the OS-native opener and detaches. We
 * deliberately do NOT await exit: the opener forks off the desktop app
 * and returns immediately on success, but some handlers (xdg-open) keep
 * the child alive for the lifetime of the app, which would otherwise
 * tether the TUI.
 */
function defaultLaunchUrl(url: string): void {
  const { cmd, args } = resolveOpenCommand(url)
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    // Unref so the TUI can exit even if the opener subprocess is still
    // alive. Guarded because Bun.Subprocess.unref landed in a recent
    // release and the feature isn't core to the happy path.
    const maybeUnref = (proc as { unref?: () => void }).unref
    if (typeof maybeUnref === "function") maybeUnref.call(proc)
  } catch (err) {
    log.warn(`slack-monitor: failed to spawn opener for ${url}: ${String(err)}`)
    throw err
  }
}

export interface OpenSlackThreadResult {
  ok: boolean
  url?: string
  reason?: "invalid-key" | "launch-failed"
  error?: unknown
}

/**
 * Open the Slack thread identified by `sessionKey` in the native Slack
 * app. Returns a structured result so the caller can flash a
 * user-visible banner on failure — we never throw from this path
 * because a dodgy key or a missing `xdg-open` shouldn't tear down the
 * monitor TUI.
 *
 * `launchUrl` is injectable for tests.
 */
export async function openSlackThread(
  sessionKey: string,
  launchUrl: UrlLauncher = defaultLaunchUrl,
): Promise<OpenSlackThreadResult> {
  const parsed = parseSlackSessionKey(sessionKey)
  if (!parsed) {
    log.warn(`slack-monitor: cannot open — unrecognised session key ${sessionKey}`)
    return { ok: false, reason: "invalid-key" }
  }
  const url = buildSlackDeepLink(parsed)
  try {
    await launchUrl(url)
    return { ok: true, url }
  } catch (err) {
    return { ok: false, reason: "launch-failed", error: err, url }
  }
}
