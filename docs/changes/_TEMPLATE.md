---
title: "{change title} — dagrunner self-change plan"
related: "{issue / PR / discussion link, or 'none'}"
created: {date}
status: approved
---

# {change title}

<!-- This plan is the VARIABLE half. The standing rules — golden rules, build harness,
     autonomy protocol, anti-drift reconcile, verify-baseline, master-doc/DECISIONS upkeep —
     all live in /dr-build. Do NOT restate them here. This plan carries only the delta for
     THIS change, written so a fresh session understands it with no access to our chat. -->

## Context (read first)
<!-- What exists now, what's wrong or missing, and why it matters. Cite the master-doc
     section / file / prior evidence that motivates the change. -->

## Root cause / rationale
<!-- Fix: the actual mechanism of the defect. Improvement: why this approach, what it
     unlocks. Be specific — assumed mechanisms are how silent no-ops get shipped. -->

## The change (directional)
<!-- The approach and the "what + why", not line-by-line code. -->

| File / module / function | Type | Change (directional) | Why |
|---|---|---|---|
| `{path}::{fn}` | MODIFY / CREATE | {high-level change} | {rationale} |

**Things to get right**
<!-- Edge cases, fields to confirm against the SDK/Claude Code schema, fail-soft vs
     fail-loud posture, anything easy to get subtly wrong. -->
-

## Validation (prove it — evidence, not assertion)
<!-- The specific evidence THIS change must produce, beyond the standing verify-baseline.
     The procedure to run + exactly what to capture (transcript / before-after diff /
     produced artifact). What does it look like when it genuinely works, not just runs? -->
-

## Done criteria (delta-specific)
<!-- Only what's specific to this change. /dr-build already requires verify-baseline green
     + master-doc & DECISIONS reconciled in the same commit — don't repeat those. -->
-

## Out of scope
<!-- Explicitly excluded, to stop scope creep. -->
-
