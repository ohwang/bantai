import { describe, expect, it, afterEach } from "bun:test"
import {
  getClipboardCmd,
  getClipboardReadCmd,
  copyToClipboard,
  copyTextDualPath,
  readClipboard,
  type Osc52Surface,
} from "../../src/utils/clipboard"

// ── Helpers for overriding process.platform ──────────────────────────────
const originalPlatform = process.platform

function setPlatform(p: string) {
  Object.defineProperty(process, "platform", { value: p, writable: true })
}

function restorePlatform() {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    writable: true,
  })
}

/**
 * Probe whether a clipboard tool is available in PATH for the current platform.
 * Used to skip integration tests gracefully on CI runners (e.g. ubuntu-latest)
 * that have no clipboard binary installed.
 *
 * macOS: pbcopy + pbpaste (always present on macOS — so this returns true locally).
 * Linux: xclip OR wl-paste (matches what clipboard.ts supports for read/write).
 * Anything else: treated as unavailable (the platform-gate early-return handles it).
 */
function hasClipboardTool(): boolean {
  if (originalPlatform === "darwin") {
    return Bun.which("pbcopy") !== null && Bun.which("pbpaste") !== null
  }
  if (originalPlatform === "linux") {
    if (Bun.which("xclip") !== null) return true
    if (Bun.which("wl-copy") !== null && Bun.which("wl-paste") !== null) return true
    return false
  }
  return false
}

// ── 1. getClipboardCmd() ─────────────────────────────────────────────────
describe("getClipboardCmd", () => {
  afterEach(() => {
    restorePlatform()
    delete process.env.WSL_DISTRO_NAME
  })

  it("returns pbcopy on darwin", () => {
    setPlatform("darwin")
    expect(getClipboardCmd()).toEqual({ cmd: "pbcopy", args: [] })
  })

  it("returns xclip on linux without WSL", () => {
    setPlatform("linux")
    delete process.env.WSL_DISTRO_NAME
    expect(getClipboardCmd()).toEqual({
      cmd: "xclip",
      args: ["-selection", "clipboard"],
    })
  })

  it("returns clip.exe on linux with WSL_DISTRO_NAME", () => {
    setPlatform("linux")
    process.env.WSL_DISTRO_NAME = "Ubuntu"
    expect(getClipboardCmd()).toEqual({ cmd: "clip.exe", args: [] })
  })

  it("returns clip.exe on win32", () => {
    setPlatform("win32")
    expect(getClipboardCmd()).toEqual({ cmd: "clip.exe", args: [] })
  })

  it("returns null on unsupported platform", () => {
    setPlatform("freebsd")
    expect(getClipboardCmd()).toBeNull()
  })
})

// ── 2. getClipboardReadCmd() ─────────────────────────────────────────────
describe("getClipboardReadCmd", () => {
  afterEach(() => {
    restorePlatform()
    delete process.env.WSL_DISTRO_NAME
    delete process.env.WAYLAND_DISPLAY
  })

  it("returns pbpaste on darwin", () => {
    setPlatform("darwin")
    expect(getClipboardReadCmd()).toEqual({ cmd: "pbpaste", args: [] })
  })

  it("returns xclip -o on linux without WSL or Wayland", () => {
    setPlatform("linux")
    delete process.env.WSL_DISTRO_NAME
    delete process.env.WAYLAND_DISPLAY
    expect(getClipboardReadCmd()).toEqual({
      cmd: "xclip",
      args: ["-selection", "clipboard", "-o"],
    })
  })

  it("returns wl-paste on linux with WAYLAND_DISPLAY", () => {
    setPlatform("linux")
    delete process.env.WSL_DISTRO_NAME
    process.env.WAYLAND_DISPLAY = "wayland-0"
    expect(getClipboardReadCmd()).toEqual({
      cmd: "wl-paste",
      args: ["--no-newline"],
    })
  })

  it("returns powershell.exe Get-Clipboard on linux with WSL_DISTRO_NAME", () => {
    setPlatform("linux")
    process.env.WSL_DISTRO_NAME = "Ubuntu"
    expect(getClipboardReadCmd()).toEqual({
      cmd: "powershell.exe",
      args: ["-Command", "Get-Clipboard"],
    })
  })

  it("returns powershell.exe Get-Clipboard on win32", () => {
    setPlatform("win32")
    expect(getClipboardReadCmd()).toEqual({
      cmd: "powershell.exe",
      args: ["-Command", "Get-Clipboard"],
    })
  })

  it("returns null on unsupported platform", () => {
    setPlatform("freebsd")
    expect(getClipboardReadCmd()).toBeNull()
  })

  it("WSL takes priority over Wayland on linux", () => {
    setPlatform("linux")
    process.env.WSL_DISTRO_NAME = "Ubuntu"
    process.env.WAYLAND_DISPLAY = "wayland-0"
    // WSL check comes first in the source, so powershell.exe wins
    expect(getClipboardReadCmd()).toEqual({
      cmd: "powershell.exe",
      args: ["-Command", "Get-Clipboard"],
    })
  })
})

