---
title: "Unit-test backfill 2b — Tier B + golden + schema-contract — dagrunner self-change plan"
related: "core hardening, step 2b (after 2a establishes conventions)"
created: 2026-06-17
status: approved
---

# Unit-test backfill 2b — Tier B + golden + schema-contract

## Context (read first)
Builds on **2a** (reuse its test conventions). Covers Tier B (the exported, testable pure helpers +
config), adds **golden/snapshot** tests for generated artifacts, and **schema-contract** tests for the
structured-output schemas. Same characterization discipline as 2a. Assumes 2a has landed.

## Root cause / rationale
Tier B is high value and cheap where the logic is exported. Golden tests lock generated output against
silent refactor drift (the point of hardening before tinkering). Schema-contract tests guard the
"wrote something, but malformed" failure class on a schema-driven system.

## The change (directional)

| Test file | Cover |
|---|---|
| `src/config/xdg.test.ts` | `computeHomePath` (default, `DAGRUNNER_HOME` override, `~` expansion); `resolveHome`; `resolveConfig` (valid / missing / explicit `DEVHARNESS_SRC` fail-loud); `initHome` creates the XDG layout |
| `src/cli/preflight.test.ts` | `getAgentContext` merges dagrunner payload + DEVHARNESS_SRC (fixture dirs); `formatAgentContext` output (golden); `runPreflight` predicates where fixture-able — partial, lean where it needs a real git repo |
| `src/cli/report.test.ts` (**golden**) | render the report HTML for a fixed `RunState` -> compare to a committed snapshot; locks output against silent drift |
| `src/config/settings-seed.test.ts` (**golden**, extend 2a) | `buildSeededSettings` JSON snapshot for a fixed input |
| `src/workflow/feature-workflow.test.ts` (**schema-contract**) | `CLASSIFY_SCHEMA` + `FINDINGS_SCHEMA` are well-formed JSON Schema; representative artifact fixtures validate against them; `featureWorkflow` passes `loadWorkflow` |

**Testability decisions (the real Tier-B forks — log the choice in `DECISIONS.md`)**
- **`cli` dispatch is not exported** (inline `main`). Either extract a pure `parseArgs`/`dispatch` for
  testability, or defer `cli` to smoke. **Lean: defer to smoke** for now — it's glue; only extract if a
  parse bug bites. Don't force a refactor inside a backfill.
- **run-id construction is inline** in `run-engine` (`slug` + `Date.now()`). To unit-test it (and to
  make the future collision-guard testable), extract a pure `makeRunId(planPath, now)`. Small, justified
  micro-extraction — do it if cheap, else defer and note it.

**Things to get right**
- **Golden tests:** snapshots are committed fixtures; the test compares output to the snapshot; updating
  a snapshot is a deliberate, reviewed act — never auto-overwrite. Make the failure diff legible.
- **Schema-contract:** validate the *schemas* are well-formed and that representative artifacts conform;
  do NOT test model-output quality.
- Same discipline as 2a: characterization (log bugs, don't silently fix), throwaway temp dirs,
  determinism (no network / real SDK).
- Respect the Tier C boundary — no `run-engine` / `sdk-runner` / `launcher` orchestration units.

## Validation (prove it — evidence, not assertion)
- `npm test` green incl. the new files; `npm run verify-baseline` exits 0.
- Golden snapshots committed; **teeth check** — change the rendered output by one char and the golden
  test goes red.
- Schema tests have teeth — break a schema (or feed a non-conforming fixture) and the test fails.
- Any testability extraction (`makeRunId`, or a `cli` parse fn) is behaviour-preserving — `verify-baseline`
  still green.

## Done criteria (delta-specific)
- Tier B modules (`xdg`, testable parts of `preflight`) have co-located unit tests, green.
- Golden tests for `report` HTML + `buildSeededSettings` JSON, snapshots committed.
- Schema-contract tests for `CLASSIFY_SCHEMA` / `FINDINGS_SCHEMA` + `featureWorkflow` validity.
- `cli` and run-id testability decisions made and logged in `DECISIONS.md`.
- `verify-baseline` green; docs/skill reconciled.

## Out of scope
- Tier C orchestration units (smoke owns them).
- The TDD standing-rule change (separate, next).
- Fixing bugs the tests reveal (log them; separate change).
