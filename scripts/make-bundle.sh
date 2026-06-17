#!/usr/bin/env bash
# make-bundle.sh — one-command source bundle for the chat-based architect (Claude).
#
# Packages, into a single zip:
#   1. the dagrunner repo source (build harness + payload + docs + src)
#   2. the Camunda private .claude/ (the siblings: ci-babysit, pr-triage, seed-data,
#      review-* agents, pr-review) — which lives outside the dagrunner repo
#
# Set the three paths once (below or via env vars), then just run it whenever Claude
# asks for a fresh zip. Uses rsync excludes, so nested .git/ and .DS_Store are dropped
# everywhere automatically (no more buried COMMIT_EDITMSG).

set -euo pipefail

# ── CONFIG: set these once ──────────────────────────────────────────────────
DAGRUNNER_DIR="${DAGRUNNER_DIR:-$HOME/dev/dagrunner}"                  # dagrunner repo root
CAMUNDA_CLAUDE_DIR="${CAMUNDA_CLAUDE_DIR:-$HOME/dev/camunda/camunda-main/.claude}"  # private .claude/ in the Camunda checkout
OUT_DIR="${OUT_DIR:-$HOME/Downloads}"                                   # where the zip lands
# ────────────────────────────────────────────────────────────────────────────

ts="$(date +%Y%m%d-%H%M%S)"
out="$OUT_DIR/dagrunner-bundle-$ts.zip"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# sanity — fail loud
[ -d "$DAGRUNNER_DIR" ]      || { echo "ERROR: DAGRUNNER_DIR not found: $DAGRUNNER_DIR" >&2; exit 1; }
[ -d "$CAMUNDA_CLAUDE_DIR" ] || { echo "ERROR: CAMUNDA_CLAUDE_DIR not found: $CAMUNDA_CLAUDE_DIR" >&2; exit 1; }

# 1) dagrunner source → bundle/dagrunner/   (drops build output, deps, run logs, archive, junk)
mkdir -p "$stage/dagrunner"
rsync -a \
  --exclude 'node_modules/' \
  --exclude '.git/' \
  --exclude 'dist/' \
  --exclude 'build/' \
  --exclude 'store/' \
  --exclude '*.log' \
  --exclude '.DS_Store' \
  --exclude 'package-lock.json' \
  --exclude 'docs/archive/' \
  "$DAGRUNNER_DIR"/ "$stage/dagrunner/"

# 2) Camunda private .claude (siblings harness) → bundle/camunda-claude/.claude/
mkdir -p "$stage/camunda-claude/.claude"
rsync -a \
  --exclude '.git/' \
  --exclude '.DS_Store' \
  "$CAMUNDA_CLAUDE_DIR"/ "$stage/camunda-claude/.claude/"

# zip from the stage root so the archive has the two clean top-level folders
( cd "$stage" && zip -rq "$out" . )

# report
echo "✓ Bundle written: $out"
echo "  Size: $(du -h "$out" | cut -f1)"
echo "  Top-level:"
( cd "$stage" && find . -maxdepth 2 -type d | sort | sed 's|^\.|   |' )
