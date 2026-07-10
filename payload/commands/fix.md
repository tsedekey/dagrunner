You are running the **fix node** of a dagrunner pipeline. Your job is to apply targeted code fixes for high-confidence review findings, self-verify the result, and write a summary artifact.

---

## Step 1 — Read findings

Read the review artifact:

```
$DAGRUN_ARTIFACTS/../review/findings.json
```

Filter to the **actionable findings**: those with `confidence: "high"` AND `severity` of `"blocker"` or `"major"`.

If there are no actionable findings (the list is empty after filtering), write a summary at `$DAGRUN_ARTIFACTS/summary.md` stating "No high-confidence blocker/major findings to fix." and exit. The gate will still pause for human review.

---

## Step 2 — Apply fixes

> **⚠️ This session is one-shot and non-resumable — nothing will ever re-invoke it.** Run the
> `./mvnw`/`npm` commands in this step and in Step 3b **in the foreground** — do not set
> `run_in_background: true` on them to "save time" by doing other work (e.g. formatting) while they
> run; there is no benefit, since you cannot usefully act on partial results, and it only invites
> the failure below. If a command ends up backgrounded anyway — deliberately or because the harness
> auto-converts a long-running Bash call — and a result says something like "running in
> background... you will be notified when it completes," do NOT trust that and do NOT end your turn
> expecting to be woken up later: there is no external process that will ever resume this session.
> `ScheduleWakeup` is disallowed for this exact reason and calling it will fail. Instead, poll the
> backgrounded task synchronously, inside this same turn, using a bounded blocking `TaskOutput`
> call (or `Monitor`) — issuing several sequential poll calls in a row is normal and does NOT end
> the turn — until the task reaches a terminal status. Ending the turn while a task is still
> running leaves `summary.md` unwritten, stranding this node at `awaiting-gate` with no artifacts.

> **⚠️ Maven flag footgun — read before running any Maven command below.** `-Dquickly` silently
> skips ALL tests — even when combined with `-DskipUTs` or `-Dit.test=...` — unless you also pass
> `-DskipTests=false`. The tell-tale symptom is a clean exit with "Tests are skipped." and no
> Failsafe report file (or a report file with a stale timestamp from an earlier run) — that is a
> false-green, not a real pass. If you see it, the tests did not run; do not report the fix as
> verified. Stick to the exact commands prescribed below (`-q` for quiet output) rather than
> substituting an "optimized" variant like `-Dquickly` to save time — if a build genuinely needs to
> be faster, check `AGENTS.md`'s module-scoped-build snippet in the repo (`$DEVHARNESS_SRC`) for the
> exact required flag combination before your first test run, not after a false-green result.

For each actionable finding in order:

1. Read the cited file at the cited line to understand the context.
2. Apply the minimal correct fix — only the code needed to address the finding. Do not refactor beyond the scope of the issue.
3. After each fix, verify the file still compiles / parses (run `npx tsc --noEmit` for TypeScript files in the `ts/` directory; run `cd java && ./mvnw compile -q` for Java files if a `java/pom.xml` is present).
4. If the fix added a new test file, run it immediately to confirm it passes before moving to the next finding:
   - New `*Test.java`: `cd java && ./mvnw test -pl <module> -Dtest=<ClassName> -q`
   - New `*IT.java`: these are Testcontainers-backed. Before your _first_ `*IT.java` execution attempt
     this session (once per session, not per finding), check Docker reachability:
     `docker info > /dev/null 2>&1; echo "docker_reachable=$?"`. If `docker_reachable` is `0`:
     `cd java && ./mvnw verify -pl <module> -Dit.test=<ClassName> -q`, same as always. If it is not
     `0`: do NOT run `./mvnw verify`/`-Dit.test=...` — only compile it
     (`cd java && ./mvnw test-compile -pl <module> -q`) and note in `summary.md` that this IT
     compiled but execution was blocked because Docker is unreachable in this environment. That is
     an honest, known limitation — report it as "compiled, execution blocked (Docker unavailable)",
     never as "verified" or a fix failure.

---

## Step 3 — Self-verification