// ── 3. copyToClipboard() ────────────────────────────────────────────────
describe("copyToClipboard", () => {
  afterEach(() => {
    restorePlatform()
  })

  it("throws on unsupported platform", async () => {
    setPlatform("freebsd")
    await expect(copyToClipboard("hello")).rejects.toThrow(
      "Unsupported platform for clipboard access",
    )
  })

  it("successfully copies text via native command", async () => {
    // Only run on a platform where clipboard is available
    if (originalPlatform !== "darwin" && originalPlatform !== "linux") return
    // Skip gracefully if no clipboard binary is installed (e.g. ubuntu-latest CI)
    if (!hasClipboardTool()) return
    restorePlatform()

    // Should not throw
    await copyToClipboard("clipboard-test-write")
  })
})

// ── 4. readClipboard() ──────────────────────────────────────────────────
describe("readClipboard", () => {
  afterEach(() => {
    restorePlatform()
  })

  it("throws on unsupported platform", async () => {
    setPlatform("freebsd")
    await expect(readClipboard()).rejects.toThrow(
      "Unsupported platform for clipboard read",
    )
  })

  it("returns a string from the clipboard", async () => {
    if (originalPlatform !== "darwin" && originalPlatform !== "linux") return
    if (!hasClipboardTool()) return
    restorePlatform()

    const result = await readClipboard()
    expect(typeof result).toBe("string")
  })
})

// ── 5. Round-trip integration ────────────────────────────────────────────
describe("copyToClipboard + readClipboard roundtrip", () => {
  afterEach(() => {
    restorePlatform()
  })

  it("writes and reads back the same text", async () => {
    if (originalPlatform !== "darwin" && originalPlatform !== "linux") return
    if (!hasClipboardTool()) return
    restorePlatform()

    const testText = `clipboard-test-${Date.now()}`
    await copyToClipboard(testText)
    const result = await readClipboard()
    expect(result.trim()).toBe(testText)
  })
})

