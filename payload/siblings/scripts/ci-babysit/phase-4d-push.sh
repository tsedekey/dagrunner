#!/bin/zsh
set -euo pipefail

RUN_ID="${DAGRUN_RUN_ID:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "")")}"
DAGRUNNER_HOME="${DAGRUNNER_HOME:-$HOME/.local/share/dagrunner}"
ARTIFACTS_DIR="$DAGRUNNER_HOME/runs/$RUN_ID/ci-babysit"
STATE_FILE="$ARTIFACTS_DIR/ci-babysit-state.json"
TICK_FILE="$ARTIFACTS_DIR/ci-babysit-tick.json"

NOOP=$(jq -r '.noop // false' "$TICK_FILE")
if [ "$NOOP" = "true" ]; then echo "No-op tick — skipping Phase 5d."; exit 0; fi

CHANGES=$(git status --porcelain 2>/dev/null || echo "")
if [ -n "$CHANGES" ]; then
  echo "Uncommitted changes detected — please commit before pushing:"
  git status --short
  echo ""
  echo "Stage and commit the fix, then this push block will run."
  exit 1
fi

NEW_HEAD=$(git rev-parse HEAD)
PRIOR_HEAD=$(jq -r '.current_head' "$TICK_FILE")

if [ "$NEW_HEAD" = "$PRIOR_HEAD" ]; then
  echo "HEAD unchanged — no fix was committed. Skipping push."
else
  echo "Pushing fix ${NEW_HEAD:0:8} with --force-with-lease..."
  git push --force-with-lease origin HEAD
  echo "Pushed. CI is re-running. Next tick will observe results."

  jq --arg h "$NEW_HEAD" '.current_head = $h | .fix_pushed = true' \
    "$TICK_FILE" > "$TICK_FILE.tmp" && \
    mv "$TICK_FILE.tmp" "$TICK_FILE"
fi
