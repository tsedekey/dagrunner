# dagrunner — Master Architecture (Source of Truth)

Status: Canonical, reconciled with the built code through Phase 3 (all three siblings built). Each sibling build also gets its own implementation plan. Cross-references cleaned up after the /verify-demo split into /seed-data.
Last updated: 2026-06-18 (hook-driven reflection capture: SessionEnd hook reads reflections.md → store log; reflect-append command renamed to reflect; notes.md renamed to reflections.md; de-flake: reflection mechanism tested deterministically via hook unit test + seeded smoke:live — no longer gated on spontaneous model output)
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
   [VERIFY-ELECTION] surfaces manual_test_recommendation from findings.json (advisory); human: "run runtime verification? [y/n]"
        |  n -> verify skipped -> pr
        |  y ↓
  verify (haiku, INFO-ONLY: writes seeding-spec.json + manual-test.md)
        |  ★ GATE 3: human runs the manual test (or invokes /seed-data)
  pr (haiku)               -> opens the PR (git push / gh run OUTSIDE the sandbox — see §5)
                              [TERMINAL — run ends here]
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
  manual_test_recommendation: { recommended: bool, surface: "ui"|"api"|"none", rationale: string },
  findings: [{ reviewer_dimension, severity, confidence, file, line, claim, grounded }] }
