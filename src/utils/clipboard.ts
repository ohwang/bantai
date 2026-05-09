/**
 * Platform-specific clipboard read/write support.
 *
 * Write: getClipboardCmd() + copyToClipboard()
 * Read:  getClipboardReadCmd() + readClipboard()
 * Image: hasClipboardImage() + readClipboardImage()
 *
 * Uses native clipboard tools:
 *   macOS  → pbcopy / pbpaste / osascript
 *   Linux  → xclip -selection clipboard (or wl-paste for Wayland)
 *   WSL    → clip.exe / powershell Get-Clipboard
 */

import { log } from "./logger"
import { existsSync } from "node:fs"
import { readFile, unlink } from "node:fs/promises"
import { resolve } from "node:path"
import { homedir } from "node:os"
import type { ImageContent } from "../protocol/types"

const IMAGE_MAX_BASE64_BYTES = 5 * 1024 * 1024
const IMAGE_MAX_RAW_BYTES = 3.75 * 1024 * 1024 // ~5MB base64
const IMAGE_MAX_DIMENSION = 2000 // pixels
const CLIPBOARD_TIMEOUT_MS = 5_000
const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i
const MACOS_CLIPBOARD_IMAGE_CLASS_REGEX = /«class (?:PNGf|TIFF|JPEG|GIFf|8BPS)»/

// ---------------------------------------------------------------------------
// Image format detection from magic bytes
// ---------------------------------------------------------------------------

/**
 * Detect image format from the first bytes of base64 data.
 * Falls back to image/png if format is unknown.
 */
export function detectImageFormatFromBase64(base64Data: string): ImageMediaType {
  try {
    const buffer = Buffer.from(base64Data.slice(0, 32), "base64")
    return detectImageFormatFromBuffer(buffer)
  } catch {
    return "image/png"
  }
}

function detectImageFormatFromBuffer(buffer: Buffer): ImageMediaType {
  if (buffer.length < 4) return "image/png"

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png"
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg"
  }
  // GIF: 47 49 46 (GIF87a or GIF89a)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif"
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "image/webp"
  }

  return "image/png"
}

// ---------------------------------------------------------------------------
// Image file path detection and reading
// ---------------------------------------------------------------------------

/**
 * Check if text looks like a path to an image file.
 */
export function isImageFilePath(text: string): boolean {
  const cleaned = removeOuterQuotes(text.trim())
  const unescaped = stripBackslashEscapes(cleaned)
  return IMAGE_EXTENSION_REGEX.test(unescaped)
}

/**
 * Read an image file from disk and return as ImageContent.
 * Returns null if the file doesn't exist, is too large, or can't be read.
 */
export async function readImageFile(filePath: string): Promise<ImageContent | null> {
  try {
    const cleaned = removeOuterQuotes(filePath.trim())
    const unescaped = stripBackslashEscapes(cleaned)
    const withHomeExpanded = unescaped === "~" || unescaped.startsWith("~/")
      ? resolve(process.env.HOME || homedir(), unescaped.slice(2))
      : unescaped
    const resolved = resolve(withHomeExpanded)

    if (!existsSync(resolved)) return null

    const buffer = await readFile(resolved)

    // Check size limit (5MB base64 ≈ 3.75MB raw)
    if (buffer.length > 3.75 * 1024 * 1024) {
      log.warn("Image file too large", { path: resolved, size: buffer.length })
      return null
    }

    const base64 = buffer.toString("base64")
    const mediaType = detectImageFormatFromBase64(base64)
    return { data: base64, mediaType }
  } catch (err) {
    log.warn("Failed to read image file", { path: filePath, error: String(err) })
    return null
  }
}

export function removeOuterQuotes(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1)
  }
  return text
}

export function stripBackslashEscapes(path: string): string {
  if (process.platform === "win32") return path
  // Replace double backslashes with placeholder, remove single backslash escapes, restore
  const placeholder = "__DBL_BKSLASH__"
  return path
    .replace(/\\\\/g, placeholder)
    .replace(/\\(.)/g, "$1")
    .replace(new RegExp(placeholder, "g"), "\\")
}

export function getClipboardCmd(): { cmd: string; args: string[] } | null {
  const platform = process.platform
  if (platform === "darwin") return { cmd: "pbcopy", args: [] }
  if (platform === "linux") {
    // WSL exposes clip.exe
    if (process.env.WSL_DISTRO_NAME) return { cmd: "clip.exe", args: [] }
    return { cmd: "xclip", args: ["-selection", "clipboard"] }
  }
  if (platform === "win32") return { cmd: "clip.exe", args: [] }
  return null
}

