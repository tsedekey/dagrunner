# dagrunner — Master Architecture (Source of Truth)

Status: Canonical, reconciled with the built code through Phase 3 (all three siblings built). Each sibling build also gets its own implementation plan. Cross-references cleaned up after the /verify-demo split into /seed-data.
Last updated: 2026-06-17 (src/ restructured into 5 cohesion folders: core/ workflow/ runtime/ config/ cli/; verify-seed stub removed)
Owner: Eddie Tsedeke

---

## 1. What dagrunner is

A thin, static TypeScript orchestrator that walks a feature change through a fixed, gated pipeline — guide -> implement -> review -> fix -> verify -> PR -> reflect — pausing at defined human gates and checkpointing to disk so it survives process exit. Each node is a Claude Code session spawned via the Agent SDK in an isolated git worktree. dagrunner owns only what Claude Code cannot do across separate sessions: the dependency graph, checkpoint-and-resume, worktree isolation, artifact hand-off, gates, and cost discipline.

Core principle: **code coordinates, model judges.** TS orchestration is free; node sessions cost. Reuse Claude Code primitives; build only cross-process/worktree gaps.

North star: **strip everything predictive out of the front of the pipeline; decide each thing where the information actually exists.** A decision from the plan before code exists is worse than the same decision from the diff/findings later.

---

## 2. System components

| #   | Component                                | Runs where                                           | Role                                                                                                                                                                                     |
| --- | ---------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Glean Agent (Feature Task Companion)** | Glean                                                | Ingests a GitHub task; emits a directional implementation plan (INTENT/why). dagrunner's expand writes the code-level HOW. The plan is dagrunner's inbox input — no GitHub issue needed. |
| 2   | **dagrunner (static feature pipeline)**  | local machine                                        | The gated feature pipeline. The heart of the system.                                                                                                                                     |
| 3   | **Three Phase-3 siblings**               | Camunda monorepo private `.claude/`, run in worktree | Interactive human-driven commands acting on Camunda: `/seed-data` (c8ctl seeding of a human-started OC), `ci-babysit`, `pr-triage`. See §9.                                              |

Phase 3 is three LOCAL siblings (/seed-data + ci-babysit + pr-triage) — one substrate, enterprise subscription locally. `/pr-review` is NOT a dagrunner sibling: it stays a private standalone command for reviewing OTHERS' PRs (see §9). gh-aw and dynamic-workflows-in-pipeline are not used (see §9 rationale).

---

## 3. The feature pipeline (fully static)

```
[Glean directional plan in inbox]
   [PREFLIGHT] (not a node; runs before the graph)
        |
  expand (unpinned)   ★ GATE 1: review the guide (conversation-led)
  implement (unpinned)
  review (static node):
     - diff-triage first step (haiku): read diff -> touches_* flags
     - fan-out selected reviewer subagents (read-only, isolated context)
     - synthesize
     - adversarial verifier ONLY if findings count > N (default 3)
        |  -> review/findings.json
  fix (consumes findings, mutates worktree, self-verifies)  ★ GATE 2: accept/reject fixes
   [VERIFY-ELECTION] human: "run runtime verification? [y/n]"
        |  n -> verify skipped -> pr
        |  y ↓
  verify (haiku, INFO-ONLY: writes seeding-spec.json + manual-test.md)
        |  ★ GATE 3: human runs the manual test (or invokes /seed-data)
  pr (haiku)               -> opens the PR (git push / gh run OUTSIDE the sandbox — see §5)
  reflect                  ★ GATE 4: per-proposal accept/reject (post-PR, skippable)
  apply-reflection (writes worktree-private + DEVHARNESS_SRC private .claude/** only; 4 guardrails)
```

**review/fix split:** review is read-only (its whole contract is one `findings.json`); fix is the mutating, gated node (so the human gates the actual code changes, with session memory for conversation-led reject).

**Adversarial verifier:** a second-order discriminator (not a 7th reviewer) — reads the reviewers' findings in isolated context, grounds each against the diff, drops/downgrades ungrounded ones. Triggered by runtime finding-count threshold N (default 3), NOT an upstream flag.

