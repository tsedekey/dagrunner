# dagrunner — Master Architecture (Source of Truth)

Status: Living document, canonical. Supersedes the rough iPhone sketch, the standalone Dynamic-Workflows ADR (kept as deeper "why" reference), and all prior master-doc revisions.
Last updated: 2026-06-13
Owner: Eddie Tsedeke

---

## 1. What dagrunner is

A thin, static TypeScript orchestrator that walks a feature change through a fixed, gated pipeline — explore -> guide -> implement -> review -> fix -> verify -> PR -> reflect — pausing at defined human gates and checkpointing to disk so it survives process exit. It does not reinvent agent intelligence: each node is a Claude Code session spawned via the Agent SDK in an isolated git worktree. dagrunner owns only what Claude Code cannot do across separate sessions: the dependency graph, checkpoint-and-resume, worktree isolation, artifact hand-off, gates, and cost discipline.

Core principle: **code coordinates, model judges.** The TS orchestration is free; the node sessions cost. Reuse Claude Code primitives wherever they exist; build only the cross-process/worktree gaps.

Design north star (validated repeatedly this project): **strip everything predictive out of the front of the pipeline; decide each thing where the information actually exists.** A decision made from the directional plan before code exists is strictly worse than the same decision made from the diff/findings later.

---

## 2. The five-component system

| #   | Component                                | Runs where               | Role                                                                                                                                                                                           |
| --- | ---------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Glean Agent (Feature Task Companion)** | Glean                    | Ingests a GitHub task; emits a directional implementation plan (INTENT/why). dagrunner's expand-guide writes the code-level HOW. The plan is dagrunner's inbox input — no GitHub issue needed. |
| 2   | **dagrunner (static feature pipeline)**  | local machine            | The gated feature pipeline. The heart of the system.                                                                                                                                           |
| 3   | **ci-babysit**                           | local (dagrunner-static) | Sibling: monitors CI on an open PR, rebases/fixes/re-verifies. Needs the local verify cluster + private context.                                                                               |
| 4   | **/pr-review**                           | session / `claude -p`    | Sibling: on-demand deep adversarial PR review as a SAVED dynamic workflow.                                                                                                                     |
| 5   | **review-triage**                        | GitHub Actions (gh-aw)   | Sibling: ingests PR review comments (bots + humans + /pr-review), classifies, drafts replies, NEVER auto-posts (gh-aw safe-outputs).                                                           |

Three substrates, three locations — local-gated (dagrunner), session-on-demand (dynamic workflows), CI-event-driven (gh-aw) — converging at the PR boundary for everything post-implementation.

---

## 3. The feature pipeline (Component 2) — fully static

All nodes are static DAG nodes. No dynamic-workflow node lives inside the feature pipeline (by design — see ADR). Native subagents are used INSIDE the review node for the bounded parallel fan-out.

```
[Glean directional plan dropped in inbox]
        |
   [PREFLIGHT]  (not a DAG node — runs before the graph; see §6)
        |
  expand-guide (unpinned)   ★ GATE 1: review the guide (conversation-led)
        |
  implement (unpinned)
        |
  review (static node):
     - diff-triage first step (haiku): read diff -> set touches_* flags
     - fan-out selected reviewer subagents (read-only, isolated context)
     - synthesize
     - adversarial verifier ONLY if findings count > N (default 3)
        |                  -> review/findings.json (single stable artifact)
  fix (consumes findings, mutates worktree, self-verifies)
        |                  ★ GATE 2: accept/reject the fixes (conversation-led)
   [VERIFY-ELECTION]  human: "run runtime verification? [y/n]"
        |   n -> verify-seed skipped -> pr
        |   y ↓
  verify-seed (seeds headless cluster)
        |                  ★ GATE 3: human runs the manual test
  pr (haiku)               -> opens the PR
        |
  reflect                  ★ GATE 4: per-proposal accept/reject (post-PR, skippable)
        |
  apply-reflection (writes worktree-private .claude/** only; 4 guardrails)
```

### Why review and fix are SPLIT (central decision)

- **review** is read-only: never touches the worktree, so its entire downstream contract is ONE schema-defined artifact (`findings.json`) — fully stabilizable.
- **fix** is the mutating node and carries the conversation-led gate, so the human gates the actual CODE CHANGES, with full session memory (reject-to-converse works because fix is static).
- This collapses the old six-static-reviewer-nodes + conditional-join + synthesize-Stop-loop into review (fan-out) -> findings -> fix (gated).

### The adversarial verifier (what it is, why it is singled out)