/** Returns the platform-specific command for reading from the system clipboard. */
export function getClipboardReadCmd(): { cmd: string; args: string[] } | null {
  const platform = process.platform
  if (platform === "darwin") return { cmd: "pbpaste", args: [] }
  if (platform === "linux") {
    if (process.env.WSL_DISTRO_NAME) {
      return { cmd: "powershell.exe", args: ["-Command", "Get-Clipboard"] }
    }
    if (process.env.WAYLAND_DISPLAY) {
      return { cmd: "wl-paste", args: ["--no-newline"] }
    }
    return { cmd: "xclip", args: ["-selection", "clipboard", "-o"] }
  }
  if (platform === "win32") {
    return { cmd: "powershell.exe", args: ["-Command", "Get-Clipboard"] }
  }
  return null
}

export async function copyToClipboard(text: string): Promise<void> {
  const clip = getClipboardCmd()
  if (!clip) throw new Error("Unsupported platform for clipboard access")

  const proc = Bun.spawn([clip.cmd, ...clip.args], {
    stdin: "pipe",
  })

  proc.stdin.write(text)
  proc.stdin.end()

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`Clipboard command exited with code ${exitCode}`)
  }
}

// ---------------------------------------------------------------------------
// Dual-path text copy (OSC 52 + native)
// ---------------------------------------------------------------------------
//
// History: shipped as the fix for the "Cmd+C silently fails for large
// selections" bug.
//
// OSC 52 is the only path that propagates a copy to the user's local
// clipboard when bantai is running on a remote host (SSH / tmux), so we
// can't drop it. But terminals impose hard upper bounds on the OSC 52
// escape-sequence length — many cap at ~74 KB, some (older xterm,
// default tmux `set-clipboard`) as low as ~8 KB — and drop the sequence
// SILENTLY when the payload is over the limit. The Zig FFI returns
// `true` because the bytes left this process; the terminal never
// delivers them to the system clipboard, so the user pastes stale or
// empty content.
//
// The fix is to always also write via the native clipboard tool
// (pbcopy / xclip / clip.exe) in parallel. Locally that's the
// source-of-truth and immune to OSC 52 limits; over SSH it fails
// silently (no clipboard tool on the remote box) but OSC 52 still
// propagates. The two paths don't fight: locally OSC 52 + pbcopy
// both write the same text and last-writer-wins is fine; over SSH only
// OSC 52 reaches anywhere meaningful.
//
// The cost is one extra subprocess per Cmd+C — negligible because copy
// keystrokes are rare.

/** Renderer-side OSC 52 surface — minimal slice of the OpenTUI renderer. */
export interface Osc52Surface {
  isOsc52Supported(): boolean
  /**
   * Emits the OSC 52 escape sequence to stdout. Returns true iff the
   * bytes were written. NOTE: a `true` return does NOT guarantee the
   * terminal accepted the payload — terminals truncate large payloads
   * silently. That's why this function is paired with a native write.
   */
  copyToClipboardOSC52(text: string): boolean
}

export interface CopyTextResult {
  /** OSC 52 escape was emitted (does NOT guarantee terminal acceptance). */
  osc52Sent: boolean
  /** Native clipboard tool succeeded (definitive — bytes are in the OS clipboard). */
  nativeOk: boolean
}

/**
 * Copy text to the clipboard via OSC 52 AND the native clipboard tool
 * in parallel. Either path succeeding is a copy success; both failing
 * is a copy failure (logged at warn level).
 *
 * Optional `copyNative` lets tests inject a fake to avoid spawning
 * `pbcopy` / `xclip`. Production code should omit it and let the helper
 * fall back to the module-level `copyToClipboard`.
 */
