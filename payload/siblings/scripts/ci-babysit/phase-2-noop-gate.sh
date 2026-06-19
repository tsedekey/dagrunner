#!/bin/zsh
set -euo pipefail

HEAD_CHANGED=$(jq -r '.head_changed' /tmp/ci-babysit-tick.json)
BASE_ADVANCED=$(jq -r '.base_advanced' /tmp/ci-babysit-tick.json)

CURRENT_CC=$(jq -c '.current_check_conclusions' /tmp/ci-babysit-tick.json)
PRIOR_CC=$(jq -c '.prior_check_conclusions' /tmp/ci-babysit-tick.json)

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

jq --argjson noop "$NOOP" '. + {noop: $noop}' /tmp/ci-babysit-tick.json \
  > /tmp/ci-babysit-tick.tmp && mv /tmp/ci-babysit-tick.tmp /tmp/ci-babysit-tick.json
