#!/bin/zsh
set -euo pipefail

echo ""
echo "========================================"
echo "  /seed-data complete"
echo "========================================"
cat verify-demo/seeded.json | jq '{
  profile,
  deployments: [.deployments[] | {process_id, deployment_key}],
  instances:   [.instances[]   | {process_id, instance_key}],
  observations:[.observations[] | {where, status, what}]
}'
echo ""
echo "Artifacts:"
echo "  verify-demo/seeded.json            — instance keys + observation records"
ls verify-demo/generated/*.bpmn 2>/dev/null && echo "  verify-demo/generated/*.bpmn       — generated BPMN resources" || true
echo ""
echo "Next: run the manual test at Gate 3."
echo "      REST observations: see verify-demo/seeded.json .observations[].ready_to_run"