export async function copyTextDualPath(
  text: string,
  osc52: Osc52Surface,
  copyNative: (t: string) => Promise<void> = copyToClipboard,
): Promise<CopyTextResult> {
  // Run OSC 52 first (it's synchronous — just an stdout write) so the
  // ordering is deterministic: the native clipboard write awaits below
  // and any later user paste sees the native value (which is the source
  // of truth on local machines, and immune to terminal-side OSC 52
  // truncation).
  let osc52Sent = false
  if (osc52.isOsc52Supported()) {
    try {
      osc52Sent = osc52.copyToClipboardOSC52(text)
    } catch (err) {
      log.warn("OSC 52 copy threw", {
        error: err instanceof Error ? err.message : String(err),
      })
      osc52Sent = false
    }
  }

  let nativeOk = false
  try {
    await copyNative(text)
    nativeOk = true
  } catch (err) {
    // Native clipboard fails over SSH (no clipboard tool on the remote)
    // or on unsupported platforms — that's expected, not a bug, as long
    // as OSC 52 succeeded. Log at debug so we don't spam warnings.
    log.debug("Native clipboard copy failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (osc52Sent && nativeOk) {
    log.info("Copied selection (OSC 52 + native)", { chars: text.length })
  } else if (osc52Sent) {
    log.info("Copied selection via OSC 52", { chars: text.length })
  } else if (nativeOk) {
    log.info("Copied selection via clipboard cmd", { chars: text.length })
  } else {
    log.warn("Failed to copy selection: both OSC 52 and native paths failed", {
      chars: text.length,
    })
  }

  return { osc52Sent, nativeOk }
}

/** Read text from the system clipboard. */
export async function readClipboard(): Promise<string> {
  const clip = getClipboardReadCmd()
  if (!clip) throw new Error("Unsupported platform for clipboard read")

  const proc = Bun.spawn([clip.cmd, ...clip.args], {
    stdout: "pipe",
    stderr: "pipe",
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(
      `Clipboard read command exited with code ${exitCode}: ${stderr.trim()}`,
    )
  }

  const text = await new Response(proc.stdout).text()
  return text
}

// ---------------------------------------------------------------------------
// Image clipboard support
// ---------------------------------------------------------------------------

type ClipboardPlatform = "darwin" | "linux-x11" | "linux-wayland" | "unsupported"

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp"

function detectPlatform(): ClipboardPlatform {
  const platform = process.platform
  if (platform === "darwin") return "darwin"
  if (platform === "linux") {
    if (process.env.WSL_DISTRO_NAME) return "unsupported"
    if (process.env.WAYLAND_DISPLAY) return "linux-wayland"
    return "linux-x11"
  }
  return "unsupported"
}

// ---------------------------------------------------------------------------
// Image downsampling — uses system tools (sips on macOS, convert on Linux)
// ---------------------------------------------------------------------------

/**
 * Attempt to downscale an image buffer using system tools.
 * Returns the original buffer if resizing isn't possible or not needed.
 */
export async function maybeResizeImage(
  buffer: Buffer,
  mediaType: ImageMediaType,
): Promise<{ buffer: Buffer; mediaType: ImageMediaType; resized: boolean }> {
  // Under size limit — no resize needed
  if (buffer.length <= IMAGE_MAX_RAW_BYTES) {
    return { buffer, mediaType, resized: false }
  }

  const platform = detectPlatform()

  if (platform === "darwin") {
    return resizeWithSips(buffer, mediaType)
  }

  if (platform === "linux-x11" || platform === "linux-wayland") {
    return resizeWithConvert(buffer, mediaType)
  }

  // Can't resize — return original (will be rejected by size check downstream)
  return { buffer, mediaType, resized: false }
}

async function resizeWithSips(
  buffer: Buffer,
  mediaType: ImageMediaType,
): Promise<{ buffer: Buffer; mediaType: ImageMediaType; resized: boolean }> {
  try {
    const tmpIn = `/tmp/opentui-resize-in-${Date.now()}.png`
    const tmpOut = `/tmp/opentui-resize-out-${Date.now()}.jpg`

    await Bun.write(tmpIn, buffer)

    // Resize to max 2000px on longest side, convert to JPEG for compression
    const proc = Bun.spawn(
      ["sips", "-Z", String(IMAGE_MAX_DIMENSION), "-s", "format", "jpeg", tmpIn, "--out", tmpOut],
      { stdout: "pipe", stderr: "pipe" },
    )
    await proc.exited

    const resized = await Bun.file(tmpOut).arrayBuffer()
    const resizedBuf = Buffer.from(resized)

    // Clean up temp files
    try { await unlink(tmpIn) } catch {}
    try { await unlink(tmpOut) } catch {}

    if (resizedBuf.length > 0 && resizedBuf.length < buffer.length) {
      return { buffer: resizedBuf, mediaType: "image/jpeg", resized: true }
    }
    return { buffer, mediaType, resized: false }
  } catch (err) {
    log.warn("sips resize failed", { error: String(err) })
    return { buffer, mediaType, resized: false }
  }
}

async function resizeWithConvert(
  buffer: Buffer,
  mediaType: ImageMediaType,
): Promise<{ buffer: Buffer; mediaType: ImageMediaType; resized: boolean }> {
  try {
    const tmpIn = `/tmp/opentui-resize-in-${Date.now()}.png`
    const tmpOut = `/tmp/opentui-resize-out-${Date.now()}.jpg`

    await Bun.write(tmpIn, buffer)

    // ImageMagick convert: resize to fit in 2000x2000, JPEG quality 80
    const proc = Bun.spawn(
      ["convert", tmpIn, "-resize", `${IMAGE_MAX_DIMENSION}x${IMAGE_MAX_DIMENSION}>`, "-quality", "80", tmpOut],
      { stdout: "pipe", stderr: "pipe" },
    )
    await proc.exited

    const resized = await Bun.file(tmpOut).arrayBuffer()
    const resizedBuf = Buffer.from(resized)

    try { await unlink(tmpIn) } catch {}
    try { await unlink(tmpOut) } catch {}

    if (resizedBuf.length > 0 && resizedBuf.length < buffer.length) {
      return { buffer: resizedBuf, mediaType: "image/jpeg", resized: true }
    }
    return { buffer, mediaType, resized: false }
  } catch (err) {
    log.warn("convert resize failed", { error: String(err) })
    return { buffer, mediaType, resized: false }
  }
}

/** Spawn a process with a timeout. Returns null if spawn fails or times out. */
async function spawnWithTimeout(
  cmd: string[],
  opts?: { stdin?: "pipe" | "inherit"; stdout?: "pipe" | "inherit"; stderr?: "pipe" | "inherit" },
): Promise<{ exitCode: number; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> } | null> {
  try {
    const proc = Bun.spawn(cmd, {
      stdin: opts?.stdin ?? "inherit",
      stdout: opts?.stdout ?? "pipe",
      stderr: opts?.stderr ?? "pipe",
    })

    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), CLIPBOARD_TIMEOUT_MS),
    )

    const result = await Promise.race([proc.exited, timeout])
    if (result === "timeout") {
      proc.kill()
      log.warn("clipboard", `Command timed out after ${CLIPBOARD_TIMEOUT_MS}ms: ${cmd.join(" ")}`)
      return null
    }

    return {
      exitCode: result as number,
      stdout: proc.stdout as ReadableStream<Uint8Array>,
      stderr: proc.stderr as ReadableStream<Uint8Array>,
    }
  } catch (err) {
    log.warn("clipboard", `Failed to spawn command: ${cmd[0]}: ${err}`)
    return null
  }
}

