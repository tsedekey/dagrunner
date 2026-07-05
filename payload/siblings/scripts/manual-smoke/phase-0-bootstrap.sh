#!/bin/zsh
# phase-0-bootstrap.sh — resolve which completed dagrunner run's artifacts to
# read, locate its worktree, and figure out which guide (define vs reproduce)
# it produced. Fails loud (never a silent fallback) when the run or its
# worktree cannot be found — this command reads DONE-run artifacts only.
set -euo pipefail

REFLECTION_LOG="$HOME/.local/share/dagrunner/store/reflection-log.jsonl"
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

RUN_DIR="$HOME/.local/share/dagrunner/runs/${RUN_ID}"
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

# Which guide did this run produce? define/guide.md (feature) or
# reproduce/guide.md (bugfix) — mutually exclusive per run.
GUIDE_PATH=""
if [ -f "$RUN_DIR/define/guide.md" ]; then
  GUIDE_PATH="$RUN_DIR/define/guide.md"
elif [ -f "$RUN_DIR/reproduce/guide.md" ]; then
  GUIDE_PATH="$RUN_DIR/reproduce/guide.md"
else
  echo "ERROR: neither define/guide.md nor reproduce/guide.md found under ${RUN_DIR}."
  echo "  manual-smoke requires a completed (or at least past-Gate-1) dagrunner run."
  exit 1
fi

ARTIFACTS_DIR="$RUN_DIR/manual-smoke"
mkdir -p "$ARTIFACTS_DIR"

STATE_OUT="$ARTIFACTS_DIR/manual-smoke-state.json"
jq -n \
  --arg run_id "$RUN_ID" \
  --arg run_dir "$RUN_DIR" \
  --arg worktree "$WORKTREE" \
  --arg guide_path "$GUIDE_PATH" \
  --arg artifacts "$ARTIFACTS_DIR" \
  '{"run_id":$run_id,"run_dir":$run_dir,"worktree":$worktree,"guide_path":$guide_path,"artifacts":$artifacts}' \
  > "$STATE_OUT"

echo "Run ID:    ${RUN_ID}"
echo "Run dir:   ${RUN_DIR}"
echo "Worktree:  ${WORKTREE}"
echo "Guide:     ${GUIDE_PATH}"
echo "Artifacts: ${ARTIFACTS_DIR}"
echo "State:     ${STATE_OUT}"
