# HANDOFF.md — dagrunner v1 Build Plan

> You are the **coordinating agent** for an unattended overnight build of **dagrunner v1**.
> Read this file first, in full. It is the task plan and sequencing — the _design decisions_
> live in the `architecture-spec` skill (theme-chunked). Load spec slices on demand per task block.
> You **delegate and verify**; you do **not** write implementation code yourself.

---

## 0. Definition of Done (the target — read before anything else)

v1 ships when ALL of the following are green:

1. **The 6-step smoke test passes**, captured as a runnable script + transcript (see `testing-protocol` skill):
   1. `dagrun init` on a clean tree → XDG home layout created.
   2. `dagrun start feature --plan toy-plan.md` → `classify` (haiku, valid JSON) → `expand-guide` (unpinned) → checkpoints at the **review gate** → exits.
   3. `dagrun status` shows `expand-guide: awaiting-gate`, costs, worktree path.
   4. `dagrun resume --reject "add error handling section"` → node revises **in the same session** → re-pauses.
   5. `dagrun resume --approve` → `implement` runs, writes a diff in the worktree, format hook fired, run reaches `done`.
   6. Kill the process mid-`implement`, `dagrun resume` → reconciles (running→failed) → re-runs cleanly.
2. **Tier-1 unit tests pass** (DAG core, schema validation, state I/O, reconcile) via the mock executor — no SDK calls.
3. **`dagrun report <run-id>`** renders a self-contained static HTML snapshot from `state.json`.
4. The build is done only when npm run verify-baseline exits 0

If you cannot reach all three, the run is still a success if you **maximize completed blocks**,
isolate blockers, commit progress, and leave a clear `BUILD-REPORT.md` (see §4).

---

## 1. What dagrunner is (one paragraph)

A thin TypeScript binary that orchestrates a **DAG of Claude Code agent runs** to take a Camunda
feature from a directional plan → guide → implementation → multi-reviewer synthesis+fix → verify →
PR → self-reflection. It **owns only what has no native Claude Code primitive that survives across
separate processes/worktrees** (the DAG executor, conditional skip, checkpoint-and-exit gates that
survive process exit, worktree lifecycle, per-run artifacts). **Everything inside a single agent run
reuses Claude Code** (node execution via Agent SDK, subagent fan-out, in-session convergence loops,
hooks, structured output, session resume, slash-command prompts). The guiding law: **do not reinvent
wheels — lean on Claude Code; build only the cross-process gaps.**

---

## 2. Non-negotiable laws (these override any instinct)

1. **No new dependencies / no new tools.** TypeScript + `@anthropic-ai/claude-agent-sdk` + Node
   built-ins + git/gh (native Bash). The static report is vanilla string-templating. Nothing else.
2. **Reuse Claude Code primitives** wherever one exists (see `architecture-spec` Theme 3 reuse map).
3. **Fail loud, never silent.** No cwd fallback, no silent defaults for `DEVHARNESS_SRC`. A broken
   verifier must never look like success.
4. **Artifacts are the only cross-node channel.** No hidden in-memory state between nodes.
5. **Show evidence, don't assert success.** Every block ends with a runnable check, not prose.
6. **Gates are always human decisions.** Never auto-approve a gate, even unattended.
7. **Typed at load.** Validate model strings, `dependsOn` refs, and node IDs at load — errors before
   any node runs.

---

## 3. Build order (task blocks → subagents)

Each block: load the named spec slice → dispatch to the named subagent with a tight brief →
receive summary + artifacts → run the block's acceptance gate → `git commit` → next.

| Phase | Block                                                                                          | Owner subagent                      | Depends on | Spec slice            |
| ----- | ---------------------------------------------------------------------------------------------- | ----------------------------------- | ---------- | --------------------- |
| 0     | Harness already in place (this scaffold). Verify settings.json loads, Context7 + LSP on.       | coordinator                         | —          | Theme 0 (harness)     |
| 1     | Read `camunda/crev` (`docs/plan.md`, `AGENTS.md`) + Agent SDK docs; report borrowable patterns | `crev-researcher`, `sdk-researcher` | 0          | crev-patterns skill   |
| 2     | Typed workflow schema + load-time validation                                                   | `types-author`                      | 1          | Themes 3, 9           |
| 3     | Mock executor + tier-1 unit tests (test-FIRST)                                                 | `test-author`                       | 2          | Theme 14              |
| 4     | DAG core (topo, readiness, join, when-skip, retry)                                             | `engine-author`                     | 2, 3       | Themes 3, 6, 10       |
| 5     | Launcher + env-propagation + XDG bootstrap (`init`)                                            | `engine-author`                     | 4          | Themes 7, 13          |
| 6     | Hooks (SessionStart sync, Stop verifier/schema, PostToolUse format, SessionEnd capture)        | `hooks-author`                      | 5          | Theme 8               |
| 7     | Thin-slice nodes (`classify`→`expand-guide`→`implement`) + gate/resume + state                 | `engine-author`                     | 6          | Themes 4, 5, 11       |
| 8     | `dagrun report` static HTML snapshot                                                           | `engine-author`                     | 7          | Theme 10, UI decision |
| 9     | 6-step smoke test, captured green                                                              | `test-author`                       | 7, 8       | Theme 14              |

