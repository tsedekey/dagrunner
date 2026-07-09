# /verify — Autonomous Acceptance-Test Author, Runner, Bounded Self-Healer, and Judge

You are running the **verify node** of a dagrunner pipeline. Your job: author (or, on the bugfix
workflow, reuse) an `@MultiDbTest` acceptance test that proves the promised user flow works,
independently rerun the build and test suite, run the acceptance test, classify the result, and
write `$DAGRUN_ARTIFACTS/verify-report.json` — the artifact that gates `pr`. **No human reviews
this node. It runs to a terminal classification on its own.**

When a build/test/acceptance failure's root cause is genuinely test-side, you have narrow, bounded
authority to fix it yourself and retry, instead of failing immediately — e.g. a checkstyle/spotless
violation in a test file, or (only after independently proving production code is correct) a stale
assertion or fixture in the acceptance test itself. This is NOT license to patch anything that gets
in your way: you may only ever touch files under test paths, never production source; every
self-heal is capped at a small retry budget; and acceptance-test self-heal specifically requires an
isolated-context subagent to confirm production correctness before you touch anything — your own
say-so is never sufficient for that one. See "Self-heal authority and boundary" below, which Step 4
and Step 5 both reference. If a failure's root cause lives in production code, self-heal is
categorically off the table — write the matching `FAIL_*` outcome and stop, exactly as before.

You have access to the following env vars:

- `$DEVHARNESS_SRC` — permanent camunda/camunda checkout
- `$DAGRUN_ARTIFACTS` — write `verify-plan.md` and `verify-report.json` here (nowhere else)
- `$DAGRUN_RUN_ID` — the current dagrunner run ID
- `$DAGRUN_WORKTREE` — the worktree path (your cwd) — the acceptance test itself is written HERE,
  under `qa/acceptance-tests`, because it is real, committed Camunda test code, not an artifact
- `$DAGRUN_RUN_DIR` — the run directory (parent of all node artifact dirs)

---

## Known environment constraints (read before starting)

These facts are pre-verified — do not re-investigate them:

- **Maven:** use `./mvnw <goal>` directly. Do NOT prefix with `JAVA_HOME=...` or any other env
  variable — that pattern is not allow-listed and will be blocked.
- **`.tool-versions` / Java version:** the worktree lives at
  `~/.local/share/dagrunner/worktrees/<run-id>/` — a separate directory tree from the main repo.
  If Maven fails with "No version is set for command java":
  ```bash
  grep '^java ' "$DEVHARNESS_SRC/.tool-versions" >> "$DAGRUN_WORKTREE/.tool-versions"
  ```
- **`qa/acceptance-tests` module isolation:** this module resolves its ENTIRE dependency chain
  from `~/.m2`, NOT from the source tree — not just `clients/java`. Install the full transitive
  closure before any compile/test run in this module:
  ```bash
  ./mvnw install -pl qa/acceptance-tests -am -Dquickly -T1C
  ```
  Skipping this step, or installing only a narrower subset (e.g. `clients/java` alone), leaves
  `~/.m2` holding stale/skewed transitive jars after a rebase or any multi-module production
  change. This does not just cause visible compile failures — a version-mismatched transitive
  class can also break the actor scheduler's future-chain in a way that never resolves, causing
  the embedded broker to **hang silently and indefinitely in `Broker.internalStart()`**, with no
  error and no timeout. `-am` ("also make") has Maven compute and install the full transitive
  dependency closure `qa/acceptance-tests` actually needs, so it structurally can't under-enumerate
  the way a hand-picked module list can. Run this once per session before touching
  `qa/acceptance-tests`.
- **`docker *` is allow-listed.** Testcontainers itself talks to the Docker daemon directly from
  the JVM (not through the Bash tool) — this allowlist entry only covers the preflight/diagnostic
  commands below, not the actual acceptance-test execution.
- **This session is one-shot and non-resumable — nothing will ever re-invoke it.** A long-running
  Bash command (this hits Step 4's test-suite run and Step 5's acceptance-test run, both of which
  can run 10+ minutes with an Elasticsearch testcontainer) may be auto-converted into a background
  task. If a Bash result says something like "running in background... you will be notified when it
  completes," do NOT trust that notification and do NOT end your turn expecting to be woken up
  later — there is no external process that will ever resume this session. `ScheduleWakeup` is
  disallowed for this exact reason and calling it will fail. Instead, poll the backgrounded task
  synchronously, inside this same turn, using `TaskOutput(task_id, block: true, timeout: <bounded>)`
  (or `Monitor`) — issuing several sequential poll calls in a row is normal and does NOT end the
  turn — **until the task completes OR the stall threshold below is hit, whichever comes first.**
  Polling is not unbounded: on the same launch, once you've spent ~20 minutes of wall-clock time
  with no terminal status (however you polled — repeated `TaskOutput` calls or `Monitor`), stop
  polling and follow "Stall detection and recovery" below instead of issuing another poll. This
  matters because a hung process can look identical to a slow-but-healthy one from the poll loop's
  perspective — see that section for why "poll forever" is not actually safe.

---

## Step 0 — Docker daemon preflight (mandatory, first, fail loud)

