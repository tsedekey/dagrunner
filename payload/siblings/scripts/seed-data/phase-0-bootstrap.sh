#!/bin/zsh
set -euo pipefail

LEARNINGS_FILE="$HOME/.local/share/dagrunner/store/learnings/seed-data.md"
mkdir -p "$(dirname "$LEARNINGS_FILE")"
if [ -f "$LEARNINGS_FILE" ]; then
  echo "=== Prior learnings for /seed-data ==="
  cat "$LEARNINGS_FILE"
  echo "======================================="
fi

ARGS="${1:-}"
PROFILE="local"

if echo "$ARGS" | grep -q -- "--profile"; then
  PROFILE=$(echo "$ARGS" | sed 's/.*--profile[[:space:]]*\([^[:space:]]*\).*/\1/')
  ARGS=$(echo "$ARGS" | sed 's/--profile[[:space:]]*[^[:space:]]*//')
fi

SPEC_PATH=$(echo "$ARGS" | xargs 2>/dev/null || true)

if [ -z "$SPEC_PATH" ]; then
  if [ -n "${DAGRUN_RUN_DIR:-}" ] && [ -f "$DAGRUN_RUN_DIR/verify-guide/seeding-spec.json" ]; then
    SPEC_PATH="$DAGRUN_RUN_DIR/verify-guide/seeding-spec.json"
  elif [ -f "verify-demo/seeding-spec.json" ]; then
    SPEC_PATH="$(pwd)/verify-demo/seeding-spec.json"
  elif [ -n "${DAGRUN_ARTIFACTS:-}" ] && [ -f "$DAGRUN_ARTIFACTS/seeding-spec.json" ]; then
    SPEC_PATH="$DAGRUN_ARTIFACTS/seeding-spec.json"
  fi
fi

if [ -z "$SPEC_PATH" ] || [ ! -f "$SPEC_PATH" ]; then
  echo "ERROR: seeding-spec.json not found."
  echo "Tried: DAGRUN_RUN_DIR/verify-guide/, verify-demo/, DAGRUN_ARTIFACTS/"
  echo "Pass the path explicitly: /seed-data path/to/seeding-spec.json"
  exit 1
fi

cat "$SPEC_PATH" | jq . > /dev/null || { echo "ERROR: $SPEC_PATH is not valid JSON"; exit 1; }

mkdir -p verify-demo/generated

jq -n --arg spec "$SPEC_PATH" --arg profile "$PROFILE" \
  '{"spec_path":$spec,"profile":$profile}' > /tmp/seed-data-state.json

echo "Spec:    $SPEC_PATH"
echo "Profile: $PROFILE"
