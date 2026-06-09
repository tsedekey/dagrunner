#!/usr/bin/env bash
# stop-schema.sh — Stop hook: validate classify.json structured output.
#
# CONTRACT (Claude Code Stop hook):
#   - Receives a JSON event on stdin (not used here; we act on env vars).
#   - exit 0                              => allow the stop.
#   - {"decision":"block","reason":"..."} => force another turn (keep running).
#
# Active only when DAGRUN_NODE_ID == "classify". For all other nodes this is a no-op.
#
# Required env vars (must be set by launcher BEFORE spawning SDK query()):
#   DAGRUN_NODE_ID     — the current node id (only acts on "classify")
#   DAGRUN_ARTIFACTS   — absolute path to the per-node artifacts directory
#
# Expected classify.json schema:
#   {
#     "touches_public_api":          <boolean>,
#     "touches_runtime":             <boolean>,
#     "perf_sensitive":              <boolean>,
#     "touches_schema_or_proto":     <boolean>,
#     "needs_runtime":               <boolean>,
#     "risk":                        "low" | "med" | "high"
#   }
#
# Failure policy (from architecture-spec Theme 8):
#   - DAGRUN_NODE_ID != "classify" → no-op (exit 0, no stdout).
#   - classify.json missing         → block.
#   - jq absent                     → block (parser-absent on a safety-relevant check = fail closed).
#   - classify.json unparseable     → block.
#   - any boolean field missing/wrong type → block.
#   - risk not in {low,med,high}    → block.
#   - All checks pass               → exit 0 (no stdout, allow the stop).

set -uo pipefail

# Consume stdin (hook event) so the process doesn't hang waiting for it.
read -r -d '' _HOOK_EVENT <&0 2>/dev/null || true

# --- no-op for non-classify nodes ---------------------------------------------

if [[ "${DAGRUN_NODE_ID:-}" != "classify" ]]; then
  exit 0
fi

# --- helpers ------------------------------------------------------------------

block() {
  local reason
  reason=$(printf '%s' "$1" | tr '\n' ' ')
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg r "${reason}" '{"decision":"block","reason":$r}'
  else
    printf '{"decision":"block","reason":"%s"}\n' "${reason//\"/\\\"}"
  fi
  exit 0
}

# --- require jq (fail closed for a safety-relevant parse) ---------------------

if ! command -v jq >/dev/null 2>&1; then
  block "stop-schema: jq is not installed — cannot validate classify.json (fail-closed)"
fi

# --- locate classify.json -----------------------------------------------------

CLASSIFY_JSON="${DAGRUN_ARTIFACTS:-}/classify.json"

if [[ -z "${DAGRUN_ARTIFACTS:-}" ]]; then
  block "stop-schema: DAGRUN_ARTIFACTS is not set — cannot locate classify.json"
fi

if [[ ! -f "${CLASSIFY_JSON}" ]]; then
  block "stop-schema: classify.json not found at '${CLASSIFY_JSON}'"
fi

# --- parse and validate -------------------------------------------------------

# Attempt to parse; any jq error means the file is malformed.
if ! CONTENT=$(jq '.' "${CLASSIFY_JSON}" 2>/dev/null); then
  block "stop-schema: classify.json is not valid JSON at '${CLASSIFY_JSON}'"
fi

# Validate the five boolean fields exist and are boolean-typed.
BOOL_FIELDS=(
  "touches_public_api"
  "touches_runtime"
  "perf_sensitive"
  "touches_schema_or_proto"
  "needs_runtime"
)

for field in "${BOOL_FIELDS[@]}"; do
  field_type=$(printf '%s' "${CONTENT}" | jq -r --arg f "${field}" 'type as $t | .[$f] | if . == null then "missing" elif type == "boolean" then "boolean" else type end' 2>/dev/null)
  if [[ "${field_type}" == "missing" ]]; then
    block "stop-schema: classify.json missing required boolean field '${field}'"
  fi
  if [[ "${field_type}" != "boolean" ]]; then
    block "stop-schema: classify.json field '${field}' must be boolean, got '${field_type}'"
  fi
done

# Validate risk is one of {low, med, high}.
RISK=$(printf '%s' "${CONTENT}" | jq -r '.risk // "missing"' 2>/dev/null)

if [[ "${RISK}" == "missing" ]] || [[ -z "${RISK}" ]]; then
  block "stop-schema: classify.json missing required field 'risk'"
fi

case "${RISK}" in
  low|med|high)
    ;;
  *)
    block "stop-schema: classify.json field 'risk' must be one of {low,med,high}, got '${RISK}'"
    ;;
esac

# --- all checks passed — allow the stop --------------------------------------

exit 0
