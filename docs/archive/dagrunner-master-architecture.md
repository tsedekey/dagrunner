# dagrunner — Master Architecture (Source of Truth)

Status: Living document, canonical. Supersedes the rough iPhone sketch, the standalone Dynamic-Workflows ADR (kept as deeper "why" reference), and all prior master-doc revisions.
Last updated: 2026-06-14
Owner: Eddie Tsedeke

---

<!-- CHANGELOG (2026-06-14 reconciliation against code)
Phase 1: DAG core, spine, state, worktree, SDK runner, report, preflight skeleton, thin-slice nodes.
  Key files: dag.ts, run-engine.ts (startRun/resumeRun), state.ts, types.ts, xdg.ts, launcher.ts,
             feature-workflow.ts (expand-guide+implement+review+fix), report.ts, preflight.ts.
Phase 2a: (1) Full preflight + runtime sandbox (settings-seed.ts, session-start.sh, stop-verifier.sh,
  stop-schema.sh, post-tool-use-format.sh, session-end.sh, deny-guard.sh); (2) review node
  (/review command + 7 agent files); (3) fix node (/fix command + gated). stop-schema.sh wired
  but classify is dormant — schema hook only fires for DAGRUN_NODE_ID == "classify".
Phase 2b: verify-election (micro-gate in resumeRun), verify-guide node (/verify-guide command,
  3 artifacts: seeding-spec.json + tour-spec.json + manual-test.md, Gate 3), pr node (/pr command,
  body.md + pr-meta.json), reflect node (/reflect, 2 flavors), apply-reflection node
  (/apply-reflection, guardrails), revert-reflection command, rerun command, runPrPostProcess.
  verifyElection field added to RunState. pr post-process (git push + gh pr create) moved outside
  agent sandbox due to TLS issues with Go binaries inside macOS Seatbelt proxy.
Post-2b: sandbox additionalDirectories expanded to include DEVHARNESS_SRC and dagrunnerHome
  (required for apply-reflection to write CLAUDE.local.md into DEVHARNESS_SRC and proposals into
  dagrunner store; all logged in DECISIONS.md).
-->

---

## 1. What dagrunner is [DRIFTED]

A thin, static TypeScript binary (`dagrun`) that orchestrates a DAG of Claude Code agent runs through a fixed, gated pipeline — expand-guide → implement → review → fix → verify-guide → pr → reflect → apply-reflection — pausing at defined human gates and checkpointing to disk so it survives process exit. It does not reinvent agent intelligence: each node is a Claude Code session spawned via the Agent SDK in an isolated git worktree. dagrunner owns only what Claude Code cannot do across separate sessions: the dependency graph, checkpoint-and-resume, worktree isolation, artifact hand-off, gates, and cost discipline.

<!-- DRIFT: §1 previously said "explore -> guide -> ... -> PR -> reflect" (no apply-reflection). Updated to list all 8 nodes by actual command name. The pipeline text below is unchanged in spirit. -->

Core principle: **code coordinates, model judges.** The TS orchestration is free; the node sessions cost. Reuse Claude Code primitives wherever they exist; build only the cross-process/worktree gaps.

Design north star (validated repeatedly this project): **strip everything predictive out of the front of the pipeline; decide each thing where the information actually exists.** A decision made from the directional plan before code exists is strictly worse than the same decision made from the diff/findings later.

---

## 2. The four-component system [DRIFTED]

<!-- DRIFT: Section was titled "five-component" but the table has always had 4 rows. Corrected to "four-component". -->

| #   | Component                                | Runs where               | Role                                                                                                                                                                                           |
| --- | ---------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Glean Agent (Feature Task Companion)** | Glean                    | Ingests a GitHub task; emits a directional implementation plan (INTENT/why). dagrunner's expand-guide writes the code-level HOW. The plan is dagrunner's inbox input — no GitHub issue needed. |
| 2   | **dagrunner (static feature pipeline)**  | local machine            | The gated feature pipeline. The heart of the system.                                                                                                                                           |
| 3   | **ci-babysit**                           | local (dagrunner-static) | Sibling: monitors CI on an open PR, rebases/fixes/re-verifies. Needs the local verify cluster + private context.                                                                               |
| 4   | **review-triage**                        | local (dagrunner-static) | Sibling: polls PR review comments, classifies, drafts replies into artifacts, NEVER auto-posts (per-comment human approve/post via dagrunner gates).                                           |

Phase 3 is two LOCAL dagrunner-static siblings (ci-babysit + review-triage) — one substrate, enterprise subscription locally. `/pr-review` is NOT a dagrunner sibling: it stays a private standalone command for reviewing OTHERS' PRs (see §9). gh-aw and dynamic-workflows-in-pipeline are not used (see §9 rationale).

---

## 3. The feature pipeline (Component 2) — fully static [DRIFTED]

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
   [VERIFY-ELECTION]  human: "runtime verification needed? [y/n]"
        |   n -> verify-guide skipped -> pr
        |   y ↓
  verify-guide (haiku): writes seeding-spec.json, tour-spec.json, manual-test.md
        |                  ★ GATE 3: human spins up the cluster + runs the manual test
  pr (haiku)               -> writes body.md; dagrunner pushes + creates draft PR post-exit
        |
  reflect (sonnet)          ★ GATE 4: per-proposal accept/reject (post-PR, skippable)
        |
  apply-reflection (sonnet) -> flavor 1 into DEVHARNESS_SRC; flavor 2 into store/
