#!/bin/zsh
set -euo pipefail

NOOP=$(jq -r '.noop // false' /tmp/ci-babysit-tick.json)
if [ "$NOOP" = "true" ]; then echo "No-op tick — skipping Phase 5c."; exit 0; fi

OC_UP=false
if command -v c8ctl > /dev/null 2>&1; then
  TOPO=$(c8ctl get topology --profile local --json 2>&1 || echo "{}")
  if echo "$TOPO" | jq -e 'select(.status != "error")' > /dev/null 2>&1; then
    OC_UP=true
  fi
fi

if [ "$OC_UP" = "true" ]; then
  echo "Local Orchestration Cluster: RUNNING (profile: local)"
else
  echo "Local Orchestration Cluster: NOT running"
  echo "NOTE: Runtime-touching fixes will be verified static-only (no cluster)."
  echo "  Start the cluster and re-run if full verification is required."
fi
