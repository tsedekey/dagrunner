# dagrunner — Phase 2a Change Order (post-fixture-run modifications)

Context: Phase 2a (preflight + permission model, review node, fix node) is BUILT and passed a local fixture run. The changes below were decided AFTER that build. This is a focused change order against the working Phase 2a code — not a rebuild. The canonical spec is `dagrunner-master-architecture.md` (already updated); this prompt is the actionable delta so you don't have to diff the handoff yourself.

All five changes share one theme: **strip everything predictive out of the front of the pipeline; decide each thing where the information actually exists.**

---

## Change 1 — Remove the `classify` node entirely

- Delete `classify` as a DAG node and its `classify.json` artifact contract.
- Nothing upstream consumed it except the review node, and predicting change-area from the plan (before code exists) is strictly worse than reading it from the diff.
- The pipeline now starts at `expand-guide`:
  `expand-guide (Gate 1) -> implement -> review -> fix (Gate 2) -> verify-election -> verify-seed (Gate 3, conditional) -> pr -> reflect -> apply-reflection`
- Keep the classify logic dormant/removed cleanly — it RETURNS in Phase 5/6 as a task-TYPE router (feature/bug/tech-debt) that branches the graph upfront. Do not delete it in a way that's hard to revive, but it must not run in the pipeline now.

## Change 2 — Relocate reviewer selection into the review node as a "diff-triage" first step

- The review node gains a cheap **haiku diff-triage** first step: read the implement diff, set three booleans — `touches_public_api`, `touches_runtime`, `touches_schema_or_proto` — then spawn the matching reviewer subagents.
- Reviewer selection rules (unchanged logic, new input = diff not plan):
  - correctness: always
  - test-adequacy: always
  - api-stability: when `touches_public_api`
  - distributed-systems: when `touches_runtime`
  - migration-safety: when `touches_schema_or_proto`
  - performance: when the diff-triage judges the change performance-sensitive
- This is an internal step of the review node, NOT a DAG node and NOT a cross-node artifact.

## Change 3 — Adversarial verifier: trigger by runtime finding-count threshold

- The verifier is no longer gated by any classify/upstream flag.
- Inside the review node, after the fan-out and synthesize, run the adversarial verifier **only when the combined findings count exceeds a tunable threshold N** (default N = 3; make it a single named constant/config).
- Its job is unchanged: a second-order discriminator that reads the reviewers' findings (in isolated context), grounds each against the actual diff, and drops/downgrades ungrounded ones. It is not a seventh reviewer.

## Change 4 — Remove `needs_runtime`; verify becomes a human election

- Remove any `needs_runtime` predicate.
- After the **fix gate** is approved, add a lightweight **verify-election** decision: prompt the human "run runtime verification? [y/n]".
  - `n` -> mark `verify-seed` as `skipped`, proceed to `pr`.
  - `y` -> run `verify-seed`, then present the existing manual-test gate (Gate 3).
- Reuse the existing conditional-node `when` machinery; the predicate input is the human's y/n answer captured at this micro-gate, not a flag. Maintain the single-awaiting-gate invariant (election and manual-test gate are sequential).

## Change 5 — Remove `recommend_pr_review` and the `risk` field

- Remove `recommend_pr_review` / `pr_review_rationale` entirely. The `/pr-review` decision is the human's, made by reading `dagrun status` (reviewer breadth already signals complexity); dagrunner does not advise on it.
- Remove the `risk` field — confirmed it feeds nothing now.

---

## Findings schema after these changes

The review node's `findings.json` no longer carries any classify-driven fields. It should be:

```
{
  run_id, timestamp,                         // passed in, not generated
  triage: { touches_public_api, touches_runtime, touches_schema_or_proto, performance_sensitive },
  reviewers_run: [string],
  reviewers_skipped: [{ name, reason }],
  adversarial_verifier_run: bool,            // true only if findings count > N
  findings: [
    { reviewer_dimension, severity, confidence, file, line, claim, grounded }
  ]
}
```

(`triage` replaces the former external classify contract; it is produced inside the review node.)

## Acceptance (re-run the fixture)

Re-run the Phase 2a validation fixture and show:

1. No `classify` node runs; the pipeline starts at expand-guide.
2. The review node's diff-triage selects the correct reviewer subset from the diff (the fixture's public-API change triggers api-stability).
3. The adversarial verifier runs only when findings > N (the 3 planted flaws is a good boundary to test both sides of the threshold — tune N or the fixture so you can demonstrate both "ran" and "skipped").
4. After fix-gate approval, the verify-election prompt appears; `n` skips to pr, `y` runs verify-seed + manual-test gate.
5. `findings.json` matches the schema above (no `risk`, no classify fields).
6. `npm run verify-baseline` exits 0.

## Out of scope

No verify-seed cluster work beyond what exists, no pr/reflect build (Phase 2b), no siblings (Phase 3). This change order only restructures the front of the pipeline and the review node's internals.
