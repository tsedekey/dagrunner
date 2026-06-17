Read the feature plan at $DAGRUN_ARTIFACTS/../plan/plan.md and classify it.

Output a JSON object (no prose) with these exact fields:

- touches_public_api: boolean — does the feature add/change a public API endpoint or public method signature?
- touches_runtime: boolean — does it change runtime/async/distributed behavior?
- perf_sensitive: boolean — could it affect latency, throughput, or memory?
- touches_schema_or_proto: boolean — does it add/change a DB schema, proto definition, or migration?
- needs_runtime: boolean — does it need a live cluster or external service to verify?
- risk: "low" | "med" | "high" — overall risk level for this change

Respond with ONLY the JSON object, nothing else.