- It is a **second-order discriminator, not a seventh reviewer.** The reviewers read the diff and GENERATE findings; the verifier reads the reviewers' FINDINGS (in isolated context, not having seen their reasoning), grounds each against the actual diff, and drops/downgrades ungrounded ones. Same principle as the fresh-model pass that caught 5 bugs in the dagrunner build.
- It cannot be folded into a reviewer: (a) **ordering** — structurally downstream, needs all findings as input; (b) **isolation** — its value is independence from the reviewers' bias; (c) **cost** — a strong-tier pass worth running only when there are enough findings to prune.
- **Trigger:** runtime finding-count threshold inside the review node (findings > N, default 3). NOT an upstream/predicted flag.

### The gates

1. **expand-guide gate** — review the implementation guide before any code is written (highest leverage).
2. **fix gate** — accept/reject the fixes applied to the worktree.
3. **verify-election + verify-seed gate** — after fix approval, the human elects y/n whether runtime verification is needed (decided WITH full context of the diff + findings, not predicted upfront). `n` => verify-seed skipped, straight to pr. `y` => verify-seed runs, then the manual-test gate. Reuses the conditional-node `when` machinery with a human-answered predicate.
4. **reflect gate** — per-proposal approval of process-knowledge changes (post-PR, skippable, never blocks the PR).

All gates: checkpoint-and-exit, single-awaiting-gate invariant, conversation-led reject (resume same session + feedback artifact). Gates live ONLY on static nodes.

### Review node findings schema (dagrunner owns it; single source of truth)

```
{
  run_id, timestamp,                          // passed IN, not generated
  triage: { touches_public_api, touches_runtime,
            touches_schema_or_proto, performance_sensitive },
  reviewers_run: [string],
  reviewers_skipped: [{ name, reason }],
  adversarial_verifier_run: bool,             // true only if findings count > N
  findings: [
    { reviewer_dimension, severity:'blocker'|'major'|'minor'|'nit',
      confidence:'high'|'med'|'low', file, line, claim, grounded:bool }
  ]
}
```

`triage` is produced INSIDE the review node (replaces the former external classify contract). Reviewer selection: correctness + test-adequacy always; api-stability when touches_public_api; distributed-systems when touches_runtime; migration-safety when touches_schema_or_proto; performance when triage judges it performance-sensitive.

---

## 4. The spine (durable backbone — built in Phase 1)

- **run-id** = `<issue>-<slug>` (re-run appends counter). Mirrors branch `feature/<issue>-<slug>`.
- **state.json** per run: top-level (runId, workflow, status, worktreePath, branch, sourcePlanPath, costs) + per-node (status, timestamps, artifacts, model, iteration, gateHistory).
- **Checkpoint-and-exit at gates**; **reconcile-on-resume** (running->failed for dead nodes, stale-lock release).
- **One run at a time** (global lockfile; verify cluster uses fixed ports). Paused runs release the lock; resume re-acquires.
- **Worktrees**: `git worktree add` off DEVHARNESS_SRC; teardown deferred to explicit `dagrun cleanup` (never auto — manual test happens post-pipeline).
- **Artifact channel**: run dir `~/.local/share/dagrunner/runs/<run-id>/<node>/` (survives teardown). Passed to nodes as absolute path via env (DAGRUN_ARTIFACTS).
- **produces contract**: a node is `done` only if it wrote its declared artifact(s); missing => failed (catches silent no-ops, incl. the `-p` empty-result regression).
- **Home layout (XDG)**: `~/.local/share/dagrunner/` (runs, worktrees, inbox, store, config.json), `~/.cache/dagrunner/` (content-addressed cache), `~/.local/bin/dagrun`, override `DAGRUNNER_HOME`, fail-loud no-cwd-fallback.
- **Hooks (native, programmatic)**: SessionStart sync (private files), PostToolUse format (stdin `tool_input.file_path`), Stop friction-journal + convergence/schema gates, SessionEnd cost capture.
- **Failure handling**: 4-class taxonomy (transient->retry, contract->fail, convergence-exhaustion->gate, budget->checkpoint-exit). Node failure != run failure; partial progress survives. Isolate-and-continue.

---

## 5. Runtime permission / sandbox / network model (Phase 2a deliverable)

Seeded into each worktree's `.claude/settings.json`, loaded via `settingSources:["project"]` with node `cwd` = worktree. DISTINCT from the build-time `bypassPermissions` posture used by the agent that BUILDS dagrunner.

Goal: **free inside the project, read anywhere, hard boundary on mutation/network outside — quiet (no prompts) before gates.**

```json
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "additionalDirectories": ["<run-dir artifacts path — injected per run>"],
    "allow": ["Read", "Bash(git *)", "Bash(npm run *)", "Bash(npx tsc *)"],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(sudo *)",
      "Bash(git push --force *)",
      "Bash(git push * --force)",
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(**/secrets/**)",
      "Write(**/.env*)"
    ]
  },
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "network": {
      "allowedDomains": [
        "api.anthropic.com",
        "registry.npmjs.org",
        "*.npmjs.org",
        "github.com",
        "*.githubusercontent.com"
      ]
    }
  }
}
```