// ── 6. copyTextDualPath ─────────────────────────────────────────────────
//
// Regression coverage for "Cmd+C silently fails for large selections".
// The bug was: when OSC 52 is supported, large payloads can be silently
// truncated by the terminal layer; we used to use ONLY OSC 52 in that
// case, so the user's clipboard was left empty/stale. The fix runs
// OSC 52 AND the native clipboard tool in parallel, so when OSC 52 is
// silently dropped the native write still gets the user the full text.
describe("copyTextDualPath", () => {
  /** Minimal Osc52Surface stub. */
  function makeOsc52(opts: { supported: boolean; sendReturns?: boolean; throws?: boolean }): {
    surface: Osc52Surface
    calls: { isOsc52SupportedCalls: number; copyCalls: string[] }
  } {
    const calls = { isOsc52SupportedCalls: 0, copyCalls: [] as string[] }
    const surface: Osc52Surface = {
      isOsc52Supported() {
        calls.isOsc52SupportedCalls++
        return opts.supported
      },
      copyToClipboardOSC52(text) {
        calls.copyCalls.push(text)
        if (opts.throws) throw new Error("kaboom")
        return opts.sendReturns ?? true
      },
    }
    return { surface, calls }
  }

  it("runs both OSC 52 and native when OSC 52 is supported", async () => {
    const { surface, calls } = makeOsc52({ supported: true, sendReturns: true })
    let nativeCalls: string[] = []
    const result = await copyTextDualPath(
      "hello",
      surface,
      async (t) => { nativeCalls.push(t) },
    )

    expect(calls.copyCalls).toEqual(["hello"])
    expect(nativeCalls).toEqual(["hello"])
    expect(result).toEqual({ osc52Sent: true, nativeOk: true })
  })

  it("succeeds via native when OSC 52 is unsupported", async () => {
    const { surface, calls } = makeOsc52({ supported: false })
    let nativeCalls: string[] = []
    const result = await copyTextDualPath(
      "hello",
      surface,
      async (t) => { nativeCalls.push(t) },
    )

    expect(calls.copyCalls).toEqual([]) // OSC 52 not invoked when unsupported
    expect(nativeCalls).toEqual(["hello"])
    expect(result).toEqual({ osc52Sent: false, nativeOk: true })
  })

  it("succeeds via OSC 52 alone when native fails (SSH-with-no-xclip case)", async () => {
    // This is the SSH-on-remote-host scenario: pbcopy/xclip aren't
    // installed on the remote, so the native call rejects, but OSC 52
    // still propagates to the user's local terminal.
    const { surface } = makeOsc52({ supported: true, sendReturns: true })
    const result = await copyTextDualPath(
      "hello",
      surface,
      async () => { throw new Error("Unsupported platform for clipboard access") },
    )

    expect(result).toEqual({ osc52Sent: true, nativeOk: false })
  })

  it("succeeds via native alone when OSC 52 emit returns false", async () => {
    // The Zig FFI returning false means the bytes never left this
    // process. Native must still cover the user.
    const { surface } = makeOsc52({ supported: true, sendReturns: false })
    let nativeCalls: string[] = []
    const result = await copyTextDualPath(
      "hello",
      surface,
      async (t) => { nativeCalls.push(t) },
    )

    expect(nativeCalls).toEqual(["hello"])
    expect(result).toEqual({ osc52Sent: false, nativeOk: true })
  })

  it("succeeds via native alone when OSC 52 throws", async () => {
    // The OSC 52 surface should never throw, but if it does the helper
    // must not let the exception propagate — copy-via-native still
    // delivers the user's text.
    const { surface } = makeOsc52({ supported: true, throws: true })
    let nativeCalls: string[] = []
    const result = await copyTextDualPath(
      "hello",
      surface,
      async (t) => { nativeCalls.push(t) },
    )

    expect(nativeCalls).toEqual(["hello"])
    expect(result).toEqual({ osc52Sent: false, nativeOk: true })
  })

  it("reports both-failed when neither path succeeds", async () => {
    const { surface } = makeOsc52({ supported: true, sendReturns: false })
    const result = await copyTextDualPath(
      "hello",
      surface,
      async () => { throw new Error("boom") },
    )

    expect(result).toEqual({ osc52Sent: false, nativeOk: false })
  })

  it("forwards the same text to both paths verbatim, including large payloads", async () => {
    // The bug is specifically about LARGE selections. Verify the helper
    // doesn't truncate or transform on its own — it must hand the full
    // string to both paths so the native write (which has no length
    // limit) recovers from any OSC 52 terminal-side truncation.
    const big = "x".repeat(100_000) // 100 KB — over the typical OSC 52 cap
    const { surface, calls } = makeOsc52({ supported: true, sendReturns: true })
    const nativeCalls: string[] = []
    const result = await copyTextDualPath(
      big,
      surface,
      async (t) => { nativeCalls.push(t) },
    )

    expect(calls.copyCalls).toEqual([big])
    expect(nativeCalls).toEqual([big])
    expect(result).toEqual({ osc52Sent: true, nativeOk: true })
  })
})
