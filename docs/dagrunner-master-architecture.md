# dagrunner — Master Architecture (Source of Truth)

Status: Living document. Supersedes the rough iPhone sketch and consolidates all design discussions, ADRs, and locked decisions.
Last updated: 2026-06-12
Owner: Eddie Tsedeke

---

## 1. What dagrunner is

A thin, static TypeScript orchestrator that walks a feature change through a fixed, gated pipeline — explore -> guide -> implement -> review -> fix -> verify -> PR -> reflect — pausing at defined human gates and checkpointing to disk so it survives process exit. It does not reinvent agent intelligence: each node is a Claude Code session spawned via the Agent SDK in an isolated git worktree. dagrunner owns only what Claude Code cannot do across separate sessions: the dependency graph, checkpoint-and-resume, worktree isolation, artifact hand-off, gates, and cost discipline.

Core principle: **code coordinates, model judges.** The TS orchestration is free; the node sessions cost. Reuse Claude Code primitives wherever they exist; build only the cross-process/worktree gaps.

---

## 2. The five-component system

| # | Component | Runs where | Role |
|---|---|---|---|
| 1 | **Glean Agent (Feature Task Companion)** | Glean | Produces the directional plan + knowledge map from org-wide context (Jira, docs, Slack) that dagrunner cannot see. Writes the INTENT; dagrunner's expand-guide writes the code-level HOW. |
| 2 | **dagrunner (static feature pipeline)** | local machine | The gated feature pipeline. The heart of the system. |
| 3 | **ci-babysit** | local (dagrunner-static) | Sibling: monitors CI on an open PR, rebases/fixes/re-verifies. Needs the local verify cluster + private context. |
| 4 | **/pr-review** | session / `claude -p` | Sibling: on-demand deep adversarial PR review as a SAVED dynamic workflow. |
| 5 | **review-triage** | GitHub Actions (gh-aw) | Sibling: ingests PR review comments (bots + humans + /pr-review), classifies, drafts replies, NEVER auto-posts (gh-aw safe-outputs). |

The unifying frame: three substrates at three locations — local-gated (dagrunner), session-on-demand (dynamic workflows), CI-event-driven (gh-aw) — converging at the PR boundary for everything post-implementation.

---

## 3. The feature pipeline (Component 2) — fully static

All nodes are static DAG nodes. No dynamic-workflow node lives inside the feature pipeline (by design — see ADR). Native subagents are used INSIDE the review node for the bounded parallel fan-out.

```
[Glean directional plan dropped in inbox]
        |
   [PREFLIGHT]  (not a DAG node — runs before the graph; see §6)
        |
  classify (haiku)        -> routing contract: tiers, reviewer set,
        |                    verifier on/off, recommend_pr_review advisory
  expand-guide (unpinned)  ★ GATE 1: review the guide (conversation-led)
        |
  implement (unpinned)
        |
  review (static subagent fan-out over bounded reviewer set
          + adversarial verifier + synthesize)   [READ-ONLY]
        |                    -> findings.schema.json (single stable artifact)
  fix (consumes findings, mutates worktree, self-verifies)
        |                  ★ GATE 2: accept/reject the fixes (conversation-led)
  verify-seed (haiku, only if classify.needs_runtime)
        |                  ★ GATE 3: human runs the manual test
  pr (haiku)              -> opens the PR; PR body notes recommend_pr_review
        |
  reflect                ★ GATE 4: per-proposal accept/reject (post-PR, skippable)
        |
  apply-reflection (writes worktree-private .claude/** only; 4 guardrails)
```

### Why review and fix are SPLIT (central decision)
- **review** is read-only: it never touches the worktree, so its entire downstream contract is ONE schema-defined artifact (`findings.json`) — fully stabilizable.
- **fix** is the mutating node and carries the conversation-led gate, so the human gates the actual CODE CHANGES, with full session memory (reject-to-converse works because fix is static).
- This restores the conversation-led gate that a combined dynamic review/fix node would have lost, and collapses the old six-static-reviewer-nodes + conditional-join + synthesize-Stop-loop into review (fan-out) -> findings -> fix (gated).

### The three (four incl. reflect) gates
1. **expand-guide gate** — review the implementation guide before any code is written (highest leverage).
2. **fix gate** — accept/reject the fixes applied to the worktree.
3. **verify-seed gate** — human runs the manual test, approves real behavior (only when needs_runtime).
4. **reflect gate** — per-proposal approval of process-knowledge changes (post-PR, skippable, never blocks the PR).

All gates: checkpoint-and-exit, single-awaiting-gate invariant, conversation-led reject (resume same session + feedback artifact). Gates live ONLY on static nodes.

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

## 5. Runtime permission / sandbox / network model (NEW — Phase 2a deliverable)

