# dagrunner — Master Architecture (Source of Truth)

Status: Canonical, reconciled with the built code through Phase 5 (bugfix workflow shipped; siblings run on any branch). Each sibling build also gets its own implementation plan.
Last updated: 2026-07-03 (docs consolidation: retired the v1-build scaffold, docs/archive/, the chat-architect handoff apparatus, and the file-based plan/status-tracking workflow — docs/changes/, docs/STATUS.md, docs/dagrunner-architect-charter.md, and the build-queue/bundle scripts are gone; self-changes are now agreed in conversation and history lives in git log. See CLAUDE.md § "How self-changes happen".)
Owner: Eddie Tsedeke

---

## 1. What dagrunner is

A thin, static TypeScript orchestrator that walks a feature change through a fixed, gated pipeline — expand -> implement -> review -> fix -> verify -> pr — pausing at defined human gates and checkpointing to disk so it survives process exit. Each node is a Claude Code session spawned via the Agent SDK in an isolated git worktree. dagrunner owns only what Claude Code cannot do across separate sessions: the dependency graph, checkpoint-and-resume, worktree isolation, artifact hand-off, gates, and cost discipline.

Core principle: **code coordinates, model judges.** TS orchestration is free; node sessions cost. Reuse Claude Code primitives; build only cross-process/worktree gaps.

North star: **strip everything predictive out of the front of the pipeline; decide each thing where the information actually exists.** A decision from the plan before code exists is worse than the same decision from the diff/findings later.

---

## 2. System components

| #   | Component                                | Runs where                                           | Role                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Glean Agent (Feature Task Companion)** | Glean                                                | Ingests a GitHub task; emits a directional implementation plan (INTENT/why). dagrunner's expand writes the code-level HOW and critically evaluates the plan's proposed implementation. The plan is dagrunner's inbox input — no GitHub issue needed. |
| 2   | **dagrunner (static feature pipeline)**  | local machine                                        | The gated feature pipeline. The heart of the system.                                                                                                                                                                                                 |
| 3   | **Three Phase-3 siblings**               | Camunda monorepo private `.claude/`, run in worktree | Interactive human-driven commands acting on Camunda: `/seed-data` (c8ctl seeding of a human-started OC), `ci-babysit`, `pr-triage`. See §9.                                                                                                          |

Phase 3 is three LOCAL siblings (/seed-data + ci-babysit + pr-triage) — one substrate, enterprise subscription locally. `/pr-review` is NOT a dagrunner sibling: it stays a private standalone command for reviewing OTHERS' PRs (see §9). gh-aw and dynamic-workflows-in-pipeline are not used (see §9 rationale).

**Feature-task plan authoring guidance:** Plans should faithfully capture the requirement, intent, and acceptance criteria — including the source issue's prescribed solution path when one exists. Keep implementation **directional**; detailed implementation is expand's job, not the plan's. Over-specifying implementation in the plan risks divergence from the issue and reduces expand's ability to find a better path.

---

## 3. The feature pipeline (fully static)

```
[Glean directional plan in inbox]
   [PREFLIGHT] (not a node; runs before the graph)
        |
  expand (unpinned)   ★ GATE 1: review the guide (conversation-led)
                        → elaborates a usable implementation guide AND critically evaluates the plan's proposed
                          implementation; surfaces a "Concerns / plan challenges" section in guide.md when the
                          plan over-specifies, diverges from the source issue, or is incomplete (advisory — no
                          hard block; human reviews at Gate 1)
  implement (unpinned)
  review (static node):
     - diff-triage first step (haiku): read diff -> touches_* flags
     - fan-out selected reviewer subagents (read-only, isolated context)
     - synthesize
     - adversarial verifier ONLY if findings count > N (default 3)
        |  -> review/findings.json
  fix (consumes findings, mutates worktree, self-verifies)  ★ GATE 2: accept/reject fixes
  verify (sonnet, AUTONOMOUS: authors/reuses a @MultiDbTest acceptance test from
          guide.md, isolated-context self-check that the AT exercises the diff,
          independently reruns build+tests, runs+classifies the AT, writes
          verify-report.json) -> outcomeGate on verify-report.json's `outcome`
        |  field: non-PASS fails this node (halts the run) exactly like a produces
        |  violation — no human gate, no election. See §3d.
  pr (haiku)               -> opens the PR (git push / gh run outside the agent's own session — see §6)
                              [TERMINAL — run ends here]
  digest (sonnet, dependsOn fix+verify, same as pr — runs in PARALLEL with pr, no added
          wall-clock time) -> writes knowledge-map.md, a bottom-up synthesis of what was
                              implemented (and why), grounded in the diff/summaries/findings —
                              not the plan. Informational/read-only, no gate (same pattern as
                              review). See §3f.
                              Each node may write reflections.md; the SessionEnd hook captures it to store
```

**review/fix split:** review is read-only (its whole contract is one `findings.json`); fix is the mutating, gated node (so the human gates the actual code changes, with session memory for conversation-led reject).

**Adversarial verifier:** a second-order discriminator (not a 7th reviewer) — reads the reviewers' findings in isolated context, grounds each against the diff, drops/downgrades ungrounded ones. Triggered by runtime finding-count threshold N (default 3), NOT an upstream flag.

**findings.json schema:**

```
{ run_id, timestamp,
  triage: { touches_public_api, touches_runtime, touches_schema_or_proto, performance_sensitive, touches_ui },
  reviewers_run: [string], reviewers_skipped: [{name,reason}],
  adversarial_verifier_run: bool,
  findings: [{ reviewer_dimension, severity, confidence, file, line, claim, grounded }] }
```

Reviewer selection (from diff-triage): correctness + test-adequacy always; api-stability when touches_public_api; distributed-systems when touches_runtime; migration-safety when touches_schema_or_proto; performance when triage judges it.

