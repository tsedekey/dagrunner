#!/bin/zsh
set -euo pipefail

NOOP=$(jq -r '.noop // false' /tmp/ci-babysit-tick.json)
if [ "$NOOP" = "true" ]; then echo "No-op tick — skipping Phase 4."; exit 0; fi

BASE_ADVANCED=$(jq -r '.base_advanced' /tmp/ci-babysit-tick.json)
BASE_BRANCH=$(jq -r '.base_branch' /tmp/ci-babysit-tick.json)

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
      /tmp/ci-babysit-tick.json > /tmp/ci-babysit-tick.tmp && \
      mv /tmp/ci-babysit-tick.tmp /tmp/ci-babysit-tick.json
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
    rm -f /tmp/ci-babysit-state.json /tmp/ci-babysit-tick.json
    exit 1
  fi
fi
