#!/bin/zsh
set -euo pipefail

RUN_ID="${DAGRUN_RUN_ID:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-')}"
DAGRUNNER_HOME="${DAGRUNNER_HOME:-$HOME/.local/share/dagrunner}"
ARTIFACTS_DIR="$DAGRUNNER_HOME/runs/$RUN_ID/ci-babysit"
STATE_FILE="$ARTIFACTS_DIR/ci-babysit-state.json"
TICK_FILE="$ARTIFACTS_DIR/ci-babysit-tick.json"

SINCE_STATE="$ARTIFACTS_DIR/since-state.json"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TICK_LOG="$ARTIFACTS_DIR/tick-${TS}.md"

CURRENT_HEAD=$(jq -r '.current_head' "$TICK_FILE")
BASE_HEAD=$(jq -r '.base_head' "$TICK_FILE")
CURRENT_CC=$(jq -c '.current_check_conclusions' "$TICK_FILE")
PR_NUMBER=$(jq -r .pr_number "$STATE_FILE")

PRIOR_ACTIONS=$(jq -c '.prior_check_actions' "$TICK_FILE")
NEWLY_FAILED=$(jq -r '.newly_failed' "$TICK_FILE")
FIX_PUSHED=$(jq -r '.fix_pushed // "false"' "$TICK_FILE")

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
' "$TICK_FILE" 2>/dev/null || echo "(unavailable)")

## Check conclusions

$(jq -r '.current_check_conclusions[] | "  [\(.bucket)] \(.name)"' "$TICK_FILE" 2>/dev/null || echo "(unavailable)")
LOGEOF

echo "Tick log: $TICK_LOG"

rm -f "$STATE_FILE" "$TICK_FILE"
