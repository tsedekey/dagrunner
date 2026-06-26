#!/bin/zsh
set -euo pipefail

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
RUN_ID="${DAGRUN_RUN_ID:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "")")}"
DAGRUNNER_HOME="${DAGRUNNER_HOME:-$HOME/.local/share/dagrunner}"
ARTIFACTS_DIR="$DAGRUNNER_HOME/runs/$RUN_ID/ci-babysit"
STATE_FILE="$ARTIFACTS_DIR/ci-babysit-state.json"
TICK_FILE="$ARTIFACTS_DIR/ci-babysit-tick.json"

PR_NUMBER=$(jq -r .pr_number "$STATE_FILE")
REPO_ARG=$(jq -r '.repo' "$STATE_FILE")
GH_FLAGS=(); [ -n "$REPO_ARG" ] && GH_FLAGS=(-R "$REPO_ARG")
SINCE_STATE="$ARTIFACTS_DIR/since-state.json"

PR_VIEW=$(gh pr view "$PR_NUMBER" --json headRefOid,baseRefName,isDraft,state "${GH_FLAGS[@]}" 2>&1)
if ! echo "$PR_VIEW" | jq -e '.headRefOid' > /dev/null 2>&1; then
  echo "ERROR: Could not fetch PR #${PR_NUMBER} state."
  echo "$PR_VIEW"
  exit 1
fi

CURRENT_HEAD=$(echo "$PR_VIEW" | jq -r '.headRefOid')
BASE_BRANCH=$(echo "$PR_VIEW" | jq -r '.baseRefName')
IS_DRAFT=$(echo "$PR_VIEW" | jq -r '.isDraft')
PR_STATE=$(echo "$PR_VIEW" | jq -r '.state')

if [ "$PR_STATE" != "OPEN" ]; then
  echo "PR #${PR_NUMBER} is ${PR_STATE} — nothing to babysit. Exiting."
  rm -f "$STATE_FILE"
  exit 0
fi

# Sync local worktree to remote PR head to avoid diagnosing stale state
git fetch origin "$BRANCH" --quiet 2>/dev/null || true
LOCAL_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")
REMOTE_BRANCH_HEAD=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "")
if [ -n "$REMOTE_BRANCH_HEAD" ] && [ "$LOCAL_HEAD" != "$REMOTE_BRANCH_HEAD" ]; then
  echo "Syncing worktree: local=${LOCAL_HEAD:0:8} remote=${REMOTE_BRANCH_HEAD:0:8}"
  git merge --ff-only "origin/$BRANCH" 2>/dev/null || \
    echo "WARNING: Could not fast-forward to remote head (non-linear history?). Proceeding with local HEAD."
fi

CHECKS_RAW=$(gh pr checks "$PR_NUMBER" --json bucket,completedAt,link,name,state,workflow \
  "${GH_FLAGS[@]}" 2>&1) || CHECKS_EXIT=$?
if echo "$CHECKS_RAW" | jq -e '.[0].name' > /dev/null 2>&1 || [ "${CHECKS_EXIT:-0}" = "8" ]; then
  CHECKS="$CHECKS_RAW"
else
  echo "WARNING: Could not fetch checks: $CHECKS_RAW"
  CHECKS="[]"
fi
if ! echo "$CHECKS" | jq -e 'if type == "array" then true else false end' > /dev/null 2>&1; then
  CHECKS="[]"
fi

CURRENT_CHECK_CONCLUSIONS=$(echo "$CHECKS" | jq -c '[.[] | {name, bucket}] | sort_by(.name)')

git fetch origin "$BASE_BRANCH" --quiet 2>/dev/null || true
BASE_HEAD=$(git rev-parse "origin/$BASE_BRANCH" 2>/dev/null || echo "")

if [ -f "$SINCE_STATE" ]; then
  PRIOR_HEAD=$(jq -r '.head_sha // ""' "$SINCE_STATE")
  PRIOR_BASE_HEAD=$(jq -r '.base_head_sha // ""' "$SINCE_STATE")
  PRIOR_CHECK_CONCLUSIONS=$(jq -c '.check_conclusions // []' "$SINCE_STATE")
  PRIOR_CHECK_ACTIONS=$(jq -c '.check_actions // []' "$SINCE_STATE")