- Inside project: auto (acceptEdits + worktree cwd). Read: global. Out-of-project mutation: kernel-blocked by macOS Seatbelt (hard block, not a prompt — a node attempting it is a bug signal, fails). Network: proxied + allowlisted, NOT cut off (WebFetch/WebSearch tools run in-process, unaffected; Bash network works for allowlisted domains; un-listed => loud failure).
- **Three gotchas:** (1) run-dir artifacts are OUTSIDE the worktree — inject the per-run artifact path into `additionalDirectories` or every node prompts; (2) Node-native `fetch`/undici ignores the proxy and breaks under the sandbox (npm/git/tsc respect it and are fine); (3) enterprise managed settings can override/lock user+project rules — governance check required.
- **Two sandbox CONTEXTS (do not conflate):** the agent BUILDING dagrunner runs under `bypassPermissions` + fail-closed deny-guard + scoped-to-project-dir (NOT Seatbelt). dagrunner RUNTIME nodes run under Seatbelt. Seatbelt is built into macOS (nothing to install); it must be FUNCTIONAL on the machine so the build agent can seed + prove the runtime sandbox (escape-write test, allowlist test, in-worktree-freedom test, both-formatters-fire test).

---

## 6. Preflight ("Prepare") — NOT a DAG node (Phase 2a, first deliverable)

`dagrun preflight` runs before the graph (and as the first thing `start` does). Fails loud on any miss: on expected base branch; git tree clean; DEVHARNESS_SRC resolves + is a repo; seeded permission settings.json present; Seatbelt available; network allowedDomains covers the task; ANTHROPIC_API_KEY unset; CLAUDE_CONFIG_DIR = ~/.claude-work; enterprise policy doesn't block what's needed; run-dir artifact path computed + in additionalDirectories. Rationale: the deterministic home for the "2am-disruption" class; must exist before review/fix mutate the real repo.

---

## 7. classify — REMOVED for now (returns Phase 5/6)

There is no classify node. Its only consumer was reviewer-selection, which now happens as the review node's internal diff-triage step (reads the diff — strictly better input than predicting from the plan). All former classify outputs were removed and relocated to where the information exists:

- `needs_runtime` -> human verify-election after the fix gate.
- `recommend_pr_review` / `pr_review_rationale` -> removed; the /pr-review call is the human's, judged from reviewer breadth in `dagrun status`.
- `run_adversarial_verifier` -> runtime finding-count threshold in the review node.
- `risk` -> removed (fed nothing).
- `touches_*` -> moved into review's diff-triage step.