**Ordering note — test-before-engine is deliberate:** Phase 3 (mock executor + tests) precedes
Phase 4 (engine) so the engine is built against a runnable spec and is provable the moment it exists.

---

## 4. Overnight autonomy protocol (how to run while the human sleeps)

- **Permission posture:** running under `permissionMode: "bypassPermissions"` with
  `settingSources: ["project"]`. The fail-closed `PreToolUse` deny hook (`.claude/hooks/deny-guard.sh`)
  is your safety layer and fires even under bypass. Do not weaken it.
- **Never block on ambiguity.** On any ambiguous decision, pick the **spec-aligned default**, append
  a one-line entry to `DECISIONS.md` (`<block> · <decision> · <why>`), and proceed. Never wait for input.
- **Per-block git checkpoint.** After a block passes its acceptance gate, `git commit -m "block N: <name>"`.
  This is the seatbelt — morning-human can `git log`/`git reset` to any block.
- **Isolate-and-continue on failure.** If a subagent fails its acceptance gate: retry **once**. If still
  failing, mark the block **blocked** in `BUILD-REPORT.md`, commit whatever is safe, and move to the next
  **independent** block. One broken block must not waste the night. (Dependent blocks of a blocked block
  are skipped and noted.)
- **Budget ceiling.** Honor the run-level `--max-budget-usd`. On hit: checkpoint-and-exit with state
  intact and the resume command in the report. Never burn unbounded.
- **Fresh-model verification** on the two load-bearing blocks (DAG core, launcher): after the author
  subagent finishes, dispatch a _different_ subagent instance to try to **refute** correctness (flag
  correctness gaps only, not style). Over-engineering is a defect — keep it minimal.
- **Morning report.** Final step: write `BUILD-REPORT.md` — blocks done/blocked, assumptions from
  `DECISIONS.md`, smoke-test result, total cost, and the exact resume command for anything incomplete.
  Run npm run verify-baseline last and record its exit status + failing gate (if any) in BUILD-REPORT.md

---

## 5. Coordinator loop (your minimal operating cycle)

```
for block in plan:
    load spec slice for block          # only the relevant theme(s)
    brief = tight task brief + slice + acceptance gate
    result = dispatch(block.owner_subagent, brief)   # worker runs in its own context
    if acceptance_gate(result) passes:
        if block in {DAG-core, launcher}: fresh_model_verify(result)
        git commit
        mark done
    else:
        retry once
        if still failing: mark blocked; commit safe; continue to next independent block
write BUILD-REPORT.md
```

You hold **plan + state** only. Workers hold the heavy context. You never author implementation code.

---

## 6. Where everything lives (XDG, crev-derived)

- Engine code + workflow defs: **this project folder** (standalone, outside the Camunda monorepo).
- Binary: `~/.local/bin/dagrun` (npm `bin` symlink).
- Run state / artifacts / worktrees / inbox / store: `~/.local/share/dagrunner/` (override `DAGRUNNER_HOME`).
- Cache (content-addressed): `~/.cache/dagrunner/`.
- Machine config: `~/.local/share/dagrunner/config.json` (`DEVHARNESS_SRC` mandatory-explicit; no secrets).
- Secrets: env / OS keychain only — never a file in the run tree, never logged.

Resolution order is documented and **fails loud** with the exact paths checked. No silent cwd fallback.

---

## 7. Scope fence — what is v1 vs phase 2

**v1 (build now):** complete engine; thin-slice feature content (`classify → expand-guide [review gate]
→ implement`); checkpoint-and-exit gates; resume-same-session; worktree lifecycle; hooks; state +
reconcile; `dagrun report` static HTML; the 6-step smoke test.

**Phase 2 (spec only, do NOT build):** the remaining feature nodes (reviewers fan-out, synthesize-and-fix,
verify-seed, pr, reflect, apply-reflection are _config additions_ on the proven engine — but only the
thin slice is required for v1 done); `ci-babysit` + `review-triage` scheduled workflows; `--since`
incremental; cross-run `store/` learning; live `dagrun ui` (Node-http + SSE + vanilla HTML).

If unsure whether something is v1, check the Definition of Done (§0). If it is not required there, it is phase 2.
