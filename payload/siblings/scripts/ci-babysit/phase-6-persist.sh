#!/bin/zsh
set -euo pipefail

ARTIFACTS_DIR=$(jq -r .artifacts /tmp/ci-babysit-state.json)
SINCE_STATE="$ARTIFACTS_DIR/since-state.json"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TICK_LOG="$ARTIFACTS_DIR/tick-${TS}.md"

CURRENT_HEAD=$(jq -r '.current_head' /tmp/ci-babysit-tick.json)
BASE_HEAD=$(jq -r '.base_head' /tmp/ci-babysit-tick.json)
CURRENT_CC=$(jq -c '.current_check_conclusions' /tmp/ci-babysit-tick.json)
PR_NUMBER=$(jq -r .pr_number /tmp/ci-babysit-state.json)

PRIOR_ACTIONS=$(jq -c '.prior_check_actions' /tmp/ci-babysit-tick.json)
NEWLY_FAILED=$(jq -r '.newly_failed' /tmp/ci-babysit-tick.json)
FIX_PUSHED=$(jq -r '.fix_pushed // "false"' /tmp/ci-babysit-tick.json)

NEW_ACTIONS="$PRIOR_ACTIONS"
if [ "$FIX_PUSHED" = "true" ] && [ -n "$NEWLY_FAILED" ]; then
  for CHECK_NAME in $(echo "$NEWLY_FAILED" | tr ',' '\n'); do
    [ -z "$CHECK_NAME" ] && continue
    ACTION=$(jq -n --arg name "$CHECK_NAME" --arg sha "$CURRENT_HEAD" --arg ts "$TS" \
      '{"name":$name,"action_sha":$sha,"action_at":$ts}')
    NEW_ACTIONS=$(echo "$NEW_ACTIONS" | jq --argjson a "$ACTION" '. + [$a]')
  done
fi

jq -n \
  --arg head "$CURRENT_HEAD" \
  --arg base "$BASE_HEAD" \
  --argjson conclusions "$CURRENT_CC" \
  --argjson actions "$NEW_ACTIONS" \
  --arg ts "$TS" \
  '{"head_sha":$head,"base_head_sha":$base,"check_conclusions":$conclusions,
    "check_actions":$actions,"last_tick_at":$ts}' \
  > "$SINCE_STATE"

echo "since-state updated: head=${CURRENT_HEAD:0:8}  last_tick=${TS}"

cat > "$TICK_LOG" << LOGEOF
# ci-babysit tick — ${TS}

PR: #${PR_NUMBER}
Head: ${CURRENT_HEAD}
Base head: ${BASE_HEAD}

## Transitions

$(jq -r '
  "head_changed: \(.head_changed)",
  "base_advanced: \(.base_advanced)",
  "newly_failed: \(.newly_failed)",
  "all_pass: \(.all_pass)",
  "rebased: \(.rebased // false)",
  "fix_pushed: \(.fix_pushed // false)"
' /tmp/ci-babysit-tick.json 2>/dev/null || echo "(unavailable)")

## Check conclusions

$(jq -r '.current_check_conclusions[] | "  [\(.bucket)] \(.name)"' /tmp/ci-babysit-tick.json 2>/dev/null || echo "(unavailable)")
LOGEOF

echo "Tick log: $TICK_LOG"

rm -f /tmp/ci-babysit-state.json /tmp/ci-babysit-tick.json
