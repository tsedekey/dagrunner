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

**Gates:** all checkpoint-and-exit, single-awaiting-gate invariant. Human review via a fresh interactive `claude` session (SDK session IDs are not resumable from the CLI — two stores don't share state); `/gate-review` + `/gate-conclude` write a `gate-decision.md` handshake file. Author-agent revision still resumes the same SDK session (via `options.resume` + `feedback-N.md`) so it revises with memory. Gates live ONLY on static nodes.

**Night-mode (`dagrun start feature --night`):** unattended overnight execution. One rule — agent-decidable gates (Gate 1 = expand, Gate 2 = fix) are auto-approved when no "Concerns / plan challenges" heading is present in the gate artifact; the verify-election always pauses (human-only). A flagged concern or an unreadable/missing artifact also pauses (fail toward the human). Every auto-decision is logged to `gateHistory` with `mode: "night"` and `basis: "no concerns flagged"` for morning audit. `agentDecidable(nodeId)` is the exported predicate; `hasConcerns(content)` is the exported concern check (both pure, unit-tested).

---

## 3c. The bugfix pipeline

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
  pr        (haiku)       — reuses /pr command
                            [TERMINAL — run ends here]
```

**Why no verify node:** Bug fix verification is automated — the regression test written in reproduce/guide.md runs during implement and fix. No human manual-test step is needed.

**base_branch from frontmatter:** Bug fixes often target release branches (hotfixes). The plan file may carry a YAML frontmatter block (`---` delimiters) with `base_branch: release/1.x`. Run-engine parses this with `parseFrontmatter()` (pure, exported, unit-tested) before creating the worktree. The worktree branches from `base_branch` as start-point. `runPrPostProcess` uses `state.baseBranch ?? "main"` for `gh pr create --base`. When absent, defaults to `"main"`.

**Severity-aware night-mode:** The same `--night` flag works for bugfix runs. Additional rule: if `state.severity` is `"critical"` or `"blocker"`, night-mode always pauses at the gate regardless of whether concerns are flagged. `severityForcesPause(severity)` is the exported predicate (pure, unit-tested). Rationale: high-stakes bugs warrant human eyes even when the agent sees no concerns.

**Frontmatter fields stored in state:** `baseBranch`, `severity`, `issueUrl` are optional fields on `RunState`. They survive resume. Only `baseBranch` is stored when non-"main" (avoids cluttering state for feature runs). None are exported as env vars — they are consumed by engine TS code from state, not by node prompts.

**Command reuse:** `/implement` and `/pr` are workflow-tolerant: they check `define/guide.md` first, then fall back to `reproduce/guide.md`. No workflow-specific command forks — single copies, no smoke:live cost increase.

---

## 3b. Validation — smoke:mock (per-plan gate) and smoke:live (occasional)

`npm run verify-baseline` = `npm ci && typecheck && unit tests && smoke:mock`. The standing gate: run on every plan change.

**smoke:mock** (`test/smoke/smoke-mock.ts`) drives the full gated featureWorkflow in-process using the mock executor — zero API calls, ~150 ms, deterministic. Asserts: gate pauses, produces-contract at every gate node, state transitions (awaiting-gate → paused → done), routing (verify skipped when election=n, runs when election=y), verifyElection stored in state.json, night-mode auto-approvals (Run C: clean plan → Gate 1 + Gate 2 auto-approved → parked at verify-election; Run D: seeded concern → parked at Gate 1). Does NOT assert model output quality or exact session IDs.

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

**Version banner (implemented):** `dagrun preflight` and a passing `dagrun start` both print dagrunner's own package version + build date/time before any node runs — `src/config/version.ts` (`getVersionInfo`), surfaced via `formatAgentContext` (preflight) and `formatVersionBanner` (start). Compiled binaries read the compile-instant timestamp from `dist/build-meta.json` (regenerated every `npm run build` by `scripts/write-build-meta.mjs`) and fail loud if it's missing; dev mode (`tsx`) prints `(dev, unbuilt)`. This makes drift between a rebuild and the running `~/.local/bin/dagrun` binary visible instead of assumed. Every dagrunner self-change bumps this version (enforced by `dr-build`, see `.claude/agents/dr-build.md`).

**Toolchain pin (NOT YET IMPLEMENTED):** the design calls for `claude` CLI to be pinned to an `EXPECTED_CLAUDE_CLI_VERSION` constant (planned home: `src/config/versions.ts` — note the plural, a distinct module from the version-banner's singular `src/config/version.ts` above) and checked via `claude --version` at preflight time, failing loud on mismatch (bypassable via `DAGRUN_SKIP_CLI_VERSION_CHECK=1`). **Neither the constant nor the check exists in the repo today** — this paragraph describes the intended design, not shipped behavior. Do not treat `claude --version` pinning as enforced until this is built. The Agent SDK dependency itself IS pinned exact (no `^` caret) in `package.json`; `npm ci` enforces it via the lockfile. **When this is eventually built:** bump `EXPECTED_CLAUDE_CLI_VERSION` + `package.json` SDK version together, run `npm install` to resync lockfile, run `smoke:live` once to confirm the new pair works, commit both in the same change.

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

Per-node tiering in the validated workflow-def (load-time model-string validation). expand unpinned; review diff-triage haiku; reviewers mixed (correctness/distributed-systems/performance unpinned; test-adequacy/api-stability/migration-safety sonnet); adversarial verifier strong tier; fix unpinned; verify haiku; pr haiku. Two-tier budget: per-run `--max-budget-usd` + per-invocation caps. Cost capture: `--output-format json` total_cost_usd; `dagrun status` shows total vs cap.

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
- `gh`/network mutations must run un-sandboxed.
- Unattended pipeline runs: never auto-approve a gate **unless `--night` is active and no concern is flagged** (see §3 night-mode). The one-rule policy: agent-decidable gates (Gate 1, Gate 2) auto-approve when `guide.md`/`summary.md` contains no "Concerns / plan challenges" heading; verify-election always pauses. Subagents never end a turn with a question.
- Schema is single-source-of-truth, owned by dagrunner, never duplicated.
- Each sibling plan front-loads a tool-introspection spike (c8ctl for /seed-data; the `gh` CI-status surface for ci-babysit; the `gh` review-comment surface for pr-triage) — verify the installed surface, don't assume from docs.
- ci-babysit and pr-triage share a worktree but have hard domain separation: ci-babysit owns git mutations (rebase, fix, commit, push); pr-triage owns the comment conversation (never calls git push, never edits source files, never stages/commits).
- pr-triage bot detection: use `user.type == "Bot"` — do NOT rely on `[bot]` login suffix (Copilot inline has type=Bot but login="Copilot" with no suffix).
