#!/bin/zsh
set -euo pipefail

RUN_ID="${DAGRUN_RUN_ID:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-')}"
DAGRUNNER_HOME="${DAGRUNNER_HOME:-$HOME/.local/share/dagrunner}"
ARTIFACTS_DIR="$DAGRUNNER_HOME/runs/$RUN_ID/ci-babysit"
STATE_FILE="$ARTIFACTS_DIR/ci-babysit-state.json"
TICK_FILE="$ARTIFACTS_DIR/ci-babysit-tick.json"

NOOP=$(jq -r '.noop // false' "$TICK_FILE")
if [ "$NOOP" = "true" ]; then echo "No-op tick — skipping Phase 5a."; exit 0; fi

REPO_ARG=$(jq -r '.repo' "$STATE_FILE")
GH_FLAGS=(); [ -n "$REPO_ARG" ] && GH_FLAGS=(-R "$REPO_ARG")

mkdir -p "$ARTIFACTS_DIR/check-logs"

PRIOR_ACTIONS=$(jq -c '.prior_check_actions // []' "$TICK_FILE")
CURRENT_HEAD=$(jq -r '.current_head' "$TICK_FILE")

FAILING_CHECKS=$(jq -r \
  --argjson actions "$PRIOR_ACTIONS" \
  --arg head "$CURRENT_HEAD" '
  .checks[] | select(.bucket == "fail") |
  . as $c |
  select(
    ($actions | map(select(.name == $c.name and .action_sha == $head)) | length) == 0
  ) |
  [.name, (.link | split("/runs/") | if length > 1 then .[1] | split("/") | .[0] else "" end)] |
  @tsv' "$TICK_FILE" 2>/dev/null || echo "")

if [ -z "$FAILING_CHECKS" ]; then
  echo "No failing checks to collect logs for."
else
  echo "Collecting failure logs..."
  # Read the outer loop's input from fd 3, not fd 0 (stdin). `gh run view`/
  # `gh api` below inherit fd 0 from this shell; if the loop also reads its
  # own here-string on fd 0, those inner commands drain the buffered
  # here-string and the outer `read` hits EOF after the first iteration —
  # silently stopping the loop with no error under `set -euo pipefail` (a
  # `read` returning nonzero is just a normal loop exit). Routing the loop's
  # own read through fd 3 (`-u3` / `3<<<`) isolates it from anything the loop
  # body does on fd 0.
  while IFS=$'\t' read -r -u3 CHECK_NAME GH_RUN_ID; do
    [ -z "$CHECK_NAME" ] && continue
    SAFE_NAME=$(echo "$CHECK_NAME" | tr '/ ' '--')
    LOG_FILE="$ARTIFACTS_DIR/check-logs/${SAFE_NAME}.log"
    echo ""
    echo "--- Check: $CHECK_NAME (run: ${GH_RUN_ID:-unknown}) ---"
    if [ -n "$GH_RUN_ID" ]; then
      REPO_NWO=$(jq -r '.repo' "$STATE_FILE" 2>/dev/null || echo "")
      if [ -z "$REPO_NWO" ]; then
        REPO_NWO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
      fi
      JOB_IDS=$(gh run view "$GH_RUN_ID" --json jobs \
        --jq '.jobs[] | select(.conclusion=="failure") | .databaseId' \
        "${GH_FLAGS[@]}" 2>/dev/null || echo "")
      if [ -n "$JOB_IDS" ] && [ -n "$REPO_NWO" ]; then
        > "$LOG_FILE"
        for JOB_ID in ${(f)JOB_IDS}; do
          gh api "repos/$REPO_NWO/actions/jobs/$JOB_ID/logs" >> "$LOG_FILE" 2>&1 || true
        done
      else
        gh run view "$GH_RUN_ID" --log-failed "${GH_FLAGS[@]}" > "$LOG_FILE" 2>&1 || true
      fi
      echo "Log written to: $LOG_FILE"
      echo "--- First 60 lines ---"
      head -60 "$LOG_FILE" || true
    else
      echo "WARNING: Could not extract run ID from check link. Fetch log manually:"
      LINK=$(jq -r --arg n "$CHECK_NAME" '.checks[] | select(.name == $n) | .link' "$TICK_FILE" 2>/dev/null || echo "")
      echo "  Link: ${LINK:-not available}"
      echo "(no run ID)" > "$LOG_FILE"
    fi
  done 3<<< "$FAILING_CHECKS"
fi
