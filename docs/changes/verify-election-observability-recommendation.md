---
title: "Verify-election observability recommendation — dagrunner self-change plan"
related: "feature; sequence AFTER unit-test-backfill-2b (extends its FINDINGS_SCHEMA contract test)"
created: 2026-06-18
status: approved
---

# Verify-election observability recommendation

## Context (read first)

After Gate 2 (fix) is approved, `run-engine.ts` runs the **verify-election** (locate by
`state.verifyElection === undefined` — the block will have shifted after the retry-cap change). Today
it's a **bare prompt** with no guidance: _"Run verify (produces seeding spec + manual-test guide)?
[y/n]"_ (or the `--verify y|n` flag). The human guesses whether a manual test is worthwhile.

Good news from grounding: `FINDINGS_SCHEMA` already carries a `triage` block including
**`touches_public_api`** — review already judges API surface. We add the UI half + a synthesized
recommendation, and surface it at the election. **Advisory only** — the human still elects.

## Rationale

A manual test is only worth performing when the change is **observable** — through a UI or an API.
review already inspects the full diff (diff-triage), so "what surface did this touch" is a cheap
extension of an existing judgment. The recommendation informs the election; it never decides it.
Producing it in review keeps "the model judges, code coordinates": review judges, `run-engine`
surfaces, the human elects.

## The change (directional)

| File / module                                                      | Type   | Change (directional)                                                                                                                                                                                                              | Why                                                                                  |
| ------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/workflow/feature-workflow.ts` — `FINDINGS_SCHEMA`             | MODIFY | add `touches_ui: boolean` to `triage` (+ required); add top-level `manual_test_recommendation: { recommended: boolean, surface: "ui"\|"api"\|"none", rationale: string }` (+ required)                                            | the recommendation lives **in findings.json** — review stays a one-artifact contract |
| `payload/commands/review.md`                                       | MODIFY | Step 1 diff-triage: also judge `touches_ui`; Step 4: populate `manual_test_recommendation` (recommended = `touches_public_api \|\| touches_ui`; `surface`; a one-line rationale)                                                  | review produces the judgment                                                         |
| `src/runtime/run-engine.ts` — verify-election block                | MODIFY | read the review node's `findings.json`; surface `manual_test_recommendation` as advisory text **before** the `[y/n]` prompt; print it on the `--verify` flag path too (so it's always recorded); do NOT change the default answer | guidance at the decision point, on both paths                                        |
| `src/runtime/run-engine.ts` (or near it)                           | ADD    | a pure `formatVerifyRecommendation(findings)` helper                                                                                                                                                                              | testable seam (TDD-friendly) for the prompt text                                     |
| `src/workflow/feature-workflow.test.ts` (schema-contract, from 2b) | MODIFY | extend to cover `touches_ui` + `manual_test_recommendation`                                                                                                                                                                       | keep the schema test honest                                                          |
| new/extended test                                                  | ADD    | `formatVerifyRecommendation` unit tests: api / ui / none → expected advisory text + recommended flag                                                                                                                              | deterministic coverage                                                               |

**Things to get right**

- **Respect "review = one findings.json contract"** — the observability data is **fields in
  findings.json**, NOT a new artifact. (Locked decision.)
- **Reuse `touches_public_api`** — don't re-implement API detection; add `touches_ui` for symmetry.
- **Advisory, not deciding** — surface the recommendation before the prompt; the default answer and the
  human's free choice are unchanged.
- **Both paths** — show/record the recommendation on the interactive prompt _and_ the `--verify` flag
  path, so it appears in the run report even on headless/queue elections.
- **Fail-soft on a missing advisory** — if `findings.json` is absent or lacks the field (e.g. a path
  where review didn't run), degrade to today's bare prompt; do NOT fail loud. This is the rare
  justified exception to fail-loud: the recommendation is advisory, not load-bearing.
- **Locate the election block by `state.verifyElection === undefined`**, not a line number — it moved
  when the retry-cap change landed in the same file.

## Validation (prove it — evidence, not assertion)

- `formatVerifyRecommendation` unit tests green for api / ui / none; teeth check (change a branch →
  test goes red).
- Schema-contract test covers the new fields (break one → fails).
- Live/smoke: a run where review sets `touches_public_api` shows "Recommendation: yes — …" at the
  election; an internal-only change shows "Recommendation: no — …". Advisory text appears; the prompt
  still accepts the human's y/n freely.
- Missing-`findings.json` path degrades to the bare prompt without crashing.
- `npm run verify-baseline` exits 0.

## Done criteria (delta-specific)

- `FINDINGS_SCHEMA` carries `touches_ui` + `manual_test_recommendation`; review populates them.
- The verify-election surfaces the recommendation (both prompt and `--verify` paths) as advisory; the
  election remains the human's, default unchanged.
- `formatVerifyRecommendation` extracted + unit-tested; schema-contract test extended.
- Fail-soft on missing advisory verified.
- Master doc / `architecture-spec` reconciled (verify-election now carries an observability
  recommendation; review's triage gains `touches_ui`); `DECISIONS.md` logs the field-not-artifact choice.

## Out of scope

- Auto-electing or changing the default based on the recommendation (advisory only, by decision).
- Observability via non-UI/API surfaces (logs, metrics) — the model may mention them in the rationale,
  but the recommended flag keys on UI/API per the scope.
- Any change to what the `verify` node produces (`seeding-spec.json` / `manual-test.md` unchanged).
