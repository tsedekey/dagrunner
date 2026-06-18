---
title: "Worktree hygiene: structural scratch backstop — dagrunner self-change plan"
created: 2026-06-18
status: ready
related: "deterministic — TDD applies; smoke:mock suffices (no node-prompt change)"
---

# Worktree hygiene — structural scratch backstop

## Context (read first)
Observed: scratch/artifacts leaking into the **Camunda worktree** (a stray "verify-guide" folder),
which risks being committed into a real PR. Grounding shows the leaks themselves are **already fixed**
incrementally: node prompts now write to absolute `$DAGRUN_ARTIFACTS` (fix.md / expand.md / pr.md
confirmed), siblings use `/tmp` + a resolved `$ARTIFACTS_DIR`, the format hook is narrowed to frontend
files, and the "verify-guide" leak was the pre-rename `verify-guide` node. So this is **not
remediation**.

The remaining gap: **hygiene is convention-only.** It holds only because every prompt currently
*remembers* the discipline. Nodes run with `cwd = worktreePath` (`sdk-runner.ts:114`), so a single
forgotten relative write lands in the worktree — and nothing structurally stops a future prompt from
regressing into a PR. This plan makes hygiene **structural**.

## Rationale
Turn "everyone remembers" into "the harness enforces." A leaked scratch file in a real Camunda PR is a
concrete embarrassment/risk; a cheap deterministic guard removes that whole class regardless of which
prompt slips.

## The change (directional)

| File / module | Type | Change (directional) | Why |
|---|---|---|---|
| `src/runtime/run-engine.ts` (worktree creation, ~L181) | MODIFY | right after `git worktree add`, seed the worktree's `.git/info/exclude` with known artifact/scratch patterns | **restriction (primary):** scratch can't be staged/committed/PR'd, silently and deterministically |
| `src/runtime/run-engine.ts` (pre-`pr` dispatch) + a pure scan fn | CREATE | before `pr` runs, scan the worktree `git status --porcelain` for leaked **artifact filenames** + scratch patterns; emit an **advisory warning** (stdout + run report) listing offenders | **visibility (secondary):** surfaces that a prompt is leaking so it gets fixed, instead of silently excluding forever |
| pure `findWorktreeScratch(statusLines, patterns)` | CREATE | given a porcelain listing + patterns → suspicious entries | TDD-able seam |
| docs: `testing-protocol` skill / master doc | MODIFY | document the backstop | anti-drift |

**Things to get right**
- **TDD** — `findWorktreeScratch` is a pure function → failing test first (leaked `guide.md` → flagged;
  clean worktree → empty; `*.tmp` / node-named dir → flagged); teeth-check.
- **High-precision signal:** the artifact filenames (`guide.md`, `notes.md`, `findings.json`,
  `summary.md`, `body.md`, `pr-meta.json`, …) belong in `$DAGRUN_ARTIFACTS`; their appearance *in the
  worktree* is the leak. **Source this list from the nodes' `produces`** (single source of truth), not
  a hardcoded copy, so it can't drift. Generic scratch patterns (`*.tmp`, `*-state.json`) are secondary.
- **The scan is ADVISORY, fail-soft** — warn, never block `pr`. Legit source changes can't be perfectly
  distinguished from scratch, so a false positive must not halt shipping. (The `.git/info/exclude` seed
  is the actual prevention; the scan is for awareness.)
- **Exclude affects only leaked copies** — artifact names are dagrunner-internal, not Camunda source, so
  excluding them in the worktree won't mask any legitimate change. Flag: confirm no real Camunda file
  legitimately shares those names.
- **Pipeline-level, not a Claude Code hook** — there's no "pre-pr" session hook event; run-engine owns
  the timing (it knows the worktree path and that `pr` is next).
- **No node-prompt change → `smoke:mock` suffices** (deterministic); `smoke:live` not required.

## Validation (prove it — evidence, not assertion)
- `findWorktreeScratch` unit tests green (leaked artifact flagged; clean → empty; scratch pattern
  flagged); teeth-check (break a branch → red).
- `smoke:mock` scenario where a node leaks an artifact into the worktree → it appears in
  `.git/info/exclude` (not staged) **and** the pre-`pr` scan warns; the run continues (advisory).
- `verify-baseline` (`smoke:mock`) green.

## Done criteria (delta-specific)
- Worktree `.git/info/exclude` seeded with artifact/scratch patterns at creation.
- Pre-`pr` advisory scan emits warnings for leaked artifacts/scratch; never blocks `pr`.
- Pure scan fn unit-tested; artifact list sourced from `produces`.
- `testing-protocol` / master doc reconciled.

## Out of scope
- Hard-blocking on suspicious files (advisory only, by decision).
- Sibling-side discipline — `ci-babysit` / `pr-triage` already use `/tmp` + `$ARTIFACTS_DIR`; a
  Camunda-side change only if a leak is ever observed there.
