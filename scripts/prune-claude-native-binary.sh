#!/usr/bin/env bash
# prune-claude-native-binary.sh — Drop the unused @anthropic-ai/claude-
# agent-sdk native variant on Linux x86_64.
#
# Why this exists:
#
# The SDK ships per-platform native binaries as optional deps:
#   @anthropic-ai/claude-agent-sdk-linux-x64        (glibc)
#   @anthropic-ai/claude-agent-sdk-linux-x64-musl   (musl)
#
# Bun's optional-dep selection installs BOTH on Linux x86_64 because both
# match `cpu=x64,os=linux`. The SDK's binary resolver then tries -musl
# first via require.resolve(); when -musl is installed the resolve
# succeeds, but spawn() fails at first invocation with ENOENT on a glibc
# host (no musl loader present) and surfaces as:
#
#   "Claude Code native binary not found at .../claude-agent-sdk-linux-x64-musl/claude"
#
# Fix: at install time, drop whichever variant doesn't match this host's
# libc. Idempotent; safe to run on every install. macOS / Windows installs
# ship a single native package (-darwin-*, -win32-x64) and are no-ops.
#
# Wired up as the `postinstall` script in package.json. When the SDK's
# upstream resolver gains libc detection this script + its hook can be
# deleted in one revert.

set -euo pipefail

# Only Linux x86_64 has the -musl/-x64 split. Other platforms ship a
# single native package — nothing to prune.
[ "$(uname -s)" = "Linux" ]  || exit 0
[ "$(uname -m)" = "x86_64" ] || exit 0

# Operate on the calling project's node_modules. When invoked as a
# postinstall script bun/npm set $PWD to the project root; the optional
# arg lets a sibling package (e.g. bantai-slack) point this at its own
# tree by passing "." or an explicit path.
ROOT="${1:-$PWD}"
ANTHROPIC_DIR="$ROOT/node_modules/@anthropic-ai"

# No-op when @anthropic-ai/* never got installed (e.g. --omit=optional or
# the dep was removed). Keeps the postinstall hook silent in that case.
[ -d "$ANTHROPIC_DIR" ] || exit 0

if [ -e /lib/ld-musl-x86_64.so.1 ]; then
  LIBC="musl"
  PRUNE="claude-agent-sdk-linux-x64"
else
  LIBC="glibc"
  PRUNE="claude-agent-sdk-linux-x64-musl"
fi

PRUNE_DIR="$ANTHROPIC_DIR/$PRUNE"
if [ -d "$PRUNE_DIR" ]; then
  rm -rf "$PRUNE_DIR"
  echo "[bantai/postinstall] libc=$LIBC — pruned @anthropic-ai/$PRUNE"
fi
