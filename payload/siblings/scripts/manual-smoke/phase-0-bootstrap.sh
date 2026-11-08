#!/bin/zsh
# phase-0-bootstrap.sh — resolve which completed dagrunner run's artifacts to
# read, locate its worktree, and locate the run's plan (plan/plan.md — the plan
# is the guide; there is no define/reproduce node). Fails loud (never a silent
# fallback) when the run or its worktree cannot be found — this command reads
# DONE-run artifacts only.
set -euo pipefail

DAGRUNNER_HOME="${DAGRUNNER_HOME:-$HOME/.local/share/camunda/dagrunner}"
REFLECTION_LOG="$DAGRUNNER_HOME/store/reflection-log.jsonl"
mkdir -p "$(dirname "$REFLECTION_LOG")"
if [ -f "$REFLECTION_LOG" ]; then
  echo "=== Prior reflections (manual-smoke) ==="
  grep '"source":"manual-smoke"' "$REFLECTION_LOG" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        e = json.loads(line)
        print(e.get('ts',''), e.get('body',''))
    except Exception:
        pass
" 2>/dev/null || true
  echo "=========================================="
fi

ARGS="${1:-}"
RUN_ID_ARG=""
if echo "$ARGS" | grep -q -- "--run-id"; then
  RUN_ID_ARG=$(echo "$ARGS" | sed 's/.*--run-id[[:space:]]*\([^[:space:]]*\).*/\1/')
elif [ -n "$ARGS" ]; then
  # First bare token (no --flag) is treated as the run-id, e.g. `/manual-smoke 53861-1`.
  RUN_ID_ARG=$(echo "$ARGS" | awk '{print $1}')
fi

# Fallback: DAGRUN_RUN_ID env (set when invoked inside a dagrunner-managed
# worktree), then the current branch name (sanitized), matching the pattern
# already established by ci-babysit/pr-triage.
RUN_ID="${RUN_ID_ARG:-${DAGRUN_RUN_ID:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-')}}"

if [ -z "$RUN_ID" ]; then
  echo "ERROR: no run-id given and none could be inferred."
  echo "  Usage: /manual-smoke <run-id>   (or run from inside that run's worktree)"
  exit 1
fi

RUN_DIR="$DAGRUNNER_HOME/runs/${RUN_ID}"
STATE_FILE="$RUN_DIR/state.json"

if [ ! -f "$STATE_FILE" ]; then
  echo "ERROR: no dagrunner run found at ${RUN_DIR} (state.json missing)."
  echo "  Confirm the run-id with: dagrun status ${RUN_ID}"
  echo "  Or list runs with: dagrun list"
  exit 1
fi

WORKTREE=$(jq -r '.worktreePath // empty' "$STATE_FILE")
if [ -z "$WORKTREE" ] || [ ! -d "$WORKTREE" ]; then
  echo "ERROR: worktree for run ${RUN_ID} is not present at '${WORKTREE:-<empty>}'."
  echo "  It may have been removed by 'dagrun cleanup'. manual-smoke needs the"
  echo "  worktree (for the diff and the OpenAPI spec) — it cannot proceed without it."
  exit 1
fi

# The plan is the contract: dagrunner copies it to <run>/plan/plan.md at start.
PLAN_PATH="$RUN_DIR/plan/plan.md"
if [ ! -f "$PLAN_PATH" ]; then
  echo "ERROR: plan/plan.md not found under ${RUN_DIR}."
  echo "  manual-smoke requires a dagrunner run that has at least started (the plan is copied in at start)."
  exit 1
fi

ARTIFACTS_DIR="$RUN_DIR/manual-smoke"
mkdir -p "$ARTIFACTS_DIR"

STATE_OUT="$ARTIFACTS_DIR/manual-smoke-state.json"
jq -n \
  --arg run_id "$RUN_ID" \
  --arg run_dir "$RUN_DIR" \
  --arg worktree "$WORKTREE" \
  --arg plan_path "$PLAN_PATH" \
  --arg artifacts "$ARTIFACTS_DIR" \
  '{"run_id":$run_id,"run_dir":$run_dir,"worktree":$worktree,"plan_path":$plan_path,"artifacts":$artifacts}' \
  > "$STATE_OUT"

echo "Run ID:    ${RUN_ID}"
echo "Run dir:   ${RUN_DIR}"
echo "Worktree:  ${WORKTREE}"
echo "Plan:      ${PLAN_PATH}"
echo "Artifacts: ${ARTIFACTS_DIR}"
echo "State:     ${STATE_OUT}"