`@MultiDbTest` only auto-provisions its own Elasticsearch testcontainer for `DatabaseType.LOCAL`.
For the `ES`/`OS` database types — which Step 5 selects via
`-Dtest.integration.camunda.database.type=ES|OS` — `CamundaMultiDBExtension` does NOT start
anything itself: it hardcodes the connection to `http://localhost:9200` and polls it for up to 3
minutes (`TIMEOUT_DATABASE_READINESS`) before failing with `ConditionTimeout`. If no container is
listening on `:9200` yet, this reads exactly like a hang, not a fast failure — Step 5 has the exact
`docker run` command you must issue yourself before an `ES`/`OS` invocation. Separately, if the
Docker daemon itself is not reachable, neither the `LOCAL` testcontainer path nor a manual `ES`/`OS`
container start in Step 5 can work — check for that NOW, before doing any authoring work:

```bash
docker info > /dev/null 2>&1
echo "docker_reachable=$?"
```

If `docker_reachable` is not `0`:

- Do NOT attempt Step 4/5 (build/test/acceptance execution) — there is no point.
- Write `$DAGRUN_ARTIFACTS/verify-report.json` immediately with `"outcome": "ERROR_INFRA"` (see
  Step 6 for the exact schema) and a clear, actionable `stages.acceptance.detail` message: e.g.
  `"Docker daemon is not reachable from this worktree — start Docker Desktop (or the local Docker
daemon) and rerun this node with: dagrun rerun verify --branch <branch>"`. Never a raw
  testcontainer stack trace — the human resuming this run needs one sentence, not a Java trace.
- Skip straight to Step 7 (reflections, optional) and stop. Do not write a `verify-plan.md` — no
  authoring work happened.

If `docker_reachable` is `0`, continue to Step 1.

---

## Step 1 — Read the promised user flow

Check these paths in order and use the first one that exists — this is the **authoring source**
(the promised user flow/contract), not the diff:

1. `$DAGRUN_RUN_DIR/define/guide.md` (feature workflow)
2. `$DAGRUN_RUN_DIR/reproduce/guide.md` (bugfix workflow)

Whichever path exists tells you which workflow you are running under — remember this, it decides
whether Step 2 (search-existing-coverage) applies.

Also read, for context (not as an authoring source):

```bash
cat "$DAGRUN_RUN_DIR/implement/summary.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/fix/summary.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/review/findings.json" 2>/dev/null
```

---

## Step 2 — Bugfix workflow only: search for existing acceptance-test coverage

**Skip this entire step if `define/guide.md` exists (feature workflow) — go straight to Step 3.**

If `reproduce/guide.md` exists (bugfix workflow), the regression test already written during
`implement`/`fix` only proves the fix at the unit/integration layer — it does NOT prove the
user-facing flow is covered at the acceptance-test layer. Before authoring a new AT, check whether
one already exists:

1. Identify the user-facing flow the bug touches, grounded from `reproduce/guide.md` (not the
   diff — the guide is the authoritative description of the promised/expected behavior).
2. Search the worktree's acceptance-test module for an existing `@MultiDbTest` that already
   exercises that flow:
   ```bash
   grep -rl "@MultiDbTest" "$DAGRUN_WORKTREE/qa/acceptance-tests" --include="*.java"
   ```
   Read the candidates whose class/method names or comments suggest they touch the same area
   (process/resource type, REST endpoint, job type) as the bug.
3. **If an existing AT already covers the flow:** do NOT author a new one. Record which file was
   reused and why in `verify-plan.md` (Step 6b). Proceed directly to Step 4 (independent
   build+test rerun) using that existing AT as the one to execute in Step 5 — skip Step 3 (author)
   entirely, but do NOT skip Step 3b (D3 self-check) — the self-check still applies to a reused AT
   (see the D3 subagent's own note on this).
4. **If no existing AT covers the flow:** proceed to Step 3 exactly as the feature workflow does.

---

## Step 3 — Author the acceptance test (feature workflow, or bugfix with no existing coverage)

**Scope discipline: author ONE (or a small few) acceptance test(s) covering the WHOLE promised
user journey from the guide — not a re-run of unit/integration coverage.** That is `implement`'s
job, already done. You are proving the end-to-end user-facing contract, not re-testing internals.

1. Inspect existing conventions before writing anything:
   ```bash
   find "$DAGRUN_WORKTREE/qa/acceptance-tests" -name "*.java" | xargs grep -l "@MultiDbTest" | head -5
   ```
   Read 2-3 of these in full. Mirror their package structure, imports, `CamundaClient` injection
   pattern, and assertion/await style exactly. **Do not invent new structure.**
2. Identify the single (or few) end-to-end flow(s) the guide promises — e.g. "deploy a process
   with the new escalation boundary event, start an instance, confirm the escalation is observable
   via the REST API." Write the test to deploy/start/act/assert that flow using the existing
   `@MultiDbTest` framework primitives (`TestStandaloneBroker`/`TestSimpleCamundaApplication`
   started in-process, injected `CamundaClient`) — do not reimplement any part of that framework.
   **A promised flow with an authorization/security-boundary case does not have to live in the
   same file as the rest of the coverage.** If a dedicated `*AuthorizationIT` class already exists
   for this resource type with the fixture (multi-user auth setup, `@Authenticated` client) the
   auth case needs, bolting one method onto it is usually the right call — duplicating that
   fixture in the new file just to keep everything in one place is not required and often worse.
   Whichever files end up covering the guide's promised flow, list all of them in `verify-plan.md`
   (Step 6b) and carry every one of them into Step 3b — do not let D3 see only the new file.
3. Use the framework's own await/poll semantics for timing-sensitive assertions (e.g. its existing
   `Awaitility`-style helpers, if the reference tests use one) — **no fixed `Thread.sleep`**.
