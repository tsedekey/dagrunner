#!/usr/bin/env bash
# session-end.sh — SessionEnd hook: capture sessionId + cost_usd into friction.jsonl.
#
# CONTRACT (Claude Code SessionEnd hook):
#   - Receives a JSON event on stdin.
#   - exit 0 in all cases (this hook is observability-only, not a blocker).
#
# Required env vars (must be set by launcher BEFORE spawning SDK query()):
#   DAGRUN_RUN_DIR     — absolute path to the run directory (runs/<run-id>/)
#   DAGRUN_NODE_ID     — the current node id
#
# Behaviour:
#   Reads the hook event JSON from stdin, extracts session_id and cost_usd
#   (falling back to total_cost_usd, then 0), and appends one structured
#   entry to $DAGRUN_RUN_DIR/friction.jsonl.
#
#   Entry shape:
#     {"ts":"<ISO8601>","node":"<DAGRUN_NODE_ID>","sessionId":"<session_id>",
#      "event":"session-end","costUsd":<number>}
#
# Failure policy (from architecture-spec Theme 8):
#   - DAGRUN_RUN_DIR or DAGRUN_NODE_ID not set → silent no-op (exit 0).
#   - JSON parser absent → silent no-op (this is observability; do not break the node).
#   - Write failure → silent no-op.
#   - NEVER echo secrets or raw auth tokens; only session_id and numeric cost are written.

set -uo pipefail

# --- silent no-op guards ------------------------------------------------------

if [[ -z "${DAGRUN_RUN_DIR:-}" ]] || [[ -z "${DAGRUN_NODE_ID:-}" ]]; then
  exit 0
fi

# --- read stdin hook event ----------------------------------------------------

EVENT="$(cat 2>/dev/null || true)"

if [[ -z "${EVENT}" ]]; then
  exit 0
fi

# --- JSON extraction (jq → python3 fallback; no-op if neither present) --------

extract_field() {  # $1 = jq path  →  echoes value or empty string
  local path="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "${EVENT}" | jq -r "${path} // empty" 2>/dev/null || true
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "${EVENT}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    keys = '${path}'.lstrip('.').split('.')
    v = d
    for k in keys:
        if isinstance(v, dict):
            v = v.get(k)
        else:
            v = None
            break
    if v is not None:
        print(v)
except Exception:
    pass
" 2>/dev/null || true
  fi
  # If neither parser is available, return empty (observability-only, no-op).
}

SESSION_ID="$(extract_field '.session_id')"
COST_USD="$(extract_field '.cost_usd')"

# Fallback to total_cost_usd if cost_usd absent.
if [[ -z "${COST_USD}" ]]; then
  COST_USD="$(extract_field '.total_cost_usd')"
fi

# Default to 0 if still empty.
if [[ -z "${COST_USD}" ]]; then
  COST_USD="0"
fi

# Default session_id to empty string if absent (still useful to record the event).
if [[ -z "${SESSION_ID}" ]]; then
  SESSION_ID=""
fi

# --- build friction entry -----------------------------------------------------

TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")"
NODE_ID="${DAGRUN_NODE_ID}"

# Construct JSON safely using jq if available; otherwise manual template.
if command -v jq >/dev/null 2>&1; then
  ENTRY=$(jq -cn \
    --arg ts       "${TS}" \
    --arg node     "${NODE_ID}" \
    --arg sid      "${SESSION_ID}" \
    --argjson cost "${COST_USD}" \
    '{"ts":$ts,"node":$node,"sessionId":$sid,"event":"session-end","costUsd":$cost}' \
    2>/dev/null) || ENTRY=""
fi

# Fallback: manual template if jq not available or jq argjson failed
# (e.g. COST_USD is not a valid JSON number).
if [[ -z "${ENTRY}" ]]; then
  # Ensure COST_USD is a valid number; strip any non-numeric content.
  SAFE_COST=$(printf '%s' "${COST_USD}" | grep -Eo '^-?[0-9]+(\.[0-9]+)?' || echo "0")
  [[ -z "${SAFE_COST}" ]] && SAFE_COST="0"
  # Escape node and sessionId for embedding in JSON string.
  SAFE_NODE="${NODE_ID//\"/\\\"}"
  SAFE_SID="${SESSION_ID//\"/\\\"}"
  ENTRY="{\"ts\":\"${TS}\",\"node\":\"${SAFE_NODE}\",\"sessionId\":\"${SAFE_SID}\",\"event\":\"session-end\",\"costUsd\":${SAFE_COST}}"
fi

if [[ -z "${ENTRY}" ]]; then
  exit 0
fi

# --- append to friction.jsonl -------------------------------------------------

mkdir -p "${DAGRUN_RUN_DIR}" 2>/dev/null || true
printf '%s\n' "${ENTRY}" >> "${DAGRUN_RUN_DIR}/friction.jsonl" 2>/dev/null || true

exit 0
