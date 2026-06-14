# dagrunner — Master Architecture (Source of Truth)

Status: Canonical, reconciled with the built code through Phase 2b. This is the source of truth for Phase 3 sibling implementation. Each sibling build also gets its own implementation plan.
Last updated: 2026-06-14
Owner: Eddie Tsedeke

---

## 1. What dagrunner is

A thin, static TypeScript orchestrator that walks a feature change through a fixed, gated pipeline — guide -> implement -> review -> fix -> verify -> PR -> reflect — pausing at defined human gates and checkpointing to disk so it survives process exit. Each node is a Claude Code session spawned via the Agent SDK in an isolated git worktree. dagrunner owns only what Claude Code cannot do across separate sessions: the dependency graph, checkpoint-and-resume, worktree isolation, artifact hand-off, gates, and cost discipline.

Core principle: **code coordinates, model judges.** TS orchestration is free; node sessions cost. Reuse Claude Code primitives; build only cross-process/worktree gaps.

North star: **strip everything predictive out of the front of the pipeline; decide each thing where the information actually exists.** A decision from the plan before code exists is worse than the same decision from the diff/findings later.

---

## 2. System components

| # | Component | Runs where | Role |
|---|---|---|---|
| 1 | Glean Feature Task Companion | Glean | Ingests a GitHub task; emits a directional implementation plan (INTENT). Dropped in dagrunner's inbox. |
| 2 | dagrunner (static feature pipeline) | local | The gated feature pipeline. The engine. Lives in its own repo. |
| 3 | Four Phase-3 siblings | Camunda monorepo private `.claude/`, run in the worktree | Interactive Claude Code commands acting on Camunda (see §9). |

---

## 3. The feature pipeline (fully static)