### Step 3.0 — Read this node's own round history (before doing anything else)

`$DAGRUN_ARTIFACTS` survives across gate revise-self iterations (only `dagrun rerun` wipes it —
this session resumes with the same artifacts dir every round). Check for a prior history:

```bash
cat "$DAGRUN_ARTIFACTS/fix-history.log" 2>/dev/null
```

If it exists, this tells you which round you're on (one line per prior round) and how many
**consecutive trailing `FAIL`** rounds immediately precede this one (a `PASS` anywhere breaks the
streak — only count consecutive `FAIL` lines counting backward from the most recent line). Keep
this number in mind for Step 3b below — if it is currently 2, THIS round's build/test result, if it
also fails, is the 3rd consecutive failure and triggers the escalation in Step 4.

After all fixes are applied, run this checklist:

**a) Addressed-each-finding check:**
For each actionable finding you targeted, confirm:

- The cited (file, line) has been changed
- The specific issue described in `claim` is resolved

Record the result in the "Findings addressed" table in `summary.md` (Step 4) — do not write a separate file.

**b) Build/test post-condition:**
Run the project's tests to confirm nothing is broken:

- If a `ts/package.json` is present: `npm --prefix ts test`
- If a `java/pom.xml` is present: check whether any `*IT.java` files were added or modified in this run.
  - If yes: reuse this session's Docker reachability check from Step 2 item 4 if already run;
    otherwise run it now (`docker info > /dev/null 2>&1; echo "docker_reachable=$?"`). If
    reachable: `cd java && ./mvnw verify -q` (runs both Surefire unit tests and Failsafe ITs), same
    as always. If not reachable: run `cd java && ./mvnw test -q` (Surefire only) plus
    `./mvnw test-compile -q` to confirm the IT(s) still compile, and record in `summary.md`'s
    Build/test result that IT execution was skipped — Docker unreachable in this environment
    (compiled, not executed; this is a known limitation, not a fix failure).
  - If no: `cd java && ./mvnw test -q` (Surefire only; this pattern is allow-listed)
- If a root `package.json` is present with a `test` script: `npm test`
- For any other project type: run the standard test command from the README

If tests fail, attempt one fix per failing test. If tests still fail after the fix attempt, note it in the summary — do NOT silently skip.

### Step 3c — Record this round's outcome (always, every round)

Append exactly one line to `$DAGRUN_ARTIFACTS/fix-history.log` (create the file if it doesn't
exist yet) recording this round's build/test result from Step 3b:

```
round <N>: build/test <PASS|FAIL> — <one-line reason>
```

`<N>` is one more than however many lines are already in the file (round 1 if the file didn't
exist). `<one-line reason>` should be specific enough to be useful later — e.g. "3 assertion
failures in DiscountServiceTest" or "checkstyle violation in NewHandler.java" — not just "tests
failed." `fix-history.log` is scratch state for this node's own cross-round bookkeeping; it is not
declared in `produces` and is not meant to reach the worktree or the PR.

**A `PASS` this round resets the consecutive-fail streak to 0**, even if the human later rejects
this round for an unrelated reason (style, scope, etc.) — the streak measures build/test
convergence, not human satisfaction with the result.

---

## Step 4 — Write summary

Write `$DAGRUN_ARTIFACTS/summary.md`:

```markdown
# Fix summary

## Changes made

- <file>: <what was changed and why>
- ...

## Findings addressed

| Dimension   | Severity | File               | Claim | Status |
| ----------- | -------- | ------------------ | ----- | ------ |
| correctness | major    | ts/src/discount.ts | ...   | FIXED  |

## Findings deferred (low confidence or nit)

| Dimension | Severity | File | Claim | Reason deferred |
| --------- | -------- | ---- | ----- | --------------- |

## Build/test result

<PASSED / FAILED — include the test output tail if FAILED>
```

### Step 4b — Escalation: 3 consecutive failed rounds (mandatory when triggered)

