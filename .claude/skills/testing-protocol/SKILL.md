---
name: testing-protocol
description: How to prove dagrunner v1 works — the mock node executor, the three test tiers, and the 6-step smoke test that defines v1-done. Load for Block 3 (mock executor + tier-1 tests) and Block 9 (smoke test). Tests plumbing determinism, never model output quality.
---

# Testing protocol — dagrunner v1

The golden rule applied to the build: **show evidence, don't assert success.** Acceptance is a
runnable script + captured transcript, never a prose "I verified it works."

## The three tiers (what is deterministic vs needs human eyes)

| Tier | Covers | How |
|---|---|---|
| 1 — deterministic unit (no Claude) | DAG topo/readiness, when-skip, join + optional-degradation, model/dependsOn/cycle validation, state.json I/O, reconcile-on-resume | Pure TS via the **mock executor**; `node --test`; seconds; offline |
| 2 — integration (real SDK, trivial nodes) | env-propagation, SessionStart sync, PostToolUse format, artifact passing, structured-output capture, checkpoint-and-exit + resume-same-session | Thin slice on a throwaway toy repo + one-line plan |
| 3 — human acceptance | gate UX, conversation-led revise quality, the manual verify step | Human drives `dagrun resume` |

## The mock node executor (first-class v1 artifact — Block 3)

A drop-in replacement for the real SDK node runner, selected via `--dry-run`/mock mode. Per node it
emits a **canned artifact** and a **chosen exit status** — never calls the SDK, never costs tokens.
It MUST be able to simulate every DAG behavior the engine must handle:
- node success (writes its declared `produces` files),
- a node FAILING its `produces` contract (declared file absent → engine marks failed),
- a reviewer failing while `optional:true` (→ degrade to skipped, synthesize proceeds),
- a gate rejecting (→ feedback artifact + revise path),
- a loop exhausting (→ onExhausted:gate),
- an infra/transient fault (→ retry-then-fail).
This is also the permanent fast local feedback loop — build it well, not as a throwaway.

## Tier-1 unit tests (Block 3, test-FIRST — before the engine)

Use Node's built-in `node:test` + `node:assert`. NO test framework dependency. Cover at minimum:
1. topological order + readiness computation (deps terminal, none failed),
2. `when` predicate skip + skip propagation downstream,
3. join rule `none-failed-min-one-success` and `optional` degradation,
4. load-time validation: bad model string, unknown dependsOn, duplicate id, cycle — each throws a
   specific, node-named error (assert the message),
5. state.json read/write round-trip,
6. reconcile-on-resume: a node left `running` becomes `failed`; stale lock released.
All green and offline. Capture the `node --test` output as evidence.

## The 6-step smoke test (Block 9 — this IS the v1-done gate)

A runnable script driving the real thin slice end to end with non-interactive flags, asserting each
step, capturing a transcript. Provide a tiny `toy-plan.md` and a throwaway toy git repo.

1. `dagrun init` → XDG home tree created (assert dirs exist).
2. `dagrun start feature --plan toy-plan.md` → `classify` runs (haiku, **valid JSON** — assert schema),
   `expand-guide` runs (unpinned), checkpoints at the **review gate**, process exits.
3. `dagrun status` shows `expand-guide: awaiting-gate`, a cost figure, the worktree path.
4. `dagrun resume --reject "add error handling section"` → node revises **in the same session**
   (assert sessionId unchanged, feedback-1.md written), re-pauses.
5. `dagrun resume --approve` → `implement` runs, a diff exists in the worktree, the format hook fired,
   run reaches `done`.
6. Kill the process mid-`implement`, then `dagrun resume` → reconcile marks the killed node
   `running→failed`, re-runs it cleanly to `done`.

Passing all six = v1 ships.

## What is explicitly NOT tested in v1
- Model output QUALITY (is the guide good?) — human judgment, not a CI assertion. Do not try.
- Load / concurrency (one-run-at-a-time).
- A live 6-way reviewer fan-out — those nodes are phase-2 config; validate the join logic with tier-1
  mock tests instead.

## Reuse
Mirror crev's ajv-style schema-validation test pattern for `classify.json` and synthesized findings
(see the crev-patterns skill). Do not invent a validation harness — hand-roll or reuse the loader's
validator.