**The principle (governs classify's return):** classify earns a node only when it ROUTES the graph, not when it annotates the change.

- Change-AREA detection (what files/layers) is derivable from the diff -> belongs downstream (review). Removed now.
- Task-TYPE routing (feature / bug / tech-debt / refactor) is NOT derivable from a not-yet-existent diff and changes the graph shape upfront -> needs an upfront node. Returns in Phase 5/6 when dagrunner handles multiple task types, as a genuine upfront branch-decider operating on the TASK.

---

## 8. Cost & model tiering

- Per-node model tiering in the validated workflow-def (load-time model-string validation). Fully under dagrunner's control (static pipeline; no tiering hidden in opaque interiors).
- Tiers: expand-guide=unpinned; review diff-triage=haiku; reviewers mixed (correctness/distributed-systems/performance unpinned; test-adequacy/api-stability/migration-safety sonnet); adversarial verifier=strong tier; fix=unpinned; verify-seed=haiku; pr=haiku; reflect=sonnet; apply-reflection=sonnet.
- Two-tier budget: per-run `--max-budget-usd` (predictable static pipeline) + per-invocation cap on any dynamic-boundary call (/pr-review, siblings).
- Cost capture: `--output-format json` => total_cost_usd + per-model breakdown; child workflow cost rolls into parent; per-agent recoverable from JSONL transcript. Cost into state.json; `dagrun status` shows total vs cap; reflect can flag disproportionate nodes. `--max-budget-usd` verified: enforced, clean error_max_budget_usd + exit 1, works on subscription billing.

---

## 9. Out-of-pipeline components (siblings — Phase 3)

- **/pr-review**: rebuild as a SAVED dynamic workflow (`.claude/workflows/`), invoked by name with structured `args`; KEEP the six specialist definitions as shared assets (reused by static in-pipeline review); replace only the orchestration glue. Author once interactively, then invoke the saved asset (never per-run generation). Pass run-id/timestamp via args (Date.now()/Math.random() throw inside workflows).
- **ci-babysit**: local/dagrunner-static (needs the local verify cluster + private context gh-aw's container can't reach). Optionally gh-aw DETECTS CI failure and dispatches to local dagrunner for the fix+verify. Borrow crev's `--since` for incremental re-review.
- **review-triage**: gh-aw (its "analyze + propose, never auto-write" shape IS gh-aw's safe-outputs model). Sits downstream of /pr-review + PR bots (Copilot/CodeRabbit) + human comments.

Defense-in-depth review model (why in-pipeline review stays static): pre-impl review (static+subagents, fast/bounded) -> PR bots (free dynamism on open) -> /pr-review (dynamic, deep, on-demand) -> human reviewers. The dynamism already exists downstream for free; the cheap deterministic pass gates access to the expensive one. Promote in-pipeline review to dynamic ONLY if downstream layers prove to catch too much.

---

## 10. Phase roadmap

| Phase   | Scope                                                                                                                                                                                                                                                                                 | Status             | Gated by                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------- |
| **1**   | Engine + spine + thin slice + Gate 1; state/resume/worktrees/artifacts/hooks/launcher; `dagrun report` static HTML. (Built classify/expand-guide/implement — classify-as-a-node since RETIRED; its logic moved into review's diff-triage.)                                            | ✅ DONE & hardened | —                                  |
| **2a**  | (1) Preflight + runtime permission/sandbox/network model [FIRST]; (2) review node (diff-triage self-select + fan-out + finding-count-gated verifier -> findings schema); (3) fix node (gated, self-verifying). Built + fixture-passed; see Change Order for post-fixture restructure. | IN PROGRESS        | nothing — pure SDK                 |
| **2b**  | verify-election + verify-seed (+ headless cluster) + Gate 3; pr node; reflect -> reflect-gate -> apply-reflection (4 guardrails)                                                                                                                                                      | after 2a           | 2a complete                        |
| **3**   | Siblings: ci-babysit (local), /pr-review (saved DW), review-triage (gh-aw)                                                                                                                                                                                                            | later              | **enterprise + governance checks** |
| **4**   | Live `dagrun ui` (Node-http + SSE + vanilla HTML, localhost-only, scrubbed)                                                                                                                                                                                                           | someday            | —                                  |
| **5/6** | Multi-task-type support (bug/tech-debt/refactor); classify RETURNS as an upfront task-type router                                                                                                                                                                                     | future             | —                                  |

Key insight: the verification gates separate Phase 2 from Phase 3, not Phase 1 from Phase 2. Phase 2 is fully unblocked (pure SDK). Phase 3 cannot start until enterprise/governance checks clear.

---

## 11. Open verification gates (must clear before Phase 3)

1. **Enterprise `disableWorkflows`**: `/workflows` confirmed AVAILABLE under ~/.claude-work. ✅
2. **SDK credit pool**: from 2026-06-15, Agent SDK / `claude -p` on subscription draws a separate monthly credit — confirm with the account owner it covers dagrunner's volume. DEFERRED (Phase 2a is pure SDK; not blocking).
3. **gh-aw governance**: runs in GitHub Actions under a repo-secret API key — different data path than local enterprise subscription; IT/governance sign-off for proprietary Camunda code.
4. **gh-aw maturity**: technical preview (billing bug in 0.68.4–0.71.3, retired); pin a known-good version; nothing mutating/critical on it yet.
5. **Pin Claude Code CLI/SDK version**: a `-p` regression once returned empty result while billing tokens (produces check catches the empty-artifact half).

---

## 12. Operating reminders (carry-forward)

- Every real-work `dagrun` command runs with `CLAUDE_CONFIG_DIR=~/.claude-work` (alias `dagrun-work`). Spawned sessions inherit config from the dagrun process, not other terminals.
- No API key — subscription auth; keep ANTHROPIC_API_KEY unset.
- Unattended runs: never auto-approve a gate; subagents must never end a turn with a question (autonomy directive in all agent .md + CLAUDE.md).
- Any FUTURE dynamic-in-pipeline node must be idempotent + cheap-to-re-run (workflow resume is session-scoped; no partial recovery).
- Schema is single-source-of-truth, owned by dagrunner, passed where needed — never duplicated.
- Reflect/apply-reflection: worktree-private .claude/\*\* only, allowlisted paths, exact approved diffs, snapshot-before-apply. Never committed to Camunda.
- Validation: Phase 2a mechanics -> fake polyglot fixture (planted flaws, both TS+Java formatters). End of Phase 2 -> de-scoped M2-6 subset (record-only, no CF rotation) on real camunda/camunda via a mimicked companion plan. Real #53839 stays for the weekend.

```

```
