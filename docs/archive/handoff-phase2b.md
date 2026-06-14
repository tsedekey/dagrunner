# dagrunner — Phase 2b Build Handoff (verify-election + verify-seed, pr, reflect loop)

Status: Active brief. Self-contained delta. Canonical spec is `dagrunner-master-architecture.md` (esp. §3, §5, §7b); this is the Phase 2b work order on top of the completed, fixture-passed Phase 2a.
Date: 2026-06-13
Prereq: Phase 2a complete (preflight + runtime permission/sandbox model, review node with diff-triage + finding-count verifier, fix node with Gate 2).

---

## 0. Definition of done

On the validation fixture (re-run end to end, covering 2a+2b):

1. After the fix gate is approved, a **verify-election** prompts "run runtime verification? [y/n]". `n` -> verify-seed `skipped` -> pr. `y` -> verify-seed runs, then Gate 3.
2. **verify-seed** stands up the headless Zeebe cluster (broker+gateway, awaits topology), **seeds baseline data** (deploys a BPMN process + starts a process instance), and **Gate 3** presents the manual test for human approve/reject. Cluster + seed are exercised FOR REAL on this fixture run.
3. **pr** node opens a PR (or, on the fixture, produces `pr/body.md` + the would-be PR metadata — see §4).
4. **reflect** produces TWO outputs and pauses at the **reflect gate** (per-proposal accept/reject, post-PR, skippable).
5. **apply-reflection** enacts ONLY approved Flavor-1 proposals into DEVHARNESS_SRC private files, under the four guardrails; Flavor-2 proposals are appended to `store/`, never applied.
6. `npm run verify-baseline` exits 0; full slice green; state/resume intact across every new gate.

Deliver runnable proof, not prose.

---

## 1. Golden rules (unchanged)

Reuse Claude Code primitives; no new deps. Artifacts are the only cross-node channel. `produces` is the deterministic contract. Fail loud, no silent cwd fallback. Show evidence. Schema single-source-of-truth.

---

## 2. Deliverable 1 — verify-election + verify-seed + Gate 3

- **verify-election** (NOT a DAG node — a micro-gate after fix approval): prompt `run runtime verification? [y/n]`, also drivable non-interactively via `--verify y|n`. Reuses the conditional-node `when` machinery; predicate input is the human answer, captured into state.json. Maintains the single-awaiting-gate invariant (election and Gate 3 are sequential).
  - `n` -> mark verify-seed `skipped`, proceed to pr.
  - `y` -> run verify-seed.
- **verify-seed** (DAG node, model=haiku): mechanical setup of the headless verify cluster against the worktree build (fixed ports — this is why one-run-at-a-time holds). Checkpoints (cluster bring-up is slow). Two sub-steps, in order:
  1. **Stand up the headless Zeebe cluster** (broker + gateway, fixed ports). Wait for readiness/topology before proceeding; fail loud on timeout.
  2. **Seed baseline data** so the human has something real to test against: deploy a simple BPMN process and start at least one process instance, then record what was seeded (process id, instance key) in the manual-test doc.
     `produces`: `verify/manual-test.md` (the seeded data + the steps for the human to run). On the fixture, the cluster + seed are exercised for real (this is the point of the 2b fixture run) even though the fixture's own TS/Java utils don't otherwise need a runtime.
- **Gate 3** (manual-test gate, conversation-led): presents `verify/manual-test.md`; human runs the test, approve -> pr; reject-with-comment -> per master §3, either re-run verify-seed or kick back (onReject configurable; default re-run verify-seed). At exhaustion, stay paused with terminal choice — never auto-cancel.
- **cleanup**: verify-seed's cluster must be torn down by `dagrun cleanup` (extend cleanup to stop any running cluster for the run).

Acceptance: `n` skips cleanly to pr; `y` seeds the cluster, Gate 3 pauses, approval proceeds, a rejection comment behaves per onReject; cluster torn down on cleanup.

## 3. Deliverable 2 — pr node

- DAG node, model=haiku. Depends on: verify-seed (or fix, when verify skipped).
- Composes the PR body from the run artifacts (guide, findings summary, fix summary, verify result if any) and opens the PR via `gh` / git push of the feature branch.
- `produces`: `pr/body.md` + the PR URL (captured to state.json).
- **Fixture note:** on the throwaway fixture, do NOT open a real PR — gate real PR creation behind a flag (e.g. `--no-pr` default for fixture runs) and still produce `pr/body.md` + the would-be metadata so the node is exercised without polluting GitHub.

Acceptance: pr produces a well-formed body from artifacts; on the fixture it writes body.md without opening a real PR.

## 4. Deliverable 3 — reflect + reflect gate + apply-reflection

See master §7b. Two flavors, two fates.

