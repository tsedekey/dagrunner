#!/usr/bin/env bash
# session-end.sh — SessionEnd hook: capture reflections.md into reflection-log.jsonl.
#
# CONTRACT (Claude Code SessionEnd hook):
#   - Receives a JSON event on stdin (payload: session_id, transcript_path,
#     cwd, hook_event_name, reason — no cost fields are included).
#   - exit 0 in all cases (this hook is observability-only, not a blocker).
#
# Required env vars (must be set by launcher BEFORE spawning SDK query()):
#   DAGRUN_NODE_ID     — the current node id
#   DAGRUN_ARTIFACTS   — absolute path to <runDir>/<nodeId>/ (per-node artifact dir)
#   DAGRUN_STORE_DIR   — absolute path to the durable store dir (<homeDir>/store/)
#
# Behaviour:
#   If $DAGRUN_ARTIFACTS/reflections.md is non-empty, appends one stamped
#   entry to $DAGRUN_STORE_DIR/reflection-log.jsonl.
#   Entry shape: {"ts":"<ISO8601>","source":"<DAGRUN_NODE_ID>","run_id":"<DAGRUN_RUN_ID>","body":"<content>"}
#   (run_id omitted if DAGRUN_RUN_ID is unset)
#
# Note: friction.jsonl (cost tracking) is written by sdk-runner.ts using the
# SDK result's total_cost_usd — the SessionEnd hook payload carries no cost
# fields (confirmed: only session_id, transcript_path, cwd, hook_event_name,
# reason are sent by Claude Code).
#
# Failure policy:
#   - DAGRUN_NODE_ID not set → silent no-op (exit 0).
#   - JSON parser absent → silent no-op.
#   - Write failure → silent no-op.

set -uo pipefail

# --- silent no-op guards ------------------------------------------------------

if [[ -z "${DAGRUN_NODE_ID:-}" ]]; then
  exit 0
fi

TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")"
NODE_ID="${DAGRUN_NODE_ID}"

# --- reflection capture: $DAGRUN_ARTIFACTS/reflections.md → store log ----------
# Reads the per-node reflections.md (written by the node if it has tips) and
# appends one JSONL entry to $DAGRUN_STORE_DIR/reflection-log.jsonl.
# Fail-soft throughout — a missed append never blocks a node.

if [[ -n "${DAGRUN_STORE_DIR:-}" ]] && [[ -n "${DAGRUN_ARTIFACTS:-}" ]]; then
  REFLECTIONS_FILE="${DAGRUN_ARTIFACTS}/reflections.md"
  if [[ -s "${REFLECTIONS_FILE}" ]]; then
    RUN_ID_VAL="${DAGRUN_RUN_ID:-}"
    REFLECTION_ENTRY=""

    if command -v jq >/dev/null 2>&1; then
      # jq -Rs . reads the file as a raw string and produces a JSON string
      # (newlines/quotes escaped) — safe for multi-line markdown.
      BODY_JSON=$(jq -Rs . < "${REFLECTIONS_FILE}" 2>/dev/null) || BODY_JSON=""
      if [[ -n "${BODY_JSON}" ]] && [[ "${BODY_JSON}" != '""' ]]; then
        REFLECTION_ENTRY=$(jq -cn \
          --arg    ts     "${TS}" \
          --arg    source "${NODE_ID}" \
          --argjson body  "${BODY_JSON}" \
          --arg    run_id "${RUN_ID_VAL}" \
          'if $run_id != "" then {ts:$ts,source:$source,run_id:$run_id,body:$body} else {ts:$ts,source:$source,body:$body} end' \
          2>/dev/null) || REFLECTION_ENTRY=""
      fi
    elif command -v python3 >/dev/null 2>&1; then
      # python3 fallback: pass values as argv to avoid quoting issues
      REFLECTION_ENTRY=$(python3 - "${TS}" "${NODE_ID}" "${RUN_ID_VAL}" "${REFLECTIONS_FILE}" <<'PYEOF' 2>/dev/null
import sys, json
ts, source, run_id, path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    with open(path, 'r') as f:
        body = f.read()
    if not body.strip():
        sys.exit(0)
    entry = {'ts': ts, 'source': source, 'body': body}
    if run_id:
        entry['run_id'] = run_id
    print(json.dumps(entry))
except Exception:
    pass
PYEOF
      ) || REFLECTION_ENTRY=""
    fi

    if [[ -n "${REFLECTION_ENTRY}" ]]; then
      mkdir -p "${DAGRUN_STORE_DIR}" 2>/dev/null || true
      printf '%s\n' "${REFLECTION_ENTRY}" >> "${DAGRUN_STORE_DIR}/reflection-log.jsonl" 2>/dev/null || true
    fi
  fi
fi

exit 0
