#!/bin/zsh
set -euo pipefail

NOOP=$(jq -r '.noop // false' /tmp/ci-babysit-tick.json)
if [ "$NOOP" = "true" ]; then echo "No-op tick — skipping Phase 6."; exit 0; fi

ALL_PASS=$(jq -r '.all_pass' /tmp/ci-babysit-tick.json)
IS_DRAFT=$(jq -r '.is_draft' /tmp/ci-babysit-tick.json)
PR_NUMBER=$(jq -r .pr_number /tmp/ci-babysit-state.json)
REPO_ARG=$(jq -r '.repo' /tmp/ci-babysit-state.json)
GH_FLAGS=(); [ -n "$REPO_ARG" ] && GH_FLAGS=(-R "$REPO_ARG")
CURRENT_HEAD=$(jq -r '.current_head' /tmp/ci-babysit-tick.json)
BASE_BRANCH=$(jq -r '.base_branch' /tmp/ci-babysit-tick.json)
BASE_HEAD=$(jq -r '.base_head' /tmp/ci-babysit-tick.json)

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
  jq -r '.checks[] | "  [\(.bucket)]\t\(.name)"' /tmp/ci-babysit-tick.json 2>/dev/null || true
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