```

Reviewer selection (from diff-triage): correctness + test-adequacy always; api-stability when touches_public_api; distributed-systems when touches_runtime; migration-safety when touches_schema_or_proto; performance when triage judges it.

**Gates:** all checkpoint-and-exit, single-awaiting-gate invariant, conversation-led reject (resume same session + feedback artifact). Gates live ONLY on static nodes.

**Night-mode (`dagrun start feature --night`):** unattended overnight execution. One rule — agent-decidable gates (Gate 1 = expand, Gate 2 = fix) are auto-approved when no "Concerns / plan challenges" heading is present in the gate artifact; the verify-election always pauses (human-only). A flagged concern or an unreadable/missing artifact also pauses (fail toward the human). Every auto-decision is logged to `gateHistory` with `mode: "night"` and `basis: "no concerns flagged"` for morning audit. `agentDecidable(nodeId)` is the exported predicate; `hasConcerns(content)` is the exported concern check (both pure, unit-tested).

---

## 3b. Validation — smoke:mock (per-plan gate) and smoke:live (occasional)

`npm run verify-baseline` = `npm ci && typecheck && unit tests && smoke:mock`. The standing gate: run on every plan change.

**smoke:mock** (`test/smoke/smoke-mock.ts`) drives the full gated featureWorkflow in-process using the mock executor — zero API calls, ~150 ms, deterministic. Asserts: gate pauses, produces-contract at every gate node, state transitions (awaiting-gate → paused → done), routing (verify skipped when election=n, runs when election=y), verifyElection stored in state.json, night-mode auto-approvals (Run C: clean plan → Gate 1 + Gate 2 auto-approved → parked at verify-election; Run D: seeded concern → parked at Gate 1). Does NOT assert model output quality or exact session IDs.

**smoke:live** (`test/smoke/smoke.ts`) runs the real 8-step pipeline with the SDK — requires `ANTHROPIC_API_KEY`, ~35 min. Proves API auth, real session-resume, structured output from live model, worktree diff. Run when node prompts change (`payload/commands/*.md`), when `sdk-runner.ts` changes, or once at build-queue end. A bad prompt that passes mock but breaks model behaviour won't surface until the next smoke:live — that is the accepted tradeoff. **Reflection wiring (step 6):** smoke seeds a known `reflections.md` into `pr/` before the resume call so the SessionEnd hook has a deterministic file to capture — this proves hook wiring + env propagation in a real session without gating on spontaneous model output. The hook logic is separately proven by the unit test (`src/hooks/session-end.test.ts`).

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

## 6. Runtime permission / sandbox / network model

Seeded into each worktree `.claude/settings.json`, loaded via `settingSources:["project"]`, node `cwd` = worktree. Distinct from the build-time `bypassPermissions` posture used by the agent that BUILDS dagrunner.

Goal: free inside the worktree, read anywhere, mutation/network outside hard-blocked, no prompts before a gate.

- `defaultMode: acceptEdits`; `additionalDirectories` includes the per-run artifact path (else every node prompts — the #1 prompt pitfall).
- `allow: [Read, Bash(git *), Bash(npm run *), Bash(npx tsc *)]`; `deny: rm -rf, sudo, force-push, .env/secrets read+write`.
- `sandbox.enabled` (macOS Seatbelt) + `autoAllowBashIfSandboxed` + network `allowedDomains` (anthropic, npm, github). Out-of-worktree mutation is kernel-blocked; network is proxied+allowlisted, NOT cut off (WebFetch/WebSearch run in-process, unaffected).
- **Known reality from the build:** `gh` and `git push` do NOT work inside the Seatbelt sandbox (TLS cert mismatch with the proxy). The `pr` node performs push / PR-creation via Node.js **outside** the sandbox. **This is the key sibling lesson: anything using `gh` must run un-sandboxed** — which the siblings are (interactive commands, not nodes).
- Node-native `fetch`/undici ignores the proxy and breaks under the sandbox (npm/git/tsc respect it).
- **Two contexts, do not conflate:** the agent BUILDING dagrunner runs bypassPermissions + fail-closed deny-guard (NOT Seatbelt); dagrunner RUNTIME nodes run Seatbelt. Seatbelt is built into macOS.
- **Two-posture permission rule (night-mode):** runtime nodes have two SDK `permissionMode` settings — `acceptEdits` for attended runs (human is present and can answer prompts) and `bypassPermissions` for night-mode (`--night` flag). The safety boundary — `sandbox.enabled: true` + fail-closed deny-guard hook — is written by `buildSeededSettings` independently of `permissionMode` and is never weakened by night-mode. Bypassing prompts (night) means "don't hang waiting for a human at 3am"; it does NOT remove the kernel- and hook-enforced mutation fence. `selectPermissionMode(nightMode?)` in `sdk-runner.ts` is the single decision point, exported and unit-tested.

---

## 7. Preflight ("Prepare") — not a node

`dagrun preflight` runs before the graph: on expected base branch; git tree clean; DEVHARNESS_SRC resolves+is a repo; seeded settings present; Seatbelt available; network allowlist covers the task; ANTHROPIC_API_KEY unset; CLAUDE_CONFIG_DIR=~/.claude-work; enterprise policy doesn't block; artifact path in additionalDirectories.

**Toolchain pin (implemented):** `claude` CLI must match `EXPECTED_CLAUDE_CLI_VERSION` (currently `2.1.181`, defined in `src/config/versions.ts`). After confirming `claude` is on PATH, preflight runs `claude --version`, parses the semver, and fails loud if it doesn't match — with a "pinned X, found Y; install the pinned version" message. Set `DAGRUN_SKIP_CLI_VERSION_CHECK=1` to bypass (for testing against a new version before updating the pin). The Agent SDK is pinned exact (no `^` caret) in `package.json` at `0.3.170`; `npm ci` enforces it via the lockfile. Both pins are the current reproducibility baseline — not a verified regression-free pair (the `-p` intermittent regression is upstream, out of scope). **Upgrade procedure:** bump `EXPECTED_CLAUDE_CLI_VERSION` + `package.json` SDK version together, run `npm install` to resync lockfile, run `smoke:live` once to confirm the new pair works, commit both in the same change.

---

## 8. classify — REMOVED; task-type routing designed fresh when needed

No classify node. Reviewer-selection moved into review's diff-triage step (reads the diff — better input than predicting from the plan). Former classify outputs relocated: needs*runtime -> human verify-election; recommend_pr_review -> human reads `dagrun status`; run_adversarial_verifier -> finding-count threshold; risk -> removed; touches*\* -> review diff-triage.

**Why classify is gone:** dormant code is drift risk — it reads as live, ages silently, and constrains future design. A future task-type router (feature/bug/tech-debt) earns a node only when it ROUTES the graph, not when it annotates. Change-AREA is diff-derivable; task-TYPE reshapes the graph upfront. That router will be designed fresh from current understanding when actually needed (Phase 5/6 or later) — not revived from stale scaffolding.

## 8b. reflect — hook-driven distributed capture

Each node optionally writes tips/gotchas to `$DAGRUN_ARTIFACTS/reflections.md`. The **SessionEnd hook** (`.claude/hooks/session-end.sh`) reads this file when the node finishes and appends one stamped JSONL entry to the durable store. The log outlives the run (stored in `~/.local/share/dagrunner/store/reflection-log.jsonl`, not in `runs/<id>/`). Capture is fail-soft — a hook failure never blocks a node.

- **Node contract:** nodes write `reflections.md` if they have useful tips; absence is fine. `fix` writes `reflections.md` whenever fixes were applied (fallback: "No non-obvious discoveries."). No node is required to write it for test coverage — the hook mechanism is proven deterministically (see Testing §14 and DECISIONS §deflake-reflection-capture-test).
- **Hook-written entry shape:** `{ ts, source, run_id?, body }` — `kind` is absent (deferred to human harvest; no judgment in the runtime path).
- **Manual/sibling append:** `dagrun reflect --source <node> --kind camunda-knowledge|dagrunner-harness --body "<text>" [--run-id <id>]` — used by ci-babysit/pr-triage and the human. This is the only path that sets `kind`.
- **Durability invariant:** `DAGRUN_STORE_DIR` is injected explicitly by the launcher (never derived via `../../` from the run dir). The store is outside the run dir and survives `dagrun cleanup`.
- **Harvest:** periodic human + architect process. Reads the log, routes by kind (when present): Camunda-knowledge tips → DEVHARNESS_SRC private files; dagrunner-harness tips → a dagrunner self-change plan.
- **Why hook-driven:** prompt-driven + fail-soft + bare-`dagrun` = three layers of "maybe" over an unowned PATH (the prior mechanism failed silently — see DECISIONS.md §hook-driven-reflection-capture). The SessionEnd hook is code we own, on a signal that already fires.

The old `reflect` + `apply-reflection` nodes are removed. `pr` is terminal.

---

## 9. Cost & model tiering

Per-node tiering in the validated workflow-def (load-time model-string validation). expand unpinned; review diff-triage haiku; reviewers mixed (correctness/distributed-systems/performance unpinned; test-adequacy/api-stability/migration-safety sonnet); adversarial verifier strong tier; fix unpinned; verify haiku; pr haiku. Two-tier budget: per-run `--max-budget-usd` + per-invocation caps. Cost capture: `--output-format json` total_cost_usd + per-model breakdown into state.json; `dagrun status` shows total vs cap.

---

## 10. Phase 3 siblings — THREE interactive Claude Code commands

All three: Claude Code commands in the **Camunda monorepo's private `.claude/`** (alongside `/pr-review`, gitignored via `.git/info/exclude`), **copied into each worktree by dagrunner's seed/sync** and RUN inside the worktree (where the built code, PR branch, and cluster live). Edit the canonical copy in DEVHARNESS_SRC; the worktree copy is ephemeral. Interactive, human-driven, **NOT sandboxed** (they need Docker, host ports, `gh`, broad network — exactly why they're commands, not nodes). Run under CLAUDE_CONFIG_DIR=~/.claude-work. Built one at a time, in order.

> DROPPED: the dedicated "/verify-demo environment creator" (DMS-based cluster + breakpoint placement). The **c8ctl dev plugin** spins up a configured local OC smoothly, making a separate cluster-creator command unnecessary. The **Debugger MCP Server (DMS)** is parked for a FUTURE bug-fix / issue-investigation workflow (where programmatic breakpoints aid an investigating agent) — it has no role in the feature-task workflow. verify emits only `seeding-spec.json` + `manual-test.md` (see §3); the code-trail the old `tour-spec.json` carried is now folded into the human-readable `manual-test.md`, and no automated breakpoint-placer consumes it.

### 10.1 seed-data (Sibling 1)

- Assumes the human has ALREADY spun up a local Orchestration Cluster via the **c8ctl dev plugin** (smooth, human-driven — this command does NOT create or tear down the cluster).
- Consumes `seeding-spec.json` (from the verify node). Seeds the running cluster via **c8ctl**: resolve abstract deployments to concrete BPMN (the spec gives descriptions, not files), deploy `deployments[]`, start `instances[]` with their variables, capture instance keys, and confirm `expected_observations[]` are reachable (ES doc present; REST call recorded but not asserted — the human observes the value).
- If no OC is reachable, fail loud telling the human to start one first.
- Named generically (`/seed-data`, not demo-specific) so it is reusable for manual testing, reproduction, and investigation — not only feature demos.

### 10.2 ci-babysit (Sibling 2)

Local: monitors CI on the open PR, rebases on base, fixes failing checks (scoped to making CI green — never a backdoor for feature changes), and re-verifies before pushing. Needs the local cluster (human-started via the c8ctl dev plugin) for runtime re-verification + private context (why it's local, not gh-aw). Uses `gh` and `git push` (un-sandboxed — fine, it's a command); rebase pushes use `--force-with-lease`, never blind `--force`.

**Human gate (never auto):** the **draft -> ready flip** is ci-babysit's defining gate — when CI is green and re-verification passes, it surfaces the readiness summary and the `gh pr ready` command but NEVER flips the PR itself. Readiness is not latched: new commits/failures reopen the work and re-present the gate.

**Poll/trigger machinery (built here, reused by pr-triage):** ci-babysit owns the Claude Code Desktop scheduled-task / poll loop and the crev-style `--since <prior-run-id>` incremental pattern (act only on new commits/failures since the last tick; checkpoint-and-exit per tick, state on disk). pr-triage (§9.3) imports this loop rather than building a second one.

Operates over the PR lifetime — the worktree must persist (don't `cleanup` until the PR is closed).

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

### Removed from scope

**/pr-review**: kept as a private standalone command for reviewing OTHERS' PRs; removed from dagrunner scope (redundant on own PRs given in-pipeline review + Copilot + human + crev). No dynamic-workflow rebuild. Dynamic workflows are not used anywhere in dagrunner.