- **notes.md prerequisite (small change to existing nodes):** `expand-guide` and `implement` each emit an OPTIONAL `<node>/notes.md` side-artifact capturing in-context discoveries about the Camunda code area (since session context is discarded by reflect-time). Lightweight; absence is not a failure.
- **reflect** (DAG node, model=sonnet): depends on pr. Inputs:
  - Flavor 1 (Camunda knowledge): synthesizes the notes.md side-artifacts + the diff + findings into `reflect/camunda-knowledge.md` — proposed private knowledge to seed future runs.
  - Flavor 2 (dagrunner improvement): reads `runs/<run-id>/friction.jsonl` (gate rejections, loop counts, tool errors, per-node cost) into `reflect/dagrunner-proposals.md`.
  - Each proposal is typed: `{ target (exact file), change-type, rationale (which friction/discovery signal), diff (concrete before/after) }`. No proposal without a named target + concrete diff.
- **reflect gate** (post-PR, skippable, per-proposal): render each proposal (target + rationale + diff); human approves/rejects PER proposal; rejection comment recorded in gateHistory. Skipping (quit/`--reject`) still completes the run `done` (PR already up — reflect never blocks shipping).
- **apply-reflection** (DAG node, model=sonnet): mechanical applier.
  - Applies ONLY approved **Flavor-1** proposals into **DEVHARNESS_SRC** (the permanent checkout, NOT the worktree — it must survive `cleanup`). Writes nested `CLAUDE.local.md` in the touched dirs; ensures each path is in `.git/info/exclude`.
  - Approved **Flavor-2** proposals are appended to `~/.local/share/dagrunner/store/proposals/` — logged for cross-run accumulation, NEVER applied to dagrunner's code.
  - **The four guardrails (HARD):**
    1. **Path allowlist** — write only to `*.local.md` / private `.claude/` variants in DEVHARNESS_SRC. Refuse anything else (source, committed `CLAUDE.md`, state.json, dagrunner repo, `.git`).
    2. **Private-only** — never `git add`/stage; paths go in `.git/info/exclude`.
    3. **Exact-approved-diffs only** — apply precisely what the gate approved; no re-reasoning/extra edits.
    4. **Snapshot-before-apply** — copy targets to `runs/<run-id>/reflect/backup/` first; expose `dagrun revert-reflection <run-id>`.

Acceptance: reflect emits both outputs; the gate is per-proposal and skippable; apply-reflection writes Flavor-1 to DEVHARNESS_SRC private files (proven to survive a subsequent cleanup), refuses an out-of-allowlist target, logs Flavor-2 to store, snapshots before applying, and `revert-reflection` restores.

---

## 5. Build harness & autonomy (same as 2a)

Coordinator delegates to tool-restricted subagents (suggest: `verify-author`, `pr-author`, `reflect-author`, `test-author`, plus read-only `sdk-researcher`). Per-deliverable git commit. Fresh-model verification pass on **apply-reflection** (the highest-blast-radius node) and the **verify-seed cluster lifecycle**. Mock-executor for deterministic tests; live run only for integration acceptance. Unattended protocol: never end a turn with a question; bypassPermissions + deny-guard for the BUILD session; isolate-and-continue; run under `CLAUDE_CONFIG_DIR=~/.claude-work`, ANTHROPIC_API_KEY unset.

## 6. Out of scope

Siblings (ci-babysit, /pr-review, review-triage) = Phase 3, gated behind enterprise/governance checks. Live `dagrun ui` = Phase 4. classify node = removed (returns Phase 5/6). No dynamic-workflow node inside the pipeline.

## 7. Two-target validation + after 2b

**Two targets, two jobs:**

- **Fast toy fixture (inner loop, mechanics):** the polyglot TS+Java fixture. Use while iterating on 2b mechanics. Has no Zeebe, so verify-seed cannot build a real cluster here — for fixture runs either elect `n` at verify-election, or exercise the lifecycle against a substituted/containerised test broker. Fast (seconds); planted flaws give deterministic review pass/fail.
- **Real engine-version feature (full 2a+2b acceptance):** the synthetic "Record engine version on process instance creation" companion plan (`verification-feature-plan.md`) run against real `camunda/camunda` on a THROWAWAY branch. Here verify-seed builds the GENUINE headless Orchestration Cluster (Zeebe broker + gateway + Elasticsearch as secondary storage) from the worktree, seeds a real deployment + process instance, and the human confirms `engineVersion` in Elasticsearch (via ElasticView) at Gate 3. This is the real cluster-lifecycle + seeding proof.

**verify-seed builds against the WORKTREE build for the real-feature acceptance run** (not a substituted broker). The substituted-broker path is only for the fast toy fixture's inner-loop mechanics.

**After 2b:** run the real engine-version feature end to end (full 2a+2b acceptance, genuine cluster + ElasticView verify), then prepare Phase 3 (run the deferred SDK-credit check + gh-aw governance). Real #53839 stays for the weekend.
