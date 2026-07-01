#!/bin/zsh
set -euo pipefail

REFLECTION_LOG="$HOME/.local/share/dagrunner/store/reflection-log.jsonl"
mkdir -p "$(dirname "$REFLECTION_LOG")"
if [ -f "$REFLECTION_LOG" ]; then
  echo "=== Prior reflections (seed-data) ==="
  grep '"source":"seed-data"' "$REFLECTION_LOG" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        e = json.loads(line)
        print(e.get('ts',''), e.get('body',''))
    except Exception:
        pass
" 2>/dev/null || true
  echo "======================================"
fi

ARGS="${1:-}"
PROFILE="local"

if echo "$ARGS" | grep -q -- "--profile"; then
  PROFILE=$(echo "$ARGS" | sed 's/.*--profile[[:space:]]*\([^[:space:]]*\).*/\1/')
  ARGS=$(echo "$ARGS" | sed 's/--profile[[:space:]]*[^[:space:]]*//')
fi

SPEC_PATH=$(echo "$ARGS" | xargs 2>/dev/null || true)
SPEC_PATH="${SPEC_PATH/#\~/$HOME}"

if [ -z "$SPEC_PATH" ]; then
  # Scan for most recent run with a verify-guide/seeding-spec.json
  RUNS_DIR="${DAGRUNNER_HOME:-$HOME/.local/share/dagrunner}/runs"
  if [ -d "$RUNS_DIR" ]; then
    SPEC_PATH=$(find "$RUNS_DIR" -maxdepth 3 -name "seeding-spec.json" -path "*/verify-guide/*" \
      | xargs ls -t 2>/dev/null | head -1 || true)
  fi
fi

if [ -z "$SPEC_PATH" ] || [ ! -f "$SPEC_PATH" ]; then
  echo "ERROR: seeding-spec.json not found."
  echo "Pass the path explicitly: /seed-data ~/.local/share/dagrunner/runs/<run-id>/verify-guide/seeding-spec.json"
  echo "Or omit it — /seed-data will scan for the most recent run automatically."
  exit 1
fi

cat "$SPEC_PATH" | jq . > /dev/null || { echo "ERROR: $SPEC_PATH is not valid JSON"; exit 1; }

# Derive run dir: spec lives at <run-dir>/verify-guide/seeding-spec.json
RUN_DIR=$(dirname "$(dirname "$SPEC_PATH")")
SEED_SCRATCH="$RUN_DIR/seed-data"
mkdir -p "$SEED_SCRATCH/generated"

REPO_ROOT=$(git rev-parse --show-toplevel)
STATE_FILE="$REPO_ROOT/.claude/seed-data-state.json"

jq -n \
  --arg spec "$SPEC_PATH" \
  --arg profile "$PROFILE" \
  --arg run_dir "$RUN_DIR" \
  --arg seed_scratch "$SEED_SCRATCH" \
  '{"spec_path":$spec,"profile":$profile,"run_dir":$run_dir,"seed_scratch":$seed_scratch}' \
  > "$STATE_FILE"

echo "Spec:         $SPEC_PATH"
echo "Profile:      $PROFILE"
echo "Run dir:      $RUN_DIR"
echo "Seed scratch: $SEED_SCRATCH"
echo "State file:   $STATE_FILE"