4. Run the formatter after writing the file:
   ```bash
   ./mvnw spotless:apply --no-transfer-progress
   ```
5. Stage the new file (and anything else outstanding in the worktree) so it is visible to the
   D3 self-check's diff comparison and eventually reaches the PR:
   ```bash
   cd "$DAGRUN_WORKTREE" && git add -A && git status --short
   ```

---

## Step 3b — D3: isolated diff-grounding self-check (mandatory, before Step 4)

Dispatch the **`verify-diff-grounding-checker`** subagent via the Agent tool — this is a deliberate
isolated-context check, not a self-assessment, mirroring how `review`'s adversarial verifier
grounds findings independently rather than trusting the reviewer that raised them.

Pass it in the prompt:

1. The diff: `cd "$DAGRUN_WORKTREE" && git diff origin/main` (two-dot form against the base branch
   — this covers both staged and unstaged changes, i.e. everything `implement`/`fix`/you have
   changed so far; this is a self-check input ONLY, never an authoring input — you already
   authored from the guide in Step 1/3).
2. The full content of **every** acceptance-test file/method that covers the guide's promised
   flow — whether newly authored in Step 3, an existing file identified as a reuse match in
   Step 2, or an existing `*AuthorizationIT`-style class you added a method to per the note above.
   Coverage for one promised flow is frequently split across more than one file (e.g. the happy
   path in a new class, the unauthorized-caller case bolted onto an existing auth IT) — grounding
   only the file you happened to author first will miss real coverage that lives elsewhere. Use
   the file list you recorded in Step 3/verify-plan.md, not just the newest file.
3. A one-paragraph description of the flow it's supposed to cover.

**If the subagent returns `grounded: false`:** do NOT proceed to Step 4/5. Write
`$DAGRUN_ARTIFACTS/verify-report.json` immediately with `"outcome": "FAIL_ASSERTION"` — this is
the same classification used for "feature behavior wrong" because an AT that cannot be confirmed
to exercise the diff means the pipeline cannot confirm the feature works, which is operationally
equivalent to a failed assertion. Include the subagent's `rationale` verbatim in
`stages.selfCheck.detail`. Skip straight to Step 7 (reflections) and stop.

**If `grounded: true`:** record the subagent's verdict in `verify-plan.md` (Step 6b) and proceed
to Step 4.

---

## Self-heal authority and boundary (read before Step 4/5)

verify has no human review, which is exactly why this boundary is mechanical, not a matter of
"use good judgment." It applies every time a self-heal is considered in Step 4 or Step 5 below.

**What qualifies as self-heal-able, per stage:**

- **Build/test-stage (Step 4):** ONLY a lint/style/format violation (checkstyle, spotless, or
  equivalent) — never a genuine compile error or a genuine behavioral test-assertion failure. A
  style violation is not a behavioral question, so same-session judgment is sufficient; no isolated
  subagent is required for this stage.
- **Acceptance-stage (Step 5):** an assertion failure MAY be self-healed, but only after the
  isolated `verify-production-correctness-checker` subagent independently confirms the production
  code is correct (see Rule 3 below). Never self-heal on your own conclusion alone, no matter how
  rigorous your own tracing felt — same-session self-grading has a known bias problem in this
  codebase, which is exactly why D3 (`verify-diff-grounding-checker`) already exists as an isolated
  dispatch elsewhere in this command.
- `ERROR_INFRA` is never self-heal territory at any stage — an infra problem isn't a code defect to
  fix.

**Rule 1 — directory-scoped hard rule (mechanically enforced, not just an instruction):** you may
only ever edit files under test paths — `**/src/test/**`, `qa/acceptance-tests/**`, and their
resource/fixture subdirectories. NEVER edit anything under `**/src/main/**` or any other production
source path. **`**/src/main/**` is a deny that always wins, even when nested under an
otherwise-allowed prefix** — e.g. a hypothetical `qa/acceptance-tests/src/main/**` (shared test-
harness code some modules keep in a `src/main` directory) is still production-shaped code, not test
code, and is still off-limits; `qa/acceptance-tests/**` is only an allow for the parts of that tree
that are themselves under `src/test` or a resource/fixture directory. If a failure's root cause
lives in production code, self-heal is categorically not an option — write the appropriate
`FAIL_*` outcome and stop.

Enforce this mechanically, every time, using this exact procedure (identical at both stages):

1. **Before attempting any fix this session**, snapshot a baseline so your own edit can be isolated
   from `implement`/`fix`'s legitimate production changes and the AT itself (do this even if Step 3
   already ran `git add -A` — it is idempotent and guarantees the baseline exists regardless of
   whether Step 2's reuse path skipped Step 3):
   ```bash
   cd "$DAGRUN_WORKTREE" && git add -A
   ```
2. Apply your candidate fix (edit the file(s) you diagnosed). Only edit existing files you have
   already read — do not create a new file as part of a self-heal fix; if the fix genuinely
   requires a new file, that is outside self-heal's scope, not a workaround for it.
3. **Check what you actually changed** — this is the mechanical gate, not a prose self-check:
   ```bash
   cd "$DAGRUN_WORKTREE" && git diff --name-only
   ```
   Every path printed must match a test path (`**/src/test/**`, `qa/acceptance-tests/**` outside
   any nested `src/main`, or a resource/fixture subdirectory of either) and must NOT match
   `**/src/main/**` under any prefix. If even one path does not match:
   ```bash
   cd "$DAGRUN_WORKTREE" && git checkout -- .
   ```
   This reverts your edit while preserving the baseline (implement/fix's legitimate production
   changes stay staged, untouched). Treat this exactly as "root cause is production code" — write
   the stage's `FAIL_*` outcome and stop; note in `detail` that a production-scope edit was
   attempted, caught, and reverted.