Seeded into each worktree's `.claude/settings.json`, loaded via `settingSources: ["project"]` with node `cwd` = worktree. Distinct from the build-time `bypassPermissions` used for the overnight build.

Goal: **free inside the project, read anywhere, hard boundary on mutation/network outside — quiet (no prompts) before gates.**

```json
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "additionalDirectories": ["<run-dir artifacts path — injected per run>"],
    "allow": ["Read", "Bash(git *)", "Bash(npm run *)", "Bash(npx tsc *)"],
    "deny": [
      "Bash(rm -rf *)", "Bash(sudo *)",
      "Bash(git push --force *)", "Bash(git push * --force)",
      "Read(**/.env)", "Read(**/.env.*)", "Read(**/secrets/**)", "Write(**/.env*)"
    ]
  },
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "network": {
      "allowedDomains": ["api.anthropic.com", "registry.npmjs.org", "*.npmjs.org", "github.com", "*.githubusercontent.com"]
    }
  }
}
```

How it realizes the model:
- **Inside project: auto** — acceptEdits + worktree-as-cwd => edits/writes/deletes in the worktree, no prompt.
- **Read anywhere: yes** — `allow: ["Read"]` global.
- **Mutation outside project: kernel-blocked** by macOS Seatbelt sandbox (not a prompt — a hard block; a node attempting it is a bug signal, fails rather than waits).
- **Network: proxied + allowlisted** — NOT cut off. Two paths:
  - Agent's WebFetch/WebSearch tools run in-process => unaffected by the Bash sandbox; still work.
  - Bash network (npm/git/curl) routes through the out-of-sandbox proxy; allowlisted domains work silently, un-listed => loud failure (preflight must validate allowlist covers the task).
- **Catastrophic ops denied** as defense-in-depth even inside.

Known gotchas (recorded):
1. **Run-dir artifacts are OUTSIDE the worktree** — must be injected into `additionalDirectories` per run, or every node prompts. Single most likely source of unexpected prompts.
2. **Node-native `fetch` (undici) ignores the proxy** and breaks under the sandbox even on allowed domains — most tools (npm/pip/curl/git-https/requests) respect it; a raw `fetch()` needs ProxyAgent or excludedCommands.
3. **Enterprise managed settings can override/lock** user+project rules (policySettings, allowManagedPermissionRulesOnly) — governance check required.

---

## 6. Preflight check ("Prepare") — NOT a DAG node (Phase 2a, first deliverable)

`dagrun preflight` runs before the graph (and as the first thing `start` does). Fails loud on any miss. Checks:
- On the expected base branch; git working tree clean.
- DEVHARNESS_SRC resolves and is a git repo.
- Seeded permission `settings.json` present; sandbox available (macOS Seatbelt).
- Network `allowedDomains` covers what the task needs.
- ANTHROPIC_API_KEY unset; CLAUDE_CONFIG_DIR points at the work config (~/.claude-work).
- Enterprise managed policy does not block what the run needs.
- Run-dir artifact path computed and in additionalDirectories.

Rationale: this is the deterministic home for the "2am-disruption" class hit during the first build. It must land BEFORE review/fix do real autonomous mutation on the real repo.

---

## 7. classify schema (routing contract)

All booleans except risk:
```
{
  touches_public_api, touches_runtime, perf_sensitive,
  touches_schema_or_proto, needs_runtime,
  risk: 'low' | 'med' | 'high',
  run_adversarial_verifier: bool,        // depth dial
  recommend_pr_review: bool,             // ADVISORY ONLY — informational
  pr_review_rationale: string            // one line, why /pr-review would help
}
```
- classify is STATIC and stays static — its output is the routing contract that drives reviewer `when`, tiers, verifier on/off.
- classify is a **cost-shaping DIAL, not a dynamic switch**: it scales HOW MUCH review (breadth + depth + verifier), never WHAT MECHANISM.
- `recommend_pr_review` does NOT trigger anything — dagrunner has no control over the post-PR dynamic /pr-review. It surfaces in `dagrun status`/`report` and the PR body so Eddie can decide to run /pr-review manually after the PR is up.

---

## 8. Cost & model tiering

- Per-node model tiering lives in the validated workflow-def (load-time model-string validation). Fully under dagrunner's control (no tiering hidden in opaque interiors, since the pipeline is static).
- Tiers: classify=haiku, expand-guide=unpinned, reviewers mixed (correctness/distributed-systems/performance unpinned; others sonnet), fix=unpinned, verify-seed=haiku, pr=haiku, reflect=sonnet, apply-reflection=sonnet.
- Two-tier budget: per-run `--max-budget-usd` (now predictable, static pipeline) + per-invocation cap on any dynamic boundary call (/pr-review, siblings).
- Cost capture: `--output-format json` => total_cost_usd + per-model breakdown; child workflow cost rolls into parent; per-agent recoverable from JSONL transcript. Cost into state.json; `dagrun status` shows total vs cap; reflect can flag disproportionate nodes.
- `--max-budget-usd` verified: enforced, clean error_max_budget_usd + exit 1, works on subscription billing.

