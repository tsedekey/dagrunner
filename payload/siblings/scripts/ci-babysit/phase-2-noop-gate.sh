#!/bin/zsh
set -euo pipefail

RUN_ID="${DAGRUN_RUN_ID:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "")")}"
DAGRUNNER_HOME="${DAGRUNNER_HOME:-$HOME/.local/share/dagrunner}"
ARTIFACTS_DIR="$DAGRUNNER_HOME/runs/$RUN_ID/ci-babysit"
STATE_FILE="$ARTIFACTS_DIR/ci-babysit-state.json"
TICK_FILE="$ARTIFACTS_DIR/ci-babysit-tick.json"

HEAD_CHANGED=$(jq -r '.head_changed' "$TICK_FILE")
BASE_ADVANCED=$(jq -r '.base_advanced' "$TICK_FILE")

CURRENT_CC=$(jq -c '.current_check_conclusions' "$TICK_FILE")
PRIOR_CC=$(jq -c '.prior_check_conclusions' "$TICK_FILE")

CHECKS_CHANGED="true"
[ "$CURRENT_CC" = "$PRIOR_CC" ] && CHECKS_CHANGED="false"

NOOP="false"
if [ "$HEAD_CHANGED" = "false" ] && [ "$BASE_ADVANCED" = "false" ] && [ "$CHECKS_CHANGED" = "false" ]; then
  echo "No-op tick: head SHA unchanged, base unchanged, check conclusions unchanged."
  NOOP="true"
else
  echo "Transitions detected — proceeding."
  echo "  head_changed=$HEAD_CHANGED  base_advanced=$BASE_ADVANCED  checks_changed=$CHECKS_CHANGED"
fi

jq --argjson noop "$NOOP" '. + {noop: $noop}' "$TICK_FILE" \
  > "$TICK_FILE.tmp" && mv "$TICK_FILE.tmp" "$TICK_FILE"
