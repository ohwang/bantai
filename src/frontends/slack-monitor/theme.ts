/**
 * Small, self-contained color + style vocabulary for the slack-monitor UI.
 *
 * We deliberately don't share the TUI's theme tokens — the monitor is a
 * read-mostly viewer whose visual language (dense, list-heavy, phase
 * badges) doesn't map cleanly onto the conversation UI's tokens. Keeping
 * a local palette also means the monitor can be themed independently
 * later without touching the TUI.
 *
 * All colors are fixed hex strings so they're safe against the OpenTUI
 * Zig FFI (numeric color values crash the renderer — see AGENTS.md).
 */

export const mc = {
  bg: "#0f0f12",
  panelBg: "#151519",
  border: "#303036",
  borderAccent: "#6c71c4",

  text: {
    primary: "#f2f2f5",
    secondary: "#b5b5bf",
    muted: "#777785",
    hint: "#565663",
  },

  /** Phase color mapping, in lower-casey banded scheme. */
  phase: {
    INITIALIZING: "#87afff",
    IDLE: "#a0a0aa",
    RUNNING: "#5fd787",
    WAITING_FOR_PERM: "#ffaf5f",
    WAITING_FOR_ELIC: "#d787d7",
    INTERRUPTING: "#ff8787",
    ERROR: "#ff5f5f",
    SHUTTING_DOWN: "#af5f5f",
    UNKNOWN: "#6c6c75",
  } as const,

  banner: {
    info: { bg: "#1f2a44", fg: "#87b0ff" },
    warn: { bg: "#3a2f10", fg: "#ffaf5f" },
    error: { bg: "#3a1010", fg: "#ff7878" },
  },

  selection: {
    /** Row background when focused+selected. */
    rowBg: "#27293a",
    /** Leading accent bar color. */
    accent: "#8c95ff",
  },
} as const