4. If every changed path is in scope, fold the good fix into the baseline before retrying:
   ```bash
   cd "$DAGRUN_WORKTREE" && git add -A
   ```

**Rule 2 — shared-fixture rule:** before editing any test fixture file (BPMN, JSON, or other
resource file under a test resources directory), check how many test files reference it:

```bash
grep -rl "<fixture-name>" "$DAGRUN_WORKTREE/qa/acceptance-tests" --include="*.java"
```

- If **more than one** test file depends on it, editing the shared fixture directly is off-limits —
  other tests rely on its current contents and you have no way to verify your edit doesn't break
  them. Instead, fix the _dependent AT's own assertions_ (e.g. update a stale expected-value list to
  account for the fixture's actual, legitimate behavior) — this is almost always the correct fix in
  practice, not a fallback.
- Only edit the fixture directly if it is used by exactly the one AT you are validating in this
  run.

**Rule 3 — proof-before-fix rule (acceptance-stage failures only):** you may treat an acceptance-test
failure as test-side and self-heal it ONLY after dispatching the **isolated**
`verify-production-correctness-checker` subagent (via the Agent tool) and receiving back
`production_correct: true` AND `confirmed: true`. Pass it: the diff, the AT's full content and the
specific failing assertion(s), the actual failure output, and a one-paragraph flow description
(same inputs D3 already uses, plus the failure output). If the subagent returns `false` for either
field, or you cannot dispatch it, self-heal is off — write `FAIL_ASSERTION` and stop, exactly as
before Rule 3 existed.

**Retry caps (cost control — acceptance cycles are expensive):**

- Build/test-stage self-heal: at most **2** fix-and-retry cycles per stage (i.e. up to 3 total run
  attempts for that stage: the original run plus 2 retries).
- Acceptance-stage self-heal: at most **1** fix-and-retry cycle (i.e. up to 2 total acceptance runs:
  the original plus 1 retry) — each cycle re-provisions a fresh testcontainer for `LOCAL` (or
  re-exercises the manually-started `ES`/`OS` container from Step 5) and can take 10+ minutes; do
  not loop expensively.
- **A stall-and-recover sequence (see "Stall detection and recovery" below) shares this SAME
  budget — it is never a separate, stacked counter.** Read the cap above as a cap on total `./mvnw`
  launches per stage (build/test: up to 3 launches; acceptance: up to 2 launches), regardless of
  why any one launch ended — a clean pass/fail, a self-healed fix-and-retry, or a stall recovered
  via a report found after termination. Recovering a usable report from a stalled launch does not,
  by itself, burn an extra cycle beyond the launch it already was — it is simply how that launch
  concluded, and the resulting pass/fail signal feeds the normal self-heal decision above with the
  remaining budget untouched. What actually consumes budget is issuing another `./mvnw` invocation
  (a genuine retry launch). If a _retry_ launch itself stalls and no usable report is found, do not
  attempt yet another launch on the strength of remaining budget — treat the stage as exhausted and
  stop. A stall with NO usable report, on ANY launch, is never retried on the spot regardless of
  remaining budget — it is `ERROR_INFRA`, and `ERROR_INFRA` is never self-heal territory at any
  stage (see above); the human reruns the whole node, not just the stalled stage.
- If a stage exhausts its retry cap still failing, write the normal `FAIL_*` outcome exactly as
  before this change, but the `detail` field must narrate what was attempted — what was diagnosed,
  what was changed, why the retry still failed (including whether a stall-and-recovery was part of
  that history) — not just the final raw failure output. A human resuming the run should not have
  to start diagnosis from zero.

---

## Stall detection and recovery (read before Step 4/5 — bounded, shares the retry budget above)