---

## 11. Phase roadmap

| Phase   | Scope                                                                                                                                                                                                                                                                                           | Status             | Gated by    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------- |
| **1**   | Engine + spine + thin slice + Gate 1; state/resume/worktrees/artifacts/hooks/launcher; `dagrun report` static HTML. (Built classify/expand/implement — classify-as-a-node since RETIRED; its logic moved into review's diff-triage.)                                                            | ✅ DONE & hardened | —           |
| **2a**  | (1) Preflight + runtime permission/sandbox/network model [FIRST]; (2) review node (diff-triage self-select + fan-out + finding-count-gated verifier -> findings schema); (3) fix node (gated, self-verifying). Built, fixture-passed, post-fixture restructure (classify removal etc.) applied. | ✅ DONE            | —           |
| **2b**  | verify-election + verify (doc-only; cluster automation REMOVED, see §9) + Gate 3; pr node (terminal); pure-capture reflection via dagrun reflect-append; rerun command; PR post-process outside sandbox.                                                                                        | ✅ DONE            | 2a complete |
| **3**   | Three interactive siblings, in order: (1) /seed-data [c8ctl, assumes human-started OC], (2) ci-babysit, (3) pr-triage. All local, human-driven.                                                                                                                                                 | ✅ DONE            | —           |
| **4**   | Live `dagrun ui` (Node-http + SSE + vanilla HTML, localhost-only, scrubbed)                                                                                                                                                                                                                     | someday            | —           |
| **5/6** | Multi-task-type support (bug/tech-debt/refactor); task-type router designed fresh when needed                                                                                                                                                                                                   | future             | —           |

Key insight: Phase 2 and Phase 3 are complete. Phases 4–6 remain future work.

Open items: confirm Agent SDK credit pool covers volume; some preflight checks (network allowlist, additionalDirectories) + content-addressed cache may be partial in code. CLI/SDK versions now pinned (see §7 toolchain pin — CLI 2.1.181, SDK 0.3.170); the `-p` intermittent regression remains upstream/out-of-scope.

---

## 12. Operating reminders

- Every real-work `dagrun` runs with CLAUDE_CONFIG_DIR=~/.claude-work (alias `dagrun-work`); spawned sessions inherit config from the dagrun process. ANTHROPIC_API_KEY unset (subscription auth).
- Siblings: canonical in Camunda private `.claude/`, run in worktree, edit in DEVHARNESS_SRC, persist worktree until PR done (esp. ci-babysit/pr-triage).
- `gh`/network mutations must run un-sandboxed.
- Unattended pipeline runs: never auto-approve a gate **unless `--night` is active and no concern is flagged** (see §3 night-mode). The one-rule policy: agent-decidable gates (Gate 1, Gate 2) auto-approve when `guide.md`/`summary.md` contains no "Concerns / plan challenges" heading; verify-election always pauses. Subagents never end a turn with a question.
- Schema is single-source-of-truth, owned by dagrunner, never duplicated.
- Each sibling plan front-loads a tool-introspection spike (c8ctl for /seed-data; the `gh` CI-status surface for ci-babysit; the `gh` review-comment surface for pr-triage) — verify the installed surface, don't assume from docs.
- ci-babysit and pr-triage share a worktree but have hard domain separation: ci-babysit owns git mutations (rebase, fix, commit, push); pr-triage owns the comment conversation (never calls git push, never edits source files, never stages/commits).
- pr-triage bot detection: use `user.type == "Bot"` — do NOT rely on `[bot]` login suffix (Copilot inline has type=Bot but login="Copilot" with no suffix).
