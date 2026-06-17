---
title: "run-id collision guard — dagrunner self-change plan"
related: "none (STATUS.md robustness hardening)"
created: 2026-06-17
status: approved
---

# run-id collision guard

## Context (read first)
The run-id is built in `src/run-engine.ts` (~L116–119):

```ts
const slug = basename(planPath, ".md").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
const runId = `${slug}-${Date.now()}`;
```

`runId` then seeds three things: the run directory (`runs/<runId>/`), the worktree path
(`worktrees/<runId>/`), and the git branch `feature/<runId>`. Two starts of the **same plan
in the same millisecond** produce an identical `runId` — the second clobbers the first's
run-dir/state and collides on the worktree + branch. Realistic trigger: scripted or retried
kickoffs of the same plan.

## Root cause / rationale
`Date.now()` is already millisecond-resolution, so this is NOT a precision problem — adding
more digits wouldn't fix it. The real gap: the id **assumes** timestamp uniqueness and
nothing asserts the run-dir is fresh before writing into it. Same failure class as the
formatter-hook fix — an assumed property (timestamps never repeat) that doesn't hold under
retries/scripts.

## The change (directional)

| File / module / function | Type | Change (directional) | Why |
|---|---|---|---|
| `src/run-engine.ts` (runId construction, ~L116–119) | MODIFY | After computing `runId`, guarantee uniqueness: append a short branch-safe random suffix, and assert the target run-dir does not already exist (fail loud if it does) | close the same-ms collision window without a silent overwrite |

**Things to get right**
- `Date.now()` is already ms — the fix is uniqueness/collision handling, not resolution.
- `runId` flows into `feature/<runId>` — any suffix must be git-branch-safe (lowercase
  alphanumeric; no spaces/slashes/dots). base36 or hex is fine.
- **Design fork (log the choice to DECISIONS.md):**
  - (a) random suffix only → never collides, but id is no longer purely deterministic from
    slug+time;
  - (b) `existsSync(runDir)` assert + fail-loud only → honours "fail loud, no silent
    fallback", but blocks same-ms retries that are actually legitimate;
  - (c) both — suffix for uniqueness + the assert as a defensive backstop.
  - Recommended: **(c)**. The fail-loud golden rule favours keeping the assert; the suffix
    makes legitimate same-ms retries just work.
- Leave the slug derivation and the human-readable `<slug>-<timestamp>` scheme intact — only
  add a uniqueness tail.

## Validation (prove it — evidence, not assertion)
- **Deterministic (mock executor / unit):** pin the clock (mock `Date.now()` to a constant)
  and construct the run-id twice for the same plan → assert two **distinct** run-ids and two
  distinct run-dir paths. This is the crisp proof.
- **Integration:** kick off the same plan twice back-to-back via the launcher → capture
  `ls ~/.local/share/dagrunner/runs/` showing two distinct run-dirs, and confirm two distinct
  `feature/*` branches created with no "worktree already exists" / clobber error.
- If cheap, capture the **before** behaviour (same-ms → collision) to show the effect, not
  just the after-fix pass.

## Done criteria (delta-specific)
- run-id construction guarantees uniqueness for same-slug, same-ms starts; chosen posture
  logged in `DECISIONS.md`.
- Suffix (if used) is git-branch-safe and `feature/<runId>` creation still succeeds.
- Deterministic test proving two distinct ids under a pinned clock.
- Integration evidence: two distinct run-dirs + branches from back-to-back same-plan kickoffs.

## Out of scope
- Changing slug derivation or the readable `<slug>-<timestamp>` scheme (only add a tail).
- Concurrency/locking redesign — `acquireLock` stays as-is; this is id uniqueness, not run
  mutual-exclusion.
- Retro-fixing existing run-dirs.