**Why this exists:** "poll until the task completes" (see "Known environment constraints" above) has
no upper bound if "completes" never actually arrives. This was observed live, three consecutive
times, on run `54177-1`'s Step 5 acceptance-test launch: `jstack` on the live JVM showed the main
thread parked forever in `CamundaMultiDBExtension.afterAll` → `TestApplication.close()` →
`Broker.close()` → `CompletableActorFuture.join()`, waiting on the Zeebe actor scheduler to signal
shutdown-complete — a signal that never arrived, even though the actor threads themselves were idle
(not processing the close task) and the test body itself had already finished well before the hang.
This is confirmed unrelated to any given diff via `git diff --stat origin/main` (no broker/lifecycle
code touched) — not something any one feature change introduces. **Root cause, reclassified after
further investigation (see `DECISIONS.md § verify-stall-recovery` for the full correction):** not a
genuine upstream Camunda product bug, but local `~/.m2` transitive-dependency version skew — an
incomplete install step left stale jars in place, which caused the embedded broker's _startup_
future-chain to deadlock silently (`Broker.internalStart()` hangs with no error, no timeout); the
`Broker.close()` hang `jstack` caught is the downstream symptom of a broker that never finished
starting cleanly. The "`qa/acceptance-tests` module isolation" install fix above (the `-am`-scoped
`./mvnw install`) addresses this specific root cause, so this exact hang pattern should now be rare.
Stall-recovery below is retained regardless, as general defense-in-depth for other/future stalls —
it is not something worth trusting a person to notice by watching a terminal. Applies to
BOTH places this node backgrounds a long `./mvnw` invocation and polls it via `TaskOutput`: Step 4's
test-suite run (`./mvnw test -pl <module>`) and Step 5's acceptance-test run (`./mvnw verify
-Dit.test=<ClassName>`) — not Step 4's build/compile command, which is fast and not a realistic
stall candidate.

**1. Stall threshold.** If a single `TaskOutput(task_id, block: true, timeout: 600000)` call on the
SAME background task (i.e. the same launch — not across separate launches) returns `status: running`
a **second time in a row** — roughly 20 minutes of wall-clock elapsed on this one launch with no
terminal status — do not poll a third time on this launch. Treat it as stalled and move to step 2
immediately.

**2. Terminate the stalled task.** Call the `TaskStop` tool with `{task_id}`. `TaskStop` is a
first-class tool in this session's toolset — ground this before relying on it by checking the
session's own `system: init` event's `tools` array, which includes `TaskStop` alongside
`TaskOutput`. If `TaskStop` itself errors or is unavailable for some reason, fall back to
identifying and killing the underlying OS process via `ps`/`kill -TERM` in Bash — but prefer
`TaskStop` as the primary path.

**3. Look for a durably-written report — do NOT trust the killed task's own final status/exit
code.** Wait a few seconds after termination, then check the stage-appropriate report directory
directly:

- **Step 4** (unit/integration test stage, `./mvnw test -pl <module>`):
  `<module>/target/surefire-reports/`
- **Step 5** (acceptance stage, `./mvnw verify -Dit.test=<ClassName>`):
  `qa/acceptance-tests/target/failsafe-reports/` — look for `<ClassName>.txt` and
  `TEST-<fully.qualified.ClassName>.xml`.

This is deliberate: JVM shutdown hooks and Surefire/Failsafe's own report-flush timing mean the real
result is very often already durably on disk as soon as the test methods + regular JUnit lifecycle
finish — independent of whether the _extension's_ `afterAll` teardown hangs afterward. The killed
task's own reported exit code/status, by contrast, is NOT a reliable signal — on run `54177-1`, two
kills of the identical hang produced inconsistent results (one `status: completed, exit_code: 0`,
the other `status: failed, exit_code: 144`) — this is an artifact of how the shell wraps a killed
process, not a trustworthy pass/fail signal either way. Never treat a "completed"/exit-0 status from
a task you JUST force-killed as meaningful on its own.

**4. Act on what you find:**

- **A complete, readable report exists for the relevant test(s):** parse it directly for the real
  result and proceed exactly as if the command itself had returned that result normally — feed it
  into the existing Step 4/5 pass/fail logic and self-heal decision, unaffected by this recovery
  path having been needed. Record in the stage's `detail` field, briefly, that a stall was hit on
  this launch and recovered via a report found after termination. Do NOT weaken this to "a report is
  present" — it must be complete (the test class's result is actually recorded, not a partial/
  in-progress file) before you trust it; an incomplete or missing report falls through to the next
  bullet.
- **No usable report is found even after the kill:** this launch is a wash with no real signal about
  correctness. Do NOT classify `FAIL_TEST`/`FAIL_ASSERTION` — that would imply a code-correctness
  signal that does not exist here. Classify `ERROR_INFRA` instead, with a clear, actionable `detail`
  that names the observed pattern explicitly: a broker/environment teardown hang in
  `CamundaMultiDBExtension.afterAll` → `Broker.close()` → `CompletableActorFuture.join()`,
  pre-existing and unrelated to this diff (cite the `54177-1` precedent above), and instructs the
  human to rerun the node.

**5. Budget:** a stall-and-recover sequence consumes one of the EXISTING retry-cycle budget slots
for that stage (2 for build/test, 1 for acceptance) — see the "Retry caps" bullet above for exactly
how launches, self-heal retries, and stalls share that one counter. Do not add a separate,
independently-uncapped stall-retry counter.

---

## Red flags — talk yourself out of these, don't act on them

This does not repeat the Rule 1/2/3 mechanics above — it's a short reinforcement of judgment calls
that lead TO the boundary being tested in the first place.

| Red flag phrase (in your own reasoning)                                        | What to do instead                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "This is basically a lint issue" (when it isn't)                               | Only checkstyle/spotless/format tooling actually flagging it counts as lint. A genuine compile error or behavioral assertion failure dressed up as "basically style" is still not self-heal-able (Step 4).                                            |
| "This assertion failure looks stale, I'll just update it"                      | Not without the `verify-production-correctness-checker` subagent's `production_correct: true` AND `confirmed: true` (Rule 3). Your own read of "looks stale" is exactly the self-grading bias Rule 3 exists to guard against.                         |
| "I'll just tweak this shared fixture once, it's a small change"                | Run the Rule 2 `grep -rl` count first. More than one dependent test means the fixture is off-limits — fix the dependent AT's assertions instead.                                                                                                      |
| "The directory check is a formality, I know my edit was test-only"             | Run `git diff --name-only` anyway (Rule 1) — it is the mechanical gate, not your own confidence.                                                                                                                                                      |
| "This has already taken a while, I'll skip the isolated subagent to save time" | The isolated subagent dispatch (D3, and Rule 3 for acceptance self-heal) is what makes verify's judgment trustworthy with no human reviewing it. Skipping it to save time removes the one check that exists precisely because there is no human here. |
| "Docker/testcontainer flakiness, I'll just call it ERROR_INFRA"                | Confirm the container was actually started and answered (Step 0 / Step 5's `ES`/`OS` note) before writing `ERROR_INFRA` — a setup omission on your part is not infra flakiness.                                                                       |

---

## Step 4 — Independent build + test rerun (fail-fast ladder, with bounded style/lint self-heal)

`verify` does not trust `implement`/`fix`'s self-reported build/test status — it reruns both
independently. Stop at the first failing stage; do not run the (expensive) acceptance test after a
broken build or failing suite.

1. **Build:**
   ```bash
   ./mvnw install -pl qa/acceptance-tests -am -Dquickly -T1C
   ./mvnw compile -q
   ```
   - **If this fails and the failure is a lint/style/format violation (checkstyle, spotless, or
     equivalent) in a file under a test path:** this qualifies for self-heal (see "Self-heal
     authority and boundary" above). Apply the minimal fix, run the Rule 1 directory check, and
     rerun the build command — up to 2 fix-and-retry cycles. If a cycle's directory check fails
     (the fix touched a non-test path), stop self-healing immediately per Rule 1 and treat this as
     a normal failure.
   - **If this fails for any other reason** (a genuine compile error, or a lint/style violation in
     a production file): not self-heal-able. Write `verify-report.json` with `"outcome":
