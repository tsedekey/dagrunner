#!/bin/zsh
set -euo pipefail

STATE_FILE="${TMPDIR%/}/seed-data-state.json"
PROFILE=$(jq -r .profile "$STATE_FILE")

echo "Checking cluster reachability (profile: $PROFILE)..."
TOPO=$(c8ctl get topology --profile "$PROFILE" --json 2>&1) || true

if echo "$TOPO" | jq -e 'select(.status == "error")' > /dev/null 2>&1; then
  echo ""
  echo "ERROR: Cannot reach Orchestration Cluster at profile '$PROFILE'."
  echo "$TOPO" | jq -r '.message // .' 2>/dev/null || echo "$TOPO"
  echo ""
  echo "Start the cluster first, then re-run /seed-data."
  echo "  c8ctl start c8-cluster"
  exit 1
fi

if ! echo "$TOPO" | jq -e 'has("clusterSize") or has("gatewayVersion") or has("partitionsCount") or has("brokers")' > /dev/null 2>&1; then
  echo "ERROR: c8ctl returned unexpected output — cluster may be unreachable or returned non-topology JSON."
  echo "Raw output:"
  echo "$TOPO"
  exit 1
fi

echo "Cluster reachable."
echo "$TOPO" | jq '{gatewayVersion,clusterSize,replicationFactor,partitionsCount} // .' 2>/dev/null \
  || echo "$TOPO" | head -3
