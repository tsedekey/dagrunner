---
name: testing-protocol
description: How to prove dagrunner v1 works — the mock node executor, the three test tiers, smoke:mock (fast in-process gate, runs on every plan), and smoke:live (real-SDK 8-step integration, run occasionally). Tests plumbing determinism, never model output quality.
---

# Testing protocol — dagrunner v1

The golden rule applied to the build: **show evidence, don't assert success.** Acceptance is a
runnable script + captured transcript, never a prose "I verified it works."

## The three tiers (what is deterministic vs needs human eyes)

| Tier                                      | Covers                                                                                                                                         | How                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1 — deterministic unit (no Claude)        | DAG topo/readiness, when-skip, join + optional-degradation, model/dependsOn/cycle validation, state.json I/O, reconcile-on-resume              | Pure TS via the **mock executor**; `node --test`; seconds; offline |
| 2 — integration (real SDK, trivial nodes) | env-propagation, SessionStart sync, PostToolUse format, artifact passing, structured-output capture, checkpoint-and-exit + resume-same-session | Thin slice on a throwaway toy repo + one-line plan                 |
| 3 — human acceptance                      | gate UX, conversation-led revise quality, the manual verify step                                                                               | Human drives `dagrun resume`                                       |

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

## smoke:mock — the per-plan gate (fast, free, deterministic)

`npm run smoke:mock` (`test/smoke/smoke-mock.ts`) drives the **full gated pipeline in-process** using
the mock executor. Zero API calls. Runs in ~150 ms. Deterministic by construction.

Two runs in one script:

- **Run A (election=n):** init → expand gate-pause → reject+feedback → approve Gate 1 → implement →
  review → fix gate-pause → approve Gate 2 + election=n → verify skipped → pr → reflect gate-pause
  → approve Gate 4 → apply-reflection → done.
- **Run B (election=y):** same but election=y: verify gate-pause → approve Gate 3 → pr → reflect
  gate-pause → approve Gate 4 → done.

What it asserts: gate pauses, produces-contract met at every gate node, artifact channel (each
produces file exists after its node), state transitions (awaiting-gate, paused, done), routing
(verify skipped when election=n, runs when election=y), verifyElection in state.json.

What it does NOT assert: model output quality (mock writes canned text), exact session IDs, JSON
validity of findings.json (mock writes plain text there).

**`verify-baseline` uses `smoke:mock`.** Run it on every plan change. It is the standing per-plan gate.

## smoke:live — the real-SDK integration test (occasional)

`npm run smoke:live` (`test/smoke/smoke.ts`) drives the full 8-step pipeline with real Claude Code
sessions. Requires `ANTHROPIC_API_KEY` or claude.ai subscription. ~35 min, real tokens,
non-deterministic on model output.

What it proves beyond smoke:mock: real API auth, real SDK session-resume, node prompts elicit valid
structured output, format hook fires, worktree diff exists.

**When to run smoke:live:**

- When a plan touches `payload/commands/*.md` (node prompts changed) — run before merging.
- Once at the end of a build queue to confirm end-to-end behaviour.
- On any change to `src/runtime/sdk-runner.ts` or the seeded settings.

**The tradeoff:** a bad node-prompt edit that passes the mock but breaks real-model behaviour would
slip past the per-plan gate until the next `smoke:live`. The mitigation is the guideline above —
prompt changes trigger a live run.

## The 8-step smoke:live test (Block 9, now called smoke:live)

A runnable script driving the real thin slice end to end with non-interactive flags, asserting each
step, capturing a transcript.

1. `dagrun init` → XDG home tree created (assert dirs exist).
2. `dagrun start feature --plan toy-plan.md` → `expand` runs (Gate 1), checkpoints, process exits.
3. `dagrun status` shows `expand: awaiting-gate`, a cost figure.
4. `dagrun resume --reject "..."` → expand revises in the same session, feedback-1.md written,
   re-pauses.
5. `dagrun resume --approve` → Gate 1 approved → implement → review (findings.json, valid JSON with
   required keys) → fix hits Gate 2, re-pauses.
6. `dagrun resume --approve --verify n` → Gate 2 approved, election=n, verify skipped, pr done,
   reflect hits Gate 4, re-pauses.
7. `dagrun resume --approve` → Gate 4 approved → apply-reflection → done.
8. Synthetic reconcile test (no API call): inject a state with `interruptRetries: 99`, resume →
   retry cap hit → run stays failed, exit 1.

Passing all eight = v1 real-SDK integration confirmed.

## What is explicitly NOT tested in v1

- Model output QUALITY (is the guide good?) — human judgment, not a CI assertion. Do not try.
- Load / concurrency (one-run-at-a-time).
- A live 6-way reviewer fan-out — those nodes are phase-2 config; validate the join logic with tier-1
  mock tests instead.

## Unit-test conventions (established by backfill 2a — follow for all future Tier A tests)

**Where tests live:** co-located `*.test.ts` alongside the module they cover (`src/core/lock.ts` →
`src/core/lock.test.ts`). The `npm test` glob `./src/**/*.test.ts` picks them up automatically.

**How to run:**

- All: `npm test` (via `node --test --import tsx ./src/**/*.test.ts`)
- One file: `node --test --import tsx src/core/lock.test.ts`

**Framework:** Node.js built-ins only — `node:test` + `node:assert/strict`. No Jest, Vitest, or
test-framework deps.

**FS fixtures:** `mkdtempSync(join(tmpdir(), 'dr-<prefix>-'))` for throwaway dirs. Never touch
`~/.local/share/dagrunner` or any real dagrunner home.

**In-module fixtures:** for validation tests, use the `FIXTURE_*` constants exported from the module
under test (e.g. `workflow.ts` exports `FIXTURE_VALID`, `FIXTURE_CYCLE`, etc.). Do not invent
parallel fixture objects in the test file.

**`process.exit()` behavior:** test via `spawnSync` (child process), not `assert.throws`. Write a
tiny inline script to a temp dir that calls the function, run it with
`spawnSync('node', ['--import', 'tsx', scriptPath])`, and assert exit code + stderr content.

**Determinism rule:** no real network, no SDK calls, no `Date.now()` assertions. Inject/mock the
clock where time appears; test ISO-string shape not exact values.

**Characterization, not correction:** these tests lock current behavior. If a test surfaces a bug,
log it in `DECISIONS.md` and file a separate change — do NOT silently fix production behavior inside
a test-backfill plan.

**Teeth check:** for any guard (validation throw, cycle detection, schema rejection), temporarily
remove the guard, run the relevant test, confirm it goes red, then restore. A test that cannot fail
is not a test. Capture the red output in the build report.

**Tier boundary:** Tier A = pure/FS-only modules (state, lock, workflow, settings-seed, dag). Do NOT
unit-test `run-engine`, `sdk-runner`, or `launcher` in Tier A — smoke owns them (Tier C).

## Reuse

Mirror crev's ajv-style schema-validation test pattern for `classify.json` and synthesized findings
(see the crev-patterns skill). Do not invent a validation harness — hand-roll or reuse the loader's
validator.