**Gates:** all checkpoint-and-exit, single-awaiting-gate invariant. Human review via a fresh interactive `claude` session (SDK session IDs are not resumable from the CLI — two stores don't share state); `/gate-review` + `/gate-conclude` write a `gate-decision.md` handshake file. Author-agent revision still resumes the same SDK session (via `options.resume` + `feedback-N.md`) so it revises with memory. Gates live ONLY on static nodes.

**Night-mode (`dagrun start feature --night`):** unattended overnight execution. One rule — agent-decidable gates (Gate 1 = expand, Gate 2 = fix) are auto-approved when no "Concerns / plan challenges" heading is present in the gate artifact. A flagged concern or an unreadable/missing artifact also pauses (fail toward the human). Every auto-decision is logged to `gateHistory` with `mode: "night"` and `basis: "no concerns flagged"` for morning audit. `agentDecidable(nodeId)` is the exported predicate; `hasConcerns(content)` is the exported concern check (both pure, unit-tested). Since the verify-autonomy change (§3d), `verify` has no gate at all (agent-decidable or otherwise) — a clean night-mode run now proceeds through `verify` and `pr` fully unattended with no park; the old "verify-election always pauses (human-only)" carve-out is gone because the election itself is gone.

---

## 3c. The bugfix pipeline

> **Since v0.1.50** the diagram below has a third gate (pre-PR, on `pr`), an OPTIONAL `verify` decided at
> the fix gate, and every gate returns to the originating companion — see §3g. The verify description
> in this section is historical.

```
[Bug fix plan in inbox — YAML frontmatter: base_branch, severity, issue URL]
   [PREFLIGHT] (same as feature)
        |
  reproduce (unpinned)  ★ GATE 1: review the reproduction guide
                          → confirms bug is real (reproducing test currently fails),
                            validates root cause, documents fix approach in guide.md.
                            Surfaces "Concerns / plan challenges" when: cannot reproduce,
                            root cause differs from plan, or change surface is broader.
  implement (unpinned)   — reuses /implement command (reads guide.md from reproduce/)
  review    (same as feature — reuses /review + FINDINGS_SCHEMA)
  fix       (unpinned)  ★ GATE 2: accept/reject fixes
  verify    (sonnet, AUTONOMOUS — reuses /verify, see §3d) — required, blocking,
                            outcomeGate-gated exactly as on the feature workflow
  pr        (haiku)       — reuses /pr command
                            [TERMINAL — run ends here]
  digest    (sonnet)      — reuses /digest command, dependsOn fix+verify (same as pr) — runs
                            in PARALLEL with pr. See §3f.
```

**verify on the bugfix workflow (added by the verify-autonomy change — see DECISIONS.md §
verify-autonomy-bugfix-conditional):** the regression test written in reproduce/guide.md and
exercised during implement/fix proves the fix at the unit/integration layer — it does NOT prove
the user-facing flow is covered at the `@MultiDbTest` acceptance-test layer. verify's first step on
this workflow (unique to bugfix, not present on feature) searches the worktree's
`qa/acceptance-tests` for an EXISTING `@MultiDbTest` that already covers the flow the bug touches,
grounded from `reproduce/guide.md`. If one is found, it is reused as-is (recorded in
`verify-plan.md`, no new AT authored); if not, verify authors one exactly as on the feature
workflow. From there — isolated self-check, independent build+test rerun, run+classify,
verify-report.json + outcomeGate — the logic is identical to the feature workflow (§3d); both
workflows share the same `payload/commands/verify.md`.

**base_branch from frontmatter:** Bug fixes often target release branches (hotfixes). The plan file may carry a YAML frontmatter block (`---` delimiters) with `base_branch: release/1.x`. Run-engine parses this with `parseFrontmatter()` (pure, exported, unit-tested) before creating the worktree. The worktree branches from `base_branch` as start-point. `runPrPostProcess` uses `state.baseBranch ?? "main"` for `gh pr create --base`. When absent, defaults to `"main"`.

**Severity-aware night-mode:** The same `--night` flag works for bugfix runs. Additional rule: if `state.severity` is `"critical"` or `"blocker"`, night-mode always pauses at the gate regardless of whether concerns are flagged. `severityForcesPause(severity)` is the exported predicate (pure, unit-tested). Rationale: high-stakes bugs warrant human eyes even when the agent sees no concerns.

**Frontmatter fields stored in state:** `baseBranch`, `severity`, `issueUrl` are optional fields on `RunState`. They survive resume. Only `baseBranch` is stored when non-"main" (avoids cluttering state for feature runs). None are exported as env vars — they are consumed by engine TS code from state, not by node prompts.

**Command reuse:** `/implement` and `/pr` are workflow-tolerant: they check `define/guide.md` first, then fall back to `reproduce/guide.md`. No workflow-specific command forks — single copies, no smoke:live cost increase.

---

## 3d. verify — autonomous acceptance-test author/runner/judge/gate

> **SUPERSEDED (v0.1.50) — read §3g first.** `verify` is no longer the autonomous MultiDbTest
> acceptance-test author/runner described in the rest of §3d (that duplicated CI on the PR). It is an
> OPTIONAL runtime hand-off for Eddie's manual testing (v0.1.57: provisioned, not self-verified),
> chosen at the fix gate, sharing one prompt
> (`payload/commands/verify.md`) across both workflows. The text below is retained as history of the
> reasoning behind the old shape (self-heal, stall detection, deferred-to-CI); none of its outcome
> names (`PASS`/`FAIL_*`/`DEFERRED_TO_CI`/`ERROR_INFRA`) exist any more.


**Why this changed:** verify was originally read-only/INFO-ONLY (haiku, no cluster) because
cluster bring-up was believed to conflict with the runtime sandbox (Seatbelt kernel enforcement).
That rationale is stale: `sandbox.enabled` has been `false` since commit `3015634` — the
structural boundary today is the Bash allow/deny list (`src/config/settings-seed.ts`) + PreToolUse
deny-guard hook, not a kernel sandbox (§6 — the `sandbox` key has since been removed from
`buildSeededSettings` entirely, not merely left disabled). `./mvnw *`/`mvn *` are already
allow-listed and already used by `implement`/`fix`; Testcontainers talks to the Docker daemon
directly from the JVM (not via the Bash tool), so it isn't gated by the allowlist either — the only
real precondition is Docker being reachable on the host, which verify checks as a fail-loud
preflight (Step 0 of `payload/commands/verify.md`), never an assumed-working dependency. With the
sandbox rationale gone, verify was redesigned to be fully autonomous — it authors and runs its own
proof, rather than handing a human a manual-test document and pausing (see DECISIONS.md §
verify-autonomy-remove-election for the full judgment-call log).

**Bounded self-heal (added by the verify-bounded-self-heal change — see `DECISIONS.md §
verify-bounded-self-heal`):** verify is no longer a pure classify-and-stop judge. Real-run evidence
(run `54177-1`) showed the original design's actual gap: verify's independent rebuild hit a
checkstyle `DeclarationOrder` violation in a _test_ file and fixed it inline, undocumented — the
prompt never authorized this — while, in the same run, its acceptance-test failure investigation
did rigorous root-cause tracing (read the RDBMS SQL, the ES/OS filter/aggregation transformer
chain, cited file:line evidence that `processDefinitionKey` scoping was correct on both backends)
and _still_ just wrote `FAIL_ASSERTION` and stopped, despite having already proven the fix belonged
in test code it was allowed to touch (a stale expected-value list in the AT, relative to unrelated
`zeebe:output`/`zeebe:input` io-mappings baked into a shared BPMN fixture 9 other test files also
depend on). That inconsistency — self-heals on whim for build, never for acceptance, with no
explicit authority or boundary either way — is what this change formalizes, not a new capability
invented from scratch.

verify now has narrow, bounded, _mechanically gated_ authority to fix test-side issues and retry,
rather than failing immediately:

- **Build/test-stage self-heal** — lint/style/format violations only (checkstyle, spotless), never
  a genuine compile error or behavioral test-assertion failure. No isolated proof subagent needed —
  a style violation isn't a behavioral question. Capped at 2 fix-and-retry cycles per stage.
- **Acceptance-stage self-heal** — an assertion failure may be self-healed only after an isolated
  `verify-production-correctness-checker` subagent (new, mirrors the existing diff-grounding
  self-check's `verify-diff-grounding-checker` pattern) independently confirms, with file:line
  citations, that the production code is correct and the failure's root cause can only be
  test-side. verify's own same-session conclusion is never sufficient — this is the same
  self-grading-bias concern the diff-grounding self-check already exists to guard against, applied
  to the companion question that only comes up on a failure. Capped at 1 fix-and-retry cycle (each
  cycle re-provisions a fresh testcontainer/ES stack and can take 10+ minutes).

Three mechanical rules bound every self-heal, checked by verify itself before any fix is kept, not
left to prompt-only discipline: (1) **directory-scoped** — a `git add -A` baseline before the fix,
`git diff --name-only` after it, asserting every changed path is under a test path
(`**/src/test/**`, `qa/acceptance-tests/**`); any production-path edit is reverted with
`git checkout -- .` and treated as "not self-heal-able," (2) **shared-fixture** — before editing any
test fixture, `grep -rl` counts how many test files reference it; more than one dependent means the
fixture is off-limits and the fix belongs in the dependent AT's own assertions instead, (3)
**proof-before-fix** (acceptance only) — the isolated subagent gate above. If a stage exhausts its
retry cap still failing, or self-heal was never authorized for the failure, verify writes the same
`FAIL_*`/`ERROR_INFRA` outcome it always did — the only difference is the `detail` field now
narrates what was diagnosed and attempted, not just the raw failure. The node's five-value
`outcome` enum, `outcomeGate` mechanics, and ungated/autonomous terminal-classifier framing are
**unchanged** — no new human gate was reintroduced; LoopConfig/loop-back-to-`fix` was explicitly
considered and rejected as out of scope (the self-heal loop runs entirely within verify's own
single agent session, the same way the undocumented checkstyle fix in `54177-1` already did).

**What verify does now (both workflows, same `payload/commands/verify.md`):**

1. **Docker preflight** — `docker info`; fails loud with an actionable message (never a raw
   testcontainer stack trace) if unreachable.
2. **Read the promised user flow** — `define/guide.md` (feature) or `reproduce/guide.md` (bugfix)
   is the authoring source. The diff is explicitly NOT an authoring input, only a self-check input
   (step 4 below) — this mirrors the pipeline's existing "guide is the contract, diff is what
   actually happened" split.
3. **Author (or, bugfix-only, reuse) one `@MultiDbTest` acceptance test** proving the whole
   promised user journey — not a re-run of `implement`'s unit/integration coverage. Written into
   the worktree's `qa/acceptance-tests` module (real, committed test code — not a dagrunner
   artifact), mirroring that module's existing conventions rather than inventing new structure.
   Bugfix workflow only: first searches for an existing AT that already covers the flow; if found,
   reuses it and skips authoring.
4. **Isolated diff-grounding self-check** — a `verify-diff-grounding-checker` subagent (isolated
   context, same pattern as `reviewer-adversarial-verifier`) confirms the AT's assertions/exercised
   paths actually tie back to the diff's changed surfaces, independently of verify's own
   self-assessment. This guards against a vacuous AT that would pass without touching the feature —
   the same self-grading-bias problem the plan flags for why `implement` shouldn't author its own
   acceptance test. A failed self-check halts before the (expensive) build/test/acceptance stages.
5. **Build the `qa/acceptance-tests` module (prerequisite for Step 5), with bounded style/lint
   self-heal, no independent test-suite rerun** — verify does not trust `implement`/`fix`'s
   self-reported build status; it rebuilds `qa/acceptance-tests` itself (the module-isolation `-am`
   install genuinely required before this module can compile/run at all — see "Known environment
   constraints" in `payload/commands/verify.md`). It does NOT separately rerun the unit/integration
   test suite (removed by the verify-defer-to-ci-and-drop-diff-scoped-rerun change, 2026-07-14 — see
   `DECISIONS.md § verify-defer-to-ci-and-drop-diff-scoped-rerun`): CI already reruns build/test on
   every push and `implement`/`fix` already self-report their own status, so the diff-scoped test
   rerun this step used to also perform was pure redundancy on top of those two signals, not an
   independent check. Fail-fast ladder: build → acceptance test. A broken build stops before the
   acceptance run — unless the failure is a lint/style/format violation in a test file (self-heal,
   capped, directory-gated; see "Bounded self-heal" above), or is mechanically confirmed pre-existing
   and diff-unrelated (`DEFERRED_TO_CI` — see below).
6. **Run + classify, with bounded proof-gated self-heal** — executes the AT via the existing
   `@MultiDbTest` framework (starts `TestStandaloneBroker`/`TestSimpleCamundaApplication` in-process,
   injects `CamundaClient` — dagrunner reimplements none of this). The framework only
   auto-provisions its own ES testcontainer for the internal `LOCAL` database type; for the `ES`/`OS`
   types verify actually runs against (`-Dtest.integration.camunda.database.type=ES|OS`), it expects
   a container already listening on `:9200` — verify starts one itself via `docker run` before
   invoking `mvnw` (see `payload/commands/verify.md` Step 5) — and classifies the result into exactly
   one of `PASS` / `FAIL_ASSERTION` / `FAIL_BUILD` / `DEFERRED_TO_CI` / `ERROR_INFRA`. An assertion
   failure is not written as `FAIL_ASSERTION` immediately — verify first works the self-heal decision
   (isolated production-correctness proof, directory/shared-fixture rules, one retry) before falling
   back to the classification.
7. **Evidence + gate** — writes `$DAGRUN_ARTIFACTS/verify-report.json` (per-stage status +
   the single outcome classification + truncated logs, now also narrating any self-heal attempted)
   and, when authoring happened, `verify-plan.md` (which flow it covers, why, and the self-check
   verdict).

**Bounded stall-recovery (added by the verify-stall-recovery change — see `DECISIONS.md §
verify-stall-recovery`):** the `ScheduleWakeup`-incompatibility fix above (`payload/commands/
verify.md`'s "poll the backgrounded task synchronously via `TaskOutput`/`Monitor`" instruction) had
its own gap: "poll until done" has no upper bound if "done" never actually arrives. Real-run
evidence (run `54177-1`, observed live) showed exactly this — Step 5's acceptance-test JVM hung
identically on three consecutive attempts, confirmed via `jstack` to be parked in
`CamundaMultiDBExtension.afterAll` → `Broker.close()` → `CompletableActorFuture.join()`, waiting on
a Zeebe actor-scheduler shutdown signal that never arrived — confirmed unrelated to any given diff
via `git diff --stat origin/main` (not something this or any other feature change introduces).
**Root cause, reclassified after further investigation (`DECISIONS.md § verify-stall-recovery`,
dated follow-up entry):** not a genuine upstream Camunda/Zeebe product bug, but local `~/.m2`
transitive-dependency version skew from an incomplete install step in `verify.md`/`implement.md`'s
own instructions, which silently deadlocks the embedded broker's `Broker.internalStart()` — the
`Broker.close()` hang above is the downstream symptom of a broker that never finished starting
cleanly. Fixed by the `-am`-scoped `./mvnw install -pl qa/acceptance-tests -am -Dquickly -T1C`
(same commit); this class of hang should now be rare. Without a human manually killing the JVM
each time, the poll loop would have continued indefinitely. Stall-recovery is retained regardless,
as general defense-in-depth for other/future stalls. verify.md now bounds this: terminate the
stalled launch via `TaskStop` (falling back to `ps`/`kill -TERM` if `TaskStop` errors), and check
the stage's report directory directly (originally `<module>/target/surefire-reports/` for Step 4,
`qa/acceptance-tests/target/failsafe-reports/` for Step 5 — Step 4 no longer participates in this
apparatus at all as of the verify-defer-to-ci-and-drop-diff-scoped-rerun change below; a killed
Step-4 build has no report-directory analog and resolves straight to `ERROR_INFRA`) rather than
trusting the killed task's own exit code/status — which run `54177-1` observed to be inconsistent
across two kills of the identical hang (`completed`/exit 0 vs. `failed`/exit 144). A complete report
found this way is fed into the normal pass/fail/self-heal logic unchanged; no usable report means
`ERROR_INFRA` (never `FAIL_ASSERTION` — there is no code-correctness signal to report). This folds
into the SAME retry-cycle budget the bounded self-heal above already uses (2 for build, 1 for
acceptance) — a stall-and-recover sequence is just one way a launch can conclude, not a second,
independently-uncapped counter.

**Stall threshold redesigned to be progress-aware, not pure wall-clock (the
run-56962-1-forensics change — see `DECISIONS.md § verify-run-56962-1-forensics`).** The original
threshold above ("two consecutive `running` polls = stalled, full stop") was calibrated entirely
from the `54177-1` scenario just described — a single acceptance-test class genuinely parked
forever — and was never validated against Step 4's bulk multi-class module runs. Run `56962-1`
showed the gap directly: `./mvnw test -pl zeebe/engine` (641 test classes) produced 149 fresh
surefire reports (~23% of the suite) in the same ~20-minute window the old rule would kill it
over — steady, healthy progress misclassified as a hang, forcing a kill-and-relaunch loop that
could never complete a large module within one session. verify.md's stall check now keeps the
~20-minute/two-consecutive-`running`-polls threshold ONLY as a floor (the minimum elapsed time
before the check can even trigger), and past that floor requires ALSO that the count of fresh
report files in the stage's report directory (compared against a `touch`ed marker file,
`$DAGRUN_ARTIFACTS/.verify-launch-marker`, via `find ... -newer`) has NOT increased across the two
most recent polls before classifying a stall — a climbing count means keep polling, not a stall.
Because a shell variable set during one Bash tool call does not survive into the next, the
reference point has to be a file, not an in-memory value; the poll-to-poll count itself is tracked
in the model's own reasoning within the turn, needing no persistence. This still correctly catches
a genuine hang (`54177-1`'s teardown-only stall happens after the report is already flushed, so
the count plateaus immediately). Step 4's "no usable report after a kill" branch was also
strengthened into an explicit bright line: classify `ERROR_INFRA` and stop, never reissue another
`./mvnw` launch for that stage on the same path — `56962-1`'s agent violated exactly this (already
implied, not previously stated as a bright line) by relaunching the full suite after an
incomplete-report stall-kill instead of writing `ERROR_INFRA`.

**Monitor/TaskOutput setup-call denial is not "a monitor is watching" (same run-56962-1-forensics
change).** `verify.md`'s "Known environment constraints" section already told the model not to
trust a "you will be notified" message and not to end its turn expecting to be woken up
(`ScheduleWakeup` is disallowed for exactly this — see the one-shot-session note above) — but it
didn't cover the case where the polling mechanism itself never started. On run `56962-1`, two
`Monitor` setup attempts were both denied outright by the Bash sandbox's multi-statement approval
policy, yet the session still ended its turn believing a monitor was running and would notify it —
nothing ever did, since node sessions are one-shot and non-resumable, and `verify-report.json` was
never written. The guard now explicitly treats a denied/errored setup call identically to having
no progress signal at all: fall back to manual single-command polls, or the stall-recovery path,
rather than ending the turn on an unconfirmed assumption.

