#!/bin/zsh
set -euo pipefail

STATE_FILE="${TMPDIR%/}/seed-data-state.json"
SEED_SCRATCH=$(jq -r .seed_scratch "$STATE_FILE")
SEEDED="$SEED_SCRATCH/seeded.json"

echo ""
echo "========================================"
echo "  /seed-data complete"
echo "========================================"
cat "$SEEDED" | jq '{
  profile,
  deployments: [.deployments[] | {process_id, deployment_key}],
  instances:   [.instances[]   | {process_id, instance_key}],
  observations:[.observations[] | {where, status, what}]
}'

echo ""
echo "Artifacts written to: $SEED_SCRATCH"
echo "  seeded.json                — instance keys and observation records"
[ -f "$SEED_SCRATCH/postman-collection.json" ] && \
  echo "  postman-collection.json    — import into Postman to run REST observations" || \
  echo "  postman-collection.json    — (not yet generated — see Phase 2b)"
ls "$SEED_SCRATCH/generated/"*.bpmn 2>/dev/null && \
  echo "  generated/*.bpmn           — generated BPMN resources" || true

echo ""
echo "--- Testing checklist ---"
REST_N=0
ES_N=0
OBS_LEN=$(cat "$SEEDED" | jq '.observations | length')
m=0
while [ "$m" -lt "$OBS_LEN" ]; do
  WHERE=$(cat "$SEEDED" | jq -r ".observations[$m].where")
  WHAT=$(cat "$SEEDED" | jq -r ".observations[$m].what")
  STATUS=$(cat "$SEEDED" | jq -r ".observations[$m].status")
  if [ "$WHERE" = "rest-api" ]; then
    REST_N=$((REST_N + 1))
    echo "[ ] REST: $WHAT — use Postman (see postman-collection.json, request $REST_N)"
  elif [ "$WHERE" = "elasticsearch" ]; then
    ES_N=$((ES_N + 1))
    echo "[ ] ES ($STATUS): $WHAT"
  fi
  m=$((m + 1))
done

rm -f "$STATE_FILE"
