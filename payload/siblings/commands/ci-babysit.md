---
description: Babysit CI on the open draft PR — one incremental tick: poll checks, rebase, fix failures, surface ready gate
argument-hint: (no args needed — PR, run-id, and repo auto-detected from current branch and git remote)
---

# /ci-babysit — CI Babysit Tick

**Input**: $ARGUMENTS

One incremental tick of CI babysitting on the open draft PR. Polls checks and base-branch state,
acts only on what is NEW since the last tick, and exits. State persists to disk so each tick is
independent. Run repeatedly to babysit continuously:

```
/loop 60s /ci-babysit
```

**WORKTREE LIFETIME CONSTRAINT:** `dagrun cleanup` MUST NOT run while this command is active and
the PR is open. Both the worktree and the feat branch must persist for the full PR lifetime.
ci-babysit fails loud on the next tick if either is gone.

**Field names verified from `gh` v2.93.0 `--help` on this machine. JSON response shapes for live
PRs are NOT confirmed end-to-end — no real PR was open at spike time. If a field comes back wrong,
inspect the raw output and adjust:**

- `gh pr checks` fields: `bucket` (pass|fail|pending|skipping|cancel), `completedAt`, `link`,
  `name`, `state`, `workflow`
- `gh pr view` fields: `headRefOid` (head SHA), `baseRefName`, `isDraft`, `state`
- Check→run-id: extract the numeric run ID from the `link` field
  (`https://github.com/<owner>/<repo>/actions/runs/<run-id>/...`)

**Scripts:** bash logic lives in `.claude/scripts/ci-babysit/`. The MD calls them; edit the
scripts for logic changes.

---

## Phase 0 — Bootstrap

Parse `$ARGUMENTS`. Validate that this is a dagrunner worktree on a feat branch. Discover the
open PR. Fail loud if the worktree or branch is missing, or if no open PR is found.

```bash
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/scripts/ci-babysit"
zsh "$SCRIPT_DIR/phase-0-bootstrap.sh" "$ARGUMENTS"
```

**PHASE_0_CHECKPOINT:**

- [ ] Running on a `feat/<slug>` branch inside a worktree
- [ ] PR number discovered (non-empty)
- [ ] `/tmp/ci-babysit-state.json` written

---

## Phase 1 — Fetch current PR state and compute transitions

Load `since-state.json`. Fetch current PR head SHA, base branch state, and check conclusions.
Compute what has changed since the last tick.

```bash
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/scripts/ci-babysit"
zsh "$SCRIPT_DIR/phase-1-fetch-state.sh"
```

**PHASE_1_CHECKPOINT:**

- [ ] Current PR head SHA fetched
- [ ] Base branch state fetched
- [ ] Check conclusions fetched (or empty with warning)
- [ ] Transitions computed
- [ ] `/tmp/ci-babysit-tick.json` written

---

## Phase 2 — No-op gate

If head SHA is unchanged AND check conclusions are identical to the prior tick, there is nothing
to act on. Writes `noop=true` into tick.json so phases 3–5 self-skip; Phase 6 still runs to
write the tick log.

```bash
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/scripts/ci-babysit"
zsh "$SCRIPT_DIR/phase-2-noop-gate.sh"
```

**PHASE_2_CHECKPOINT:**

- [ ] If no-op: `noop=true` written into tick.json; phases 3–5 self-skip; Phase 6 writes tick log
- [ ] If transitions detected: `noop=false`; continue to Phase 3

---

## Phase 3 — Rebase if base branch advanced

Rebase occurs FIRST, before any check fixing, so fixes apply against the current base. If git
rebase exits non-zero, STOP immediately and surface the conflict — do not guess at semantic
conflicts. Push with `--force-with-lease` after a clean rebase.

```bash
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/scripts/ci-babysit"
zsh "$SCRIPT_DIR/phase-3-rebase.sh"
```

**PHASE_3_CHECKPOINT:**

- [ ] If base not advanced: skipped cleanly
- [ ] If base advanced and rebase clean: pushed, tick state updated with new head
- [ ] If rebase conflict: STOPPED with conflict details, human must resolve

---

## Phase 4a — Collect failing check logs

Fetch the failure log for every check currently in `fail` bucket. Write logs to
`$ARTIFACTS_DIR/check-logs/` for Phase 4b diagnosis.

```bash
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/scripts/ci-babysit"
zsh "$SCRIPT_DIR/phase-4a-collect-logs.sh"
```

**PHASE_4a_CHECKPOINT:**

- [ ] Failure logs written to `$ARTIFACTS_DIR/check-logs/` (one per failing check)

---

## Phase 4b — Diagnose and fix failing checks

Read the failure logs collected above. For each failing check:

1. Determine the root cause from the log output. Common categories:
   - **Format/lint** (`spotless`, `prettier`, `eslint`, `checkstyle`): apply automatic formatting.
     For Java: `PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH" ./mvnw license:format spotless:apply -T1C`
     For TypeScript/frontend: `npm run format` or `npx prettier --write .` in the relevant package.
   - **Compilation or type error**: fix the specific type or import error. Scope changes to the
     failing file(s). Do NOT restructure or refactor beyond making the type check pass.
   - **Test failure**: read the test output carefully. Fix the code under test if the test
     correctly describes intended behavior. If the test expectation is stale (e.g., a snapshot
     test after an intentional change), update the snapshot — not silently, show the diff.
   - **Build failure** (Maven/npm): fix the specific build error.