**Step 4 rescoped to diff-relevant test classes (the verify-diff-scoped-test-rerun change,
2026-07-14 — see `DECISIONS.md § verify-diff-scoped-test-rerun`), then had that entire test-suite
rerun dropped outright and replaced with a `DEFERRED_TO_CI` outcome for confirmed pre-existing
build breaks (the verify-defer-to-ci-and-drop-diff-scoped-rerun change, same day — see `DECISIONS.md
§ verify-defer-to-ci-and-drop-diff-scoped-rerun`).** The progress-aware stall threshold two
paragraphs up made whole-module runs survivable (no more false stalls), but did not fix the deeper
problem it was papering over: whole-module scope itself manufactures false failures. Run
`56962-1`'s actual `ERROR_INFRA` outcome is the empirical proof — `./mvnw test -pl zeebe/engine`
(641 classes) ran twice (~4 hours total), surfaced ~26% failures entirely unrelated to the diff, and
— proven via baseline-commit comparison — every one was pre-existing environment/resource
contention, not a regression, while the 6 test classes actually relevant to the diff were 100%
clean. The verify-diff-scoped-test-rerun change first fixed this by rescoping Step 4 to a mechanical
diff-relevant class mapping (`-Dtest=Class1,Class2,...`, naming convention + `grep -rlw` fallback +
any class named in the guide/summary, with an N>0-executed-tests confirmation via a re-touched
`.verify-launch-marker`) instead of `-pl <touched-module>`. Run `56954-1` then surfaced the deeper
question this narrowing hadn't asked: is an independent test-suite rerun in `verify` needed at all,
given CI already reruns build/test on every push and `implement`/`fix` already self-report their own
status? Eddie's answer, agreed in conversation: no — the rerun (in either its whole-module or
diff-scoped form) was pure redundancy layered on two signals that already exist, so
`payload/commands/verify.md`'s Step 4 dropped it entirely, keeping only the build prerequisite
(the `-am` module-isolation install `qa/acceptance-tests` genuinely cannot compile/run without).
This also retires the class-mapping mechanism, the N>0-executed check, and — since Step 4 is no
longer a bulk multi-class run — the stall-detection apparatus's Step 4 applicability entirely
(it is Step 5-only now; a killed Step 4 build has no report-directory analog to recover a signal
from, so a Step 4 stall resolves straight to `ERROR_INFRA`).

Run `56954-1` also surfaced a second, independent problem the drop above doesn't address: the
mandatory `-am` install can itself fail on a genuine, pre-existing trunk break entirely unrelated to
the diff being verified (12 NullAway compile errors in `zeebe/snapshot`, confirmed byte-identical to
the merge-base — a module this run never touched). Before this change, that situation had no correct
classification: `FAIL_BUILD` would hard-block `pr` for a problem the PR author cannot fix (self-heal
is categorically off — it's production code, out of scope, unrelated) and did not cause, and
`ERROR_INFRA` would misrepresent a real (if pre-existing) compile break as an environment/tooling
problem. `payload/commands/verify.md`'s Step 4 now works a narrow, mechanical "Deferred-to-CI check"
before falling back to `FAIL_BUILD` on a genuine build failure: identify the specific failing
file/module from Maven's error output, confirm it is absent from `git diff --name-only
"$(git merge-base origin/main HEAD)"`, and additionally confirm it is byte-identical via `git diff
"$(git merge-base origin/main HEAD)" -- <file>` returning empty (closing the "file was deleted"
gap that absence-from-diff alone wouldn't). Only if both checks confirm unrelated does verify write
`"outcome": "DEFERRED_TO_CI"` instead of `FAIL_BUILD`; any uncertainty falls through to `FAIL_BUILD`
unchanged — this is a bright line, not a judgment call. `DEFERRED_TO_CI` is a new, narrower
classification, not a rename of `ERROR_INFRA` — it means "the codebase this branch is based on
doesn't compile, for reasons this diff didn't cause," and Step 5 is still skipped exactly as it is
on `FAIL_BUILD` (there is no build to run the acceptance test against either way).

**The new engine mechanism — `outcomeGate`:** node status in dagrunner was previously derived only
from SDK success/failure + `produces` file-existence — nothing read the CONTENT of a produced
artifact. A new optional `Node` field, `outcomeGate: { file, field, passValues }` (`src/core/types.ts`),
closes this gap. Checked in `src/core/dag.ts`'s `checkOutcomeGate` (a small pure function, shared —
not duplicated — with `src/runtime/run-engine.ts`'s `rerunNode`) immediately after the existing
produces-file-existence check passes: it reads `field` out of the named JSON artifact and, if the
value isn't in `passValues`, marks the node `"failed"` with a clear message instead of `"done"`.
`verify` is wired with `outcomeGate: { file: "verify-report.json", field: "outcome", passValues:
["PASS", "DEFERRED_TO_CI"] }` on both workflows — `DEFERRED_TO_CI` was added to `passValues` by the
verify-defer-to-ci-and-drop-diff-scoped-rerun change above precisely because it is a non-blocking
outcome: verify confirmed a pre-existing, diff-unrelated trunk issue and deferred acceptance-test
confirmation to CI, which must not read as a failure of THIS change. `FAIL_BUILD`/`FAIL_ASSERTION`/
`ERROR_INFRA` remain outside `passValues` and block `pr` exactly as before. This gives every
blocking classification a uniform engine-level effect — node fails, run halts, `pr` (which depends
on `verify`, no longer `optional`) never runs — identical to today's produces-violation halt
semantics, while `DEFERRED_TO_CI` (like `PASS`) lets the node reach `"done"` and `pr` proceed,
carrying a visible callout (see `payload/commands/pr.md`) rather than silently reading as a normal
pass. No separate `ERROR_INFRA`/`DEFERRED_TO_CI`-specific engine code path was added: the
distinction between "this feature is broken," "the environment is broken," and "trunk is broken for
unrelated reasons" lives entirely in the artifact's `outcome` field and `passValues`, not in
different control flow.

**Sibling mechanism — `noPlaceholders` (added by the structural-upgrades change, 2026-07-09 — see
`DECISIONS.md § structural-upgrades-2026-07-09`):** a second content-level check, `noPlaceholders:
string[]` (`src/core/types.ts`), lists produced filenames to mechanically scan for unresolved
`TBD`/`TODO`/`FIXME`/`XXX` markers (whole-word, case-sensitive) after fenced code blocks are blanked
(a guide may legitimately quote an existing `// TODO` from the codebase it describes — that is not
an authored placeholder). Checked by `src/core/dag.ts`'s `checkNoPlaceholders`, immediately after
`checkOutcomeGate`, same failure shape (`"failed"` with a clear message, never a silent pass). Wired
as `noPlaceholders: ["guide.md"]` on `define` (feature) and `reproduce` (bugfix) — Eddie chose the
mechanical check over a prompt self-check specifically because it is verifiable, unlike the
RED-evidence declaration below.

**Why this check needed FOUR wiring sites, not one:** `define`/`reproduce` are gated nodes, and
`sdk-runner.ts` guarantees a gated node's executor call ALWAYS returns `awaiting-gate`, never
`done` — so `runDag`'s own done-branch (where `checkOutcomeGate` already lived, and where the
originating brief for this change said to add the sibling check) is never actually reached by the
two nodes `noPlaceholders` targets. The only two places a gated node's status ever flips to `done`
are `run-engine.ts`'s two gate-approve transitions: `resumeRun`'s manual `--approve` branch and
`startRun`'s night-mode auto-approve loop. `checkNoPlaceholders` is wired into all four done-
transition sites (`runDag`, `rerunNode` — mirroring `checkOutcomeGate`'s existing dual-wiring — plus
both gate-approve branches). On a gate-approve failure, the human/night-mode "approve" decision is
still recorded in `gateHistory` (it genuinely happened) but the node's `status` is written `"failed"`
with the check's error instead of `"done"` — the mechanical check overrides the approval outcome,
not the audit trail of what was decided. Proven end-to-end (not just via the pure-function unit
tests) by `smoke:mock` Run G: a `gate-pause-with-placeholder` mock-executor scenario writes an
unresolved `TODO` into `define/guide.md`, then the real `startRun`/`resumeRun` approve path is
exercised and asserted to end `define` `"failed"` (not `"done"`), block `implement`, and fail the
run — the wiring gap the advisor's review caught before this shipped, and the thing a `runDag`-only
wiring would have made invisible (the mock guide.md content contains no placeholder token, so
"check passed" and "check never ran" would have looked identical on the happy path alone).

**What was removed:** the verify-election micro-gate (the "run runtime verification? [y/n]"
pause after Gate 2, and night-mode's mandatory park at it — verify-election was the ONE thing
night-mode could never auto-decide) is gone entirely, along with `RunState.verifyElection`, the
`--verify y|n` CLI flag, and `manual_test_recommendation` in `FINDINGS_SCHEMA` (it existed solely
to feed the election prompt). `verify` is no longer `optional` — it is required and blocking on
both workflows, and Gate 3 (the old "human runs the manual test") no longer exists. Night-mode now
completes a clean run fully unattended, start to `pr`, with no manual-test pause anywhere.

**The old manual-test-guide value didn't disappear — it moved out of the pipeline.** A new
sibling, `/manual-smoke` (§10), reuses the old verify.md's content generation almost verbatim,
relocated to run on demand against a completed (or past-Gate-1) run's existing artifacts. It gates
nothing and is not part of the autonomous run.

**Scope boundary — what verify explicitly does NOT do:** CI's dist/packaging/cross-storage matrix.
verify is acceptance-level verification of THIS change, not a CI re-run.

**One-shot session vs. auto-backgrounded long commands (run `54177-1`):** Step 4/5's `./mvnw`
invocations can run 10+ minutes (an `@MultiDbTest` acceptance test either provisions its own
`LOCAL`-type Elasticsearch testcontainer, or — for `ES`/`OS` — talks to the container verify started
manually against `:9200`), long enough that the SDK auto-converts the Bash call into a background
task. In
`54177-1`, `verify` read that as "come back later," called `ScheduleWakeup`, and ended its turn —
but nothing ever resumes a node's session (see §6's `disallowedTools` note), so the run just idled
until the harness killed the backgrounded Maven task, never reaching a PASS/FAIL verdict.
`ScheduleWakeup` is now mechanically disallowed for every node (§6); `payload/commands/verify.md`'s
"Known environment constraints" section also tells the model explicitly to poll a backgrounded task
to completion synchronously via `TaskOutput`/`Monitor`, within the same turn, rather than trust the
"you will be notified" message. See `DECISIONS.md § verify-scheduleawakeup-incompatibility`.

---

## 3e. Verified-RED TDD, the 3-failed-fix-rounds escalation, and red-flag tables

Three prompt-level hardening changes landed together (2026-07-09, alongside the `noPlaceholders`
engine change in §3d — see `DECISIONS.md § structural-upgrades-2026-07-09` for the full log):

**Verified-RED TDD on feature `implement` (feature workflow only):** `payload/commands/implement.md`
is shared by both workflows, but the RED-proof gap it closes is real only on the feature side —
`reproduce.md` Step 2 already proves red at the bug-symptom level (runs the reproducing
test/validation command, confirms it currently fails) before any guide is written. `implement.md`
now has a step, gated on which guide.md path was read (`define/guide.md` vs `reproduce/guide.md` —
the same detection pattern `verify.md` Step 1 already uses), that on the feature path: identifies
the unit/integration test(s) the guide's acceptance criteria imply (explicitly NOT an `@MultiDbTest`
acceptance test — that stays `verify`'s job, authored later in isolated context), writes that test
first, runs it, confirms it fails for the right reason (captures the output), only then writes the
implementation, reruns to confirm GREEN, and writes `$DAGRUN_ARTIFACTS/red-evidence.md` with the
test identity, captured RED output, and GREEN confirmation. `red-evidence.md` is declared in
`implement`'s `produces` array in `feature-workflow.ts` ONLY (not `bugfix-workflow.ts`'s `implement`
node) — this reuses the existing produces-contract engine mechanism (`dag.ts`'s
`missing = (node.produces ?? []).filter(...)`) rather than any new hook; `.claude/hooks/
session-end.sh` was explicitly considered and rejected for this because it is fail-soft/
observability-only and cannot enforce anything. **Known, accepted ceiling:** this proves existence +
a plausible RED→GREEN narrative, not a cryptographically-verified ordering — an agent could still
fabricate `red-evidence.md`'s content. That is intentional; over-engineering around it was
explicitly rejected.