```
[Glean directional plan in inbox]
   [PREFLIGHT] (not a node; runs before the graph)
        |
  expand-guide (unpinned)   ★ GATE 1: review the guide (conversation-led)
  implement (unpinned)
  review (static node):
     - diff-triage first step (haiku): read diff -> touches_* flags
     - fan-out selected reviewer subagents (read-only, isolated context)
     - synthesize
     - adversarial verifier ONLY if findings count > N (default 3)
        |  -> review/findings.json
  fix (consumes findings, mutates worktree, self-verifies)  ★ GATE 2: accept/reject fixes
   [VERIFY-ELECTION] human: "run runtime verification? [y/n]"
        |  n -> verify-guide skipped -> pr
        |  y ↓
  verify-guide (haiku, INFO-ONLY: writes seeding-spec.json + tour-spec.json + manual-test.md)
        |  ★ GATE 3: human runs the manual test (or invokes /verify-demo)
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

## 4. The spine

- **run-id = `<slug>-<timestamp>`** (the built format; no issue-number injection). Branch `feature/<slug>`.
- **state.json** per run: top-level (runId, workflow, status, worktreePath, branch, sourcePlanPath, costs) + per-node (status, timestamps, artifacts, model, iteration, gateHistory).
- Checkpoint-and-exit at gates; reconcile-on-resume (running->failed for dead nodes; stale-lock release).
- One run at a time (global lockfile; verify cluster fixed ports). Paused runs release the lock; resume re-acquires.
- Worktrees via `git worktree add` off DEVHARNESS_SRC; teardown deferred to explicit `dagrun cleanup` (never auto — manual test + PR-lifetime siblings need the worktree alive).
- Artifact channel: `~/.local/share/dagrunner/runs/<run-id>/<node>/` (survives teardown), passed to nodes as absolute path via env.
- `produces` contract: a node is `done` only if it wrote its declared artifact(s); missing => failed.
- XDG home: `~/.local/share/dagrunner/` (runs, worktrees, inbox, store, config.json), `~/.cache/dagrunner/`, `~/.local/bin/dagrun`, override DAGRUNNER_HOME, fail-loud no-cwd-fallback.
- Hooks: SessionStart sync (private files), PostToolUse format (**TS/JS/CSS/HTML only** — Java/YAML excluded after a YAML-coercion incident), Stop friction/gates, SessionEnd cost.
- `dagrun rerun` re-seeds the worktree `.claude/` from current source (this is the mechanism that copies the siblings into the worktree).
- Failure: 4-class taxonomy (transient->retry, contract->fail, convergence-exhaustion->gate, budget->checkpoint-exit). Node failure != run failure; isolate-and-continue.
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

No classify node. Reviewer-selection moved into review's diff-triage step (reads the diff — better input than predicting from the plan). Former classify outputs relocated: needs_runtime -> human verify-election; recommend_pr_review -> human reads `dagrun status`; run_adversarial_verifier -> finding-count threshold; risk -> removed; touches_* -> review diff-triage.

**Principle (governs classify's return):** classify earns a node only when it ROUTES the graph, not when it annotates the change. Change-AREA is diff-derivable (downstream). Task-TYPE (feature/bug/tech-debt) is not derivable from a not-yet-existent diff and reshapes the graph upfront -> returns Phase 5/6 as an upfront task-type router.

## 7b. reflect — self-improvement, two flavors

- **Flavor 1 (Camunda knowledge):** synthesized from expand-guide/implement `notes.md` side-artifacts + diff + findings into `reflect/camunda-knowledge.md`. APPLIED (gated) into **DEVHARNESS_SRC** private gitignored files (nested `CLAUDE.local.md`) — written to the PERMANENT checkout, not the worktree, so it survives `cleanup` and seeds future runs (the reverse of the SessionStart sync).
- **Flavor 2 (dagrunner improvement):** from `friction.jsonl` into `reflect/dagrunner-proposals.md`. LOGGED to `~/.local/share/dagrunner/store/` for cross-run accumulation, NEVER auto-applied (dagrunner's code needs tests/review; one run's friction is noise).
- **reflect gate:** per-proposal, post-PR, skippable (never blocks the PR).
- **apply-reflection guardrails (HARD):** (1) path allowlist — only `*.local.md` / private `.claude/` variants; refuse source, committed CLAUDE.md, state.json, dagrunner repo, .git; (2) private-only, never `git add`, paths in `.git/info/exclude`; (3) exact-approved-diffs only (mechanical applier, no re-reasoning); (4) snapshot-before-apply to `runs/<run-id>/reflect/backup/`, expose `dagrun revert-reflection`.

## 7c. verify-guide (info-only) + /verify-demo

verify-seed (cluster automation) was REMOVED — it structurally conflicts with the sandbox (needs Docker/broad-network/host-ports) and is negative-ROI. Replaced by **verify-guide**: a haiku info-only node (no cluster, can't fail that way) emitting two machine-consumable artifacts as the contract for `/verify-demo`:
- `seeding-spec.json`: `{ deployments[], instances[], expected_observations[] }`.
- `tour-spec.json`: `{ feature_summary, breakpoints[]{file,line,why,what_to_observe}, before_path[] }` — file:line computed from the diff (verify-guide has diff context; do NOT defer location-derivation to verify-demo). `before_path` empty for pure additions.
- plus human-readable `manual-test.md`.

`/verify-demo` (Phase 3 siblings 1+2) consumes these — see §9.

---

## 8. Cost & model tiering

Per-node tiering in the validated workflow-def (load-time model-string validation). expand-guide unpinned; review diff-triage haiku; reviewers mixed (correctness/distributed-systems/performance unpinned; test-adequacy/api-stability/migration-safety sonnet); adversarial verifier strong tier; fix unpinned; verify-guide haiku; pr haiku; reflect/apply-reflection sonnet. Two-tier budget: per-run `--max-budget-usd` + per-invocation caps. Cost capture: `--output-format json` total_cost_usd + per-model breakdown into state.json; `dagrun status` shows total vs cap.

---

## 9. Phase 3 siblings — FOUR interactive Claude Code commands

All four: Claude Code commands in the **Camunda monorepo's private `.claude/`** (alongside `/pr-review`, gitignored via `.git/info/exclude`), **copied into each worktree by dagrunner's seed/sync** and RUN inside the worktree (where the built code, PR branch, cluster, and tour-spec file:line refs live). Edit the canonical copy in DEVHARNESS_SRC; the worktree copy is ephemeral. Interactive, human-driven, **NOT sandboxed** (they need Docker, host ports, `gh`, broad network — exactly why they're commands, not nodes). Run under CLAUDE_CONFIG_DIR=~/.claude-work. Built one at a time, in order.

### 9.1 /verify-demo environment creator (Sibling 1)
Consumes `tour-spec.json` + the existing OC run configuration. Stands up a debuggable headless OC (broker+gateway) via the Debugger MCP Server (DMS) JetBrains plugin + Elasticsearch in Docker; places the tour breakpoints. **Linchpin (spike first): can DMS SET breakpoints programmatically, not just inspect?** Degrade gracefully (emit manual breakpoint instructions) if not. Emits `environment.json` (gateway addr, ES URL) for Sibling 2.

### 9.2 /verify-demo seed-data creator (Sibling 2)
Consumes `seeding-spec.json` + `environment.json`. Seeds via **c8ctl**: resolve abstract deployments to concrete BPMN (spec gives descriptions, not files), deploy, start instances with variables, capture instance keys, confirm `expected_observations[]` reachable (ES doc present; REST call recorded but not asserted — the human observes the value at the tour).

### 9.3 ci-babysit (Sibling 3)
Local: monitors CI on the open PR, rebases/fixes/re-verifies. Needs the local verify cluster + private context (why it's local, not gh-aw). Uses `gh` (un-sandboxed — fine, it's a command). Borrow crev's `--since` for incremental re-review. Operates over the PR lifetime — the worktree must persist (don't `cleanup` until the PR is closed).

### 9.4 pr-triage (Sibling 4)
Local: polls the PR for new review comments (bots + humans + crev), classifies each, drafts replies into artifacts, surfaces for per-comment human approve/post. **NEVER auto-posts.** gh-aw was deliberately rejected (its async edge is cancelled by the human gate; safe-outputs governance is redundant with never-auto-post; data-governance cost not worth it). Revisit gh-aw only if this becomes team-scale, multi-repo, no-single-human-gate infra.

### Removed from scope
**/pr-review**: kept as a private standalone command for reviewing OTHERS' PRs; removed from dagrunner scope (redundant on own PRs given in-pipeline review + Copilot + human + crev). No dynamic-workflow rebuild. Dynamic workflows are not used anywhere in dagrunner.

---

## 10. Phase roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Engine + spine + thin slice + Gate 1; state/resume/worktrees/artifacts/hooks/launcher; `dagrun report` | ✅ done |
| 2a | preflight + runtime permission/sandbox model; review (diff-triage + finding-count verifier); fix (gated) | ✅ done |
| 2b | verify-election + verify-guide + Gate 3; pr; reflect + reflect-gate + apply-reflection | ✅ done |
| 3 | Four siblings in order: (1) /verify-demo env [DMS], (2) /verify-demo seed [c8ctl], (3) ci-babysit, (4) pr-triage. All local, human-driven. | in progress |
| 4 | Live `dagrun ui` (Node-http + SSE + vanilla HTML, localhost-only, scrubbed) | someday |
| 5/6 | Multi-task-type support (bug/tech-debt/refactor); classify RETURNS as upfront task-type router | future |

Open items (not Phase-3 blockers): confirm post-2026-06-15 Agent SDK credit pool covers volume; pin Claude Code CLI/SDK version (a `-p` regression once returned empty result while billing — `produces` check catches the empty half); some preflight checks + content-addressed cache may be partial in code.

---

## 11. Operating reminders

- Every real-work `dagrun` runs with CLAUDE_CONFIG_DIR=~/.claude-work (alias `dagrun-work`); spawned sessions inherit config from the dagrun process. ANTHROPIC_API_KEY unset (subscription auth).
- Siblings: canonical in Camunda private `.claude/`, run in worktree, edit in DEVHARNESS_SRC, persist worktree until PR done (esp. ci-babysit/pr-triage).
- `gh`/network mutations must run un-sandboxed.
- Unattended pipeline runs: never auto-approve a gate; subagents never end a turn with a question.
- Schema is single-source-of-truth, owned by dagrunner, never duplicated.
- Each sibling plan front-loads a tool-introspection spike (DMS / c8ctl) — verify the installed surface, don't assume from docs.
