#!/usr/bin/env bash
# stop-verifier.sh — Stop hook: run the per-node convergence verifier script.
#
# CONTRACT (Claude Code Stop hook):
#   - Receives a JSON event on stdin (not used here; we act on env vars).
#   - exit 0                              => allow the stop.
#   - {"decision":"block","reason":"..."} => force another turn (keep running).
#
# Required env var (optional — if unset, this hook is a no-op):
#   DAGRUN_VERIFIER_SCRIPT — absolute path to an executable verifier script.
#
# Failure policy (from architecture-spec Theme 8):
#   - DAGRUN_VERIFIER_SCRIPT not set       → no-op, exit 0.
#   - Verifier script not executable       → block (broken verifier ≠ success).
#   - Verifier exits non-zero              → block (not converged yet).
#   - Verifier script crashes / not found  → block (broken verifier ≠ success).
#
# A broken verifier MUST block — it must never look like success.

set -uo pipefail

# --- no-op when verifier is not configured ------------------------------------

if [[ -z "${DAGRUN_VERIFIER_SCRIPT:-}" ]]; then
  exit 0
fi

# --- helpers ------------------------------------------------------------------

block() {
  local reason
  reason=$(printf '%s' "$1" | tr '\n' ' ')
  # Use jq if available to produce safe JSON; fall back to manual escaping.
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg r "${reason}" '{"decision":"block","reason":$r}'
  else
    printf '{"decision":"block","reason":"%s"}\n' "${reason//\"/\\\"}"
  fi
  exit 0
}

# --- validate verifier script is executable -----------------------------------

if [[ ! -f "${DAGRUN_VERIFIER_SCRIPT}" ]]; then
  block "stop-verifier: verifier script '${DAGRUN_VERIFIER_SCRIPT}' not found"
fi

if [[ ! -x "${DAGRUN_VERIFIER_SCRIPT}" ]]; then
  block "stop-verifier: verifier script '${DAGRUN_VERIFIER_SCRIPT}' is not executable"
fi

# --- run the verifier ---------------------------------------------------------
# Capture stdout+stderr. A non-zero exit (clean failure) → block with the output.
# An actual script crash (e.g. bash syntax error producing a non-zero but erratic exit)
# is indistinguishable from a clean non-zero at this level — both correctly block.

VERIFIER_OUTPUT=""
VERIFIER_EXIT=0
VERIFIER_OUTPUT=$("${DAGRUN_VERIFIER_SCRIPT}" 2>&1) || VERIFIER_EXIT=$?

if [[ "${VERIFIER_EXIT}" -ne 0 ]]; then
  # Truncate output to first 5 lines to keep the reason field readable.
  TRUNCATED=$(printf '%s' "${VERIFIER_OUTPUT}" | head -5)
  block "stop-verifier: verifier exited ${VERIFIER_EXIT}: ${TRUNCATED}"
fi

# Verifier passed — allow the stop.
exit 0