**Check the trigger condition using Step 3.0's count plus this round's own Step 3b/3c result:** if
this round's build/test check FAILED and it is the **3rd consecutive** `FAIL` (i.e. Step 3.0 found 2
consecutive trailing `FAIL`s already in `fix-history.log`, and this round makes 3), do NOT just note
it in the "Build/test result" line as usual. Instead, append a prominent section to `summary.md`:

```markdown
## ⚠️ Architecture in question

This finding/test has now failed 3 consecutive fix rounds: <name the specific finding(s)/test(s)>.

### What was tried each round

- Round 1: <pull from fix-history.log line 1 + feedback-1.md if present — what was attempted, why it failed>
- Round 2: <pull from fix-history.log line 2 + feedback-2.md if present>
- Round 3 (this round): <what was attempted this round, why it still failed>

### Recommendation

Three consecutive fix attempts on the same finding, each producing a different (or the same)
failure, is a signal that the underlying approach may be wrong — not that a 4th attempt is more
likely to succeed than the first three were. **Consider rejecting this round** with an instruction
to reconsider the underlying approach rather than requesting another fix attempt — e.g. send the
run back to `/define` (feature) or `/reproduce` (bugfix) for a revised guide, rather than continuing
to iterate on `fix`.
```

This is a mandatory section when the trigger condition is met — do not talk yourself out of writing
it because "the next attempt will probably work" (see the red-flag table below). This is a
same-`summary.md`-file addition, not a new gate: `run-engine.ts`'s gate-context builder already
embeds the full `summary.md` content verbatim into `gate-context.md` for the human review dialogue
(`gate-review.md`'s existing "present the full artifact content, do not truncate" instruction), so
this section surfaces to the human automatically — no other action is required of you here.

---

## Step 5 — Write reflections.md

Write `$DAGRUN_ARTIFACTS/reflections.md`. This file is **required** whenever fixes were applied.

If there is nothing non-obvious to report, write a single line: `No non-obvious discoveries.`

Otherwise document any of the following:

- Hidden coupling that forced you to touch files beyond the directly cited location.
- A deferred finding that looks systemic (the same root cause likely exists in other places
  in this module — worth flagging to future runs).
- A build or test quirk that surprised you (flaky test, undocumented compile dependency,
  classpath issue).
- A root-cause pattern behind multiple findings (e.g. "three blockers trace back to the same
  missing transaction boundary in the service layer").
- Any automatic reformatting (e.g. a formatter hook changed additional files beyond your edits).

Do not recap the summary — that is already in summary.md.
The SessionEnd hook captures reflections.md automatically — you do not need to call any CLI command.

## Red flags — talk yourself out of these, don't act on them

| Red flag phrase (in your own reasoning)                              | What to do instead                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| "While I'm in this file, I'll also clean up X"                       | Scope is the cited finding, nothing more. Defer or flag X separately — do not fold it into this fix.                                             |
| "This other test failure is probably flaky, unrelated to my change"  | Rerun it before dismissing it. "Probably flaky" without a rerun is a guess, not a finding.                                                       |
| "The next fix attempt will probably work, I'll skip the escalation"  | If this is the 3rd consecutive `FAIL` (Step 3.0), write the "Architecture in question" section — it is mandatory, not optional, at that trigger. |
| "This finding is basically the same as one I already fixed nearby"   | Verify against the cited (file, line) and `claim` text — do not assume adjacency means the same root cause.                                      |
| "I'll widen the fix to cover a case the finding didn't mention"      | That is scope creep. Fix exactly what the finding describes; note anything broader as a deferred finding.                                        |
| "Tests pass locally in my head, I don't need to actually rerun them" | Rerun the actual command (Step 3b) every round — a round without a real rerun cannot honestly log PASS in `fix-history.log`.                     |

---

## Constraints

- Fix ONLY findings with `confidence: "high"` AND `severity` of `"blocker"` or `"major"`. Defer everything else.
- Do not make speculative improvements beyond what the findings require.
- Do not modify `$DAGRUN_ARTIFACTS/../review/findings.json` — it is the read-only input.
- Write all artifacts to `$DAGRUN_ARTIFACTS/` (summary.md, reflections.md, fix-history.log).
- If a build or test step is unavailable (no build tool found), note it in the summary and continue.
