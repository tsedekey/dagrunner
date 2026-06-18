---
title: "Unit-test backfill 2a — Tier A core + test conventions — dagrunner self-change plan"
related: "core hardening, step 2a of: restructure (done) -> tests -> TDD"
created: 2026-06-17
status: approved
---

# Unit-test backfill 2a — Tier A core + test conventions

## Context (read first)

Post-restructure, `src/` is in 5 cohesion folders. Only `core/dag.ts` has unit tests (16). This
backfills the highest-risk **deterministic core** (Tier A of the agreed tiering) and establishes the
unit-test conventions the rest of the backfill + future TDD will follow. These are **characterization
tests of existing behaviour** — not TDD (TDD becomes a standing rule in a later change). Reuse the
existing harness: `node --test` via `tsx`, co-located `*.test.ts` (the `npm test` glob already nests),
the mock-executor pattern where a double is needed.

## Root cause / rationale

Lock the core before feature-accretion. Tier A modules are pure / FS-only -> cheap, deterministic
coverage — and they're the ones where a silent regression is catastrophic: resume, run
mutual-exclusion, load-time validation, seeded settings.

## The change (directional)

New co-located test files (cover the real exported units):

| Test file                          | Cover                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/state.test.ts`           | `readState`/`writeState` round-trip; malformed JSON -> fail-loud (not a silent default); missing-file behaviour                                                                                                                                                                                                |
| `src/core/lock.test.ts`            | `acquireLock` creates a lock; acquiring a held lock fails (mutual exclusion); `releaseLock` clears; `readLock` returns info / null; stale-lock handling                                                                                                                                                        |
| `src/workflow/workflow.test.ts`    | `loadWorkflow(FIXTURE_VALID)` passes; `FIXTURE_BAD_MODEL` / `_BAD_DEPENDS` / `_DUPLICATE_ID` / `_CYCLE` each **throw at load** (the "typo is a load error" guarantee); `validateClassifyOutput` accepts valid / rejects invalid. **Use the fixtures the module already exports — don't invent parallel ones.** |
| `src/config/settings-seed.test.ts` | `buildSeededSettings`: owned keys (permissions / sandbox / hooks) come from dagrunner; passthrough (mcpServers etc.) from DEVHARNESS_SRC; merge precedence is correct. `readSourcePassthrough` + `readWorkProfileMcpServers` via fixture files                                                                 |
| `src/core/dag.test.ts`             | extend only if a gap surfaces (already 16 tests)                                                                                                                                                                                                                                                               |

Plus: **capture the test conventions** (a short `TESTING.md`, or a section in the `testing-protocol`
skill): where tests live (co-located `*.test.ts`), how to run (`npm test`), the fixture pattern
(throwaway `mkdtempSync` dirs for FS; in-module fixtures for validation), and the determinism rule
(no network, no real SDK, runs in seconds).

**Things to get right**

- **Characterization, not correction.** Capture what the code _does_. If a test reveals a bug, log it
  in `DECISIONS.md` and flag it for a _separate_ change — do NOT alter production behaviour inside a
  test-backfill plan, and don't write a test that asserts buggy behaviour as if correct.
- Use `workflow.ts`'s already-exported `FIXTURE_*` — single source of fixtures.
- FS tests use throwaway temp dirs (`mkdtempSync`), never the real `~/.local/share/dagrunner`.
- Determinism: inject/mock the clock where time appears; no real network or SDK in Tier 1.
- **Stay in Tier A.** Do NOT unit-test `run-engine` orchestration / `sdk-runner` / `launcher` here —
  those are Tier C (smoke owns them).

## Validation (prove it — evidence, not assertion)

- `npm test` runs the new files green; `npm run verify-baseline` exits 0.
- **Teeth check:** each validation test must fail loudly if its rule is broken — e.g. temporarily
  comment out the cycle check and confirm the `FIXTURE_CYCLE` test goes red. A test that can't fail
  isn't a test.
- The 4 Tier-A modules have meaningful co-located unit tests; `dag` still green.

## Done criteria (delta-specific)

- `state`, `lock`, `workflow`, `settings-seed` have co-located unit test files, green under `npm test`.
- Test conventions captured (short doc or skill section) for plan 2b + future TDD to follow.
- `verify-baseline` green; `testing-protocol` skill / master doc reconciled if conventions changed.
- Any bug a test surfaces is logged in `DECISIONS.md`, not silently patched.

## Out of scope

- Tier B, golden, schema-contract — plan **2b**.
- `run-engine` / `sdk-runner` / `launcher` units — smoke owns them.
- Making the suite TDD — that's the later standing-rule change.
- Fixing bugs the tests reveal (log them; separate change).
