#!/bin/zsh
set -euo pipefail

NOOP=$(jq -r '.noop // false' /tmp/ci-babysit-tick.json)
if [ "$NOOP" = "true" ]; then echo "No-op tick — skipping Phase 5a."; exit 0; fi

ARTIFACTS_DIR=$(jq -r .artifacts /tmp/ci-babysit-state.json)
REPO_ARG=$(jq -r '.repo' /tmp/ci-babysit-state.json)
GH_FLAGS=(); [ -n "$REPO_ARG" ] && GH_FLAGS=(-R "$REPO_ARG")

mkdir -p "$ARTIFACTS_DIR/check-logs"

PRIOR_ACTIONS=$(jq -c '.prior_check_actions // []' /tmp/ci-babysit-tick.json)
CURRENT_HEAD=$(jq -r '.current_head' /tmp/ci-babysit-tick.json)

FAILING_CHECKS=$(jq -r \
  --argjson actions "$PRIOR_ACTIONS" \
  --arg head "$CURRENT_HEAD" '
  .checks[] | select(.bucket == "fail") |
  . as $c |
  select(
    ($actions | map(select(.name == $c.name and .action_sha == $head)) | length) == 0
  ) |
  [.name, (.link | capture("runs/(?P<run_id>[0-9]+)") | .run_id // "")] |
  @tsv' /tmp/ci-babysit-tick.json 2>/dev/null || echo "")

if [ -z "$FAILING_CHECKS" ]; then
  echo "No failing checks to collect logs for."
else
  echo "Collecting failure logs..."
  while IFS=$'\t' read -r CHECK_NAME RUN_ID; do
    [ -z "$CHECK_NAME" ] && continue
    SAFE_NAME=$(echo "$CHECK_NAME" | tr '/ ' '--')
    LOG_FILE="$ARTIFACTS_DIR/check-logs/${SAFE_NAME}.log"
    echo ""
    echo "--- Check: $CHECK_NAME (run: ${RUN_ID:-unknown}) ---"
    if [ -n "$RUN_ID" ]; then
      gh run view "$RUN_ID" --log-failed "${GH_FLAGS[@]}" > "$LOG_FILE" 2>&1 || true
      echo "Log written to: $LOG_FILE"
      echo "--- First 60 lines ---"
      head -60 "$LOG_FILE" || true
    else
      echo "WARNING: Could not extract run ID from check link. Fetch log manually:"
      LINK=$(jq -r --arg n "$CHECK_NAME" '.checks[] | select(.name == $n) | .link' /tmp/ci-babysit-tick.json 2>/dev/null || echo "")
      echo "  Link: ${LINK:-not available}"
      echo "(no run ID)" > "$LOG_FILE"
    fi
  done <<< "$FAILING_CHECKS"
fi
