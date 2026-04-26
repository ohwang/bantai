#!/usr/bin/env bash
# docs-check.sh — Grep-assert that high-risk facts in AGENTS.md still hold.
#
# AGENTS.md mixes PROSE and DERIVED sections (see the comment at the top of the
# file). DERIVED sections mirror code; this script catches the most common drift
# modes that prose review keeps missing:
#
#   - The CLI subcommand list claims `bantai claude|codex|gemini` while the
#     registry exposes more (qwen).
#   - The drift-contract recipe table references a file (e.g.
#     `src/protocol/permission-modes.ts`) that doesn't exist.
#
# Exit code 0 = clean. Non-zero = at least one assertion failed; output names
# the section + the file or fact that drifted.
#
# Run via: bun run docs:check

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$ROOT/AGENTS.md"
errors=0

if [[ ! -f "$AGENTS" ]]; then
  echo "ERROR: AGENTS.md not found at $AGENTS"
  exit 1
fi

# ---------------------------------------------------------------------------
# Assertion 1: CLI subcommand list in the Architecture section is plural-aware.
#
# The original drift was "bantai claude|codex|gemini [prompt]" — a hand-list
# that omitted qwen after the 2ea1a3a integration. We don't try to reproduce
# the registry from bash; we just enforce that the doc no longer hard-codes a
# fixed pipe list and instead explains the rule + names the registry helper.
# ---------------------------------------------------------------------------

if grep -E -q '`bantai claude\|codex\|gemini[^`]*`' "$AGENTS"; then
  echo "FAIL: AGENTS.md contains the legacy 'bantai claude|codex|gemini' hand-list."
  echo "      Replace it with a reference to BACKEND_REGISTRY / exposeAsCliSubcommand."
  errors=$((errors + 1))
fi

if ! grep -q "exposeAsCliSubcommand" "$AGENTS"; then
  echo "FAIL: AGENTS.md should reference \`exposeAsCliSubcommand\` so future readers"
  echo "      learn that 'bantai <id>' subcommands derive from BACKEND_REGISTRY."
  errors=$((errors + 1))
fi

# ---------------------------------------------------------------------------
# Assertion 2: every file the drift-contract recipe table claims to exist
# actually exists on disk. The table is the most common stale-fact site once
# new registries are added.
# ---------------------------------------------------------------------------

REQUIRED_FILES=(
  "src/protocol/registry.ts"
  "src/protocol/permission-modes.ts"
  "src/protocol/effort-levels.ts"
  "src/protocol/session-state.ts"
  "src/protocol/rate-limits.ts"
  "src/cli/options.ts"
  "src/backends/claude/jsonl-shapes.ts"
)

for f in "${REQUIRED_FILES[@]}"; do
  if ! grep -F -q "$f" "$AGENTS"; then
    echo "FAIL: AGENTS.md drift-contract table no longer references \`$f\`."
    echo "      Either the registry moved (update the doc) or the recipe lost a row."
    errors=$((errors + 1))
  fi
  if [[ ! -f "$ROOT/$f" ]]; then
    echo "FAIL: AGENTS.md references \`$f\` but it doesn't exist on disk."
    errors=$((errors + 1))
  fi
done

# ---------------------------------------------------------------------------
# Assertion 3: deep-dive docs the rules link to actually exist. Prevents the
# "rule pointed at /docs/foo.md, foo.md was renamed" failure mode.
# ---------------------------------------------------------------------------

REQUIRED_DOCS=(
  "docs/external-data-handling.md"
  "docs/slack-text-vs-markdown.md"
  "docs/slack-setup.md"
  "docs/minislack.md"
)

for d in "${REQUIRED_DOCS[@]}"; do
  if grep -F -q "$d" "$AGENTS" && [[ ! -f "$ROOT/$d" ]]; then
    echo "FAIL: AGENTS.md links to \`$d\` but the file is missing."
    errors=$((errors + 1))
  fi
done

# ---------------------------------------------------------------------------
# Assertion 4: backends-directory list matches what's on disk. Hand-listing
# `claude/codex/acp/mock` while `follow/` and `shared/` exist is the original
# drift case #3.
# ---------------------------------------------------------------------------

ACTUAL_BACKENDS=$(cd "$ROOT/src/backends" && ls -d */ 2>/dev/null | sed 's:/::' | sort | tr '\n' ' ')
for backend in $ACTUAL_BACKENDS; do
  if ! grep -F -q "$backend" "$AGENTS"; then
    echo "WARN: AGENTS.md never names backend \`$backend\` (exists on disk)."
    echo "      Either it's intentionally hidden or the doc drifted."
  fi
done

# ---------------------------------------------------------------------------

if [[ $errors -eq 0 ]]; then
  echo "docs:check OK ($AGENTS)"
  exit 0
else
  echo ""
  echo "docs:check failed with $errors hard error(s)."
  exit 1
fi
