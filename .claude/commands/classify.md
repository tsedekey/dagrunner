Read the feature plan at $DAGRUN_ARTIFACTS/../plan/plan.md and classify it.

Output a JSON object (no prose) with these exact fields:

- touches_public_api: boolean — does the feature add/change a public API endpoint?
- touches_runtime: boolean — does it change runtime/async behavior?
- perf_sensitive: boolean — could it affect performance?
- touches_schema_or_proto: boolean — does it add/change a DB schema or proto?
- needs_runtime: boolean — does it need a live cluster to verify?
- risk: "low" | "med" | "high" — overall risk level

Respond with ONLY the JSON object, nothing else.