else
  PRIOR_HEAD=""
  PRIOR_BASE_HEAD=""
  PRIOR_CHECK_CONCLUSIONS="[]"
  PRIOR_CHECK_ACTIONS="[]"
fi

HEAD_CHANGED="false"
BASE_ADVANCED="false"
[ "$CURRENT_HEAD" != "$PRIOR_HEAD" ] && HEAD_CHANGED="true"
[ -n "$BASE_HEAD" ] && [ "$BASE_HEAD" != "$PRIOR_BASE_HEAD" ] && [ -n "$PRIOR_BASE_HEAD" ] && BASE_ADVANCED="true"

NEWLY_FAILED=$(jq -n \
  --argjson cur "$CURRENT_CHECK_CONCLUSIONS" \
  --argjson pri "$PRIOR_CHECK_CONCLUSIONS" '
  ($cur | map(select(.bucket == "fail")) | .[].name) as $names |
  $names | select(
    . as $n |
    ($pri | map(select(.name == $n and .bucket == "fail")) | length) == 0
  )' 2>/dev/null | tr '\n' ',' | sed 's/,$//' | sed 's/"//g' || echo "")

ALL_PASS=$(echo "$CHECKS" | jq -r '
  if length == 0 then "false"
  elif ([.[] | select(.bucket != "pass" and .bucket != "skipping")] | length) == 0 then "true"
  else "false"
  end' 2>/dev/null || echo "false")

jq -n \
  --arg pr "$PR_NUMBER" \
  --arg current_head "$CURRENT_HEAD" \
  --arg prior_head "$PRIOR_HEAD" \
  --arg base_branch "$BASE_BRANCH" \
  --arg base_head "$BASE_HEAD" \
  --arg prior_base_head "$PRIOR_BASE_HEAD" \
  --argjson checks "$CHECKS" \
  --argjson current_check_conclusions "$CURRENT_CHECK_CONCLUSIONS" \
  --argjson prior_check_conclusions "$PRIOR_CHECK_CONCLUSIONS" \
  --argjson prior_check_actions "$PRIOR_CHECK_ACTIONS" \
  --arg head_changed "$HEAD_CHANGED" \
  --arg base_advanced "$BASE_ADVANCED" \
  --arg newly_failed "$NEWLY_FAILED" \
  --arg all_pass "$ALL_PASS" \
  --arg is_draft "$IS_DRAFT" \
  '{pr:$pr, current_head:$current_head, prior_head:$prior_head,
    base_branch:$base_branch, base_head:$base_head, prior_base_head:$prior_base_head,
    checks:$checks, current_check_conclusions:$current_check_conclusions,
    prior_check_conclusions:$prior_check_conclusions, prior_check_actions:$prior_check_actions,
    head_changed:($head_changed=="true"), base_advanced:($base_advanced=="true"),
    newly_failed:$newly_failed, all_pass:($all_pass=="true"), is_draft:($is_draft=="true")}' \
  > "$TICK_FILE"

echo "PR #${PR_NUMBER}  head: ${CURRENT_HEAD:0:8}  base: ${BASE_BRANCH} (${BASE_HEAD:0:8})"
echo "Draft:          $IS_DRAFT"
echo "Head changed:   $HEAD_CHANGED  (${PRIOR_HEAD:0:8} → ${CURRENT_HEAD:0:8})"
echo "Base advanced:  $BASE_ADVANCED  (${PRIOR_BASE_HEAD:0:8} → ${BASE_HEAD:0:8})"
echo "Failing checks: ${NEWLY_FAILED:-none}"
echo "All pass:       $ALL_PASS"
echo ""
echo "Check summary:"
echo "$CURRENT_CHECK_CONCLUSIONS" | jq -r '.[] | "  \(.bucket)\t\(.name)"'
