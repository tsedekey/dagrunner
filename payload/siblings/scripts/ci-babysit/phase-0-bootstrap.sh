#!/bin/zsh
set -euo pipefail

REFLECTION_LOG="$HOME/.local/share/dagrunner/store/reflection-log.jsonl"
if [ -f "$REFLECTION_LOG" ]; then
  PRIOR=$(jq -r 'select(.source == "ci-babysit") | "[\(.ts)]\n\(.body)"' "$REFLECTION_LOG" 2>/dev/null || true)
  if [ -n "$PRIOR" ]; then
    echo "=== Prior ci-babysit reflections ==="
    echo "$PRIOR"
    echo "====================================="
  fi
fi

ARGS="${1:-}"
REPO_ARG=""
PR_NUMBER_ARG=""
RUN_ID_ARG=""

if echo "$ARGS" | grep -q -- "--repo"; then
  REPO_ARG=$(echo "$ARGS" | sed 's/.*--repo[[:space:]]*\([^[:space:]]*\).*/\1/')
  ARGS=$(echo "$ARGS" | sed 's/--repo[[:space:]]*[^[:space:]]*//')
fi
if echo "$ARGS" | grep -q -- "--pr"; then
  PR_NUMBER_ARG=$(echo "$ARGS" | sed 's/.*--pr[[:space:]]*\([^[:space:]]*\).*/\1/')
  ARGS=$(echo "$ARGS" | sed 's/--pr[[:space:]]*[^[:space:]]*//')
fi
if echo "$ARGS" | grep -q -- "--run-id"; then
  RUN_ID_ARG=$(echo "$ARGS" | sed 's/.*--run-id[[:space:]]*\([^[:space:]]*\).*/\1/')
fi

WORKTREE=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$WORKTREE" ]; then
  echo "ERROR: Not inside a git worktree. ci-babysit must run from a dagrunner worktree."
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if ! echo "$BRANCH" | grep -qE "^feat/"; then
  echo "ERROR: Current branch '$BRANCH' is not a feat branch (expected feat/<slug>)."
  echo "ci-babysit runs inside a dagrunner worktree on the feat/<slug> branch."
  exit 1
fi

RUN_ID="${RUN_ID_ARG:-${DAGRUN_RUN_ID:-}}"
if [ -z "$RUN_ID" ]; then
  RUN_ID=$(echo "$BRANCH" | sed 's|^feat[a-z]*/||')
fi

GH_FLAGS=()
[ -n "$REPO_ARG" ] && GH_FLAGS=(-R "$REPO_ARG")
if [ -n "$PR_NUMBER_ARG" ]; then
  PR_NUMBER="$PR_NUMBER_ARG"
else
  PR_NUMBER=$(gh pr view --json number --jq '.number' "${GH_FLAGS[@]}" 2>/dev/null || echo "")
fi
if [ -z "$PR_NUMBER" ]; then
  echo "ERROR: No open PR found for branch '$BRANCH'."
  echo "The dagrunner 'pr' node must open the PR before running ci-babysit."
  echo "  gh pr list --head $BRANCH   — confirm PR existence"
  exit 1
fi

ARTIFACTS_DIR="$HOME/.local/share/dagrunner/runs/${RUN_ID}/ci-babysit"
mkdir -p "$ARTIFACTS_DIR"
STATE_FILE="$ARTIFACTS_DIR/ci-babysit-state.json"
TICK_FILE="$ARTIFACTS_DIR/ci-babysit-tick.json"

jq -n \
  --arg run_id "$RUN_ID" \
  --arg pr "$PR_NUMBER" \
  --arg branch "$BRANCH" \
  --arg worktree "$WORKTREE" \
  --arg repo "$REPO_ARG" \
  --arg artifacts "$ARTIFACTS_DIR" \
  '{"run_id":$run_id,"pr_number":$pr,"branch":$branch,"worktree":$worktree,"repo":$repo,"artifacts":$artifacts}' \
  > "$STATE_FILE"

echo "Run ID:    ${RUN_ID}"
echo "PR:        #${PR_NUMBER} (branch: ${BRANCH})"
echo "Worktree:  ${WORKTREE}"
echo "Artifacts: ${ARTIFACTS_DIR}"
echo "State:     ${STATE_FILE}"
