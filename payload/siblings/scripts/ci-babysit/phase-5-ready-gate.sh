#!/bin/zsh
set -euo pipefail

RUN_ID="${DAGRUN_RUN_ID:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-')}"
DAGRUNNER_HOME="${DAGRUNNER_HOME:-$HOME/.local/share/dagrunner}"
ARTIFACTS_DIR="$DAGRUNNER_HOME/runs/$RUN_ID/ci-babysit"
STATE_FILE="$ARTIFACTS_DIR/ci-babysit-state.json"
TICK_FILE="$ARTIFACTS_DIR/ci-babysit-tick.json"

NOOP=$(jq -r '.noop // false' "$TICK_FILE")
if [ "$NOOP" = "true" ]; then echo "No-op tick — skipping Phase 6."; exit 0; fi

ALL_PASS=$(jq -r '.all_pass' "$TICK_FILE")
IS_DRAFT=$(jq -r '.is_draft' "$TICK_FILE")
PR_NUMBER=$(jq -r .pr_number "$STATE_FILE")
REPO_ARG=$(jq -r '.repo' "$STATE_FILE")
GH_FLAGS=(); [ -n "$REPO_ARG" ] && GH_FLAGS=(-R "$REPO_ARG")
CURRENT_HEAD=$(jq -r '.current_head' "$TICK_FILE")
BASE_BRANCH=$(jq -r '.base_branch' "$TICK_FILE")
BASE_HEAD=$(jq -r '.base_head' "$TICK_FILE")

if [ "$ALL_PASS" != "true" ]; then
  echo "Not all checks pass — ready gate not presented."
elif [ "$IS_DRAFT" != "true" ]; then
  echo "PR #${PR_NUMBER} is already marked ready for review. Nothing to gate on."
else
  echo ""
  echo "========================================"
  echo "  ALL CHECKS PASS — PR IS READY"
  echo "========================================"
  echo ""
  echo "PR #${PR_NUMBER}"
  echo "Head:  ${CURRENT_HEAD:0:8}"
  echo "Base:  ${BASE_BRANCH} (${BASE_HEAD:0:8})"
  echo ""
  echo "Checks:"
  jq -r '.checks[] | "  [\(.bucket)]\t\(.name)"' "$TICK_FILE" 2>/dev/null || true
  echo ""
  echo "To mark this PR ready for review, run:"
  echo ""
  echo "  gh pr ready ${PR_NUMBER} ${GH_FLAGS[*]}"
  echo ""
  echo "ci-babysit will NOT run this command. You must run it manually."
  echo ""
  echo "NOTE: If new commits or failures arrive before you flip, the next tick reopens"
  echo "the work and re-presents this gate. Readiness is not latched."
fi
