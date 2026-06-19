#!/bin/zsh
set -euo pipefail

PROFILE=$(jq -r .profile /tmp/seed-data-state.json)

echo "Checking cluster reachability (profile: $PROFILE)..."
TOPO=$(c8ctl get topology --profile "$PROFILE" --json 2>&1)

if echo "$TOPO" | jq -e 'select(.status == "error")' > /dev/null 2>&1; then
  echo ""
  echo "ERROR: Cannot reach Orchestration Cluster at profile '$PROFILE'."
  echo "$TOPO" | jq -r '.message // .'
  echo ""
  echo "Start the cluster first, then re-run /seed-data."
  echo "  c8ctl dev env info        — list available environments"
  echo "  docker compose -f .c8dev/envs/<name>/docker-compose.yml up -d"
  exit 1
fi

echo "Cluster reachable."
echo "$TOPO" | jq '{gatewayVersion,clusterSize,replicationFactor,partitionsCount} // .' 2>/dev/null \
  || echo "$TOPO" | head -3
