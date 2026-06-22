#!/bin/zsh
set -euo pipefail

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
RUN_ID="${DAGRUN_RUN_ID:-$(echo "$BRANCH" | sed -E 's|^(feature|feat)/||')}"
ARTIFACTS_DIR="${DAGRUN_ARTIFACTS:-$HOME/.local/share/dagrunner/runs/${RUN_ID}/pr-triage}"
TICK_FILE="$ARTIFACTS_DIR/pr-triage-tick.json"
NEW_OR_EDITED_FILE="$ARTIFACTS_DIR/new-or-edited.json"

COUNT=$(jq 'length' "$NEW_OR_EDITED_FILE")

if [ "$COUNT" = "0" ]; then
  jq '. + {"noop": true}' "$TICK_FILE" > "${TICK_FILE}.tmp" && mv "${TICK_FILE}.tmp" "$TICK_FILE"
  echo "No new or edited comments — tick is a no-op. Nothing to triage."
  exit 0
fi

echo "Found ${COUNT} new/edited comment(s) to triage."
jq '. + {"noop": false}' "$TICK_FILE" > "${TICK_FILE}.tmp" && mv "${TICK_FILE}.tmp" "$TICK_FILE"