2. **STOP if the fix implies a feature or design change.** If the failure reveals an
   unimplemented requirement, a broken API contract, or behavior that needs a design decision,
   surface it to the human with the exact log lines and stop. Do NOT silently rework the feature.

3. **Scope all fixes to making CI green.** Do not introduce refactors, renames, or cleanups
   beyond what the check requires.

4. Apply each fix in the worktree. After applying, stage and commit with a conventional-commit
   subject only — no body, no trailers:
   ```
   git add <specific files>
   git commit -m "fix: <brief reason>"
   ```
   Then continue to Phase 4c for local verification.

If there are no failing checks (e.g., checks are pending or all pass), skip to Phase 5.

---

## Phase 4c — Re-verify locally

After applying the fix, run the relevant local checks before pushing. Do NOT push without local verification.

- **Java module change**: `PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH" ./mvnw verify -pl <module> -DskipTests=false` for the affected module(s). To run a specific failing test class: add `-Dtest=<ClassName> -DskipITs`. Do NOT use `-Dquickly` — it skips spotless entirely.
- **Format-only fix**: re-run the formatter (`spotless:apply` or `prettier --write`) and confirm `git diff --stat` shows no further changes.
- **Frontend/TypeScript change**: `npm run typecheck && npm run lint` (or equivalent for the failing package).
- **Runtime behavior**: call the relevant REST endpoint or c8ctl command. If the local cluster is not running, state your result explicitly as "STATIC ONLY — runtime re-verification requires a running cluster."

If any check fails: diagnose and fix before proceeding to Phase 4d. Do not push a fix that fails locally.

**Important:** When running `spotless:apply`, run it across ALL modules that construct any type your PR changed — not just the modules you directly edited. A call site in a downstream module can exceed the line limit even though you never touched it.

---

## Phase 4d — Push fix

After local re-verification passes, push the fix. Then exit — do not wait for CI inside this
tick. The next tick will observe the updated check results.

```bash
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/scripts/ci-babysit"
zsh "$SCRIPT_DIR/phase-4d-push.sh"
```

**PHASE_4_CHECKPOINT:**

- [ ] Each failing check diagnosed (fix applied or STOPPED with reason)
- [ ] Local re-verification passed (or labeled static-only)
- [ ] Fix pushed with `--force-with-lease` (or skipped if HEAD unchanged)

---

## Phase 5 — Ready gate

Present the draft → ready summary when all checks pass. **NEVER call `gh pr ready` automatically.**

```bash
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/scripts/ci-babysit"
zsh "$SCRIPT_DIR/phase-5-ready-gate.sh"
```

**PHASE_5_CHECKPOINT:**

- [ ] If checks not all passing: ready gate not shown (correct)
- [ ] If all pass and draft: summary printed, `gh pr ready` command shown to human
- [ ] `gh pr ready` was NOT called automatically

---

## Phase 6 — Update since-state and write tick log

Advance the `since` marker only after all actions in this tick are complete. An interrupted tick
that did not reach Phase 6 will re-process the same transitions on the next wake (fail-safe).

```bash
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/scripts/ci-babysit"
zsh "$SCRIPT_DIR/phase-6-persist.sh"
```

---

## Scheduling

Run as a poll loop using `/loop`:

```
/loop 60s /ci-babysit
```

This re-invokes `/ci-babysit` every 60 seconds. Each invocation is one independent tick.
The `since-state.json` persists between ticks — an interrupted or killed tick re-processes cleanly.

To use with a specific PR or repo:

```
/loop 60s /ci-babysit --pr 1234 --repo camunda/camunda
```

## Re-run behavior

Each tick is independent and idempotent:

- **No-op tick** (nothing changed): only updates `last_tick_at`. No git, gh, or push actions.
- **Rebase tick**: fetch + rebase + push. Next tick re-observes new head.
- **Fix tick**: fix + local verify + push. Next tick observes CI result.
- **Ready gate**: prints command, waits for human. No state mutation.
- **since-state.json** is only advanced after all actions complete — an interrupted tick will
  re-process the same transitions on the next wake.

## Acceptance criteria

1. Two consecutive ticks with no PR changes → second tick exits as no-op with no git/gh actions.
2. After a new failing commit: next tick acts only on the new failure; prior-addressed checks at
   the same SHA are skipped.
3. On a real failing check: failure log fetched, scoped fix applied, locally re-verified (cluster
   or clearly-labeled static-only), pushed with `--force-with-lease`. Following tick observes new
   CI result.
4. On an advanced base branch: rebases cleanly and pushes; a conflict STOPS and surfaces to human.
5. When all checks pass: prints readiness summary and `gh pr ready` command; does NOT call it.
   Readiness is re-presented if new work arrives before the human flips.
6. `dagrun cleanup` is forbidden until PR closes; ci-babysit fails loud (exit 1) if it wakes and
   the worktree or `feat/<slug>` branch is missing.

---

## Learnings

If this tick encountered anything unexpected that is not already captured in prior reflections,
append one JSON line to `~/.local/share/dagrunner/store/reflection-log.jsonl`:

```json
{
  "ts": "<ISO-8601-UTC>",
  "source": "ci-babysit",
  "run_id": "<run_id>",
  "body": "## YYYY-MM-DD\n\n**Symptom:** ...\n**Root cause:** ...\n**Resolution:** ...\n**Watch for:** ..."
}
```

Only log if it adds knowledge that would prevent wasted time on a future run. Routine failures
(format check, test failure, rebase conflict) do not need an entry. Novel `gh` field mismatches,
tool-version surprises, or environment assumptions that proved wrong are the right candidates.