"FAIL_BUILD"`, `stages.build.status: "FAIL"`, and a truncated (last ~40 lines) build-log tail
     in `stages.build.detail`. Skip to Step 7 and stop.
   - **If the retry cap is exhausted still failing:** write `"outcome": "FAIL_BUILD"` as above, but
     `stages.build.detail` must narrate the diagnosis and what was attempted (see retry-cap rule
     above), not just the final raw log tail. Skip to Step 7 and stop.
2. **Unit/integration test suite** (scope: the module(s) `implement`/`fix` touched — do not run
   the full monorepo suite; identify touched modules from `git diff --cached --name-only
origin/main`):
   ```bash
   ./mvnw test -pl <touched-module(s)> -q
   ```
   - **If this backgrounds and the poll stalls** (returns `status: running` a second time in a row
     on the same launch): follow "Stall detection and recovery" above — terminate via `TaskStop`,
     check `<module>/target/surefire-reports/` for a complete report, and proceed from there rather
     than polling a third time.
   - **If this fails and the failure is a lint/style/format violation** (e.g. checkstyle enforced
     during the test-phase compile) in a test-path file: same self-heal procedure as the build
     stage — up to 2 fix-and-retry cycles, Rule 1 directory check on every attempt.
   - **If this fails for any other reason** (a genuine behavioral test-assertion failure, or a
     violation in a production file): NOT self-heal-able, regardless of how confident you are about
     the root cause — a behavioral test failure is a real signal, not a lint nit. Write
     `verify-report.json` with `"outcome": "FAIL_TEST"`, `stages.test.status: "FAIL"`, and a
     truncated failing-test-output tail in `stages.test.detail`. Skip to Step 7 and stop.
   - **If the retry cap is exhausted still failing:** write `"outcome": "FAIL_TEST"` as above, with
     `stages.test.detail` narrating the diagnosis and what was attempted. Skip to Step 7 and stop.
3. Both passing → `stages.build.status` and `stages.test.status` are `"PASS"`. Proceed to Step 5.

**Out of scope — do not add:** CI's dist/packaging/cross-storage matrix. This is acceptance-level
verification of THIS change, not a CI re-run.

---

## Step 5 — Run the acceptance test, classify the outcome (with bounded, proof-gated self-heal)

The module's default Maven profile EXCLUDES `@Tag("multi-db-test")` classes — which every
`@MultiDbTest`/`@HistoryMultiDbTest` class carries. Running WITHOUT `-Pmulti-db-test` silently
selects 0 tests (`BUILD SUCCESS`, `Tests run: 0`) — a false green, not a real pass. Always include
`-Pmulti-db-test` for the AT class (the one authored in Step 3 or reused in Step 2):

```bash
./mvnw verify -pl qa/acceptance-tests -Pmulti-db-test -Dit.test=<AcceptanceTestClassName> \
  -Dtest.integration.camunda.database.type=<TYPE> -q
```

`<TYPE>` selects the secondary-storage backend (`CamundaMultiDBExtension#DatabaseType`):

- **`RDBMS_H2`** — embedded, no setup required. Use this as the default/fastest verification
  backend unless the diff specifically touches the ES/OS-only read path (e.g. a terms-aggregation
  reader, index mappings), in which case also run `ES` (and/or `OS`) below.
