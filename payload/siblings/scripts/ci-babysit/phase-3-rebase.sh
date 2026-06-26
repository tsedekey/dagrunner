#!/bin/zsh
set -euo pipefail

RUN_ID="${DAGRUN_RUN_ID:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "")")}"
DAGRUNNER_HOME="${DAGRUNNER_HOME:-$HOME/.local/share/dagrunner}"
ARTIFACTS_DIR="$DAGRUNNER_HOME/runs/$RUN_ID/ci-babysit"
STATE_FILE="$ARTIFACTS_DIR/ci-babysit-state.json"
TICK_FILE="$ARTIFACTS_DIR/ci-babysit-tick.json"

NOOP=$(jq -r '.noop // false' "$TICK_FILE")
if [ "$NOOP" = "true" ]; then echo "No-op tick — skipping Phase 4."; exit 0; fi

BASE_ADVANCED=$(jq -r '.base_advanced' "$TICK_FILE")
BASE_BRANCH=$(jq -r '.base_branch' "$TICK_FILE")

if [ "$BASE_ADVANCED" = "false" ]; then
  echo "Base branch not advanced — skipping rebase."
else
  echo "Base branch '$BASE_BRANCH' has advanced. Rebasing..."
  git fetch origin "$BASE_BRANCH" --quiet

  if git rebase "origin/$BASE_BRANCH"; then
    REBASE_HEAD=$(git rev-parse HEAD)
    echo "Rebase complete. New head: ${REBASE_HEAD:0:8}"
    echo "Pushing with --force-with-lease..."
    git push --force-with-lease origin HEAD

    NEW_BASE_HEAD=$(git rev-parse "origin/$BASE_BRANCH" 2>/dev/null || echo "")
    jq --arg bh "$NEW_BASE_HEAD" --arg rh "$REBASE_HEAD" \
      '.base_head = $bh | .current_head = $rh | .rebased = true' \
      "$TICK_FILE" > "$TICK_FILE.tmp" && \
      mv "$TICK_FILE.tmp" "$TICK_FILE"
    echo "Pushed. CI will pick up the rebase."
  else
    git rebase --abort 2>/dev/null || true
    echo ""
    echo "STOP: Rebase conflict detected. This requires human judgment."
    echo ""
    echo "Conflict details:"
    git status
    echo ""
    echo "The rebase has been aborted. To resolve:"
    echo "  git fetch origin ${BASE_BRANCH}"
    echo "  git rebase origin/${BASE_BRANCH}"
    echo "  # resolve conflicts, then:"
    echo "  git rebase --continue"
    echo "  git push --force-with-lease origin HEAD"
    echo ""
    echo "ci-babysit will resume on the next tick after you push the resolution."
    rm -f "$STATE_FILE" "$TICK_FILE"
    exit 1
  fi
fi