---

## 9. Out-of-pipeline components (siblings — Phase 3)

- **/pr-review**: rebuild as a SAVED dynamic workflow (`.claude/workflows/`), invoked by name with structured `args`; KEEP the six specialist definitions as shared assets (reused by static in-pipeline review); replace only the orchestration glue. Author once interactively, then invoke the saved asset (never per-run generation). Determinism constraint: pass run-id/timestamp via args (Date.now()/Math.random() throw inside workflows).
- **ci-babysit**: local/dagrunner-static (needs the local verify cluster + private context gh-aw's container can't reach). Optionally gh-aw DETECTS CI failure and dispatches to local dagrunner for the fix+verify. Borrow crev's `--since` for incremental re-review.
- **review-triage**: gh-aw (its "analyze + propose, never auto-write" shape IS gh-aw's safe-outputs model). Sits downstream of /pr-review + PR bots (Copilot/CodeRabbit) + human comments.

Defense-in-depth review model (why in-pipeline review stays static): pre-impl review (static+subagents, fast/bounded) -> PR bots (free dynamism on open) -> /pr-review (dynamic, deep, on-demand) -> human reviewers. The dynamism already exists downstream for free; the cheap deterministic pass gates access to the expensive dynamic pass. Promote in-pipeline review to dynamic ONLY if downstream layers prove to catch too much.

---

## 10. Phase roadmap

| Phase | Scope | Status | Gated by |
|---|---|---|---|
| **1** | Engine + spine + thin slice (classify/expand-guide/implement + Gate 1); state/resume/worktrees/artifacts/hooks/launcher; `dagrun report` static HTML | ✅ DONE & hardened | — |
| **2a** | (1) Preflight + runtime permission/sandbox/network model [FIRST], then (2) review node (subagent fan-out + adversarial verifier -> findings schema), then (3) fix node (gated, self-verifying) | NEXT | nothing — pure dagrunner + SDK |
| **2b** | verify-seed (+ headless verify cluster wiring) + Gate 3; pr node; reflect -> reflect-gate -> apply-reflection (4 guardrails) | after 2a | 2a complete |
| **3** | Siblings: ci-babysit (local), /pr-review (saved DW), review-triage (gh-aw) | later | **enterprise + governance checks** |
| **4** | Live `dagrun ui` (Node-http + SSE + vanilla HTML, localhost-only, scrubbed) | someday | — |

Key phasing insight: **the verification gates separate Phase 2 from Phase 3, not Phase 1 from Phase 2.** Phase 2 is fully unblocked to start now (pure SDK). Phase 3 cannot start until the enterprise/governance checks clear.

Dependency notes:
- Preflight + permission model are the FIRST 2a deliverable (must exist before review/fix mutate the real repo).
- review (2a) must precede verify-seed (2b) — verify tests the fixed code.
- pr depends on fix; reflect depends on the whole pipeline existing.

---

## 11. Open verification gates (must clear before Phase 3)

1. **Enterprise `disableWorkflows`**: run `/workflows` under ~/.claude-work; confirm not disabled by Camunda policy.
2. **SDK credit pool**: from 2026-06-15, Agent SDK / `claude -p` on subscription draws a separate monthly credit — confirm with the account owner it covers dagrunner's volume (dagrunner drives every node via the SDK).
3. **gh-aw governance**: runs in GitHub Actions under a repo-secret API key — different data path than local enterprise subscription; IT/governance sign-off for proprietary Camunda code.
4. **gh-aw maturity**: technical preview (billing bug in 0.68.4-0.71.3, retired); pin a known-good version; nothing mutating/critical on it yet.
5. **Pin Claude Code CLI/SDK version**: a `-p` regression once returned empty result while billing tokens (produces check catches the empty-artifact half).

---

## 12. Operating reminders (carry-forward)

- Every real-work `dagrun` command runs with `CLAUDE_CONFIG_DIR=~/.claude-work` (alias `dagrun-work`). Spawned sessions inherit config from the dagrun process, not other terminals.
- No API key — subscription auth; keep ANTHROPIC_API_KEY unset.
- Unattended runs: never auto-approve a gate; subagents must never end a turn with a question (autonomy directive in all agent .md + CLAUDE.md).
- Any FUTURE dynamic-in-pipeline node must be idempotent + cheap-to-re-run (no partial recovery; workflow resume is session-scoped).
- Schema is single-source-of-truth, owned by dagrunner, passed into any workflow via args — never duplicated.
- Reflect/apply-reflection: worktree-private .claude/** only, allowlisted paths, exact approved diffs, snapshot-before-apply. Never committed to Camunda.