**3-failed-fix-rounds escalation (`fix.md`, shared by both workflows — one edit covers both):** `fix`
already checkpoint-exits to a human gate on every round, and `run-engine.ts`'s gate-context builder
already embeds the full `summary.md` content verbatim into `gate-context.md` for the human review
dialogue — so this needed NO new engine/gate mechanism, just richer `summary.md` content at round 3.
Confirmed via `sdk-runner.ts` that a gated node's `$DAGRUN_ARTIFACTS` directory is NOT wiped between
revise-self gate iterations (only `dagrun rerun`, the manual CLI command, wipes artifacts — and even
then, it archives the prior attempt to `<nodeId>-attempts/attempt-<N>/` first rather than deleting it;
see § 9's Burn Monitor section and DECISIONS.md § rerun-artifact-archiving), so
`fix.md` persists its own cross-round state in `$DAGRUN_ARTIFACTS/fix-history.log` (one
`round <N>: build/test <PASS|FAIL> — <reason>` line per round, appended at the end of Step 3's
self-verification; read back at the start of Step 3 to count consecutive trailing `FAIL`s).
`fix-history.log` is deliberately NOT in `produces` — it is scratch cross-round bookkeeping for
`fix` itself, never meant to reach the worktree or PR. When a round's build/test check fails for the
3rd consecutive time, `fix.md` writes a mandatory `## ⚠️ Architecture in question` section into
`summary.md` (which finding/test has failed 3 rounds running, a per-round reconstruction pulled from
`fix-history.log` + `feedback-*.md`, and an explicit recommendation to reject and send the run back
to `/define`/`/reproduce` for a revised guide rather than requesting a 4th fix attempt). A `PASS`
resets the streak to 0 regardless of a later human rejection for unrelated reasons (style, scope) —
the streak measures build/test convergence, not human satisfaction. `gate-review.md` is untouched —
its existing "present the full artifact content, do not truncate" instruction already surfaces the
new section with no edit needed.

**Red-flag / rationalization tables** were added to `implement.md`, `fix.md`, and `verify.md` — a
short (5-8 row) two-column table per node ("red flag phrase" → "what to do instead"), each tailored
to that node's actual failure modes (skipping the new RED step, scope creep, and leaving work
half-done for `implement`; scope creep beyond the cited finding, dismissing a still-failing test as
"probably flaky" without rerunning, and talking oneself out of the round-3 escalation for `fix`;
reinforcing — not duplicating — the existing Rule 1/2/3 self-heal boundary language for `verify`).
These are deliberately cheap, skimmable red-flag recognition aids, not new procedural steps.

**Testing note:** these three changes are prompt-only (no unit-testable engine surface beyond
confirming `smoke:mock` still passes and the new `red-evidence.md` produces entry doesn't break
anything — both confirmed). `smoke:live` was deferred for all three, consistent with this file's
established precedent for prompt-only changes whose new branches (a genuinely-red test, a 3rd
consecutive fix failure, a red-flag table being consulted) aren't reachable by a toy mock fixture —
see `DECISIONS.md § structural-upgrades-smoke-live-deferred`.

---

## 3f. digest — bottom-up knowledge map (terminal-adjacent, parallel with `pr`)

> **Reshaped (v0.1.50, decided with Eddie):** digest stays an optional, read-only, parallel-with-`pr`
> node but writes only two sections — deferred findings/unresolved risks and open reviewer questions
> (incl. whether the optional verify demonstration ran). The six-section bottom-up map described below
> is historical. Artifact name (`knowledge-map.md`) and node shape are unchanged.


**Why this exists:** an external task-intake tool (Glean, §2) gives Eddie a problem-first knowledge
map at the *start* of a run, before any planning happens. Nothing gave him the equivalent *after*
implementation — grounded in what actually got built, not what was planned — before he reviews the
PR diff or reads pr-triage's drafted replies on it. `digest` closes that gap.

**Placement (both workflows):** `id: "digest"`, `command: "/digest"`, `dependsOn: ["fix", "verify"]`
— the same dependency set as `pr`, so `digest` is scheduled in parallel with `pr` and adds no
wall-clock time to the run. It is deliberately NOT sequential after `pr`, NOT bolted onto an
existing node's command, and NOT a standalone on-demand command outside the DAG — see
`DECISIONS.md § digest-node` for the placement options considered. This addition is config-only:
`src/workflow/feature-workflow.ts`, `src/workflow/bugfix-workflow.ts`, and
`payload/commands/digest.md` — no engine change, since `runPrPostProcess`
(`src/runtime/run-engine.ts`) keys off `state.nodes["pr"]` by id, not by `pr` being positionally
last, and there is no worktree-cleanup path keyed on run completion or on `pr` for `digest` to
disturb (worktrees persist until PR close regardless).