```

<!-- DRIFT: (a) verify-guide now produces 3 artifacts (seeding-spec.json, tour-spec.json, manual-test.md), not just manual-test.md. The three-artifact contract is the input spec for /verify-demo (Phase 3). (b) pr node annotation updated: git push and gh pr create happen OUTSIDE the agent session (in Node.js runPrPostProcess) due to TLS issues with Go binaries inside the macOS Seatbelt proxy — see §5 Three gotchas. (c) reflect and apply-reflection added to the diagram text. -->

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
3. **verify-election + verify-guide gate** — after fix approval, the human elects y/n whether runtime verification is needed (decided WITH full context of the diff + findings, not predicted upfront). `n` => verify-guide skipped, straight to pr. `y` => verify-guide writes three artifacts (seeding-spec.json + tour-spec.json + manual-test.md — see §7c), then the manual-test gate where the human spins up the cluster themselves and runs it. Reuses the conditional-node `when` machinery with a human-answered predicate. NOTE: the automated cluster-stand-up node (former "verify-seed") was REMOVED — see §7c.
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

## 4. The spine (durable backbone — built in Phase 1) [DRIFTED]

<!-- DRIFT: (a) run-id format corrected: code generates `${slug}-${Date.now()}` where slug = planPath basename lowercased/slugified. There is NO `<issue>` prefix from the plan filename itself — the user's plan filename IS the slug. (b) state.json shape now includes `verifyElection: "y"|"n"` field (added Phase 2b). No top-level `costs` field — costs are per-node inside `nodes`. (c) CLI command surface is much larger than previously documented. (d) friction.jsonl described here for completeness. -->

- **run-id** = `<plan-filename-slug>-<unix-timestamp>`. Slug is derived by lower-casing and replacing non-alphanumeric/dash characters in the plan file's basename (minus `.md`). Example: plan file `feature-plan-position.md` → run-id `feature-plan-position-1781446096738`. Mirrors branch `feature/<slug>` created inside the worktree.
- **state.json** per run:
  - Top-level: `runId, workflow, createdAt, updatedAt, status, worktreePath, branch, sourcePlanPath, verifyElection?`
  - Per-node (keyed by node id): `status, startedAt?, endedAt?, artifacts[], model?, iteration, sessionId?, cost, gateHistory[], error?`
  - `verifyElection: "y"|"n"` — captured once after Gate 2 approval; pre-marks verify-guide skipped when `n`.
  - No top-level cost aggregate — sum per-node `cost` for the total.
- **friction.jsonl** — per-run JSONL file (`<run-dir>/friction.jsonl`); each entry written by the SessionEnd hook: `{"ts":"<ISO>","node":"<id>","sessionId":"<id>","event":"session-end","costUsd":<number>}`. This is reflect's "friction journal" input.
- **Checkpoint-and-exit at gates**; **reconcile-on-resume** (running→failed for dead nodes, interrupted nodes reset to pending on resume).
- **One run at a time** (global lockfile; verify cluster uses fixed ports). Paused runs release the lock; resume re-acquires.
- **Worktrees**: `git worktree add` off DEVHARNESS_SRC; teardown deferred to explicit `dagrun cleanup` (never auto — manual test happens post-pipeline).
- **Artifact channel**: run dir `~/.local/share/dagrunner/runs/<run-id>/<node>/` (survives teardown). Passed to nodes as absolute path via env (`DAGRUN_ARTIFACTS`). `DAGRUN_RUN_DIR` = run dir root (read-only across nodes; `DAGRUN_ARTIFACTS` is per-node).
- **produces contract**: a node is `done` only if it wrote its declared artifact(s); missing => failed (catches silent no-ops, incl. the `-p` empty-result regression).
- **Home layout (XDG)**: `~/.local/share/dagrunner/` (`runs/`, `worktrees/`, `inbox/`, `store/`), `~/.cache/dagrunner/` (preflight context; content-addressed cache not yet used), `~/.local/bin/dagrun`, override `DAGRUNNER_HOME`, fail-loud no-cwd-fallback.
- **Hooks (native, programmatic)**: SessionStart sync (private files), PostToolUse format (frontend-file extension guard — TS/JS/CSS/HTML only), Stop convergence/schema gates, SessionEnd cost+session capture (→ friction.jsonl).
- **Failure handling**: optional node failure → skipped (non-blocking for dependents); non-optional failure → run halts as `failed`. Transient/retryable failures retry up to `maxRetries` (default 2) before becoming terminal. Interrupted nodes (reconciled on resume) reset to pending.
- **PR post-processing (outside sandbox)**: after the pr node completes, `runPrPostProcess` in Node.js pushes the feature branch (`git push origin HEAD`) and creates a draft PR (`gh pr create --draft`) from outside the Claude Code sandbox. This is mandatory — Go binaries (`gh`) don't trust the macOS Seatbelt proxy certificate; Node.js uses the keychain correctly. PR URL is written back to `pr-meta.json` on success; `pr-error.txt` on failure.

### CLI command surface

```
dagrun init [--home <path>]
dagrun preflight [--base-branch <branch>] [--config <file>]
dagrun start <workflow> --plan <file> [--max-budget-usd <n>] [--force]
dagrun resume <run-id> [--approve] [--reject "<comment>"] [--verify y|n]
dagrun status [<run-id>]
dagrun list
dagrun abort <run-id>
dagrun cleanup <run-id>
dagrun cleanup --all
dagrun clear <run-id>
dagrun clear --all [--yes]
dagrun report <run-id>
dagrun logs <run-id> <node>
dagrun rerun <run-id> <node-id>
dagrun revert-reflection <run-id>
```

Key commands not in the prior doc:

- **`dagrun rerun <run-id> <node-id>`** — re-executes a single node against the existing worktree in isolation. Re-seeds `.claude/` (commands, hooks, settings.json) from current dagrunner source so prompt/settings changes take effect immediately. Wipes node's artifact dir, runs the node, updates state.json. Used to test node changes or recover from failed nodes without restarting the full pipeline. Does NOT acquire the run lock (debug/recovery tool).
- **`dagrun revert-reflection <run-id>`** — reads `reflect/backup/manifest.json` and restores the snapshotted DEVHARNESS_SRC files, undoing apply-reflection. Used for test runs or rollbacks.
- **`dagrun abort <run-id>`** — marks a run aborted and releases the lock.
- **`dagrun clear <run-id> / --all [--yes]`** — deletes run artifact directories from disk.
- **`dagrun logs <run-id> <node>`** — dumps all artifact files for a node to stdout.
- **`dagrun list`** — tabular list of all runs with status and updated timestamp.

---

## 5. Runtime permission / sandbox / network model (Phase 2a deliverable) [DRIFTED]

<!-- DRIFT: (a) additionalDirectories now includes DEVHARNESS_SRC and dagrunnerHome (added post-2b to allow apply-reflection to write CLAUDE.local.md into DEVHARNESS_SRC and proposals into store/). (b) allow list expanded with Maven, curl, jq, MCP tools. (c) deny list expanded with credential-write guards, MCP tool denies. (d) allowedDomains expanded with api.github.com, Maven/Gradle repos. (e) Three gotchas updated: gotcha #1 now also notes DEVHARNESS_SRC and dagrunnerHome; new gotcha #4 about Go binaries and sandbox TLS. -->

Seeded into each worktree's `.claude/settings.json`, loaded via `settingSources:["project"]` with node `cwd` = worktree. DISTINCT from the build-time `bypassPermissions` posture used by the agent that BUILDS dagrunner.

Goal: **free inside the project, read anywhere, hard boundary on mutation/network outside — quiet (no prompts) before gates.**

Actual seeded settings (as of post-2b):

```json
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "additionalDirectories": [
      "<run-dir>",
      "~/.m2",
      "~/.docker",
      "/tmp",
      "<tmpdir>",
      "<DEVHARNESS_SRC>",
      "<DAGRUNNER_HOME>"
    ],
    "allow": [
      "Read",
      "Bash(git *)",
      "Bash(npm *)",
      "Bash(npx tsc *)",
      "Bash(npx prettier *)",
      "Bash(./mvnw *)",
      "Bash(cd java && ./mvnw *)",
      "Bash(mvn *)",
      "Bash(curl *)",
      "Bash(jq *)",
      "mcp__camunda-knowledge__docs_lookup",
      "mcp__camunda-knowledge__semgrep_scan",
      "mcp__camunda-knowledge__bpmn_lint",
      "mcp__camunda-knowledge__zeebe_invariants",
      "mcp__camunda-knowledge__graph_query"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(sudo *)",
      "Bash(git push --force *)",
      "Bash(git push * --force)",
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(**/secrets/**)",
      "Write(**/.env*)",
      "mcp__camunda-knowledge__history_search",
      "mcp__camunda-knowledge__incident_search",
      "mcp__camunda-knowledge__sg_search",
      "mcp__camunda-knowledge__sg_definition",
      "mcp__camunda-knowledge__sg_references"
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
        "api.github.com",
        "*.githubusercontent.com",
        "repo.maven.apache.org",
        "central.maven.org",
        "*.maven.org",
        "plugins.gradle.org"
      ]
    }
  },
  "hooks": {
    "SessionStart": [{ "command": "session-start.sh" }],
    "Stop": [
      { "command": "stop-verifier.sh" },
      { "command": "stop-schema.sh" }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "command": "post-tool-use-format.sh"
      }
    ],
    "SessionEnd": [{ "command": "session-end.sh" }]
  }
}
```

- Inside project: auto (acceptEdits + worktree cwd). Read: global. Out-of-project mutation: kernel-blocked by macOS Seatbelt (hard block, not a prompt — a node attempting it is a bug signal, fails). Network: proxied + allowlisted, NOT cut off (WebFetch/WebSearch tools run in-process, unaffected; Bash network works for allowlisted domains; un-listed => loud failure).
- **Four gotchas:** (1) run-dir artifacts are OUTSIDE the worktree — inject the per-run artifact path into `additionalDirectories` or every node prompts. Also DEVHARNESS_SRC and DAGRUNNER_HOME are now listed so apply-reflection can write private files back (logged in DECISIONS.md as a scope decision; prompt-discipline is the guard); (2) Node-native `fetch`/undici ignores the proxy and breaks under the sandbox (npm/git/tsc respect it and are fine); (3) enterprise managed settings can override/lock user+project rules — governance check required; (4) **Go binaries (`gh`, any cgo binary) do not trust the macOS Seatbelt proxy certificate** — they bypass the keychain. Any tool that needs `gh` MUST run outside the sandbox via Node.js `execSync` (see `runPrPostProcess` in §4).
- **Two sandbox CONTEXTS (do not conflate):** the agent BUILDING dagrunner runs under `bypassPermissions` + fail-closed deny-guard + scoped-to-project-dir (NOT Seatbelt). dagrunner RUNTIME nodes run under Seatbelt. Seatbelt is built into macOS (nothing to install); it must be FUNCTIONAL on the machine so the build agent can seed + prove the runtime sandbox (escape-write test, allowlist test, in-worktree-freedom test, both-formatters-fire test).
- **stop-schema.sh wiring note:** stop-schema.sh is wired into every node session but is effectively dormant — it is a no-op for every `DAGRUN_NODE_ID` except `"classify"`, and classify is not in the current pipeline. Retained as the gate mechanism for Phase 5/6 classify revival.

---

## 6. Preflight ("Prepare") — NOT a DAG node (Phase 2a, first deliverable) [DRIFTED]

<!-- DRIFT: (a) Actual checks implemented are a subset of the doc spec. (b) `dagrun start` runs preflight automatically (hard fail if it fails). (c) `dagrun preflight` also emits agent context to ~/.cache/dagrunner/preflight-context.md. (d) Checks NOT yet implemented are marked. -->

`dagrun preflight` runs before the graph (and as the first thing `start` does). Implemented checks:

1. **DEVHARNESS_SRC resolves and is a git repo** — fails loud.
2. **On expected base branch** (default: `main`) — fails loud.
3. **Git working tree clean** in DEVHARNESS_SRC — fails loud.
4. **Dagrunner home subdirs exist** (`runs/`, `worktrees/`, `inbox/`, `store/`) — fails loud.
5. **Auth credential present** — checks ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or `claude auth status` — fails loud.
6. **`claude` CLI on PATH** — fails loud.
7. **macOS Seatbelt available** (`sandbox-exec` on PATH) — advisory warning only, not a hard fail.

`dagrun preflight` additionally:

- Displays a merged agent context summary (commands/agents/skills/MCP servers/env/hooks from both dagrunner and DEVHARNESS_SRC) so the user can verify what nodes will see.
- Writes full agent context to `~/.cache/dagrunner/preflight-context.md` (includes the exact seeded settings.json template).

NOT YET IMPLEMENTED (from original spec):

- Seeded permission settings.json present check
- Network `allowedDomains` covers the task
- `ANTHROPIC_API_KEY unset` check (code allows API key; only checks `requireManagedAuth` if the caller sets it)
- Enterprise policy doesn't block what's needed

---

## 7. classify — REMOVED for now (returns Phase 5/6) [MATCHES]

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

## 7b. The reflect node — self-improvement (two flavors) [DRIFTED]

<!-- DRIFT: (a) notes.md from fix node is now REQUIRED (not optional); fix command writes it or writes "No non-obvious discoveries." if nothing to report. expand-guide and implement notes.md remain optional side-artifacts. (b) stop-schema.sh retention noted above in §5. (c) The dagrunner-proposals.md Flavor-2 proposals are appended to DAGRUNNER_HOME/store/proposals/proposals.jsonl (the sandbox now allows writes there via dagrunnerHome in additionalDirectories). -->

reflect is the self-improvement mechanism. It runs post-PR, is gated (per-proposal) and skippable, and NEVER blocks the PR. It produces TWO outputs with fundamentally different fates — they are more different than "two flavors of one thing": they diverge on input, destination repo, lifecycle, and crucially whether they are APPLIED or merely LOGGED.

|                 | Flavor 1 — Camunda knowledge                                                                                                                      | Flavor 2 — dagrunner improvement                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| What            | lessons about the Camunda codebase (where the job state machine lives, applier patterns, how tests run) so Claude understands it better next time | lessons about dagrunner itself (fix gate rejected 4x, review cost disproportionate, verifier threshold felt wrong) |
| Best input      | the run's ARTIFACTS — expand-guide/implement `notes.md` + guide.md + findings.json + the diff                                                     | the FRICTION JOURNAL (`friction.jsonl` entries from SessionEnd) + gate history in `state.json`                     |
| Output artifact | `reflect/camunda-knowledge.md`                                                                                                                    | `reflect/dagrunner-proposals.md`                                                                                   |
| Destination     | private, gitignored files in the PERMANENT Camunda checkout (DEVHARNESS_SRC)                                                                      | dagrunner's own `store/proposals/proposals.jsonl` (`~/.local/share/dagrunner/store/proposals/`)                    |
| Fate            | **APPLIED** (auto-written by apply-reflection, gated)                                                                                             | **LOGGED only — never auto-applied**                                                                               |

### Flavor 1 — Camunda knowledge: APPLY, but write back to DEVHARNESS_SRC (not the worktree)

- LOAD-BEARING: apply-reflection must write into **DEVHARNESS_SRC (the permanent main checkout), NOT the ephemeral worktree.** Worktrees are torn down by `dagrun cleanup`; knowledge written only into the worktree dies at cleanup — the opposite of "accumulates over time." This is the REVERSE of the SessionStart sync (which copies private files FROM DEVHARNESS_SRC INTO the worktree); apply-reflection writes new/updated knowledge BACK INTO DEVHARNESS_SRC so it survives and seeds future runs (as nested `CLAUDE.local.md` in the touched directories).
- Privacy mechanism: use `.git/info/exclude` (machine-local, itself never committed) for `**/CLAUDE.local.md`, stronger than the tracked `.gitignore`. Hard guardrail: flavor 1 may ONLY touch `*.local.md` / `.claude/` private variants — NEVER the committed `CLAUDE.md` (a team artifact; changing that is a PR, not a reflection).
- Four guardrails (unchanged): allowlist (`*.local.md` / `.claude/` private only), `.git/info/exclude`, apply exact approved diffs only, snapshot-before-apply (to `runs/<run-id>/reflect/backup/`).
- **Sandbox access**: DEVHARNESS_SRC is in `additionalDirectories` so the sandbox allows writes there. Scope decision logged in DECISIONS.md: all nodes get this access; prompt-discipline is the guard for cross-tree writes.

### Flavor 2 — dagrunner improvement: LOG, never auto-apply

- reflect must NOT edit dagrunner's own code. Reasons: (a) dagrunner is real software needing tests + review — it cannot be safely hot-patched from inside a Camunda feature run; (b) its repo isn't even present in the worktree; (c) one run's friction is often noise — accumulate across runs before acting.
- Flavor 2 appends an observation to `~/.local/share/dagrunner/store/proposals/proposals.jsonl`. The human (or the build agent) later triages accumulated proposals and acts through the normal dagrunner build/review process. Logged, not applied. This is the primary consumer of the cross-run `store/` layer.
- **Revert**: `dagrun revert-reflection <run-id>` reads `runs/<run-id>/reflect/backup/manifest.json` and restores snapshotted DEVHARNESS_SRC files. Flavor-2 proposals in the store are NOT reverted (they are append-only; the human curates them independently).

### Capturing in-context knowledge before it is lost (the notes.md mechanism)

- Claude Code does NOT auto-persist memory in headless nodes, and `implement` should not curate memory (single-purpose nodes; its job is code).
- `expand-guide` and `implement` each emit an OPTIONAL `notes.md` side-artifact (discoveries about this area of the codebase) as they work.
- `fix` emits a REQUIRED `notes.md` (even if the content is "No non-obvious discoveries.") — the fix gate and reflect consume it; its absence in prior runs caused the PostToolUse formatting side-effects to go unrecorded.
- reflect synthesizes those + the diff + `friction.jsonl` into the flavor-1 proposals. This captures the rich in-context understanding (otherwise gone by reflect-time, since session context is discarded) without burdening the nodes or breaking the artifacts-only channel.

Symmetry: flavor 1 makes dagrunner better AT Camunda (knowledge accumulates in the checkout); flavor 2 makes dagrunner better AS A TOOL (proposals accumulate in the store). Neither crosses into the other's repo; only the safe one (flavor 1) auto-applies.

---

## 7c. verify-seed (automated cluster stand-up) — REMOVED [DRIFTED]

<!-- DRIFT: (a) verify-seed.md still exists in .claude/commands/ as a deprecated stub (marked DEPRECATED in its header). (b) verify-guide produces THREE artifacts (seeding-spec.json, tour-spec.json, manual-test.md), not just manual-test.md as the prior doc implied. (c) Schemas below are the actual implemented contracts from verify-guide.md. -->

The original 2b design had a `verify-seed` node that automatically stood up the headless cluster (Maven build, Elasticsearch under Docker, broker/gateway) and seeded data. It was REMOVED after the 2b fixture run: it exhausted all 5 attempts and aborted. Root cause is structural, not a config bug:

- **Cluster bring-up fundamentally conflicts with the runtime sandbox (§5).** The sandbox confines nodes to the worktree with no out-of-tree writes and an allowlisted network; cluster orchestration needs the opposite (Docker, broad network, Maven's full reach, host ports). Lifting the sandbox to accommodate it breaks the security model for the one node that needs it broken most — and even then it failed on further config issues.
- **Low ROI for a single DRI.** Eddie can spin up the cluster faster by hand (with experience), leaning on AI ad hoc when stuck. Automating it is negative ROI.

What was KEPT — the valuable half — is **verify-guide** (§3): a doc-only node (haiku) that reads the diff + findings + plan and writes THREE artifacts. It needs NO cluster/Docker/Maven, so it can't fail the way verify-seed did, and runs in seconds. The human then spins up the cluster themselves and runs the guide at Gate 3.

### verify-guide output contract (THREE artifacts; implemented in /verify-guide command)

- **`verify/seeding-spec.json`** — what to seed to demonstrate the feature, structured for `c8ctl`:

```json
{
  "deployments": [
    { "description": "<BPMN process>", "why": "<why it exercises the feature>" }
  ],
  "instances": [{ "process_id": "<id>", "variables": {}, "why": "<why>" }],
  "expected_observations": [
    {
      "where": "elasticsearch|operate|tasklist|rest-api|logs",
      "what": "<field>",
      "expected_value": "<value>"
    }
  ]
}
```

- **`verify/tour-spec.json`** — guided code-trail with CANDIDATE BREAKPOINTS at file:line, resolved from the diff:

```json
{
  "feature_summary": "<one-paragraph summary>",
  "breakpoints": [{ "file": "<relative>", "line": <int>, "why": "<why>", "what_to_observe": "<what>" }],
  "before_path": [{ "file": "<relative>", "line": <int>, "note": "<contrast note>" }]
}
```

All `file` + `line` values in `breakpoints` MUST resolve to real lines in the post-change worktree (verify-guide spot-checks at least one). `before_path` may be empty for pure additions. Minimum 2 breakpoints, maximum 8.

- **`verify/manual-test.md`** — human-readable render of both specs for Gate 3.

### /verify-demo — the Phase 3 interactive command (NOT built in 2b)

A standalone Claude Code command (like the personal /pr-review), OUTSIDE dagrunner and OUTSIDE the sandbox, that the human invokes to get a guided show-and-tell of the feature. It consumes verify-guide's two specs:

- Stands up a real headless C8 Orchestration Cluster via the DMS (Debugger MCP Server) JetBrains plugin (run configuration pre-existing) + Elasticsearch in Docker for secondary storage.
- seeding-spec -> creates the data via `c8ctl`.
- tour-spec -> sets breakpoints via DMS so the human can follow the code trail (a "show and tell").
- May also ingest the Glean companion guide as the "before" picture (feature before the change), with verify-guide's tour as the "after" — a before/after demonstration. (Workstation-coupled to DMS/c8ctl/docker — a personal interactive tool, not portable/unattended automation.)
- TECHNICAL LINCHPIN to spike before committing Phase 3: confirm the DMS MCP surface can programmatically SET breakpoints at file:line (not just inspect a session). If it can only inspect, the tour degrades to "here are the lines to break on yourself."

Automatability note: the GUIDE is fully automatable (verify-guide, in-pipeline). The cluster + seeding EXECUTION lives in /verify-demo OUTSIDE the sandbox (human-invoked) — never a sandboxed pipeline node.

---

## 8. Cost & model tiering [DRIFTED]

<!-- DRIFT: (a) Model tier assignments confirmed against feature-workflow.ts. (b) review node itself has no pinned model in the workflow definition — the diff-triage step and reviewer subagents pin their own models per the /review command prompt; the review NODE is effectively unpinned. (c) `dagrun status` shows per-node cost summed; it does NOT display a total-vs-cap comparison yet. -->

- Per-node model tiering in the validated workflow-def (load-time model-string validation). Fully under dagrunner's control (static pipeline; no tiering hidden in opaque interiors).
- Tiers (from feature-workflow.ts): expand-guide=unpinned; implement=unpinned; review=unpinned (diff-triage and subagents use haiku/mixed internally per /review command); fix=unpinned; verify-guide=haiku; pr=haiku; reflect=sonnet; apply-reflection=sonnet.
- Two-tier budget: per-run `--max-budget-usd` (predictable static pipeline) + per-invocation cap on any dynamic-boundary call (/pr-review, siblings).
- Cost capture: SDK `result.total_cost_usd` accumulated per node → `state.nodes[id].cost`; `dagrun status` shows per-node cost and summed total; reflect can flag disproportionate nodes (reads state.json cost fields). Per-model breakdown available in `transcript.log` (compact SDK JSON per line). `--max-budget-usd` verified: enforced, clean error_max_budget_usd + exit 1, works on subscription billing.
- NOT YET: `dagrun status` does not show total vs budget cap comparison.

---

## 9. Out-of-pipeline siblings (Phase 3) — FOUR interactive Claude Code commands [MATCHES]

All four are Claude Code commands living in `.claude/`, NOT dagrunner pipeline nodes and NOT sandboxed. They are workstation-coupled and human-driven (a human is always present). They run under `CLAUDE_CONFIG_DIR=~/.claude-work`. Built one at a time, in the order below.

### 9.1 `/verify-demo` environment creator (Sibling 1)

- Consumes `tour-spec.json` (from the verify-guide node) + the existing headless OC run configuration.
- Stands up a real debuggable headless Orchestration Cluster (Zeebe broker + gateway) via the **Debugger MCP Server (DMS)** JetBrains plugin, plus **Elasticsearch in Docker** as secondary storage; places the tour `breakpoints[]` (and `before_path[]` when present) at their file:line.
- Linchpin to confirm first via a tool spike: whether DMS can _set_ breakpoints programmatically (not just inspect). Degrade gracefully (emit manual breakpoint instructions) if not.
- Emits `environment.json` (gateway addr, ES URL) for Sibling 2.

### 9.2 `/verify-demo` seed-data creator (Sibling 2)

- Consumes `seeding-spec.json` (from verify-guide) + `environment.json` (from Sibling 1).
- Seeds the running cluster via **c8ctl**: deploy the spec's `deployments[]`, start the `instances[]` with their variables, so the feature is demonstrable. Confirms `expected_observations[]` are reachable.
- Runs AFTER the environment exists.

### 9.3 ci-babysit (Sibling 3)

- Local dagrunner-static-style command: monitors CI on an open PR, rebases/fixes/re-verifies. Needs the local verify cluster + private context (gh-aw's container could not reach these — confirmed local).
- Borrow crev's `--since` for incremental re-review.

### 9.4 pr-triage / review-triage (Sibling 4)

- Local command (gh-aw deliberately rejected — its async edge is cancelled by the human gate; safe-outputs governance is redundant with the never-auto-post rule; ceding the data-governance path was not worth it). Revisit gh-aw only if this becomes team-scale, multi-repo, no-single-human-gate infrastructure.
- Polls a PR for new review comments (bots + humans + crev), classifies each, drafts replies into artifacts, surfaces for per-comment human approve/post. NEVER auto-posts.

### Removed from scope (record)

- **/pr-review**: kept as a private standalone command for reviewing OTHERS' PRs; removed from dagrunner scope (redundant on own PRs given in-pipeline review + Copilot + human + crev). No dynamic-workflow rebuild.

---

## 10. Phase roadmap [MATCHES]

| Phase   | Scope                                                                                                                                                                                                                                                                                           | Status             | Gated by                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------- |
| **1**   | Engine + spine + thin slice + Gate 1; state/resume/worktrees/artifacts/hooks/launcher; `dagrun report` static HTML. (Built classify/expand-guide/implement — classify-as-a-node since RETIRED; its logic moved into review's diff-triage.)                                                      | ✅ DONE & hardened | —                                     |
| **2a**  | (1) Preflight + runtime permission/sandbox/network model [FIRST]; (2) review node (diff-triage self-select + fan-out + finding-count-gated verifier -> findings schema); (3) fix node (gated, self-verifying). Built, fixture-passed, post-fixture restructure (classify removal etc.) applied. | ✅ DONE            | —                                     |
| **2b**  | verify-election + verify-guide (doc-only; cluster automation REMOVED, see §7c) + Gate 3; pr node; reflect -> reflect-gate -> apply-reflection (4 guardrails); rerun + revert-reflection commands; PR post-process outside sandbox.                                                              | ✅ DONE            | 2a complete                           |
| **3**   | Four interactive siblings, built in order: (1) /verify-demo env creator [DMS], (2) /verify-demo seed creator [c8ctl], (3) ci-babysit, (4) pr-triage. All local, all human-driven.                                                                                                               | later              | SDK-credit check; pin CLI/SDK version |
| **4**   | Live `dagrun ui` (Node-http + SSE + vanilla HTML, localhost-only, scrubbed)                                                                                                                                                                                                                     | someday            | —                                     |
| **5/6** | Multi-task-type support (bug/tech-debt/refactor); classify RETURNS as an upfront task-type router                                                                                                                                                                                               | future             | —                                     |

Key insight: Phase 2 is fully unblocked (pure SDK). With gh-aw and dynamic-workflows dropped from scope, Phase 3 (two local siblings) is also pure SDK — its only remaining open items are the SDK-credit check and the CLI/SDK version pin.

---

## 11. Open verification gates [MATCHES]

1. **Enterprise `disableWorkflows`**: `/workflows` confirmed AVAILABLE under ~/.claude-work. ✅ (Now moot for the pipeline anyway — no dynamic-workflow node is used.)
2. **SDK credit pool**: from 2026-06-15, Agent SDK / `claude -p` on subscription draws a separate monthly credit — confirm with the account owner it covers dagrunner's volume. DEFERRED (Phase 2 is pure SDK; not blocking). Applies to Phase 3 too, since both siblings are local SDK runs.
3. **Pin Claude Code CLI/SDK version**: a `-p` regression once returned empty result while billing tokens (produces check catches the empty-artifact half).
4. **gh-aw governance/maturity** — NO LONGER A dagrunner GATE (review-triage is now local). Retained only as a note for the deferred team-scale option: if gh-aw is ever adopted, it would need IT/governance sign-off (proprietary code in GitHub Actions under a repo-secret key) and a pinned non-preview version (billing bug in 0.68.4–0.71.3, retired).

---

## 12. Operating reminders (carry-forward) [DRIFTED]

<!-- DRIFT: Added reminders about: PR post-process, rerun/revert-reflection, new CLI commands, sandbox DEVHARNESS_SRC write-through. -->

- Every real-work `dagrun` command runs with `CLAUDE_CONFIG_DIR=~/.claude-work` (alias `dagrun-work`). Spawned sessions inherit config from the dagrun process, not other terminals.
- No API key — subscription auth; keep ANTHROPIC_API_KEY unset.
- Unattended runs: never auto-approve a gate; subagents must never end a turn with a question (autonomy directive in all agent .md + CLAUDE.md).
- Any FUTURE dynamic-in-pipeline node must be idempotent + cheap-to-re-run (workflow resume is session-scoped; no partial recovery).
- Schema is single-source-of-truth, owned by dagrunner, passed where needed — never duplicated.
- Reflect = two flavors (see §7b): flavor 1 (Camunda knowledge) APPLIED into DEVHARNESS_SRC private files (NOT the ephemeral worktree — it dies at cleanup), allowlist `*.local.md`/`.claude/` private only, `.git/info/exclude`, exact approved diffs, snapshot-before-apply, never the committed CLAUDE.md, never committed to Camunda. Flavor 2 (dagrunner proposals) LOGGED to store/ — never auto-applied. expand-guide/implement emit optional notes.md; fix emits REQUIRED notes.md (at minimum "No non-obvious discoveries.") for reflect to synthesize flavor 1 from.
- PR post-process: `git push` and `gh pr create --draft` run in Node.js OUTSIDE the sandbox after the pr node exits. `gh` (Go binary) cannot run inside the sandbox — TLS certificate mismatch with the Seatbelt proxy. Do not add `gh` to the sandbox allow list; keep post-process in Node.js.
- `dagrun rerun <run-id> <node>` re-seeds the worktree `.claude/` from current dagrunner source before running. Use it to test prompt/settings changes without restarting the full pipeline. Does NOT lock the run.
- `dagrun revert-reflection <run-id>` undoes apply-reflection by restoring snapshots from `reflect/backup/manifest.json`.
- Sandbox `additionalDirectories` includes DEVHARNESS_SRC and DAGRUNNER_HOME (post-2b). This allows apply-reflection to write CLAUDE.local.md files into DEVHARNESS_SRC and proposals into store/. Scope logged in DECISIONS.md.
- Validation: Phase 2a mechanics -> fake polyglot fixture (planted flaws, both TS+Java formatters). End of Phase 2 -> de-scoped M2-6 subset (record-only, no CF rotation) on real camunda/camunda via a mimicked companion plan. Real #53839 stays for the weekend.

---

## Appendix: Open questions / unresolved contradictions

1. **`dagrun status` cap display**: The doc (§8) says "`dagrun status` shows total vs cap" — the code only shows the total. No budget-vs-cap comparison is rendered. Intentional omission or missing TODO?

2. **Content-addressed cache** (`~/.cache/dagrunner/`): Mentioned in §4 home layout. Only the preflight context file is written there today. The content-addressed node-skip cache (Phase 1 design, analogous to crev) is not implemented. Is this in scope for Phase 3 or later?

3. **preflight checks not implemented**: Four preflight items from the original spec are not in code: (a) seeded settings.json present; (b) network allowedDomains covers the task; (c) ANTHROPIC_API_KEY unset; (d) enterprise policy check. These were in the Phase 2a spec. Intentional deferral or forgotten?

4. **stop-schema.sh classify fields vs. DORMANT classify**: stop-schema.sh validates `needs_runtime` and `risk` in classify.json — fields that were in the old pre-2a schema but ARE NOT in `CLASSIFY_SCHEMA` / `ClassifyOutput` in feature-workflow.ts. These schemas diverged when the field list changed. If classify returns in Phase 5/6, which schema wins?

5. **review node model**: The featureWorkflow node for `review` has no `model` set (unpinned). Is the haiku diff-triage step entirely internal to the /review command prompt (using subagents), or does the runner need to pin something?

---

## Appendix: Implemented-but-undocumented decisions

1. **`runPrPostProcess` architecture**: `git push` and `gh pr create --draft` moved to Node.js post-processing (outside sandbox) because Go binaries don't trust the macOS Seatbelt proxy TLS certificate. This is a permanent architectural decision (not a workaround), now documented in §4 and §5.

2. **`additionalDirectories` scope expansion**: DEVHARNESS_SRC and dagrunnerHome added to the sandbox whitelist. Scope is intentional (all nodes get write access to DEVHARNESS_SRC). Prompt-discipline is the guard. Logged in DECISIONS.md.

3. **PostToolUse formatter extension guard**: `post-tool-use-format.sh` now has a file-extension guard — `npx prettier --write` only runs on TS/JS/CSS/HTML files. YAML, XML, Java, JSON, Markdown are excluded. Driven by YAML quote coercion on `process-instances.yaml`.

4. **fix node `notes.md` required**: Changed from optional to required after the first real-pipeline run silently omitted it. Minimum content: "No non-obvious discoveries." This ensures hook-introduced side-effects (e.g. prettier reformatting YAML) are always captured.

5. **SIGINT diagnostic handler**: On Ctrl+C, the CLI writes `<run-dir>/diagnostic-<ts>.md` (state.json snapshot + artifact file inventory + log tails). Lock is released. No partial state corruption.

6. **`dagrun rerun` does not lock**: rerunNode is explicitly not locking — it's a debug/recovery tool. The user is responsible for ensuring no concurrent dagrun is active on the same run.

7. **`dagrun revert-reflection` uses manifest.json**: apply-reflection writes `runs/<run-id>/reflect/backup/manifest.json` containing `{files:[{original,backup}]}`. `revert-reflection` reads this manifest to know which files to restore — it does not scan the backup directory heuristically.

8. **run-id format is `<slug>-<timestamp>` not `<issue>-<slug>`**: The slug comes from the plan filename, not from a GitHub issue number. There is no issue-number injection into the run-id.