**findings.json schema:**

```
{ run_id, timestamp,
  triage: { touches_public_api, touches_runtime, touches_schema_or_proto, performance_sensitive },
  reviewers_run: [string], reviewers_skipped: [{name,reason}],
  adversarial_verifier_run: bool,
  findings: [{ reviewer_dimension, severity, confidence, file, line, claim, grounded }] }
```

Reviewer selection (from diff-triage): correctness + test-adequacy always; api-stability when touches_public_api; distributed-systems when touches_runtime; migration-safety when touches_schema_or_proto; performance when triage judges it.

**Gates:** all checkpoint-and-exit, single-awaiting-gate invariant, conversation-led reject (resume same session + feedback artifact). Gates live ONLY on static nodes.

---

## 3b. Validation — smoke:mock (per-plan gate) and smoke:live (occasional)

`npm run verify-baseline` = `npm ci && typecheck && unit tests && smoke:mock`. The standing gate: run on every plan change.

**smoke:mock** (`test/smoke/smoke-mock.ts`) drives the full gated featureWorkflow in-process using the mock executor — zero API calls, ~150 ms, deterministic. Asserts: gate pauses, produces-contract at every gate node, state transitions (awaiting-gate → paused → done), routing (verify skipped when election=n, runs when election=y), verifyElection stored in state.json. Does NOT assert model output quality or exact session IDs.

**smoke:live** (`test/smoke/smoke.ts`) runs the real 8-step pipeline with the SDK — requires `ANTHROPIC_API_KEY`, ~35 min. Proves API auth, real session-resume, structured output from live model, worktree diff. Run when node prompts change (`payload/commands/*.md`), when `sdk-runner.ts` changes, or once at build-queue end. A bad prompt that passes mock but breaks model behaviour won't surface until the next smoke:live — that is the accepted tradeoff.

**Executor-factory injection seam:** `startRun`, `resumeRun`, `rerunNode` all accept an optional `executorFactory` parameter (defaults to `makeSDKRunner`). This is the seam that lets smoke:mock swap in `createMockExecutor` without touching engine logic. See DECISIONS.md § split-smoke-mock-gate-live-occasional.

---

## 4. The spine

- **run-id = `<slug>-<timestamp>`** (the built format; no issue-number injection). Branch `feature/<slug>`.
- **state.json** per run: top-level (runId, workflow, status, worktreePath, branch, sourcePlanPath, costs) + per-node (status, timestamps, artifacts, model, iteration, gateHistory, interruptRetries?).
- Checkpoint-and-exit at gates; reconcile-on-resume: `reconcileRunningNodes` marks any `running` node `failed` (crash recovery), then `resetInterruptedNodes` resets interrupt-reconciled nodes to `pending` up to `MAX_INTERRUPT_RETRIES` (currently 2, i.e. 3 total attempts) before leaving them permanently `failed`. Rationale: a transient Ctrl+C shouldn't permanently fail a resumable run, but an unbounded retry would never settle a genuinely broken node — the cap bounds both risks. The retry counter (`interruptRetries` on NodeState) is distinct from the gate iteration counter; stale-lock release follows reconcile.
- One run at a time (global lockfile; verify cluster fixed ports). Paused runs release the lock; resume re-acquires.
- Worktrees via `git worktree add` off DEVHARNESS_SRC; teardown deferred to explicit `dagrun cleanup` (never auto — manual test + PR-lifetime siblings need the worktree alive).
- Artifact channel: `~/.local/share/dagrunner/runs/<run-id>/<node>/` (survives teardown), passed to nodes as absolute path via env.
- `produces` contract: a node is `done` only if it wrote its declared artifact(s); missing => failed.
- XDG home: `~/.local/share/dagrunner/` (runs, worktrees, inbox, store, config.json), `~/.cache/dagrunner/`, `~/.local/bin/dagrun`, override DAGRUNNER_HOME, fail-loud no-cwd-fallback.
- Hooks: SessionStart sync (private files), PostToolUse format (**TS/JS/CSS/HTML only** — Java/YAML excluded after a YAML-coercion incident), Stop friction/gates, SessionEnd cost.
- `dagrun rerun` re-seeds the worktree `.claude/` from `payload/` (runtime-only: 10 pipeline commands + 7 reviewer agents). Hooks always come from `.claude/hooks/` (genuinely shared). `.claude/{commands,agents}` are build-harness-only and are never seeded into worktrees — this is the split that prevents build tools from polluting Camunda worktrees.
- Failure: 4-class taxonomy (transient->retry, contract->fail, convergence-exhaustion->gate, budget->checkpoint-exit). Node failure != run failure; isolate-and-continue.
- **CLI exit codes:** `dagrun start`/`resume` exit 0 on `done`/`paused`; exit 1 when the run ends `failed`. Callers (night queue, CI) must treat non-zero as a genuine failure — do not swallow it. The run engine owns the final status; the CLI layer propagates it.
- `dagrun report` static HTML (built, Phase 1).