**Model tier:** `sonnet`, not `opus`. This is synthesis of already-written artifacts (guide, diff,
`implement`/`fix` summaries, `review` findings, `verify`'s outcome) — not the adversarial,
ungrounded-claim-hunting judgment `review`'s `opus`-tier reviewers perform. Matches
`implement`/`fix`/`verify`'s cost-disciplined default.

**No gate:** informational only, read-only, does not mutate the worktree — the same pattern as
`review`. `produces: ["knowledge-map.md"]`, written to `digest`'s own artifact directory
(`<runDir>/digest/knowledge-map.md`), following the existing produces/artifactsDir convention every
other node uses.

**Workflow-tolerant, like `/implement` and `/pr`:** `payload/commands/digest.md` checks
`define/guide.md` first, then falls back to `reproduce/guide.md`, so one command file serves both
workflows with no fork (matching §3c's "Command reuse" note).

**Read-only diff access under a concurrency constraint unique to this node:** every other node in
the pipeline that reads the diff (`review`, `verify`'s deferred-to-CI check) runs at a point where
nothing else in the pipeline is concurrently mutating the worktree. `digest` is the first node that
does NOT have that guarantee — it runs in parallel with `pr`, whose Step 4 is a backstop
`git add -A && git commit` in the same worktree. `digest.md` therefore reads the diff via
`git diff "$(git merge-base origin/main HEAD)"` (working tree against the merge-base, no `--cached`,
no `git add` of its own) rather than `review.md`'s `git diff --cached origin/main` pattern — correct
whether or not `pr`'s commit has landed yet, and never touches the index itself.

**Content contract (six sections, in order, in `knowledge-map.md`):** Background (the
subsystem/area touched, terrain a reader needs before the diff makes sense) → The problem/feature
(INTENT restated from `guide.md`, not the implementation plan) → What was implemented (the diff,
file:line-grounded, organized by concern/component, with design choices/tradeoffs pulled from
`implement/summary.md`/`fix/summary.md`) → Review & fix (what `review/findings.json` flagged, what
`fix/summary.md` addressed vs. explicitly deferred) → How it was verified (the acceptance test
`verify` authored/reused, and a precise PASS-vs-`DEFERRED_TO_CI` read of `verify-report.json`'s
`outcome` — `DEFERRED_TO_CI` is non-blocking but means acceptance confirmation itself was deferred
to CI, not that it passed at that layer) → Open questions (what a PR reviewer is likely to ask).

**Explicit scope cut — pr-triage is NOT wired to consume this artifact.** pr-triage's `RUN_ID`
resolution falls back to a sanitized branch name when `DAGRUN_RUN_ID` is unset, so the run-id path
between a dagrunner run and a pr-triage invocation on the same PR may not line up — reconciling that
is a deliberate follow-up once `digest`'s content/format has proven useful standalone, not part of
this change. No file under `payload/siblings/pr-triage` was touched.

**Testing:** prompt-only content aside from the workflow config, matching §3e's precedent —
`feature-workflow.test.ts`/`bugfix-workflow.test.ts` assert the node's shape (dependsOn, model,
produces, no gate); `smoke:mock`'s generic `success` scenario (unrecognised node ids default to it,
writing every declared `produces` file) exercises the wiring end-to-end with no scenario-map change
needed. `smoke:live` was deferred — see `DECISIONS.md § digest-node`.

---

## 3g. Companion gates and the optional provision-and-hand-off verify (v0.1.50, reshaped v0.1.57)

**Companion gates (`Workflow.companionGates`, bugfix only).** Eddie plans in one local companion
conversation. `dagrun start bugfix … --companion-session <id>` records that conversation's
`CLAUDE_CODE_SESSION_ID` in `state.companion` (or `--no-companion` explicitly opts into the legacy
fresh-session gates; no silent default; `--night` is incompatible). At every gate (`reproduce`, `fix`,
and the new pre-PR gate on `pr`) the run pauses and dagrunner spawns **nothing**: it writes
`<gate>/gate.json` (run, gate, iteration, `revision`, plan sha, worktree HEAD, evidence hashes,
mechanical validation, pending decision) and `gate-context.md`, and prints how to return: `dagrun resume <run>` (no flags, in a
terminal) or `dagrun gate open <run>` resumes the recorded session from its original directory with an opening prompt that tells it a gate is
waiting (a bare `claude --resume` reopens the chat with no gate context). The companion drives the run with:

- `dagrun gate show <run>` — the brief.
- `dagrun gate decide <run> --gate <g> --revision <rev> --action approve|amend|hold …` — **two-step**:
  without `--confirm` it only PROPOSES (prints the exact action/scope and a decision id); only
  `--confirm <id>` executes. The id binds run, gate, revision, action, target, comment and run-next, so
  understanding / "continue explaining" / "looks good" can never advance a run, stale or wrong-run
  revisions are refused, and a repeated confirmed decision is a no-op (`gateHistory[].decisionId`).
- `dagrun gate attach <run> --session <id> [--reconstructed]` — recovery when the original session is
  gone (transcript missing) or for a legacy run; a reconstructed session is flagged, never the default.

Actions map onto existing machinery only: `approve` (existing approve), `amend` (revise the gate node
via feedback-N.md, or a workflow-declared `gate.amendTargets` ancestor — bugfix `pr` → `fix` — which
archives and resets every downstream node so no stale evidence is reused), `hold` (record, stay
paused). Legacy `resume --approve/--reject` is refused on companion runs. Independently, nothing here
authorizes merge, reviewer requests, marking ready, or backport labels; the draft PR is pushed/created
only after the pre-PR gate is approved (`runPrPostProcess`).

**Optional verify.** The `fix` gate has `decidesNode: "verify"`: approving requires an explicit
`--run-next yes|no` (agent advice lives in `fix/summary.md` § *Verify recommendation*). The decision is
persisted as `fix/next-node-decision.json`; `verify`'s `when` reads it (missing/garbled → loud error).
`pr`/`digest` use `joinRule: none-failed-min-one-success` so a *skipped* verify does not block them
while a *failed* one still does.

**verify is provision-and-hand-off, not self-test-and-teardown (v0.1.57).** verify builds the
candidate from the worktree, deploys it on a local loopback-only disposable target (docker
default; C8 Run / c8ctl where the repo has them), seeds demo data, proves the environment reachable
with one readiness probe, writes `demo.md` (how to reach it, exact manual steps + expected results)
and **stops with the environment still running**. It renders no verdict (the node is a one-shot
session and must never wait for a human). Eddie tests by hand and reports his verdict to the
*companion*, which makes the gate decision; only then is the environment removed. `verify-report.json`
is schema 3: `PROVISIONED | BLOCKED_RUNTIME` (only `PROVISIONED` passes; `DEMONSTRATED`/
`NOT_DEMONSTRATED` no longer exist). `evidenceCheck: "verify-runtime"` (`core/verify-evidence.ts`)
refuses a `PROVISIONED` claim without: a worktree-built candidate at HEAD, a matching dirty-file list
(normalized on both sides; `node_modules` and untracked-dir summaries ignored), a loopback
`local-disposable` target with a host `port`, a non-empty **typed** `target.ownedResources`
(`{kind: container|network|image|volume|tempdir, name}`, every name carrying `dagrun-<run-id>-` —
the durable inventory a later cleanup needs, since the node session is gone), `readiness`
evidence (an unreachable environment is not PROVISIONED), and `teardown: {status: "pending"}`.
A pure refactor with no user-observable runtime surface keeps the light path: `capability: "source"` +
`sourceRationale`, `ownedResources: []`, `teardown: not-applicable` — nothing provisioned, nothing to
clean up. On its own failure (`BLOCKED_RUNTIME`) the node cleans up its partial resources itself,
since no human will ever test them.

**Teardown is deterministic engine code, triggered by the verdict.** `core/verify-cleanup.ts` reads
the report (schema 3, and legacy schema 2 so old runs stay cleanable; a v2 report that already says
`cleanup: clean` is not pending), removes ONLY resources that are named in `ownedResources` AND carry
this run's `dagrun-<run-id>-` prefix (anything else is refused and reported, never touched), verifies
absence via `docker ps -a / network ls / image ls / volume ls` rather than trusting rm exit codes,
re-checks `git status --porcelain -uall` against the recorded `dirtyFiles`, and writes
`verify/teardown.json` (`{status: clean|leftovers, leftovers, removed, at, trigger, worktree}`; the
report is never rewritten). It is idempotent, and docker is reached only through an injectable
`execFile` seam. Two entry points share it: the standalone `dagrun verify cleanup <run-id>` (also the
retry path; non-zero exit + loud output on leftovers or worktree drift), and — reusing the
`gate decide` machinery, applied in `resumeRun` right where the decision is recorded — **any decide
action (approve / amend / hold) at a gate downstream of `verify`** (the pre-PR gate) tears the
environment down. A teardown failure is loud but never corrupts the recorded decision; an amend that
leaves leftovers records the decision then stops instead of re-provisioning under colliding names.
Amend tears down *before* the reset archives `verify/` (the report is the only inventory);
`rerun <run> verify` tears down a still-provisioned earlier environment first. The gate brief carries
`verifyEnvironment` (running, host:port, "manual testing pending", path to `demo.md`) and the
proposal statement warns that the decision tears the environment down, so the companion tells Eddie.
`dagrun status` / `dagrun list` flag a PROVISIONED-but-not-torn-down environment (no reaper).
The feature workflow has no pre-PR gate, so there only `dagrun verify cleanup` (plus that warning)
removes the environment. verify does not replace unit/integration/regression checks or CI.

## 3b. Validation — smoke:mock (per-plan gate) and smoke:live (occasional)

`npm run verify-baseline` = `npm ci && typecheck && unit tests && smoke:mock`. The standing gate: run on every plan change.

**smoke:mock** (`test/smoke/smoke-mock.ts`) drives both gated workflows in-process using the mock executor — zero API calls, deterministic. Asserts: gate pauses, produces-contract (and, since the verify-autonomy change, `outcomeGate`) at every relevant node, state transitions (awaiting-gate → paused → done), night-mode auto-approvals. Eight runs: **A** (feature workflow, full happy path — define/fix gates approved, `verify` runs autonomously to a `PASS` outcome, `pr` runs, run done — no election anywhere); **B** (bugfix workflow, same shape, proving the amendment's conditional-but-required `verify` on that workflow too); **C** (night-mode, clean plan — Gate 1 + Gate 2 auto-approved AND `verify` runs autonomously to `done`, the run completes fully unattended with no park, unlike the old verify-election design which always parked here); **D** (night-mode, seeded concern → parked at Gate 1, unchanged); **E** (stale gate from a prior workflow version auto-skipped on resume); **F** (a non-`PASS` `verify-report.json` outcome fails `verify` via `outcomeGate` and blocks `pr` — proven end-to-end through the real `startRun`/`resumeRun`/`runDag` path, with `resumeRun`'s intentional `process.exit(1)` on a failed run temporarily intercepted so the in-process smoke script can inspect the resulting `state.json` instead of dying with it); **G** (added by the structural-upgrades change — `noPlaceholders`: `define`'s `guide.md` contains an unresolved `TODO`, manually approved at Gate 1 via `resumeRun`'s `--approve` path, and the mechanical scan fails the node on the gate-approve transition itself — not `runDag`'s done-branch, since a gated node never reaches `done` there — blocking `implement` and failing the run); **H** (the same `noPlaceholders` proof through the OTHER gate-approve site — `startRun`'s night-mode auto-approve loop, using a placeholder-laden `guide.md` with no "Concerns / plan challenges" heading so it auto-approves rather than parking; needed a new `startRunCapturingExit` smoke helper mirroring `resumeRunCapturingExit` since `startRun`'s own night-mode loop also calls `process.exit(1)` on a failed run). G and H together are the load-bearing proof that `checkNoPlaceholders` is wired at BOTH places a gated node's status actually flips to `done`, not just where the analogous `checkOutcomeGate` happens to already live. Does NOT assert model output quality or exact session IDs.

**smoke:live** (`test/smoke/smoke.ts`) runs the real 8-step pipeline with the SDK — requires `ANTHROPIC_API_KEY`, ~35 min. Proves API auth, real session-resume, structured output from live model, worktree diff. Run when node prompts change (`payload/commands/*.md`) or when `sdk-runner.ts` changes. A bad prompt that passes mock but breaks model behaviour won't surface until the next smoke:live — that is the accepted tradeoff. **Reflection wiring (step 6):** smoke seeds a known `reflections.md` into `pr/` before the resume call so the SessionEnd hook has a deterministic file to capture — this proves hook wiring + env propagation in a real session without gating on spontaneous model output. The hook logic is separately proven by the unit test (`src/hooks/session-end.test.ts`).

**Executor-factory injection seam:** `startRun`, `resumeRun`, `rerunNode` all accept an optional `executorFactory` parameter (defaults to `makeSDKRunner`). This is the seam that lets smoke:mock swap in `createMockExecutor` without touching engine logic. See DECISIONS.md § split-smoke-mock-gate-live-occasional.

**Unit test coverage (co-located `*.test.ts`):**

- _Tier A (core)_: `dag.test.ts`, `state.test.ts`, `lock.test.ts`, `workflow.test.ts`, `settings-seed.test.ts` — DAG topology, state I/O, lock discipline, loadWorkflow, settings-seed merge rules.
- _Tier B (exported helpers)_: `xdg.test.ts` (`computeHomePath`, `resolveHome`, `resolveConfig`, `initHome`), `preflight.test.ts` (`getAgentContext`, `formatAgentContext`, fixture-able `runPreflight` predicates), `hooks/session-end.test.ts` (invokes `.claude/hooks/session-end.sh` directly in a temp env — proves reflection capture, best-effort no-op on absent/empty file, run_id field, friction.jsonl write).
- _Golden_: `report.test.ts` (HTML output of `generateReport` → `report.golden.snap`); `settings-seed.test.ts` extension (`buildSeededSettings` JSON → `settings-seed.golden.json`); `preflight.test.ts` (`formatAgentContext` text → `preflight.golden.txt`). Stored in `.snap`/`.txt`/`.json` to avoid Prettier hook reformatting (`.html` is in scope, those are not). `UPDATE_SNAPSHOTS=1` regenerates — a deliberate act.
- _Schema-contract_: `feature-workflow.test.ts` — well-formedness of `CLASSIFY_SCHEMA`/`FINDINGS_SCHEMA`, conforming+nonconforming fixtures (hand-rolled validator, no ajv), `featureWorkflow` passes `loadWorkflow`.
- _Tier C (orchestration)_ owned by smoke (never unit-tested).

---

## 4. The spine

- **run-id = `<slug>-<timestamp>-<hex>`** (the built format; no issue-number injection). The three-segment id is `<plan-basename-slug>-<Date.now()>-<6-char random hex>`. The hex suffix closes the same-millisecond collision window (two starts of the same plan in the same ms produce distinct ids). `startRun` additionally asserts the target run-dir does not exist before writing into it — fail loud if it does. Branch `feature/<runId>`. `makeRunId(planPath, now, suffix?)` is exported from `src/runtime/run-engine.ts` for unit testing; the suffix is injectable for determinism in tests and defaults to `randomBytes(3).toString("hex")` in production.
- **state.json** per run: top-level (runId, workflow, status, worktreePath, branch, sourcePlanPath, costs) + per-node (status, timestamps, artifacts, model, iteration, gateHistory, interruptRetries?). `gateHistory` entries carry optional `mode: "night"` and `basis` fields when the decision was made by night-mode automation.
- Checkpoint-and-exit at gates; reconcile-on-resume: `reconcileRunningNodes` marks any `running` node `failed` (crash recovery), then `resetInterruptedNodes` resets interrupt-reconciled nodes to `pending` up to `MAX_INTERRUPT_RETRIES` (currently 2, i.e. 3 total attempts) before leaving them permanently `failed`. Rationale: a transient Ctrl+C shouldn't permanently fail a resumable run, but an unbounded retry would never settle a genuinely broken node — the cap bounds both risks. The retry counter (`interruptRetries` on NodeState) is distinct from the gate iteration counter; stale-lock release follows reconcile.
- One run at a time (global lockfile; verify cluster fixed ports). Paused runs release the lock; resume re-acquires.
- Worktrees via `git worktree add` off DEVHARNESS_SRC; teardown deferred to explicit `dagrun cleanup` (never auto — manual test + PR-lifetime siblings need the worktree alive).
- Artifact channel: `~/.local/share/dagrunner/runs/<run-id>/<node>/` (survives teardown), passed to nodes as absolute path via env.
- `produces` contract: a node is `done` only if it wrote its declared artifact(s); missing => failed.
- XDG home: `~/.local/share/dagrunner/` (runs, worktrees, inbox, store, config.json), `~/.cache/dagrunner/`, `~/.local/bin/dagrun`, override DAGRUNNER_HOME, fail-loud no-cwd-fallback.
- Hooks: SessionStart sync (private files), PostToolUse format (**TS/JS/CSS/HTML only** — Java/YAML excluded after a YAML-coercion incident), Stop friction/gates, SessionEnd cost.
- `dagrun rerun` re-seeds the worktree `.claude/` from `payload/` (runtime-only: 10 pipeline commands + 7 reviewer agents). Hooks always come from `.claude/hooks/` (genuinely shared). `.claude/{commands,agents}` are build-harness-only and are never seeded into worktrees — this is the split that prevents build tools from polluting Camunda worktrees.
- `dagrun scaffold <node-id> --branch <feature-branch>` creates a scaffold run: worktree from the given branch, state.json with all transitive deps pre-marked done and the target node pending. Lets a developer run a single node in isolation via `dagrun rerun` without executing the full pipeline. No lock acquired; no agent launched by scaffold itself.
- Failure: 4-class taxonomy (transient->retry, contract->fail, convergence-exhaustion->gate, budget->checkpoint-exit). Node failure != run failure; isolate-and-continue.
- **CLI exit codes:** `dagrun start`/`resume` exit 0 on `done`/`paused`; exit 1 when the run ends `failed`. Callers (night queue, CI) must treat non-zero as a genuine failure — do not swallow it. The run engine owns the final status; the CLI layer propagates it.
- `dagrun report` static HTML (built, Phase 1).

---

### 5. Worktree hygiene — structural scratch backstop

Node `cwd` is the worktree, so a relative write lands in the worktree and risks reaching a PR.
Two structural guards (prompt discipline is no longer the only line of defence):

- **Prevention:** at `git worktree add`, seed the worktree's `.git/info/exclude` with the node
  artifact filenames (sourced from each node's `produces`) + secondary scratch patterns
  (`*.tmp`, `*-state.json`). Leaked artifacts/scratch can't be staged or PR'd.
- **Visibility:** before `pr`, a deterministic scan (`findWorktreeScratch`) checks `git status
--porcelain` for those names and writes an **advisory** `scratch-warning.txt` — surfaces a
  leaking prompt without blocking. Advisory + fail-soft: it never halts shipping.

---

## 6. Runtime permission model

Seeded into each worktree `.claude/settings.json`, loaded via `settingSources:["project"]`, node `cwd` = worktree. Distinct from the build-time `bypassPermissions` posture used by the agent that BUILDS dagrunner.

Goal: free inside the worktree, read anywhere, mutation outside hard-blocked, no prompts before a gate.

- `defaultMode: acceptEdits`; `additionalDirectories` includes the per-run artifact path (else every node prompts — the #1 prompt pitfall).
- `allow`/`deny` (`src/config/settings-seed.ts`): `./mvnw *`/`mvn *`/`git *`/`npm *`/`curl *`/`jq *`/`docker *` etc. allow-listed; `rm -rf`, `sudo`, force-push, `.env`/secrets read+write, `Write(.claude/**)` deny-listed. This allow/deny list, plus the PreToolUse deny-guard hook, IS the enforced mutation boundary — there is no filesystem sandbox underneath it (see below).
- **Two contexts, do not conflate:** the agent BUILDING dagrunner runs `bypassPermissions` + the fail-closed deny-guard hook; dagrunner RUNTIME nodes run `acceptEdits`/`bypassPermissions` (see the two-posture rule below) + the same deny-guard hook.
- **Two-posture permission rule (night-mode):** runtime nodes have two SDK `permissionMode` settings — `acceptEdits` for attended runs (human is present and can answer prompts) and `bypassPermissions` for night-mode (`--night` flag). The safety boundary — the Bash allow/deny list + fail-closed deny-guard hook — is written by `buildSeededSettings` independently of `permissionMode` and is never weakened by night-mode. Bypassing prompts (night) means "don't hang waiting for a human at 3am"; it does NOT remove the hook-enforced mutation fence. `selectPermissionMode(nightMode?)` in `sdk-runner.ts` is the single decision point, exported and unit-tested.
- **Every node session unconditionally sets `disallowedTools: ["ScheduleWakeup"]`** (`buildBaseQueryOptions` in `sdk-runner.ts`, mirroring `selectPermissionMode`'s extraction pattern). A dagrunner node session is a single one-shot SDK `query()` call — `applyNodeEnv` → `query({ prompt, options })` → drain the message stream to completion → return — with no external mechanism that ever resumes or re-invokes it later. `ScheduleWakeup` persists a durable wakeup for an EXTERNAL scheduler to fire the `/loop` skill later; dagrunner never wires up that scheduler and never will, so the tool is categorically incompatible with every node, not just `verify` (see `DECISIONS.md § verify-scheduleawakeup-incompatibility` for the run-54177-1 evidence that motivated this).

> **History — there used to be a filesystem sandbox here; it's gone, not just disabled.** Earlier design (`phase2b-verify-guide` in `DECISIONS.md`) had runtime nodes wrapped in a macOS Seatbelt sandbox (`sandbox.enabled: true` + `autoAllowBashIfSandboxed` + network `allowedDomains`), with `gh`/`git push` failing inside it (TLS cert mismatch with the sandbox's network proxy) — which is why the `pr` node still pushes/opens the PR via Node.js **outside the agent's own session** rather than via an in-session `gh` call (see `runPrPostProcess` in `run-engine.ts`). Commit `3015634` set `sandbox.enabled: false` (it was blocking Maven writes to `**/target/`), and the verify-autonomy change (§3d, `DECISIONS.md § verify-autonomy-remove-election`) removed the `sandbox` key from `buildSeededSettings` entirely, since a permanently-`false` toggle with no code path to re-enable it was dead config, not a real security posture — see `DECISIONS.md § night-mode-permission-posture` for the fuller history. The `gh`/`git push`-outside-session design was kept (pushing deterministically from Node.js rather than trusting the agent's own command construction is still good practice on its own merits) but the original TLS-under-proxy rationale for it no longer applies and has not been re-verified against the current deny-guard-only boundary.

---

## 7. Preflight ("Prepare") — not a node

`dagrun preflight` runs before the graph: on expected base branch; git tree clean; DEVHARNESS_SRC resolves+is a repo; seeded settings present; ANTHROPIC_API_KEY unset; CLAUDE_CONFIG_DIR=~/.claude-work; enterprise policy doesn't block; artifact path in additionalDirectories. (No sandbox/network-allowlist check — there is no sandbox to check; see §6.)

**Version banner (implemented):** `dagrun preflight` and a passing `dagrun start` both print dagrunner's own package version + build date/time before any node runs — `src/config/version.ts` (`getVersionInfo`), surfaced via `formatAgentContext` (preflight) and `formatVersionBanner` (start). Compiled binaries read the compile-instant timestamp from `dist/build-meta.json` (regenerated every `npm run build` by `scripts/write-build-meta.mjs`) and fail loud if it's missing; dev mode (`tsx`) prints `(dev, unbuilt)`. This makes drift between a rebuild and the running `~/.local/bin/dagrun` binary visible instead of assumed. Every dagrunner self-change bumps this version (enforced by `dr-build`, see `.claude/agents/dr-build.md`).

**Toolchain pin (NOT YET IMPLEMENTED):** the design calls for `claude` CLI to be pinned to an `EXPECTED_CLAUDE_CLI_VERSION` constant (planned home: `src/config/versions.ts` — note the plural, a distinct module from the version-banner's singular `src/config/version.ts` above) and checked via `claude --version` at preflight time, failing loud on mismatch (bypassable via `DAGRUN_SKIP_CLI_VERSION_CHECK=1`). **Neither the constant nor the check exists in the repo today** — this paragraph describes the intended design, not shipped behavior. Do not treat `claude --version` pinning as enforced until this is built. The Agent SDK dependency itself IS pinned exact (no `^` caret) in `package.json`; `npm ci` enforces it via the lockfile. **When this is eventually built:** bump `EXPECTED_CLAUDE_CLI_VERSION` + `package.json` SDK version together, run `npm install` to resync lockfile, run `smoke:live` once to confirm the new pair works, commit both in the same change.

---

## 8. classify — REMOVED; task-type routing designed fresh when needed

No classify node. Reviewer-selection moved into review's diff-triage step (reads the diff — better input than predicting from the plan). Former classify outputs relocated: needs*runtime -> human verify-election; recommend_pr_review -> human reads `dagrun status`; run_adversarial_verifier -> finding-count threshold; risk -> removed; touches*\* -> review diff-triage.

**Why classify is gone:** dormant code is drift risk — it reads as live, ages silently, and constrains future design. A future task-type router (feature/bug/tech-debt) earns a node only when it ROUTES the graph, not when it annotates. Change-AREA is diff-derivable; task-TYPE reshapes the graph upfront. That router will be designed fresh from current understanding when actually needed (Phase 5/6 or later) — not revived from stale scaffolding.

## 8b. reflect — hook-driven distributed capture

Each node optionally writes tips/gotchas to `$DAGRUN_ARTIFACTS/reflections.md`. The **SessionEnd hook** (`.claude/hooks/session-end.sh`) reads this file when the node finishes and appends one stamped JSONL entry to the durable store. The log outlives the run (stored in `~/.local/share/dagrunner/store/reflection-log.jsonl`, not in `runs/<id>/`). Capture is fail-soft — a hook failure never blocks a node.

- **Node contract:** nodes write `reflections.md` if they have useful tips; absence is fine. `fix` writes `reflections.md` whenever fixes were applied (fallback: "No non-obvious discoveries."). No node is required to write it for test coverage — the hook mechanism is proven deterministically (see Testing §14 and DECISIONS §deflake-reflection-capture-test).
- **Entry shape:** `{ ts, source, run_id?, body }` — that's it. There is no `kind` field. An earlier design reserved `kind` as a routing hint (`camunda-knowledge` | `dagrunner-harness`) settable via a manual `dagrun reflect --kind ...` flag, but a reflection-log audit found zero of 105 entries across 53 days carried it — 100% of real capture comes via the SessionEnd hook, which never had a kind to infer (its payload is `{session_id, transcript_path, cwd, hook_event_name, reason}`, no semantic signal), and the manual `--kind`-requiring CLI path was never actually invoked by any prompt (`grep`-verified: no file under `payload/` references `dagrun reflect` at all). The field was removed entirely — see DECISIONS.md § reflect-drop-kind.
- **Manual/sibling append:** `dagrun reflect --source <node> --body "<text>" [--run-id <id>]` exists as a CLI entry point, but nothing in `payload/` currently calls it — capture is 100% hook-driven in practice today.
- **Durability invariant:** `DAGRUN_STORE_DIR` is injected explicitly by the launcher (never derived via `../../` from the run dir). The store is outside the run dir and survives `dagrun cleanup`.
- **Harvest:** periodic human + architect process, with no runtime `kind` to route by — the harvester reads each entry's `source`/`body` and makes the camunda-knowledge-vs-dagrunner-harness call itself at harvest time. This is how routing has actually worked in practice (every harvest to date), not a placeholder for a mechanism that was never built.
- **Why hook-driven:** prompt-driven + fail-soft + bare-`dagrun` = three layers of "maybe" over an unowned PATH (the prior mechanism failed silently — see DECISIONS.md §hook-driven-reflection-capture). The SessionEnd hook is code we own, on a signal that already fires.

The old `reflect` + `apply-reflection` nodes are removed. `pr` is terminal; `digest` (§3f) is
terminal-adjacent — it runs in parallel with `pr` off the same two dependencies and nothing depends
on it.

---

## 9. Cost & model tiering

Per-node tiering in the validated workflow-def (load-time model-string validation). expand unpinned; review diff-triage haiku; reviewers mixed (correctness/distributed-systems/performance unpinned; test-adequacy/api-stability/migration-safety sonnet); adversarial verifier strong tier; fix sonnet; verify sonnet; pr haiku; digest sonnet (§3f — synthesis of already-written artifacts, not adversarial judgment, so it doesn't need opus). Two-tier budget: per-run `--max-budget-usd` + per-invocation caps. Cost capture: `--output-format json` total_cost_usd; `dagrun status` shows total vs cap.

**Effort tuning (orthogonal to model tier):** `Node.effort?: EffortLevel` (`"low" | "medium" | "high" | "xhigh" | "max"`, `src/core/types.ts`) passes through to the SDK's `Options.effort`, validated at load time exactly like `model` (`workflow.ts`, same "typed at load" pattern — a bad value is a load error, never a silent runtime default). Omitted = the SDK's own model-specific default (on Sonnet 5 this is `"high"` with adaptive thinking on, per the SDK's `sdk.d.ts`). `implement` and `fix` in both `feature-workflow.ts` and `bugfix-workflow.ts` pin `effort: "medium"` — real burn-instrumentation evidence (run `54177-1`) showed these two `claude-sonnet-5` nodes as the run's dominant cost (`implement` $38.37, `fix` $5.82), and neither had ever deliberately set `thinking`/`effort`; per Sonnet 5's own migration documentation, `"medium"` is comparable in intelligence to the prior generation's `"high"`, making it a documented, low-risk step down rather than a guess. `verify`/`review`/`define`/`reproduce`/`pr` are deliberately excluded from this first cut — see DECISIONS.md § effort-tuning-implement-fix for the full rationale and why full `thinking: disabled` was rejected. The per-node option mapping (model/allowedTools/maxBudget/outputSchema/effort) lives in the pure, unit-tested `applyNodeOptions` (`sdk-runner.ts`), extracted alongside `buildBaseQueryOptions` so it's testable without mocking the SDK's `query()`.

**Burn capture (per-node `burn.json`, Deliverable 1 of the Burn Monitor):** the SDK's terminal `result` message carries `modelUsage: Record<string, ModelUsage>` (per-model input/output/cache-read/cache-creation tokens + cost, free alongside `total_cost_usd`) — dagrunner previously discarded this, keeping only the aggregate cost. `sdk-runner.ts` now captures it at the same single write-site as `friction.jsonl` (right after the SDK message loop, before all early returns — failed/awaiting-gate/done all pass through it) and writes `$DAGRUN_ARTIFACTS/burn.json` via the pure, unit-tested `buildBurn()` (`src/runtime/burn.ts`). `friction.jsonl` gains an additive `modelUsage` field (existing `costUsd` consumers — `cli.ts`, `report.ts` — are unaffected; they treat friction lines as opaque strings). **This cannot be captured from the SessionEnd hook** — `.claude/hooks/session-end.sh`'s payload is `{session_id, transcript_path, cwd, hook_event_name, reason}` only, no cost/usage fields; the SDK result message is the only carrier, and `sdk-runner.ts` is the only place that sees it.

`burn.json` v1 (`schemaVersion: 1`, `phase: "rollup"`, `intraNode: null` always through D1+D2) buckets each model id into a dagrunner tier (`opus`/`sonnet`/`haiku`/`unknown`) via `modelIdToTier()` (`src/runtime/burn.ts`). Missing/malformed `modelUsage` writes an explicit `{error: "modelUsage missing from SDK result"}` marker — never a silently-zeroed derived block.

**Empirical finding (real `review`-node run, `53861-1`, opus-tier parent node with sonnet-tier fan-out):** `modelUsage` contained two keys — `claude-opus-4-8` (the review node's own pinned tier) and `claude-sonnet-4-6` (the reviewer subagents' pinned model, set in `payload/agents/*.md` frontmatter). **Subagent token usage rolls up into the parent node's `modelUsage` as a distinct, separately-tiered entry — visible at the rollup level, not merged away.** A tier-leak feature does not need to wait for transcript-level parsing.

**Deliverable 2 — report rendering + hotspot detection:** D1 shipped exact-string classification, which missed the `claude-sonnet-4-6` case above (bucketed to `tierMix.unknown`). D2 fixed this: `modelIdToTier()` now classifies via case-insensitive substring match (`"opus"`/`"sonnet"`/`"haiku"`) instead of an exact-id map, so `claude-sonnet-4-6` — and any future dated/aliased model id in a known family — classifies correctly without dagrunner needing to enumerate every id Anthropic ships. The same function doubles as the declared-tier classifier for a node's `NodeState.model` (which holds either a short tier alias like `"sonnet"` in fixtures/tests, or the full pinned id like `"claude-sonnet-5"` at runtime — substring matching handles both).

`dagrun report` (`src/cli/report.ts`) now renders each node's `burn.json`: cache-creation/read split, output tokens, per-tier mix (with any `tierMix.unknown` tokens shown visibly as "unclassified" — never silently dropped, extending burn.json's own fail-loud principle into the report), and hotspot badges. Four hotspot checks, all pure functions in `burn.ts` (`detectColdReloadTax`, `detectTierLeak`, `detectOutputHeavy`, `computeFatPrefixFlaggedNodes`, composed per node by `computeNodeHotspots`):

- **cold-reload-tax** — `derived.cacheColdRatio` above a threshold (a node is re-paying its fixed prompt prefix on nearly every turn instead of hitting cache).
- **tier-leak** — the node's `tierMix` has nonzero tokens in a tier strictly above its _declared_ tier (e.g. a `sonnet`-declared node whose subagent fan-out used `opus`). Skipped entirely when the node has no declared tier — there is no expectation to violate. `tierMix.unknown` tokens never trigger this flag on their own.
- **fat-fixed-prefix** — run-level: the fraction of nodes-with-valid-burn-data whose `cacheCreationTokens` exceed a threshold; if that fraction covers most of the run, every node meeting the per-node threshold gets the badge. A single large-context node isn't a hotspot; a prefix that's fat almost everywhere usually is.
- **output-heavy** — `outputTokens` is a disproportionate share of the node's total tracked tokens (candidate for a cheaper model or shorter-output prompt).

All four thresholds (`COLD_RELOAD_TAX_THRESHOLD`, `OUTPUT_HEAVY_SHARE_THRESHOLD`, `FAT_PREFIX_TOKEN_THRESHOLD`, `FAT_PREFIX_NODE_COVERAGE`) are hardcoded named constants in `burn.ts`, explicitly provisional — no config system was added; they will be tuned once a body of real `burn.json` evidence exists. The report also adds a run-level Token Rollup section (totals by bucket and by tier, plus run-wide cold-reload tax via the same `cacheColdRatio()` D1 already shipped). A node with a `BurnDocError` marker or with no `burn.json` at all (never ran, predates this feature, or the file is unparseable) renders "no burn data" — the report never throws and the node's existing status row is unaffected.

**D3 (transcript-parsing spike) is GO for D4** (read-only investigation, no capture code shipped — see DECISIONS.md § `burn-monitor-d3-spike`). Against the real `53861-1`/`review` session: node→JSONL is deterministic (glob `<claudeConfigDir>/projects/*/​<sessionId>.jsonl` — do not reverse-engineer Claude Code's cwd-sanitization scheme); `assistant` records carry full, untruncated `usage` blocks (dagrunner's own 8 KB `transcript.log` truncation is irrelevant — D4 reads the raw config-dir JSONL, never `transcript.log`); each subagent invocation has its own file (`<sessionId>/subagents/agent-<agentId>.jsonl` + a `meta.json` sidecar giving the exact reviewer-dimension name, `toolUseId` linkage, and `spawnDepth` — cleaner than the plan's `isSidechain`/`parentUuid`-in-one-file guess, though the subagent file also carries those fields); and oversized tool results are externalized by Claude Code itself to `tool-results/<hash>.txt` with an explicit size+path marker keyed by `tool_use_id` in the JSONL — no delta-accounting needed.

**D4a (intra-node attribution — capture only) shipped** — `src/runtime/intra-node.ts`, called from `sdk-runner.ts` right after the rollup `burn.json` write, in its own independent try/catch (a failure here never blocks the node and never affects the already-written rollup doc — same fail-soft posture as the `friction.jsonl`/`burn.json` writes it sits next to). On success, `burn.json` is overwritten in place with `phase: "transcript"` and a populated `intraNode`; on any failure to locate/parse the session JSONL, the rollup doc written moments earlier stands unchanged (`phase: "rollup"`, `intraNode: null`) — this is a normal degrade path, not an error state. `intraNode` carries: `subagents[]` (per reviewer-dimension `agentType`, dominant `tier`, summed `tokens`, and `apportionedCostUsd` — the model's rollup `costUSD` split proportionally by each party's token share, since subagent turns carry no cost field of their own); `toolCallCounts` and `retryCount` (combined across parent + all subagents); `verboseToolOutputs[]` (tool results Claude Code itself externalized to `tool-results/<hash>.txt`, parsed from its own in-band size+path marker — no second threshold invented); and `reconciliation` (always present, per rollup model id, comparing the intra-node token sums against the same node's trusted rollup — observational, never a pass/fail gate on the node).

**Corrected dedup rule (D4a finding — supersedes the D3 spike's prose on this one point):** the spike's own writeup said streaming-duplicate JSONL lines (same `message.id`, re-emitted 3-4x) carry "identical usage values." Re-verifying against the same real session while building D4a found this is only true for input/cache tokens (fixed at request time) — `output_tokens` and the `content` array's `tool_use` blocks actually GROW across duplicates as the response streams, since each duplicate is a fuller cumulative snapshot of the same turn. Deduping by "first occurrence wins" (a literal reading of the spike's prose) undercounted output tokens by 30-60% against the trusted rollup. The corrected rule — **last occurrence per `message.id` wins** — reconciles exactly against `burn.json`'s rollup on the same real run: input/cache-read/cache-creation deltas are exactly 0, output tokens land at the same ~-5%/-13% residual the D3 spike itself had already found and attributed to a streaming-finalization artifact (not a dedup or attribution bug). See DECISIONS.md § `burn-monitor-d4a-intra-node-capture` for the full numbers.

**D4b (intra-node rendering — the Burn Monitor's final deliverable) shipped** — `dagrun report` (`src/cli/report.ts`) now renders `intraNode` for any node whose burn.json is `phase: "transcript"`; a `phase: "rollup"` node (predates D4a, or the session JSONL wasn't locatable) renders exactly as it did after D2, unaffected. A new **Intra-Node Attribution** section (one block per transcript-phase node) adds: a **subagent fan-out drilldown** — one row per subagent, `agentType`/`tier`/token breakdown/`apportionedCostUsd`, sorted DESCENDING by apportioned cost — the plan's headline "split the review node's cost per reviewer" deliverable; **tool-call counts** (name → count, sorted descending) and **retry count** (rendered only when nonzero); **verbose tool outputs** (tool name + size in KB — deliberately omits the on-disk transcript path, host-local Claude Code internal clutter with no report value, unlike every other in-repo/run-directory artifact link this report exposes); and **reconciliation deltas** (delta + delta % per rollup model id, rendered plainly with no color-coding or pass/fail styling — this is burn-capture's own observational self-check, not a gate). Two new hotspot flags extend `computeNodeHotspots` (`src/runtime/burn.ts`), both degrading to "no flag" on a null `intraNode` so rollup-phase nodes are unaffected: **verbose-tool-output** (fires on presence alone — Claude Code's own externalization already thresholded the signal, no second threshold invented) and **fan-out-multiplier** (fires when at least `FAN_OUT_MULTIPLIER_MIN_SUBAGENTS` (2) of a node's subagents each independently clear `FAN_OUT_MULTIPLIER_CACHE_READ_THRESHOLD` (500,000) cache-read tokens — the "same cached context re-read N times across a fan-out" cost multiplier — reporting the qualifying count and the summed cache-read tokens across only the qualifying subagents). Both thresholds are provisional named constants, same status as D2's four. **Not implemented, and explicitly out of scope:** a third transcript-derived hotspot ("runaway thinking on non-reasoning nodes") the original plan mentioned — D4a's `intraNode` schema has no thinking-vs-output-text split to derive it from (D4a's own build report noted this sub-bucket was omitted as not a clean/cheap addition); adding it would require reopening D4a's capture schema, out of scope for a rendering-only deliverable. See DECISIONS.md § `burn-monitor-d4b-report-rendering`.

**This closes the Burn Monitor plan end to end:** D1 (rollup capture) → D2 (report rendering + rollup-level hotspots) → D3 (transcript-parsing feasibility spike) → D4a (intra-node capture) → D4b (intra-node rendering). `dagrun report` now shows, for any node with transcript-phase data, exactly which reviewer dimension drove a fan-out node's cost, how many tool calls and retries it made, which tool outputs got externalized for size, and how well burn-capture's own transcript-derived sums reconcile against the trusted SDK rollup — the full loop from "the SDK discards this" (D1's starting point) to "a human reading `dagrun report` can see it."

**Retry-attempt archiving (burn-monitor-adjacent, not a Burn Monitor deliverable itself):** all of the above — `burn.json`, `friction.jsonl`, `transcript.log`, `reflections.md` — describes ONE node attempt. `dagrun rerun <run-id> <node-id>` is the only place a node's artifacts directory is ever wiped between separate CLI invocations, and until this change that wipe was a plain `rmSync` — every attempt before the last was destroyed, with no record of what happened or why it failed. Real evidence this mattered: run `54177-1`'s `verify` node was manually rerun 7 times over 3 days chasing an intermittent Docker/environment issue (~$27.84 total across those attempts, per `friction.jsonl`, which — unlike `transcript.log`/`reflections.md`/`burn.json` — is append-only and survived); by the time anyone went looking for _why_ the middle attempts cost what they did, only the last attempt's transcript/reflections/burn.json existed to explain it. `run-engine.ts`'s `rerunNode` now calls a small pure helper, `archivePriorAttempt(runDir, nodeId, artifactsDir)`, immediately before the wipe: if the artifacts directory exists and is non-empty, it is renamed (not copied — same-filesystem, so this is cheap) to `<runDir>/<nodeId>-attempts/attempt-<N>/`, where `N` is the next sequential integer for that node id (independent per node — `verify-attempts/` and `review-attempts/` number separately). A rerun of a node with no prior artifacts (or an already-empty directory) is a no-op — nothing to preserve. See DECISIONS.md § rerun-artifact-archiving for the full design-choice rationale, and `src/runtime/run-engine.test.ts`'s `archivePriorAttempt` suite (5 tests, teeth-checked) plus `test/smoke/smoke-mock.ts` Run I (the only smoke-mock run that exercises `rerunNode` at all, also teeth-checked at the wiring call site, not just the pure function) for verification. **`resumeRun`'s matching gap is now closed too:** the crash-recovery retry path (`resetInterruptedNodes` resetting a `failed`-by-interrupt node back to `pending`) used to re-execute into the SAME artifacts directory with no wipe and no archive — a node's session-level writers (`transcript.log`/`burn.json`, both `writeFileSync`, which truncates) silently overwrote the interrupted attempt's partial output, while `reflections.md` (appended by the SessionEnd hook) duplicated onto it instead. This was empirically confirmed, not just theorized: 10 of 105 entries in `store/reflection-log.jsonl` are byte-identical duplicates across three runs (`53857-1`, `53861-1`, `54316-1`), none of which had a `-attempts/` directory — ruling out `rerunNode` as the cause. `resumeRun` now calls `archiveInterruptedNodeArtifacts(runDir, stateBefore, stateAfter)` immediately after `resetInterruptedNodes`, which reuses the same `archivePriorAttempt` helper (archive-then-wipe) for every node that transitioned `failed` → `pending` in that call. See DECISIONS.md § resume-interrupt-artifact-archiving, `src/runtime/run-engine.test.ts`'s `archiveInterruptedNodeArtifacts` suite (3 tests, teeth-checked), and `test/smoke/smoke-mock.ts` Run J (teeth-checked at the `resumeRun` wiring call site, not just the pure function — mirroring Run I's precedent for `rerunNode`).

---

## 10. Phase 3 siblings — THREE interactive Claude Code commands

All three: Claude Code commands in the **Camunda monorepo's private `.claude/`** (alongside `/pr-review`, gitignored via `.git/info/exclude`), **copied into each worktree by dagrunner's seed/sync** and RUN inside the worktree (where the built code, PR branch, and cluster live). Edit the canonical copy in DEVHARNESS_SRC; the worktree copy is ephemeral. Interactive, human-driven — they need Docker, host ports, `gh`, broad network, none of which the autonomous DAG's fire-and-forget nodes are a good fit for; that's why they're commands, not nodes. Run under CLAUDE_CONFIG_DIR=~/.claude-work. Built one at a time, in order.

> DROPPED: the dedicated "/verify-demo environment creator" (DMS-based cluster + breakpoint placement). The **c8ctl dev plugin** spins up a configured local OC smoothly, making a separate cluster-creator command unnecessary. The **Debugger MCP Server (DMS)** is parked for a FUTURE bug-fix / issue-investigation workflow (where programmatic breakpoints aid an investigating agent) — it has no role in the feature-task workflow. **Since the verify-autonomy change (§3d), the pipeline's `verify` node no longer emits `seeding-spec.json`/`manual-test.md` at all** — that generation moved to the on-demand `/manual-smoke` sibling (§10.4). The code-trail the old `tour-spec.json` carried is folded into `manual-test.md`, and no automated breakpoint-placer consumes it.

### 10.1 seed-data (Sibling 1)

- Assumes the human has ALREADY spun up a local Orchestration Cluster via the **c8ctl dev plugin** (smooth, human-driven — this command does NOT create or tear down the cluster).
- Consumes `seeding-spec.json` — **since §3d, this comes from `/manual-smoke` (§10.4), invoked on demand, not from the pipeline's `verify` node** (verify no longer produces this file at all). Seeds the running cluster via **c8ctl**: resolve abstract deployments to concrete BPMN (the spec gives descriptions, not files), deploy `deployments[]`, start `instances[]` with their variables, capture instance keys, and confirm `expected_observations[]` are reachable (ES doc present; REST call recorded but not asserted — the human observes the value).
- If no OC is reachable, fail loud telling the human to start one first.
- Named generically (`/seed-data`, not demo-specific) so it is reusable for manual testing, reproduction, and investigation — not only feature demos.

### 10.2 ci-babysit (Sibling 2)

Local: monitors CI on the open PR, rebases on base, fixes failing checks (scoped to making CI green — never a backdoor for feature changes), and re-verifies before pushing. Needs the local cluster (human-started via the c8ctl dev plugin) for runtime re-verification + private context (why it's local, not gh-aw). Uses `gh` and `git push` directly; rebase pushes use `--force-with-lease`, never blind `--force`.

**Human gate (never auto):** the **draft -> ready flip** is ci-babysit's defining gate — when CI is green and re-verification passes, it surfaces the readiness summary and the `gh pr ready` command but NEVER flips the PR itself. Readiness is not latched: new commits/failures reopen the work and re-present the gate.

**Poll/trigger machinery (built here, reused by pr-triage):** ci-babysit owns the Claude Code Desktop scheduled-task / poll loop and the crev-style `--since <prior-run-id>` incremental pattern (act only on new commits/failures since the last tick; checkpoint-and-exit per tick, state on disk). pr-triage (§9.3) imports this loop rather than building a second one.

Operates over the PR lifetime — in a dagrunner-managed worktree (`DAGRUN_RUN_ID` set) it must
persist (don't `cleanup` until the PR is closed). Neither sibling requires a dagrunner worktree,
though: Phase 0 gates only on PR discoverability (`gh pr list`/`gh pr view` for the current
branch), not on branch naming or worktree origin — both run from any git checkout, on any branch,
as long as a PR exists for it. `RUN_ID` falls back to the sanitized current branch name
(`/` → `-`) when `DAGRUN_RUN_ID` is unset, so sequential runs on different branches out of the
same checkout don't collide on one state directory.

### 10.3 pr-triage (Sibling 3)

Local: polls the open PR for new review comments across **three gh API endpoints** — inline review
comments (`pulls/{pr}/comments`), PR-level issue comments (`issues/{pr}/comments`), and review
summaries (`pulls/{pr}/reviews`) — classifies each, drafts replies as artifacts in
`pr-triage/drafts/`, and surfaces a **per-comment human approve/post gate**. **NEVER auto-posts.**

**Bot detection:** `user.type == "Bot"` is reliable and must be used as the primary signal.
Login `[bot]` suffix is NOT reliable — Copilot inline surfaces as `"Copilot"` with no suffix
but `user.type == "Bot"`. Never use the login suffix as the sole test.

**Triage-state lifecycle per comment:** `seen → drafted → {posted | skipped | superseded}`.
Edited comments re-enter as `superseded` — the prior draft is archived to `prior_draft_file`,
not silently overwritten. This ensures the human always sees what changed.

**Coexistence contract with ci-babysit:** ci-babysit owns all git mutations (rebase, fix, push).
pr-triage owns the comment conversation only. pr-triage MUST NOT call `git push`, stage files,
edit source files, or commit. The two commands share the same worktree but have strict domain
separation enforced by convention.

**Artifact path:** `~/.local/share/dagrunner/runs/<run-id>/pr-triage/` — drafts live in
`pr-triage/drafts/<comment-id>.md`; triage state in `pr-triage/triage-state.json`.

**Poll machinery:** reuses ci-babysit's scheduled-task / poll loop and `--since` incremental
pattern (§9.2) — it does NOT build a second loop; per tick it ingests only new/edited comments
since the last processed marker.

gh-aw deliberately rejected (its async edge is cancelled by the human gate; safe-outputs
governance redundant with never-auto-post; data-governance cost not worth it). Revisit only if
this becomes team-scale, multi-repo, no-single-human-gate infra.

### 10.4 manual-smoke (Sibling 4 — added by the verify-autonomy change, §3d)

`payload/siblings/commands/manual-smoke.md`. Generates a human-readable `manual-test.md` — plus
`seeding-spec.json`, only when a live cluster is actually needed — for a completed (or
past-Gate-1) run, replacing the fixed `seeding-spec.json` + `manual-test.md` pair the pipeline's
`verify` node used to write before verify became autonomous (§3d, `DECISIONS.md §
verify-autonomy-remove-election`) — relocated here rather than deleted, since the manual-walkthrough
value didn't disappear, only the reason to gate on it did.

- **Invocation:** `/manual-smoke [run-id]`, run on demand against any completed (or past-Gate-1)
  run's existing artifacts — bootstrap logic (run/worktree/guide resolution) lives in
  `payload/siblings/scripts/manual-smoke/phase-0-bootstrap.sh`.
- **Read-only from the worktree, and never executes anything against a live cluster or locally** —
  never modifies worktree files, never runs Maven/Docker/`curl`/`zdb`/cluster commands itself, only
  writes into the run's own `manual-smoke/` artifact subdirectory (so it can be invoked repeatedly,
  including against a run whose `verify` node failed its `outcomeGate`, without disturbing pipeline
  state).
- **Gates nothing.** Unlike the removed verify-election, this sibling has no pipeline effect —
  it exists purely for a human who wants a walkthrough, independent of that run's `verify` outcome.
- Reads the same input priority order the old verify-guide used: run artifacts (`plan.md`,
  `define/guide.md` or `reproduce/guide.md`, `implement`/`review` outputs) → git log → git diff →
  OpenAPI spec (only actually read if the REST API is a chosen surface, see below).
- **Analyzes the diff to choose a verification method before writing anything (`verify-manual-smoke-method-analysis`,
  DECISIONS.md).** The old version always assumed a live cluster reachable via REST API/Postman,
  which breaks for a diff that never touches the REST gateway or any secondary-storage export path
  at all (e.g. a change confined to Optimize, or an internal broker/engine change with no
  externally observable contract). It now picks from: `rest-api` (Postman/curl against the REST
  gateway, spec-grounded), `secondary-storage` (a direct ES/OS/RDBMS query via a database client),
  `zdb` (the Zeebe debugging tool, for broker/engine/stream-processor internals REST/secondary
  storage can't fully observe — its actual CLI shape is located in the worktree at generation time,
  never assumed from memory), or `existing-test` (no live-cluster surface applies at all — names
  the specific pre-existing test class/suite that already covers the changed behavior, e.g. an
  Optimize E2E suite, and the exact local command to run it). Multiple methods can combine (e.g.
  `rest-api` + `secondary-storage` for a REST-triggered, ES-materialized feature); `existing-test`
  is exclusive of the others — when it's the only applicable method, `seeding-spec.json` is omitted
  entirely (there is nothing to seed) and `manual-test.md` names the test command instead of
  cluster-seeding steps.
- `seed-data` (§10.1) automates confirmation for `rest-api` and `elasticsearch` observations only —
  `opensearch`/`rdbms`/`zdb` observations already degrade gracefully to a `NOT_CHECKED` record
  (unchanged; `seed-data` itself was NOT modified by this change), leaving confirmation to the
  human via `manual-test.md`'s own concrete steps.

### Removed from scope

**/pr-review**: kept as a private standalone command for reviewing OTHERS' PRs; removed from dagrunner scope (redundant on own PRs given in-pipeline review + Copilot + human + crev). No dynamic-workflow rebuild. Dynamic workflows are not used anywhere in dagrunner.

---

## 11. Phase roadmap

| Phase  | Scope                                                                                                                                                                                                                                                                                                                         | Status             | Gated by    |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------- |
| **1**  | Engine + spine + thin slice + Gate 1; state/resume/worktrees/artifacts/hooks/launcher; `dagrun report` static HTML. (Built classify/expand/implement — classify-as-a-node since RETIRED; its logic moved into review's diff-triage.)                                                                                          | ✅ DONE & hardened | —           |
| **2a** | (1) Preflight + runtime permission/sandbox/network model [FIRST]; (2) review node (diff-triage self-select + fan-out + finding-count-gated verifier -> findings schema); (3) fix node (gated, self-verifying). Built, fixture-passed, post-fixture restructure (classify removal etc.) applied.                               | ✅ DONE            | —           |
| **2b** | verify-election + verify (doc-only; cluster automation REMOVED, see §9) + Gate 3; pr node (terminal); pure-capture reflection via dagrun reflect-append; rerun command; PR post-process outside sandbox.                                                                                                                      | ✅ DONE            | 2a complete |
| **3**  | Three interactive siblings, in order: (1) /seed-data [c8ctl, assumes human-started OC], (2) ci-babysit, (3) pr-triage. All local, human-driven.                                                                                                                                                                               | ✅ DONE            | —           |
| **5**  | Bug fix workflow (`dagrun start bugfix`). New `reproduce` node (Gate 1: confirms bug is real, validates root cause); shorter pipeline — no verify node (regression test runs in implement/fix). `base_branch` from plan YAML frontmatter (hotfix branch support). Severity-aware night-mode (critical/blocker always pauses). | ✅ DONE            | —           |
| **6**  | Live `dagrun ui` (Node-http + SSE + vanilla HTML, localhost-only, scrubbed)                                                                                                                                                                                                                                                   | someday            | —           |

Key insight: Phases 1, 2, 3, and 5 are complete. Phase 6 remains future work.

Open items: confirm Agent SDK credit pool covers volume; some preflight checks (network allowlist, additionalDirectories) + content-addressed cache may be partial in code. CLI/SDK versions now pinned (see §7 toolchain pin — CLI 2.1.181, SDK 0.3.170); the `-p` intermittent regression remains upstream/out-of-scope.

---

## 12. Operating reminders

- Every real-work `dagrun` runs with CLAUDE_CONFIG_DIR=~/.claude-work (alias `dagrun-work`); spawned sessions inherit config from the dagrun process. ANTHROPIC_API_KEY unset (subscription auth).
- Siblings: canonical in Camunda private `.claude/`, edit in DEVHARNESS_SRC. ci-babysit/pr-triage
  run from any git checkout on any branch with a discoverable PR — not restricted to a
  dagrunner-managed worktree. When `DAGRUN_RUN_ID` IS set (dagrunner-managed worktree), persist
  the worktree until the PR is done.
- `gh`/network mutations in the pipeline (the `pr` node) run via Node.js outside the agent's own session, not via an in-session `gh` call (see §6).
- Unattended pipeline runs: never auto-approve a gate **unless `--night` is active and no concern is flagged** (see §3 night-mode). The one-rule policy: agent-decidable gates (Gate 1, Gate 2) auto-approve when `guide.md`/`summary.md` contains no "Concerns / plan challenges" heading. Since the verify-autonomy change (§3d), `verify` has no gate at all — it runs autonomously to a terminal classification, so a clean night-mode run now proceeds through `verify` and `pr` fully unattended with no park anywhere. Subagents never end a turn with a question.
- Schema is single-source-of-truth, owned by dagrunner, never duplicated.
- Each sibling plan front-loads a tool-introspection spike (c8ctl for /seed-data; the `gh` CI-status surface for ci-babysit; the `gh` review-comment surface for pr-triage) — verify the installed surface, don't assume from docs.
- ci-babysit and pr-triage share a worktree but have hard domain separation: ci-babysit owns git mutations (rebase, fix, commit, push); pr-triage owns the comment conversation (never calls git push, never edits source files, never stages/commits).
- pr-triage bot detection: use `user.type == "Bot"` — do NOT rely on `[bot]` login suffix (Copilot inline has type=Bot but login="Copilot" with no suffix).