/**
 * Detect whether the system clipboard contains image data.
 * Returns false on unsupported platforms or when no image is present.
 */
export async function hasClipboardImage(): Promise<boolean> {
  const plat = detectPlatform()

  if (plat === "unsupported") return false

  if (plat === "darwin") {
    const result = await spawnWithTimeout(
      ["osascript", "-e", "clipboard info"],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (!result || result.exitCode !== 0) return false
    const output = await new Response(result.stdout).text()
    return MACOS_CLIPBOARD_IMAGE_CLASS_REGEX.test(output)
  }

  if (plat === "linux-x11") {
    const result = await spawnWithTimeout(
      ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (!result || result.exitCode !== 0) return false
    const output = await new Response(result.stdout).text()
    return /image\/(png|jpeg|jpg|gif|webp|bmp)/.test(output)
  }

  if (plat === "linux-wayland") {
    const result = await spawnWithTimeout(
      ["wl-paste", "--list-types"],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (!result || result.exitCode !== 0) return false
    const output = await new Response(result.stdout).text()
    return /^image\//m.test(output)
  }

  return false
}

export type ClipboardImageResult =
  | { ok: true; image: ImageContent; resized: boolean }
  | { ok: false; reason: "too_large" | "no_image" | "unsupported" | "error" }

/**
 * Read image data from the system clipboard.
 * Returns base64-encoded image content (with resize metadata), or null if
 * no image is present or on unsupported platforms.
 *
 * If the image exceeds the size limit, attempts to downscale using system
 * tools (sips on macOS, ImageMagick convert on Linux).
 */
export async function readClipboardImage(): Promise<ClipboardImageResult> {
  const plat = detectPlatform()

  if (plat === "unsupported") return { ok: false, reason: "unsupported" }

  if (plat === "darwin") {
    return readClipboardImageDarwin()
  }

  if (plat === "linux-x11") {
    return readClipboardImageLinuxX11()
  }

  if (plat === "linux-wayland") {
    return readClipboardImageLinuxWayland()
  }

  return { ok: false, reason: "unsupported" }
}

function makeDarwinClipboardTempPath(): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return `/tmp/bantai-clip-${unique}.png`
}

async function readClipboardImageDarwin(): Promise<ClipboardImageResult> {
  const tmpPath = makeDarwinClipboardTempPath()

  const result = await spawnWithTimeout(
    [
      "osascript",
      "-e", "set theImage to the clipboard as «class PNGf»",
      "-e", `set theFile to open for access POSIX file "${tmpPath}" with write permission`,
      "-e", "write theImage to theFile",
      "-e", "close access theFile",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )

  if (!result || result.exitCode !== 0) {
    if (result) {
      const stderr = await new Response(result.stderr).text()
      log.warn("clipboard", `osascript image read failed (exit ${result.exitCode}): ${stderr.trim()}`)
    }
    return { ok: false, reason: "no_image" }
  }

  try {
    const arrayBuffer = await Bun.file(tmpPath).arrayBuffer()
    const rawBuffer = Buffer.from(arrayBuffer)

    // Detect actual format from magic bytes, then attempt downscale if oversized
    const detectedType = detectImageFormatFromBuffer(rawBuffer)
    const { buffer: finalBuffer, mediaType, resized } = await maybeResizeImage(rawBuffer, detectedType)
    if (resized) {
      log.info("clipboard", "Image was downscaled to fit size limit")
    }

    const base64 = finalBuffer.toString("base64")

    if (base64.length > IMAGE_MAX_BASE64_BYTES) {
      log.warn("clipboard", `Clipboard image too large after resize: ${base64.length} bytes base64 (limit ${IMAGE_MAX_BASE64_BYTES})`)
      return { ok: false, reason: "too_large" }
    }

    return { ok: true, image: { data: base64, mediaType }, resized }
  } catch (err) {
    log.warn("clipboard", `Failed to read temp image file: ${err}`)
    return { ok: false, reason: "error" }
  } finally {
    await unlink(tmpPath).catch(() => {})
  }
}

async function readClipboardImageLinuxX11(): Promise<ClipboardImageResult> {
  const result = await spawnWithTimeout(
    ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
    { stdout: "pipe", stderr: "pipe" },
  )

  if (!result || result.exitCode !== 0) {
    if (result) {
      const stderr = await new Response(result.stderr).text()
      log.warn("clipboard", `xclip image read failed (exit ${result.exitCode}): ${stderr.trim()}`)
    }
    return { ok: false, reason: "no_image" }
  }

  return binaryStdoutToImageContent(result.stdout)
}

async function readClipboardImageLinuxWayland(): Promise<ClipboardImageResult> {
  const result = await spawnWithTimeout(
    ["wl-paste", "--type", "image/png"],
    { stdout: "pipe", stderr: "pipe" },
  )

  if (!result || result.exitCode !== 0) {
    if (result) {
      const stderr = await new Response(result.stderr).text()
      log.warn("clipboard", `wl-paste image read failed (exit ${result.exitCode}): ${stderr.trim()}`)
    }
    return { ok: false, reason: "no_image" }
  }

  return binaryStdoutToImageContent(result.stdout)
}

async function binaryStdoutToImageContent(
  stdout: ReadableStream<Uint8Array>,
): Promise<ClipboardImageResult> {
  try {
    const arrayBuffer = await new Response(stdout).arrayBuffer()
    const rawBuffer = Buffer.from(arrayBuffer)

    // Detect actual format from magic bytes, then attempt downscale if oversized
    const detectedType = detectImageFormatFromBuffer(rawBuffer)
    const { buffer: finalBuffer, mediaType, resized } = await maybeResizeImage(rawBuffer, detectedType)
    if (resized) {
      log.info("clipboard", "Image was downscaled to fit size limit")
    }

    const base64 = finalBuffer.toString("base64")

    if (base64.length > IMAGE_MAX_BASE64_BYTES) {
      log.warn("clipboard", `Clipboard image too large after resize: ${base64.length} bytes base64 (limit ${IMAGE_MAX_BASE64_BYTES})`)
      return { ok: false, reason: "too_large" }
    }

    return { ok: true, image: { data: base64, mediaType }, resized }
  } catch (err) {
    log.warn("clipboard", `Failed to read image from stdout: ${err}`)
    return { ok: false, reason: "error" }
  }
}