---

## 5. Runtime permission / sandbox / network model

Seeded into each worktree `.claude/settings.json`, loaded via `settingSources:["project"]`, node `cwd` = worktree. Distinct from the build-time `bypassPermissions` posture used by the agent that BUILDS dagrunner.

Goal: free inside the worktree, read anywhere, mutation/network outside hard-blocked, no prompts before a gate.

- `defaultMode: acceptEdits`; `additionalDirectories` includes the per-run artifact path (else every node prompts — the #1 prompt pitfall).
- `allow: [Read, Bash(git *), Bash(npm run *), Bash(npx tsc *)]`; `deny: rm -rf, sudo, force-push, .env/secrets read+write`.
- `sandbox.enabled` (macOS Seatbelt) + `autoAllowBashIfSandboxed` + network `allowedDomains` (anthropic, npm, github). Out-of-worktree mutation is kernel-blocked; network is proxied+allowlisted, NOT cut off (WebFetch/WebSearch run in-process, unaffected).
- **Known reality from the build:** `gh` and `git push` do NOT work inside the Seatbelt sandbox (TLS cert mismatch with the proxy). The `pr` node performs push / PR-creation via Node.js **outside** the sandbox. **This is the key sibling lesson: anything using `gh` must run un-sandboxed** — which the siblings are (interactive commands, not nodes).
- Node-native `fetch`/undici ignores the proxy and breaks under the sandbox (npm/git/tsc respect it).
- **Two contexts, do not conflate:** the agent BUILDING dagrunner runs bypassPermissions + fail-closed deny-guard (NOT Seatbelt); dagrunner RUNTIME nodes run Seatbelt. Seatbelt is built into macOS.

---

## 6. Preflight ("Prepare") — not a node

`dagrun preflight` runs before the graph: on expected base branch; git tree clean; DEVHARNESS_SRC resolves+is a repo; seeded settings present; Seatbelt available; network allowlist covers the task; ANTHROPIC_API_KEY unset; CLAUDE_CONFIG_DIR=~/.claude-work; enterprise policy doesn't block; artifact path in additionalDirectories. (Some checks may still be partial in code — confirm against implementation.)

---

## 7. classify — REMOVED (returns Phase 5/6)

No classify node. Reviewer-selection moved into review's diff-triage step (reads the diff — better input than predicting from the plan). Former classify outputs relocated: needs*runtime -> human verify-election; recommend_pr_review -> human reads `dagrun status`; run_adversarial_verifier -> finding-count threshold; risk -> removed; touches*\* -> review diff-triage.

**Principle (governs classify's return):** classify earns a node only when it ROUTES the graph, not when it annotates the change. Change-AREA is diff-derivable (downstream). Task-TYPE (feature/bug/tech-debt) is not derivable from a not-yet-existent diff and reshapes the graph upfront -> returns Phase 5/6 as an upfront task-type router.

## 7b. reflect — self-improvement, two flavors

- **Flavor 1 (Camunda knowledge):** synthesized from expand/implement `notes.md` side-artifacts + diff + findings into `reflect/camunda-knowledge.md`. APPLIED (gated) into **DEVHARNESS_SRC** private gitignored files (nested `CLAUDE.local.md`) — written to the PERMANENT checkout, not the worktree, so it survives `cleanup` and seeds future runs (the reverse of the SessionStart sync).
- **Flavor 2 (dagrunner improvement):** from `friction.jsonl` into `reflect/dagrunner-proposals.md`. LOGGED to `~/.local/share/dagrunner/store/` for cross-run accumulation, NEVER auto-applied (dagrunner's code needs tests/review; one run's friction is noise).
- **reflect gate:** per-proposal, post-PR, skippable (never blocks the PR).
- **apply-reflection guardrails (HARD):** (1) path allowlist — only `*.local.md` / private `.claude/` variants; refuse source, committed CLAUDE.md, state.json, dagrunner repo, .git; (2) private-only, never `git add`, paths in `.git/info/exclude`; (3) exact-approved-diffs only (mechanical applier, no re-reasoning); (4) snapshot-before-apply to `runs/<run-id>/reflect/backup/`, expose `dagrun revert-reflection`.

---

## 8. Cost & model tiering

Per-node tiering in the validated workflow-def (load-time model-string validation). expand unpinned; review diff-triage haiku; reviewers mixed (correctness/distributed-systems/performance unpinned; test-adequacy/api-stability/migration-safety sonnet); adversarial verifier strong tier; fix unpinned; verify haiku; pr haiku; reflect/apply-reflection sonnet. Two-tier budget: per-run `--max-budget-usd` + per-invocation caps. Cost capture: `--output-format json` total_cost_usd + per-model breakdown into state.json; `dagrun status` shows total vs cap.

---

## 9. Phase 3 siblings — THREE interactive Claude Code commands

All three: Claude Code commands in the **Camunda monorepo's private `.claude/`** (alongside `/pr-review`, gitignored via `.git/info/exclude`), **copied into each worktree by dagrunner's seed/sync** and RUN inside the worktree (where the built code, PR branch, and cluster live). Edit the canonical copy in DEVHARNESS_SRC; the worktree copy is ephemeral. Interactive, human-driven, **NOT sandboxed** (they need Docker, host ports, `gh`, broad network — exactly why they're commands, not nodes). Run under CLAUDE_CONFIG_DIR=~/.claude-work. Built one at a time, in order.

> DROPPED: the dedicated "/verify-demo environment creator" (DMS-based cluster + breakpoint placement). The **c8ctl dev plugin** spins up a configured local OC smoothly, making a separate cluster-creator command unnecessary. The **Debugger MCP Server (DMS)** is parked for a FUTURE bug-fix / issue-investigation workflow (where programmatic breakpoints aid an investigating agent) — it has no role in the feature-task workflow. verify emits only `seeding-spec.json` + `manual-test.md` (see §3); the code-trail the old `tour-spec.json` carried is now folded into the human-readable `manual-test.md`, and no automated breakpoint-placer consumes it.

### 9.1 seed-data (Sibling 1)

- Assumes the human has ALREADY spun up a local Orchestration Cluster via the **c8ctl dev plugin** (smooth, human-driven — this command does NOT create or tear down the cluster).
- Consumes `seeding-spec.json` (from the verify node). Seeds the running cluster via **c8ctl**: resolve abstract deployments to concrete BPMN (the spec gives descriptions, not files), deploy `deployments[]`, start `instances[]` with their variables, capture instance keys, and confirm `expected_observations[]` are reachable (ES doc present; REST call recorded but not asserted — the human observes the value).
- If no OC is reachable, fail loud telling the human to start one first.
- Named generically (`/seed-data`, not demo-specific) so it is reusable for manual testing, reproduction, and investigation — not only feature demos.

### 9.2 ci-babysit (Sibling 2)

Local: monitors CI on the open PR, rebases on base, fixes failing checks (scoped to making CI green — never a backdoor for feature changes), and re-verifies before pushing. Needs the local cluster (human-started via the c8ctl dev plugin) for runtime re-verification + private context (why it's local, not gh-aw). Uses `gh` and `git push` (un-sandboxed — fine, it's a command); rebase pushes use `--force-with-lease`, never blind `--force`.

**Human gate (never auto):** the **draft -> ready flip** is ci-babysit's defining gate — when CI is green and re-verification passes, it surfaces the readiness summary and the `gh pr ready` command but NEVER flips the PR itself. Readiness is not latched: new commits/failures reopen the work and re-present the gate.

**Poll/trigger machinery (built here, reused by pr-triage):** ci-babysit owns the Claude Code Desktop scheduled-task / poll loop and the crev-style `--since <prior-run-id>` incremental pattern (act only on new commits/failures since the last tick; checkpoint-and-exit per tick, state on disk). pr-triage (§9.3) imports this loop rather than building a second one.

Operates over the PR lifetime — the worktree must persist (don't `cleanup` until the PR is closed).

### 9.3 pr-triage (Sibling 3)

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

## 10. Phase roadmap

| Phase   | Scope                                                                                                                                                                                                                                                                                           | Status             | Gated by    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------- |
| **1**   | Engine + spine + thin slice + Gate 1; state/resume/worktrees/artifacts/hooks/launcher; `dagrun report` static HTML. (Built classify/expand/implement — classify-as-a-node since RETIRED; its logic moved into review's diff-triage.)                                                            | ✅ DONE & hardened | —           |
| **2a**  | (1) Preflight + runtime permission/sandbox/network model [FIRST]; (2) review node (diff-triage self-select + fan-out + finding-count-gated verifier -> findings schema); (3) fix node (gated, self-verifying). Built, fixture-passed, post-fixture restructure (classify removal etc.) applied. | ✅ DONE            | —           |
| **2b**  | verify-election + verify (doc-only; cluster automation REMOVED, see §9) + Gate 3; pr node; reflect -> reflect-gate -> apply-reflection (4 guardrails); rerun + revert-reflection commands; PR post-process outside sandbox.                                                                     | ✅ DONE            | 2a complete |
| **3**   | Three interactive siblings, in order: (1) /seed-data [c8ctl, assumes human-started OC], (2) ci-babysit, (3) pr-triage. All local, human-driven.                                                                                                                                                 | ✅ DONE            | —           |
| **4**   | Live `dagrun ui` (Node-http + SSE + vanilla HTML, localhost-only, scrubbed)                                                                                                                                                                                                                     | someday            | —           |
| **5/6** | Multi-task-type support (bug/tech-debt/refactor); classify RETURNS as an upfront task-type router                                                                                                                                                                                               | future             | —           |

Key insight: Phase 2 and Phase 3 are complete. Phases 4–6 remain future work.

Open items: confirm Agent SDK credit pool covers volume; pin Claude Code CLI/SDK version (a `-p` regression once returned empty result while billing — `produces` check catches the empty half); some preflight checks + content-addressed cache may be partial in code.

---

## 11. Operating reminders

- Every real-work `dagrun` runs with CLAUDE_CONFIG_DIR=~/.claude-work (alias `dagrun-work`); spawned sessions inherit config from the dagrun process. ANTHROPIC_API_KEY unset (subscription auth).
- Siblings: canonical in Camunda private `.claude/`, run in worktree, edit in DEVHARNESS_SRC, persist worktree until PR done (esp. ci-babysit/pr-triage).
- `gh`/network mutations must run un-sandboxed.
- Unattended pipeline runs: never auto-approve a gate; subagents never end a turn with a question.
- Schema is single-source-of-truth, owned by dagrunner, never duplicated.
- Each sibling plan front-loads a tool-introspection spike (c8ctl for /seed-data; the `gh` CI-status surface for ci-babysit; the `gh` review-comment surface for pr-triage) — verify the installed surface, don't assume from docs.
- ci-babysit and pr-triage share a worktree but have hard domain separation: ci-babysit owns git mutations (rebase, fix, commit, push); pr-triage owns the comment conversation (never calls git push, never edits source files, never stages/commits).
- pr-triage bot detection: use `user.type == "Bot"` — do NOT rely on `[bot]` login suffix (Copilot inline has type=Bot but login="Copilot" with no suffix).