- **`ES` / `OS`** — NOT auto-provisioned by testcontainers (only the internal `LOCAL` type is — see
  Step 0). You must start the container yourself on `:9200` and confirm it actually answers BEFORE
  launching `mvnw`, or the run silently burns its full 3-minute `TIMEOUT_DATABASE_READINESS` budget
  polling a closed port and fails with `ConditionTimeout` inside `CamundaMultiDBExtension` — this is
  a setup omission on your part, not testcontainer/infra flakiness, and must not be classified or
  narrated as `ERROR_INFRA` without first confirming the container really was up (see the
  `ERROR_INFRA` note below).

  ```bash
  # ES — image/version kept in sync with zeebe/test-util/.../TestSearchContainers.java
  # (which itself tracks version.elasticsearch.container in parent/pom.xml)
  docker run -d --name dagrun-verify-es -p 9200:9200 \
    -e discovery.type=single-node \
    -e xpack.security.enabled=false \
    -e xpack.watcher.enabled=false \
    -e xpack.ml.enabled=false \
    -e action.auto_create_index=true \
    -e action.destructive_requires_name=false \
    -e ES_JAVA_OPTS="-Xms512m -Xmx512m" \
    docker.elastic.co/elasticsearch/elasticsearch:8.19.16

  # OS — see docs/testing/acceptance.md for the maintained flags/version
  docker run -d --name dagrun-verify-os -p 9200:9200 -p 9600:9600 \
    -e discovery.type=single-node \
    -e OPENSEARCH_INITIAL_ADMIN_PASSWORD=yourStrongPassword123! \
    -e DISABLE_SECURITY_PLUGIN=true \
    opensearchproject/opensearch:2.19.5

  # wait for it to actually answer before invoking mvnw — bounded, fails loud, never a fixed sleep
  i=0; until curl -sf http://localhost:9200 > /dev/null 2>&1; do
    i=$((i+1)); if [ "$i" -ge 45 ]; then echo "ES did not answer on :9200 within 90s" >&2; exit 1; fi
    sleep 2
  done
  ```

  Remove the container once Step 5/6 are done (`docker rm -f dagrun-verify-es`) — it is scoped to
  this node's own run, not left behind for the next one.

**If this backgrounds and the poll stalls** (returns `status: running` a second time in a row on the
same launch — this is the stage where the stall was actually observed live, on run `54177-1`, three
consecutive times): follow "Stall detection and recovery" above — terminate via `TaskStop`, check
`qa/acceptance-tests/target/failsafe-reports/` for a complete `<ClassName>.txt`/`TEST-*.xml`, and
proceed from there rather than polling a third time.

Classify the result into exactly ONE of:

- **`PASS`** — the AT ran and all assertions passed. Proceed to Step 6.
- **`FAIL_ASSERTION` (candidate)** — the AT ran but an assertion failed (the feature's behavior may
  be wrong, or the test itself may be stale). Do not write this outcome yet — first work the
  self-heal decision below.
- **`ERROR_INFRA`** — the AT could not even start/run due to a genuine environment problem: a
  `LOCAL`-type testcontainer failed to provision, a manually-started `ES`/`OS` container (Step 5)
  came up but `CamundaMultiDBExtension` still never reported it healthy, a port conflict, etc. — OR
  the task stalled and had to be killed with no usable report recovered afterward (see "Stall
  detection and recovery" above). **Never** read this as a green pass, and never self-heal it (see
  "Self-heal authority and boundary" above). IMPORTANT — before writing this outcome for an `ES`/`OS`
  run: confirm you actually started the container per Step 5 and that it answered on `:9200`. A
  `ConditionTimeout` from `CamundaMultiDBExtension` when no container was ever started is a Step-5
  setup omission, not infra flakiness — go back, start the container, confirm it answers, and rerun
  before writing any outcome at all. Docker being reachable at Step 0 does not guarantee a
  `LOCAL`-type testcontainer starts cleanly either; distinguish "my container never came up"
  (ERROR_INFRA) from "my container came up and the assertion failed" (FAIL_ASSERTION) by reading the
  actual failure — a container-health/connection exception looks very different from a JUnit
  assertion failure. Write `verify-report.json` with `"outcome": "ERROR_INFRA"` and stop.
- (`FAIL_BUILD`/`FAIL_TEST` were already handled in Step 4 — you only reach this step once those
  passed.)

**On a `FAIL_ASSERTION` candidate — work this decision before writing anything:**

1. Trace the failure yourself first (as you naturally would) to form an initial hypothesis of
   whether the root cause is production code or the test/fixture — but do NOT act on your own
   conclusion yet.
2. Dispatch the **`verify-production-correctness-checker`** subagent via the Agent tool (Rule 3).
   Pass it the diff, the AT's full content and the specific failing assertion(s), the actual
   failure output, and a one-paragraph flow description.
3. **If the subagent does not return `production_correct: true` AND `confirmed: true`:** self-heal
   is off. Write `verify-report.json` with `"outcome": "FAIL_ASSERTION"`, `stages.acceptance.status:
"FAIL"`, and include the subagent's `rationale`/`evidence` in `stages.acceptance.detail`
   alongside the raw failure. Skip to Step 7 and stop — exactly as before this change.
4. **If the subagent confirms production is correct:** the fix is test-side. Determine where:
   - If the fix is to the AT's own assertions/expectations, edit the AT file directly.
   - If the fix would touch a shared fixture, apply Rule 2 (the shared-fixture check) first — if
     more than one test file depends on the fixture, fix the dependent AT's assertions instead of
     the fixture (this is the common case, not an edge case — see the run-54177-1 precedent this
     change formalizes).

   Apply the fix, run the Rule 1 directory check, and — if it passes — rerun the specific AT class.
   You get **at most 1** retry cycle for the acceptance stage (2 total runs: original + 1 retry).

