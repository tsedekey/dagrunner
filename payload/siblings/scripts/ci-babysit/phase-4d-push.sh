#!/bin/zsh
set -euo pipefail

NOOP=$(jq -r '.noop // false' /tmp/ci-babysit-tick.json)
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
PRIOR_HEAD=$(jq -r '.current_head' /tmp/ci-babysit-tick.json)

if [ "$NEW_HEAD" = "$PRIOR_HEAD" ]; then
  echo "HEAD unchanged — no fix was committed. Skipping push."
else
  echo "Pushing fix ${NEW_HEAD:0:8} with --force-with-lease..."
  git push --force-with-lease origin HEAD
  echo "Pushed. CI is re-running. Next tick will observe results."

  jq --arg h "$NEW_HEAD" '.current_head = $h | .fix_pushed = true' \
    /tmp/ci-babysit-tick.json > /tmp/ci-babysit-tick.tmp && \
    mv /tmp/ci-babysit-tick.tmp /tmp/ci-babysit-tick.json
fi