5. **If the retry still fails, or the Rule 1 directory check fails at any point:** stop self-healing
   immediately. Write `verify-report.json` with `"outcome": "FAIL_ASSERTION"`, and
   `stages.acceptance.detail` must narrate the full diagnosis (including the subagent's verdict),
   what was changed, and why the retry still failed (or why the directory check reverted the
   attempt). Skip to Step 7 and stop.
6. **If the retry passes:** `"outcome": "PASS"`. Record in `stages.acceptance.detail` that this run
   passed after a self-heal, what was diagnosed, and what was changed — a PASS that required a
   self-heal is still worth narrating for the human reading the report, even though it isn't a
   failure. Proceed to Step 6.

Use the framework's own await/poll helpers for any timing-sensitive read in your own manual
inspection of the result — do not add fixed sleeps to work around a flaky-looking read.

---

## Step 6 — Write the evidence artifacts

### 6a — `$DAGRUN_ARTIFACTS/verify-report.json`

Always write this file, on every path through this command (Step 0's early exit, Step 3b's
self-check failure, Step 4's build/test failure, and Step 5's classification all converge here).
Schema:

```json
{
  "run_id": "<$DAGRUN_RUN_ID>",
  "timestamp": "<ISO 8601>",
  "outcome": "PASS | FAIL_ASSERTION | FAIL_BUILD | FAIL_TEST | ERROR_INFRA",
  "acceptanceTest": {
    "path": "<qa/acceptance-tests/.../ClassName.java, or null if never reached>",
    "source": "authored | reused-existing | not-reached"
  },
  "stages": {
    "dockerPreflight": { "status": "PASS | FAIL", "detail": "<one sentence>" },
    "selfCheck": {
      "status": "PASS | FAIL | SKIPPED",
      "detail": "<subagent rationale or reason skipped>"
    },
    "build": {
      "status": "PASS | FAIL | SKIPPED",
      "detail": "<truncated log tail or reason skipped>"
    },
    "test": {
      "status": "PASS | FAIL | SKIPPED",
      "detail": "<truncated log tail or reason skipped>"
    },
    "acceptance": {
      "status": "PASS | FAIL | SKIPPED",
      "detail": "<truncated log tail or reason skipped>"
    }
  },
  "diagnostics": "<optional: incident/variable diagnostics the framework exposed on failure — omit key entirely if PASS>"
}
```

Rules:

- `outcome` is the single field the pipeline's engine-level gate reads (`checkOutcomeGate` in
  `dag.ts`) — it must be exactly one of the five values above, nothing else.
- Truncate any log/output text to roughly the last 40 lines (or ~4 KB) — never paste a full raw
  dump. The goal is enough context for a human resuming the run to understand what broke, not a
  complete transcript.
- Every stage field must be present even when `SKIPPED` (e.g. `acceptance` is `SKIPPED` when
  Step 0/3b/4 already stopped the run) — never omit a stage key.
- Valid JSON, no trailing commas.
- If a self-heal was attempted at any stage (see "Self-heal authority and boundary" above) — whether
  it ultimately succeeded or the stage exhausted its retry cap and still failed — that stage's
  `detail` must narrate the diagnosis, what was changed, and the result, not just the final raw
  log/output. This applies even on a self-healed `PASS`: a human reading the report later should be
  able to tell a self-heal happened without re-deriving it from the worktree diff.
- The same narration requirement applies if a stall-and-recovery sequence happened at any stage (see
  "Stall detection and recovery" above), regardless of whether it recovered a usable report or ended
  in `ERROR_INFRA` — `detail` must say a stall was hit, that the task was terminated, and what (if
  anything) was recovered from the report directory.

### 6b — `$DAGRUN_ARTIFACTS/verify-plan.md`

Skip this file entirely if Step 0 exited early (no authoring work happened). Otherwise:

```markdown
# Verify plan — <feature/fix name from the guide>

## Flow covered

<One paragraph: the user-facing flow this acceptance test proves, drawn from the guide.>

## Acceptance test

- **File:** `qa/acceptance-tests/.../ClassName.java`
- **Source:** authored new | reused existing (bugfix workflow only — name the flow match reason)

## D3 self-check verdict

<The verify-diff-grounding-checker subagent's grounded/rationale verdict, verbatim.>

## Independent build + test rerun

- Build: PASS/FAIL
- Test suite (`<module(s)>`): PASS/FAIL

## Outcome

<PASS | FAIL_ASSERTION | FAIL_BUILD | FAIL_TEST | ERROR_INFRA — one line, matches verify-report.json>
```

---

## Step 7 — Reflections (optional, do this last)

Write `$DAGRUN_ARTIFACTS/reflections.md` if you discovered anything non-obvious about the
acceptance-test surface, the build/test rerun, or the framework's own quirks (e.g. an
`@MultiDbTest` await pattern that isn't obvious from the reference tests, a testcontainer
provisioning gotcha). Absence is fine. The SessionEnd hook captures this automatically.

---

## Constraints

- The acceptance test file is real, committed Camunda test code — it belongs in
  `$DAGRUN_WORKTREE/qa/acceptance-tests`, NOT in `$DAGRUN_ARTIFACTS`.
- `verify-plan.md` and `verify-report.json` are the ONLY files written to `$DAGRUN_ARTIFACTS`.
- Never let a testcontainer/infra failure read as `PASS` — when in doubt between `ERROR_INFRA` and
  `FAIL_ASSERTION`, prefer `ERROR_INFRA` only when the failure is clearly provisioning-level (the
  test body itself never ran); otherwise it's a real assertion failure.
- Do not add any CI-style dist/packaging/cross-storage matrix coverage — out of scope.
- Do not skip the D3 self-check for a reused existing AT (bugfix path) — reuse still needs
  grounding confirmation.
- Self-heal (Step 4/5) is bounded and gated — never edit anything under `**/src/main/**` or any
  other production path (Rule 1), never edit a shared fixture used by more than one AT (Rule 2), and
  never self-heal an acceptance-test failure without a confirmed
  `verify-production-correctness-checker` verdict (Rule 3). When self-heal is not authorized for a
  failure, behave exactly as this node did before this change: write the matching
  `FAIL_*`/`ERROR_INFRA` outcome and stop.
