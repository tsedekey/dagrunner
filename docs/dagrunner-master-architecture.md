# dagrunner — Master Architecture (Source of Truth)

Status: Canonical, reconciled with the built code through Phase 5 (bugfix workflow shipped; siblings run on any branch). Each sibling build also gets its own implementation plan.
Last updated: 2026-11-08 (v0.1.84: `dagrun rerun` returns the nodes that were skipped only because the rerun node had not finished back to `pending`, so rerun + resume no longer ends `done` with review/fix/pr skipped after a RED failure — §3e, §3g "Which command when", §4, DECISIONS.md § rerun-reenables-blocked-dependents; before that v0.1.83: a run whose adopted worktree was removed fails loud on resume/rerun/gate attach --reseed — §4, DECISIONS.md § missing-worktree-fails-loud; before that the plan is the guide: the define and reproduce nodes and their gates are removed, `implement` proves RED first and the first gate of a run is `fix` — §3, §3c, §3e, DECISIONS.md § plan-is-the-guide; runs ADOPT an existing worktree instead of creating one — §4 "Worktree adoption", DECISIONS.md § worktree-adoption). Previously 2026-11-03 (verify node removed from both workflows — §3d, DECISIONS.md § verify-node-removed). Previously 2026-07-03 (docs consolidation: retired the v1-build scaffold, docs/archive/, the chat-architect handoff apparatus, and the file-based plan/status-tracking workflow — docs/changes/, docs/STATUS.md, docs/dagrunner-architect-charter.md, and the build-queue/bundle scripts are gone; self-changes are now agreed in conversation and history lives in git log. See CLAUDE.md § "How self-changes happen".)
Owner: Eddie Tsedeke

---

## 1. What dagrunner is

A thin, static TypeScript orchestrator that walks a change through a fixed, gated pipeline — implement -> review -> fix -> pr, starting from an approved plan that was authored upstream — pausing at defined human gates (the fix gate and the pre-PR gate) and checkpointing to disk so it survives process exit. Each node is a Claude Code session spawned via the Agent SDK in the git worktree the run was started in — dagrunner ADOPTS an existing linked worktree of DEVHARNESS_SRC (created by `wm add` / `git worktree add`) and never creates or, for adopted runs, removes one (§4). dagrunner owns only what Claude Code cannot do across separate sessions: the dependency graph, checkpoint-and-resume, worktree isolation (via adoption), artifact hand-off, gates, and cost discipline.

Core principle: **code coordinates, model judges.** TS orchestration is free; node sessions cost. Reuse Claude Code primitives; build only cross-process/worktree gaps.

North star: **strip everything predictive out of the front of the pipeline; decide each thing where the information actually exists.** A decision from the plan before code exists is worse than the same decision from the diff/findings later.

---

## 2. System components

| #   | Component                                | Runs where                                           | Role                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Glean Agent (Feature Task Companion)** | Glean                                                | Ingests a GitHub task and (together with the Copilot planning session that follows it) produces the approved plan — INTENT and the code-level HOW. The approved plan file is dagrunner's inbox input and the contract of the run; no node re-derives it. No GitHub issue needed. |
| 2   | **dagrunner (static feature pipeline)**  | local machine                                        | The gated feature pipeline. The heart of the system.                                                                                                                                                                                                 |
| 3   | **Phase-3 siblings**                     | Camunda monorepo private `.claude/`, run in worktree | Interactive human-driven commands acting on Camunda: `/seed-data` (c8ctl seeding of a human-started OC), `ci-babysit`; `pr-triage` left in v0.1.87 (§10.3). See §9.                                                                                                          |

Phase 3 is LOCAL siblings (/seed-data + ci-babysit; pr-triage was the third until v0.1.87, §10.3) — one substrate, enterprise subscription locally. `/pr-review` is NOT a dagrunner sibling: it stays a private standalone command for reviewing OTHERS' PRs (see §9). gh-aw and dynamic-workflows-in-pipeline are not used (see §9 rationale).

**Plan authoring guidance (since v0.1.82 — the plan is the guide):** the plan is the contract `implement` works from; there is no define/reproduce node that elaborates or challenges it. So it must be implementable as written: the requirement, intent and acceptance criteria — including the source issue's prescribed solution path when one exists — plus, for a bug, the reported symptom, the root-cause hypothesis and the reproducing test or validation command, because `implement` must prove RED from them (§3e). When the plan turns out to be wrong, the run stops (an unprovable RED fails the run; a flagged `## Concerns / plan challenges` pauses `--night`) and the human goes back to the planning session for a revised plan — a new revision and a new run.

---

## 3. The feature pipeline (fully static)

> **Since v0.1.82 the plan is the guide** (DECISIONS.md § plan-is-the-guide): the plan stage happens
> upstream in a Copilot planning session whose approved plan file is the run's input, so the
> `define` (feature) and `reproduce` (bugfix) nodes — two opus nodes that turned that plan into a
> guide — and their human gates are gone. The first human gate of a run is the **fix gate**
> (after implement and review), then the **pre-PR gate** on `pr`; both return to the originating
> companion (`companionGates: true`, §3g). `implement` took over the one useful thing those nodes
> did: it proves RED first (§3e). History: v0.1.64 gave feature its pre-PR gate and
> `companionGates: true` (§3g, § feature-companion-gates-parity); `expand` was later renamed
> `define`; v0.1.79 removed `verify` (§3d). The night-mode description below is otherwise historical.

```
[approved plan in inbox — authored upstream, e.g. in a Copilot planning session]
   [PREFLIGHT] (not a node; runs before the graph)
        |
  implement (sonnet, medium)  — reads <runDir>/plan/plan.md (the plan IS the guide).
                        PROVES RED FIRST: runs the plan's reproducing test (bugfix) or writes the failing
                        test the acceptance criteria imply (feature), watches it fail for the right reason,
                        implements, reruns GREEN; writes red-evidence.md + red.json.
                        outcomeGate on red.json: anything but red="confirmed" FAILS THE RUN here (no gate,
                        no "continue and flag") and review never starts. If RED is proven but the plan's
                        assumptions differ, implement continues and adds "## Concerns / plan challenges"
                        to its summary.md.
  review (static node):
     - diff-triage first step (haiku): read diff -> touches_* flags
     - fan-out selected reviewer subagents (read-only, isolated context)
     - synthesize
     - adversarial verifier ONLY if findings count > N (default 3)
        |  -> review/findings.json
  fix (consumes findings, mutates worktree, self-verifies)  ★ FIRST GATE (the "fix gate"): accept/reject fixes
  pr (haiku)   ★ PRE-PR GATE (the "pr gate") -> composes the PR body; the push / draft-PR happen outside the
                              agent's session after the gate is approved (see §3g, §6)
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
  findings: [{ reviewer_dimension, severity, confidence, file, line, claim, grounded }] }
```

Reviewer selection (from diff-triage): correctness + test-adequacy always; api-stability when touches_public_api; distributed-systems when touches_runtime; migration-safety when touches_schema_or_proto; performance when triage judges it.

**Gates:** all checkpoint-and-exit, single-awaiting-gate invariant. Human review via a fresh interactive `claude` session (SDK session IDs are not resumable from the CLI — two stores don't share state); `/gate-review` + `/gate-conclude` write a `gate-decision.md` handshake file. Author-agent revision still resumes the same SDK session (via `options.resume` + `feedback-N.md`) so it revises with memory. Gates live ONLY on static nodes.

**Night-mode (`dagrun start feature --night`):** unattended overnight execution. One rule — agent-decidable gates (the fix gate and the pre-PR `pr` gate) are auto-approved when no "Concerns / plan challenges" heading is present. The scan (`nightConcernsFlagged`, exported and unit-tested) covers the gate node's own primary artifact AND the primary artifact of every DONE ancestor: `implement` raises the heading in ITS `summary.md` (RED proven, plan assumptions differ), while the first gate is `fix`, whose own `summary.md` would not repeat it — scanning only the gate's artifact would auto-approve past a flagged plan challenge. A flagged concern, an unreadable/missing artifact, or a leftover gate id the workflow no longer defines also pauses (fail toward the human). Every auto-decision is logged to `gateHistory` with `mode: "night"` and `basis: "no concerns flagged"` for morning audit. `agentDecidable(nodeId)` (`fix`, `pr`) is the exported predicate; `hasConcerns(content)` is the exported heading check (both pure, unit-tested). A clean night-mode run proceeds `implement` → `review` → `fix` → `pr` fully unattended; there is no election or hand-off step anywhere in the pipeline (§3d).

---

## 3c. The bugfix pipeline

> **Since v0.1.50** the diagram below has a pre-PR gate (on `pr`) and every gate returns to
> the originating companion — see §3g. **Since v0.1.79 there is no `verify` node** (§3d). **Since
> v0.1.82 there is no `reproduce` node and no gate before `implement`** (§3): the plan is the guide,
> and the bugfix `implement` takes over reproduce's RED proof.

```
[Bug fix plan in inbox — YAML frontmatter: base_branch, severity, issue URL]
   [PREFLIGHT] (same as feature)
        |
  implement (sonnet, medium) — reuses /implement (reads <runDir>/plan/plan.md)
                            → runs the plan's reproducing test/validation command and confirms it FAILS
                              for the reported symptom (no named test: writes the smallest one that
                              demonstrates it); implements; reruns GREEN; red-evidence.md + red.json.
                              Cannot reproduce (already fixed / test missing or flaky / env unavailable /
                              root cause plainly differs) -> red.json "not-reproduced" -> the run FAILS here.
                              RED proven but root cause / change surface differ from the plan ->
                              continues, with "## Concerns / plan challenges" in summary.md.
  review    (same as feature — reuses /review + FINDINGS_SCHEMA)
  fix       (sonnet, medium) ★ FIRST GATE: accept/reject fixes
  pr        (haiku)     ★ PRE-PR GATE — reuses /pr command
                            [TERMINAL — run ends here]
```

**base_branch from frontmatter:** Bug fixes often target release branches (hotfixes). The plan file may carry a YAML frontmatter block (`---` delimiters) with `base_branch: release/1.x`. Run-engine parses this with `parseFrontmatter()` (pure, exported, unit-tested) before adopting the worktree. dagrunner no longer branches from it (the worktree already exists on its own branch); `base_branch` is what the adopted branch must DIFFER from and what must resolve in DEVHARNESS_SRC (adoption checks (b) and (d), §4), and what the change diff and PR are taken against. `runPrPostProcess` uses `state.baseBranch ?? "main"` for `gh pr create --base`. When absent, defaults to `"main"`.

**Severity-aware night-mode:** The same `--night` flag works for bugfix runs. Additional rule: if `state.severity` is `"critical"` or `"blocker"`, night-mode always pauses at the gate regardless of whether concerns are flagged. `severityForcesPause(severity)` is the exported predicate (pure, unit-tested). Rationale: high-stakes bugs warrant human eyes even when the agent sees no concerns.

**Frontmatter fields stored in state:** `baseBranch`, `severity`, `issueUrl` are optional fields on `RunState`. They survive resume. Only `baseBranch` is stored when non-"main" (avoids cluttering state for feature runs). None are exported as env vars — they are consumed by engine TS code from state, not by node prompts.

**Command reuse:** `/implement`, `/review` and `/pr` are shared by both workflows and read the same inputs — `<runDir>/plan/plan.md` (the plan, copied in at start) plus `implement/red-evidence.md` — so there is no per-workflow guide path to resolve any more. `implement.md` tells the two cases apart from the plan itself (a plan that reports a defect is the bugfix case, one that describes new behaviour is the feature case): the run-environment block carries no workflow name, and both cases end in the same `red.json`. No workflow-specific command forks — single copies. The two workflows now differ only in name (branch/PR-title prefix) and the findings schema; merging them into one is a possible later cleanup, not done here.

---

## 3d. Content-level node checks (`outcomeGate`, `noPlaceholders`) — and the REMOVED verify node

**verify was removed (v0.1.79 — DECISIONS.md § verify-node-removed).** The pipeline was then
define|reproduce -> implement -> review -> fix -> pr (since v0.1.82: implement -> review -> fix -> pr, §3). verify went through three shapes — an
autonomous `@MultiDbTest` author/runner/judge, an optional provision-and-hand-off of a
local runtime for manual testing chosen at the fix gate (v0.1.50/v0.1.57), and finally nothing.
Eddie's use of the optional hand-off showed it was skipped at the fix-gate decision on nearly every
run, so it did not earn being a node: it carried a docker-provisioning contract
(`verify-report.json` schema 3 + `evidenceCheck`), a deterministic teardown engine, a fix-gate
decision mechanism (`decidesNode` / `next-node-decision.json` / `--run-next`), a `joinRule` on `pr`
that existed only so a skipped verify did not block it, two checker subagents and a very large
prompt — all to serve a step that was almost always declined. It was deleted outright: no
replacement node, no feature flag, no deprecation shim. The history of the reasoning (self-heal,
stall detection, deferred-to-CI, provision-and-hand-off) lives in DECISIONS.md, not here; none of
its outcome names or evidence types exist any more.

What a human wants from "see it work" is still available without a pipeline node: the
`/manual-smoke` sibling (§10.4) generates a manual-test walkthrough on demand from any run's
artifacts, and the RED→GREEN test that `implement` writes (and `fix` keeps green) is
the pipeline's own behavioral proof. CI reruns the full build/test/acceptance matrix on the PR.

**What the removal took with it, and what it deliberately left.**

- Removed (verify was their only user): `Node.evidenceCheck` and its load-time validation,
  `GateConfig.decidesNode` (+ its load validation, `GateRequest.runNext`, the `--run-next` flag on
  `gate decide` and legacy `resume --approve`, the `run-next:` line of the legacy decision file,
  `fix/next-node-decision.json`, `DAGRUN_GATE_DECIDES_NODE`, the run-snapshot "decision" skip reason
  and the `## Verify recommendation` advice reader), `Node.joinRule` and `JoinRule` (only the two
  `pr` nodes used it), the gate brief's `verifyEnvironment`, the verify teardown engine and
  `dagrun verify cleanup`, the pending-environment warnings in `status`/`list`, and the
  `verify-runtime` report fixture in the mock executor. `gitDirtyPaths` (only the evidence hook used it) is gone;
  `gitHead` (the gate revision's worktree-HEAD component) moved into `core/gate.ts` unchanged.
- Left on purpose (generic engine, not verify-specific): `Node.when` and `Node.optional` — the
  conditional-skip / optional-degradation primitives CLAUDE.md names as core — and `outcomeGate`
  below. `when`/`optional` have no shipped user; they stay unit-tested in `dag.test.ts`. `outcomeGate`
  has one again since v0.1.82 (`implement`'s `red.json`, §3e) and stays covered end-to-end by
  `smoke:mock` Runs F/F2.
- Left on purpose (not verify's): the `Bash(docker *)` allowance in the seeded settings
  (`fix.md` runs `docker info` before the first `*IT.java` execution), the manual-smoke sibling,
  its `verify-guide/` output directory and `seeding-spec.json`, and the seed-data sibling that
  reads that spec.
- **Old runs.** A run created before the removal still has a `verify` entry in `state.json`.
  Read-only commands (`status`, `list`, `report`, `ui`, `gate show`) are state-driven and
  tolerate it (the UI appends it as a legacy node with no definition; pinned by
  `old-run-tolerance.test.ts`). **Resuming an in-flight old run is not supported**: the engine
  does not fail on the unknown node — it ignores it and runs `pr` straight after `fix` — so a
  provisioned verify environment from such a run is simply left behind. There is no migration
  code. Any already-provisioned verify docker resources can no longer be torn down by dagrunner
  and must be removed by hand.
- **Old runs, again (v0.1.82 — define/reproduce).** A run created before the plan-is-the-guide change
  still has a `define` (feature) or `reproduce` (bugfix) node — gated, usually `done` — and a
  `<node>/guide.md`. Same contract: read-only commands tolerate it (pinned by
  `old-run-tolerance.test.ts`, which also covers a run paused AT the old first gate and a failed
  leftover node); resuming is **unsupported** and was measured, not changed: a leftover node that is
  `pending`/`running`/`skipped`/`done` is ignored (`pending` and a reset-from-`running` end `skipped`),
  a leftover `failed` node still ends the run `failed` (`anyFailed`) even if every current node
  finished, and a run paused AT the old gate has that gate auto-skipped as a "stale gate" so `implement`
  runs for the first time without the guide's approval. See DECISIONS.md § plan-is-the-guide.

**The engine mechanism — `outcomeGate`:** node status in dagrunner was originally derived only
from SDK success/failure + `produces` file-existence — nothing read the CONTENT of a produced
artifact. The optional `Node` field `outcomeGate: { file, field, passValues }` (`src/core/types.ts`)
closes this gap. Checked in `src/core/dag.ts`'s `checkOutcomeGate` (a small pure function, shared —
not duplicated — with `src/runtime/run-engine.ts`'s `rerunNode`) immediately after the existing
produces-file-existence check passes: it reads `field` out of the named JSON artifact and, if the
value isn't in `passValues`, marks the node `"failed"` with a clear message instead of `"done"` —
identical halt semantics to a produces violation (node fails, run halts, dependents never run). Any
failure to locate/parse the file also fails loud, never a silent pass. verify was its first user and
took the shipped use with it; since v0.1.82 `implement` uses it again (`file: red.json`, `field: red`,
`passValues: ["confirmed"]`, §3e). **Order matters:** the produces-existence check runs FIRST, so a
node that skipped any declared file fails with the generic `produces contract violated` error and the
outcome gate never reads its content — which is why `implement` lists `red.json` in `produces` AND its
prompt demands `summary.md`, `red-evidence.md` and `red.json` even when RED is not proven (pinned by
`dag.test.ts`). A failed node's reason is visible in `dagrun status --json` (`nodes.<id>.error`), in
`dagrun gate show` on a failed run, in the report and in the UI snapshot.

**Sibling mechanism — `noPlaceholders` (added by the structural-upgrades change, 2026-07-09 — see
`DECISIONS.md § structural-upgrades-2026-07-09`):** a second content-level check, `noPlaceholders:
string[]` (`src/core/types.ts`), lists produced filenames to mechanically scan for unresolved
`TBD`/`TODO`/`FIXME`/`XXX` markers (whole-word, case-sensitive) after fenced code blocks are blanked
(a guide may legitimately quote an existing `// TODO` from the codebase it describes — that is not
an authored placeholder). Checked by `src/core/dag.ts`'s `checkNoPlaceholders`, immediately after
`checkOutcomeGate`, same failure shape (`"failed"` with a clear message, never a silent pass). Was wired
as `noPlaceholders: ["guide.md"]` on `define` (feature) and `reproduce` (bugfix) — Eddie chose the
mechanical check over a prompt self-check specifically because it is verifiable, unlike the
RED-evidence declaration below. **Since v0.1.82 no shipped node declares it** (the guides it scanned
are gone; `plan.md` is not scanned): the primitive and its four wiring sites stay as generic engine,
flagged for a possible later cleanup, and stay covered by `dag.test.ts` and `smoke:mock` Runs G/H
through a tiny custom gated workflow.

**Why this check needed FOUR wiring sites, not one:** the nodes it targeted (`define`/`reproduce`) were gated, and
`sdk-runner.ts` guarantees a gated node's executor call ALWAYS returns `awaiting-gate`, never
`done` — so `runDag`'s own done-branch (where `checkOutcomeGate` already lived, and where the
originating brief for this change said to add the sibling check) is never actually reached by a
gated node. The only two places a gated node's status ever flips to `done`
are `run-engine.ts`'s two gate-approve transitions: `resumeRun`'s manual `--approve` branch and
`startRun`'s night-mode auto-approve loop. `checkNoPlaceholders` is wired into all four done-
transition sites (`runDag`, `rerunNode` — mirroring `checkOutcomeGate`'s existing dual-wiring — plus
both gate-approve branches). On a gate-approve failure, the human/night-mode "approve" decision is
still recorded in `gateHistory` (it genuinely happened) but the node's `status` is written `"failed"`
with the check's error instead of `"done"` — the mechanical check overrides the approval outcome,
not the audit trail of what was decided. Proven end-to-end (not just via the pure-function unit
tests) by `smoke:mock` Run G: a `gate-pause-with-placeholder` mock-executor scenario writes an
unresolved `TODO` into a custom gated node's `summary.md`, then the real `startRun`/`resumeRun` approve path is
exercised (`resumeRun` takes a test-only `workflow` seam for the custom workflow) and asserted to end the node `"failed"` (not `"done"`), block its dependent, and fail the
run — the wiring gap the advisor's review caught before this shipped, and the thing a `runDag`-only
wiring would have made invisible (the mock content contains no placeholder token, so
"check passed" and "check never ran" would have looked identical on the happy path alone).

**One-shot session vs. auto-backgrounded long commands (run `54177-1`):** a Bash command running
10+ minutes (a Maven build) is auto-converted by the SDK into a background task. In `54177-1` the
(since-removed) verify node read the "you will be notified" message as "come back later", called
`ScheduleWakeup` and ended its turn — but nothing ever resumes a node's session (see §6's
`disallowedTools` note), so the run idled until the harness killed the task. `ScheduleWakeup` is
mechanically disallowed for EVERY node (§6); a node that backgrounds a long command must poll it to
completion synchronously via `TaskOutput`/`Monitor` within the same turn. This rule is not
verify-specific and was not superseded by the node's removal.

---

## 3e. Verified-RED TDD, the 3-failed-fix-rounds escalation, and red-flag tables

Three prompt-level hardening changes landed together (2026-07-09, alongside the `noPlaceholders`
engine change in §3d — see `DECISIONS.md § structural-upgrades-2026-07-09` for the full log; the RED
change below was broadened to both workflows in v0.1.82):

**Verified-RED first on `implement` (both workflows, since v0.1.82 — it began feature-only in the
2026-07-09 change):** `payload/commands/implement.md` is shared by both workflows. Before this change
the bugfix side proved red in `reproduce.md` Step 2 and the feature side in `implement.md`; with
`define`/`reproduce` gone (§3) `implement` owns the proof for both. It reads
`<runDir>/plan/plan.md` and, before writing any implementation code: **bugfix** — runs the
reproducing test/validation command the plan names and confirms it fails for the reported symptom
(no named test: writes the smallest one that demonstrates it); **feature** — identifies the
unit/integration test(s) the acceptance criteria imply (explicitly NOT an `@MultiDbTest` acceptance
test) and writes that test first. Either way it runs the test, confirms it fails **for the right
reason** (not a compile error, typo or wrong import; captures the output), only then implements,
reruns to confirm GREEN, and writes `<artifactsDir>/red-evidence.md` (test identity, captured RED
output, GREEN confirmation) and `<artifactsDir>/red.json`.

`red.json` is the machine-readable verdict: `{"red":"confirmed","test":"<file#case>","command":"<cmd>"}`
or `{"red":"not-reproduced","reason":"<what was tried and observed>"}`. Both workflows' `implement`
declare `produces: ["summary.md", "red-evidence.md", "red.json"]` and
`outcomeGate: { file: "red.json", field: "red", passValues: ["confirmed"] }` (§3d). **Unprovable RED
fails the run loudly** — Eddie's decision: bug already fixed, test missing/unrunnable, flaky,
environment unavailable, or the plan's reproduction does not demonstrate the symptom. `implement` then
writes no implementation code and stages nothing, but still writes all three files (so the
produces check, which runs first, does not mask the reason), the outcome gate fails the node, `review`
never starts, and the run ends `failed` with `outcome gate failed — red = "not-reproduced", expected
one of: confirmed`. No new gate, no escalation gate, no "continue and flag"; the driver reports the
reason and the human returns to the planning session for a revised plan (a new revision, a new run —
the plan is the contract). The failed run is also recoverable in place when the cause was not the plan
(e.g. the environment was unavailable): the outcome-gate failure does not short-circuit `runDag`, so
`review`/`fix`/`pr` are persisted `skipped` — with `skipReason: "blocked-dependency"` (§4) — and
`dagrun rerun <run> implement` followed by `dagrun resume <run>` returns them to `pending` and runs them
to the fix gate (§3g); it never ends `done` with them skipped (it did before v0.1.84, a false success).
When RED IS proven but the plan's assumptions differ (root cause is not the
one stated, change surface broader than expected), `implement` continues and adds a short
`## Concerns / plan challenges` section to its `summary.md` (ported from `reproduce.md` Step 4);
`--night` treats that heading as a flagged concern at the next gate (§3 night-mode).
`red-evidence.md`/`red.json` are plain `produces` entries: this reuses the existing
produces-contract and outcome-gate mechanisms rather than any new hook; `.claude/hooks/
session-end.sh` was explicitly considered and rejected for this because it is fail-soft/
observability-only and cannot enforce anything. They also reach the fix gate as evidence (the brief's
`upstreamArtifacts` and an `outcomeGate` validation row). **Known, accepted ceiling:** this proves
existence + a plausible RED→GREEN narrative, not a cryptographically-verified ordering — an agent
could still fabricate `red-evidence.md`'s content or `red.json`'s `confirmed`. That is intentional;
over-engineering around it was explicitly rejected.

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
`fix-history.log` + `feedback-*.md`, and an explicit recommendation to reject rather than request a 4th fix attempt — and, when the plan itself is what is wrong, to say so and stop so the driver can send the human back to the planning session for a revised plan, i.e. a new run). A `PASS`
resets the streak to 0 regardless of a later human rejection for unrelated reasons (style, scope) —
the streak measures build/test convergence, not human satisfaction. `gate-review.md` is untouched —
its existing "present the full artifact content, do not truncate" instruction already surfaces the
new section with no edit needed.

**Red-flag / rationalization tables** were added to `implement.md` and `fix.md` (and, until its removal, `verify.md`) — a
short (5-8 row) two-column table per node ("red flag phrase" → "what to do instead"), each tailored
to that node's actual failure modes (skipping the RED step or implementing without a proven RED, scope creep, and leaving work
half-done for `implement`; scope creep beyond the cited finding, dismissing a still-failing test as
"probably flaky" without rerunning, and talking oneself out of the round-3 escalation for `fix`).
These are deliberately cheap, skimmable red-flag recognition aids, not new procedural steps.

**Testing note:** these three changes are prompt-only (no unit-testable engine surface beyond
confirming `smoke:mock` still passes and the new `red-evidence.md` produces entry doesn't break
anything — both confirmed). `smoke:live` was deferred for all three, consistent with this file's
established precedent for prompt-only changes whose new branches (a genuinely-red test, a 3rd
consecutive fix failure, a red-flag table being consulted) aren't reachable by a toy mock fixture —
see `DECISIONS.md § structural-upgrades-smoke-live-deferred`.

---

## 3f. digest — REMOVED (v0.1.65); folded into the companion gate conversation

`digest` (a parallel, no-gate, optional, read-only node, `dependsOn: ["fix", "verify"]`,
`produces: ["knowledge-map.md"]`) is gone from both workflows — see `DECISIONS.md §
digest-removed-folded-into-companion`. It existed to give Eddie a post-implementation synthesis
before he reviewed the PR; by the time it was reshaped to its final two-section form (deferred
findings/unresolved risks, open reviewer questions), both workflows already had
`companionGates: true` (§3g) — the companion independently reads the exact same upstream artifacts
(`review/findings.json`, `fix/summary.md`, `verify-report.json`) at the fix/pr gates and talks them
through with Eddie live. `digest` wrote the same two sections to a file nothing downstream ever
read. Its content didn't disappear — it is now an explicit, named step inside the companion's
existing per-finding gate walkthrough (deployed skill references, outside this repo:
`~/.claude/skills/bug-fix-companion/references/dagrunner-gates.md` and
`~/.claude/skills/feature-work-companion/references/dagrunner-feature-gates.md`; this repo's
bugfix-only mirror is `docs/bug-fix-companion-gate-addition.md`). `payload/commands/digest.md` was
deleted; `digest`'s old placement rationale (sibling of `pr`, same `dependsOn`, zero added
wall-clock time) and model-tier rationale (`sonnet`, not `opus` — synthesis, not adversarial
judgment) are preserved only as history in `DECISIONS.md § digest-node` / `§
digest-node-optional-follow-up` / `§ digest-shrunk`, not reproduced here (same convention as §8's
removed `classify` node).

---

## 3g. Companion gates (v0.1.50, feature parity v0.1.64; the optional verify hand-off they once carried was removed in v0.1.79 — §3d)

**Companion gates (`Workflow.companionGates`, both workflows since v0.1.64 — DECISIONS.md §
feature-companion-gates-parity).** Eddie plans in one local companion
conversation. `dagrun start <workflow> … --companion-session <id>` records that conversation's
`CLAUDE_CODE_SESSION_ID` in `state.companion` (or `--no-companion` explicitly opts into the legacy
fresh-session gates; no silent default; `--night` is incompatible — a `--night` feature run now
also needs `--no-companion`, same as bugfix already did). At every gate (`fix` — the first gate of a run
since v0.1.82 — and the pre-PR gate on `pr`) the run pauses and dagrunner spawns **nothing**: it writes
`<gate>/gate.json` (run, gate, iteration, `revision`, plan sha, worktree HEAD, evidence hashes,
mechanical validation, pending decision) and `gate-context.md`, and prints how to return: `dagrun resume <run>` (no flags, in a
terminal) or `dagrun gate open <run>` resumes the recorded session from its original directory with an opening prompt that tells it a gate is
waiting (a bare `claude --resume` reopens the chat with no gate context). The companion drives the run with:

- `dagrun gate show <run>` — the brief.
- `dagrun gate decide <run> --gate <g> --revision <rev> --action approve|amend|hold …` — **two-step**:
  without `--confirm` it only PROPOSES (prints the exact action/scope and a decision id); only
  `--confirm <id>` executes. The id binds run, gate, revision, action, target and comment, so
  understanding / "continue explaining" / "looks good" can never advance a run, stale or wrong-run
  revisions are refused, and a repeated confirmed decision is a no-op (`gateHistory[].decisionId`).
- `dagrun gate attach <run> --session <id> [--reconstructed]` — recovery when the original session is
  gone (transcript missing) or for a legacy run; a reconstructed session is flagged, never the default.

Actions map onto existing machinery only: `approve` (existing approve), `amend` (revise the gate node
via feedback-N.md, or a workflow-declared `gate.amendTargets` ancestor — bugfix `pr` → `fix` — which
archives and resets every downstream node so no stale evidence is reused), `hold` (record, stay
paused). Legacy `resume --approve/--reject` is refused on companion runs. Independently, nothing here
authorizes merge, reviewer requests (the pr node only SUGGESTS reviewers — §3h), marking ready, or backport labels; the draft PR is pushed/created
only after the pre-PR gate is approved (`runPrPostProcess`). **That step fails loud**: if the pr node's
`body.md` / `pr-meta.json` are missing or `pr-meta.json` is not valid JSON, the pr node is marked `failed`
(state.json `error` names the expected paths, hints at a stray `<worktree>/.dagrun-pr-output/`, and says
`dagrun rerun <run> pr`; also written to `pr/pr-error.txt`), the run is `failed`, and every caller
(`startRun`, the night-mode loop, `resumeRun` — which also serves companion `gate decide --confirm` — and
`rerunNode`) exits 1. Why: pr is a gated node, so approval flips it to `done` without the `produces` check
that ungated nodes get; run `51496-1` approved a pr gate whose output had been written into the worktree,
printed "run done", and nothing was ever pushed. Skips that stay silent: `prUrl` already set (idempotent),
pr node not `done`, no pr node. Push / `gh pr create` failures keep the softer contract (message +
`pr-error.txt`, node stays `done`, manual command printed) — the deliverables are intact and the smokes pin
it. The mock executor writes a `pr-meta.json` for a `pr` node so mock runs model a real pr session.

**Gate-reading now also covers digest's old job (v0.1.65 — `DECISIONS.md §
digest-removed-folded-into-companion`).** The now-removed `digest` node (§3f) read
`review/findings.json` and `fix/summary.md` to write two sections — deferred findings/unresolved
risks, and open questions a PR reviewer would likely ask — to a file nothing downstream consumed.
The companion already reads those identical artifacts live, at the fix and pr gates, in its existing
per-finding walkthrough (one finding at a time, wait for understanding). The deployed skill
references (`~/.claude/skills/bug-fix-companion/references/dagrunner-gates.md` and
`~/.claude/skills/feature-work-companion/references/dagrunner-feature-gates.md`, both outside this
repo) now make this explicit rather than leaving it implicit: at the `fix` gate, the companion names
which findings `fix` explicitly deferred (dimension/severity/reason) alongside the findings it
addressed; at the `pr` gate it surfaces the open questions a reviewer would likely ask (design
tradeoffs, scope boundaries the plan drew). This repo's bugfix-only mirror of that doc is `docs/bug-fix-companion-gate-addition.md`.

**Lesson promotion — `dagrun reflect` gets its first real caller (v0.1.65, same change).** `dagrun
reflect --source <node> --body "<text>" [--run-id <id>]` (§8b) existed as dead code — no file under
`payload/` ever called it. The companion is not a node session, so it never receives the
dagrunner-seeded SessionEnd hook or `$DAGRUN_ARTIFACTS`/`$DAGRUN_NODE_ID` that hook depends on; a bare
CLI call needs none of that wiring, the same as `gate show`/`gate decide`/`status` it already runs.
When something surfacing in a gate conversation — a deferred finding, a recurring gotcha, a design
tradeoff — looks durably useful beyond this one run, the companion names it to Eddie and proposes
capturing it; only on his explicit go-ahead does it run `dagrun reflect --source companion --body
"<the lesson>" --run-id <run-id>`. This is deliberately NOT automatic and NOT every finding — most
gate findings stay local to the run, same as always; this is for the rare one worth keeping. No new
store, hook, or CLI flag was added — `reflect-append.ts`'s fail-soft append (§8b) and `appendReflection`
are unchanged; only the doc wiring that routes a real caller to the existing command changed.

**The fix gate decides nothing about a downstream node.** Until v0.1.79 the `fix` gate carried
`decidesNode: "verify"` (an explicit `--run-next yes|no`, persisted as
`fix/next-node-decision.json` and read by verify's `when`) and `pr` carried a `joinRule` so a
skipped verify did not block it. With the node gone (§3d) the whole mechanism is gone too:
approving `fix` is a plain approve that continues to `pr`, `gate decide` has no `--run-next`, and
the approve `--comment`, if given, is recorded on the gate's `gateHistory` entry (it used to ride
into the decision file as verify's "focus"). `pr` is a pre-PR gate on both workflows
(`dependsOn: ["fix"]`; `gate.amendTargets: ["fix"]`).

**Which command when — `resume` and `gate …` are one engine, not two systems (clarified v0.1.58; wording only, no behavior change).**
`resumeRun` (`runtime/run-engine.ts`) is the single execution engine. `dagrun resume --approve/--reject`
call it directly with a bare decision; `dagrun gate decide --confirm` first validates the decision
against the gate brief (revision, action, target, session, propose-then-confirm), then calls the _same_
`resumeRun` with a `gateRequest`. "Legacy" only ever meant the old flag-based calling convention (no
propose-then-confirm step, no statement shown to the human first) and, on a non-companion run, the
fresh spawned review session — not deprecated or parallel code. On a companion-gates run bare
`--approve/--reject` is refused (exit 1) so the confirmable path is the only way to decide.

"Awaiting a gate" means _some node has `status: "awaiting-gate"`_ (`awaitingGateId`, a per-node scan) —
not the run's top-level status. A crashed run whose top-level status is still `running` but whose gate
node is `awaiting-gate` therefore still counts as awaiting.

| Run state                                                                                                                                      | `gate show`                                   | `gate open` / `gate attach`                                                                                            | `gate decide`                                                                                                | `resume <run>` (no flags)                                                                                                                                                                                                        | `resume --approve/--reject`                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Awaiting a gate, companion run** (`state.companion` set and workflow `companionGates`)                                                       | prints the brief (JSON)                       | `open`: relaunches the originating conversation (`claude --resume <id> <gate prompt>`); `attach`: rebinds the session  | no `--confirm`: PROPOSES, changes nothing; matching `--confirm`: applies via `resumeRun`                     | **stdin AND stdout are TTYs:** relaunches the companion exactly like `gate open` (`resumeOpensCompanion`). **Otherwise:** falls through to `resumeRun`, which re-emits the brief, prints how to return, exits 0, decides nothing | refused, exit 1                                     |
| **Awaiting a gate, no companion** (`--no-companion` on either workflow, or a feature run from before v0.1.64 that never set `state.companion`) | prints the brief (`companion.status` blocked) | `open`: error (no companion to resume). `attach`: error if the workflow has no `companionGates`, else adopts a session | refused `[no-companion]` until a session is attached                                                         | falls through to `resumeRun`: spawns a fresh interactive `claude` review session (`/gate-review`, `/gate-conclude`) and applies the decision it writes                                                                           | applies the decision directly                       |
| **No gate pending** (any top-level status)                                                                                                     | `not paused at a gate (status: X)`, exit 0    | error, exit 1                                                                                                          | `refused [not-awaiting]`, exit 1 — except an identical decision already applied, an idempotent no-op, exit 0 | falls through to `resumeRun` — the only command that works here (below)                                                                                                                                                          | runs, but there is no gate, so the flags do nothing |
| **Top-level `failed`, nodes since completed out-of-band via `dagrun rerun <run> <node>`**                                                      | no gate ⇒ as "no gate pending"                | error                                                                                                                  | `not-awaiting`                                                                                               | **the correct command**: no decision is made; `resumeRun` runs whatever is still `pending` (including the nodes `rerun` just re-enabled, below) and recomputes the top-level status from the nodes (`done` if none failed)                                                            | n/a                                                 |
| **Crashed** (top-level `running`, a node stuck `running`, process gone)                                                                        | no gate ⇒ no-op message                       | error                                                                                                                  | `not-awaiting`                                                                                               | `resumeRun`: crash reconciliation (below), then continues                                                                                                                                                                        | n/a                                                 |

What `resumeRun` does with no decision, in order: (1) nodes stuck `running` are marked failed
("process interrupted") then reset to `pending` for up to `MAX_INTERRUPT_RETRIES` attempts, archiving
their artifacts; past the cap they stay `failed`; (2) if a node is `awaiting-gate`, the gate handling in
the table above; (3) otherwise `runDag` runs every `pending` node whose dependencies allow it and
finalizes the top-level status (`failed` if ANY node is `failed`, else `done`; exits 1 on `failed`).
It does not retry a plainly `failed` node or revive a `skipped` one — that is `dagrun rerun`.
`rerun` executes exactly one node, takes no run lock and never touches the run's top-level status (its
output ends `To continue: dagrun resume <run-id>`), so after an out-of-band `rerun` the run can read
`failed` while every node is `done`; a plain `resume <run-id>` is the reconciling step. It is safe
there because with no gate awaiting the bare-resume companion relaunch does not apply.

**What `rerun` does to the nodes downstream of the rerun node (v0.1.84).** A non-short-circuit failure
(an outcome gate, a `produces` violation) makes `runDag` break out of its loop, and its end-of-run sweep
persists every still-pending node as `skipped` — `skipped` is terminal, so before v0.1.84 a succeeding
`rerun` of the failed node followed by `resume` left those nodes skipped and ended the run `done`: a false
success (§3e's RED failure was the measured case). The sweep now writes `skipReason: "blocked-dependency"`
on exactly those nodes, and when the rerun lands `done` or `awaiting-gate`, `rerunNode` returns every
transitive dependent carrying that marker to `pending` (`endedAt`/`error`/`skipReason` cleared; `cost`,
`attempts`, `gateHistory` kept; leftover artifacts archived to `<node>-attempts/`, not deleted), so the next
`resume` runs them. Why a marker rather than inference: a `when`-skip and a sweep-skip are written
identically, and the workflow cannot tell them apart either. Skips by a node's own rule — a `when`
predicate, an optional node that failed, a stale gate — never carry it and stay skipped; a downstream node
that is already `done` is left exactly as before; a rerun that fails again leaves the dependents skipped
(still blocked). Legacy state written before v0.1.84 has no marker and is not guessed at: rerun + resume on
such a run still ends `done` with the nodes skipped, and the recovery is a new run. `gate attach --reseed`
resets no node; gate amend/reject have their own resets (an amend already rebuilds every downstream node).

**Agent-driven operation: `--detach`, `status --json`, `events.jsonl` (v0.1.61).** A companion agent drives
the run instead of a terminal human, so foreground phases (minutes) and the lack of a cheap machine-readable
status are the gap. All of it is plumbing around the one engine; no new execution path.

- **`--detach`** (`start`, `resume`, `gate decide --confirm`; `runtime/detach.ts`): the parent re-invokes the
  _same_ CLI command minus `--detach` as a `detached` child (`stdio` → `<runDir>/driver.log`, `unref`),
  prints run id / pid / log path, exits 0. The parent never takes the run lock and applies nothing; the child
  is a normal driver and re-validates everything. Because an exit 0 that hides a doomed child would be a lie,
  the parent first runs every check the child would refuse _synchronously_: `validateStartOptions` (workflow,
  companion association — extracted from `startRun`), the confirmed-decision validation in `gateDecide`
  (`DecideArgs.detach` replaces the `resumeRun` call), the lock check (`assertLockAvailable` /
  `assertNoLiveDriver`), and a refusal of `--detach` where the child would need a terminal (legacy gate review,
  a decide without `--confirm`). For `start`, the parent allocates the run id (`makeRunId`), claims `runs/<id>/`
  (so `driver.log` has a home) and passes it as the internal `--run-id`; `startRun`'s clobber backstop
  tolerates a dir holding only `driver.log`.
- **Lock liveness is the run lock's pid, nothing new** (`core/lock.ts`). Before: same-run re-acquire always
  succeeded, and `resumeRun` released-then-acquired unconditionally, so a second `resume` could steal a live
  run and reconcile its running nodes to `failed`. Now `isPidAlive` (signal 0, EPERM = alive) gates it: a
  same-run lock held by another _live_ pid is refused ("already being driven by pid N") before any state is
  touched; a dead pid is a stale lock and is recovered by overwriting, exactly as before; a _different_ run's
  lock (even stale) still needs `--force`; a corrupt lock still fails loud.
- **`dagrun status [<run>] --json`** (`cli/status-json.ts`): read-only (no lock write, no `emitGateBrief` —
  the gate revision comes from the latest `gate.opened` event). `status`: terminal states pass through
  (`done|failed|aborted`), otherwise `awaiting-gate` iff a node is (per-node scan, as everywhere), else the
  top-level status. `stale` = top-level `running`, no gate pending, no live lock holder for this run. Human
  output without `--json` is unchanged. A run dir holding only `driver.log` errors loudly pointing at the log.
- **`<runDir>/events.jsonl`** (`core/events.ts`): append-only `{ts,type,node?,iteration?,detail?}` history —
  `run.started`, `run.status`, `node.started`, `node.finished` (status/duration/cost), `node.retry`,
  `node.invalidated`, `gate.decision` (action/decisionId/target/revision/invalidated), `gate.opened`
  (revision). It is _derived_, not a second source of truth: `writeState` diffs the previous `state.json` on
  disk against the state it is about to write and appends the resulting events, so every existing transition
  point (runDag, resumeRun, night mode, amend, abort) is covered by one choke point. Only `gate.opened` is an
  explicit emit (`emitGateBrief`, once per revision), because the revision exists only once the brief is
  built. An append failure warns and is swallowed — observability never fails a run.
- **Per-iteration timing**: `NodeState.attempts[]` (`{iteration,status,startedAt,endedAt,durationMs,cost}`)
  is appended by `runDag` whenever a node leaves `running` (done/failed/paused at a gate) and carried across
  amend/reset, so a re-run no longer overwrites earlier iterations' timing. The existing `<node>-attempts/`
  dirs archive _artifacts_ only and hold no timing, so they are unchanged.

**Saved diff and on-disk artifact listing (v0.1.62).** The fix gate's viewer had summary prose but not the
change itself, and saw an empty artifact list because `state.nodes[id].artifacts` is only written at
approve/finish. Both are engine plumbing, no agent involved:

- **`changes.diff`** (`core/changes-diff.ts`): `git diff <merge-base(origin/<base_branch>, HEAD)>` of the
  worktree working tree (committed + staged + unstaged) plus untracked files (`ls-files --others
--exclude-standard`, so the worktree's seeded excludes apply) rendered as new-file diffs with
  `git diff --no-index /dev/null <file>`. It never stages or touches the index/worktree. `node_modules` is
  excluded (same rule as `normalizeDirty`); lockfiles are NOT (no existing rule, and a lockfile change can be
  part of a fix). Base = the run's `state.baseBranch ?? "main"` (hotfix runs branch from release branches);
  `origin/<base>` is tried first, then the local `<base>` the worktree was branched from; if neither
  resolves, it errors. Capped at 2 MB with a `[dagrun: changes.diff truncated …]` marker. Written by the
  executor wrapper when `fix` finishes or pauses (both workflows), registered as a `fix` artifact on done/
  approve, and refreshed in `fix/` (plus a copy in `pr/`) when the pre-PR gate opens (`announcePause`), since
  an amend may have moved the worktree. A diff failure warns on stderr and never fails the node.
  `rerun` (debug tool) does not write it, like the pre-PR scratch scan.
- **Listing** (`core/node-files.ts`): `collectGateEvidence` and `status --json` per-node `artifacts` list
  every regular file in the node dir: registered ones first (state order), then unregistered ones
  alphabetically with `registered:false`, each with `size` and `mtime`. `transcript.log`, `burn.json`,
  `gate.json`, `gate-context.md`, `gate-decision.md` are excluded unless registered. `status --json`
  `artifacts` therefore changed from `string[]` to `{path, registered, size, mtime}[]`.
- **Revision is unchanged**: only declared `produces` files are hashed into the gate revision, exactly as
  before, so extra listed files (the diff, scratch) never make a companion's decision stale.
- **`gate.openedAt`**: `emitGateBrief` stamps the brief with the `gate.opened` event's ts (the existing
  event for that revision, or the one it just wrote); `status --json` `awaitingGate.since` already used it.

**`dagrun ui` — read-only timeline viewer (v0.1.63; rebuilt to the approved mockup and made live in v0.1.67).** A companion agent (or Eddie) needs a visual,
live-updating view of a run alongside the companion chat; `status --json`/`events.jsonl` are
machine-readable but not a place to _look_. `dagrun ui [--port <n>] [--open] [--home <dir>]` starts a
loopback-only (`127.0.0.1`) Node `http` server (zero new deps — no Express, no frontend framework, no
build step) and prints the URL; it never auto-opens a browser unless `--open` is passed (best-effort
`open`/`xdg-open`/`cmd start` by platform, never fails the command if it can't). Default port `4740`
(distinct from OTLP's 4317/4318; nothing else in this repo claims a port); `--port <n>` overrides, and a
port already in use fails loud with the exact retry command — it never silently picks another port.

- **One page, a run-chips row, `?run=<id>` deep-link** — `src/ui/page.ts` serves a single self-contained
  HTML document: a STATIC shell plus inline `<style>`/`<script>` (no static asset files — avoids a
  dist-copy build step the "no build step" rule would otherwise need; nothing is loaded from the network,
  system fonts only). The layout is the approved mockup (direction 2, "timeline"): run chips, issue/branch
  line + hero title, status line, the gate "letter" card, a vertical PIPELINE with a status rail and a
  per-node card (Artifacts / Output / Details tabs), an ACTIVITY feed (right column wide, below at ~760px)
  with an "Agent messages" toggle, System/Light/Dark theme. The mockup was recovered (see DECISIONS.md
  § ui-mockup-port-and-live-tail) after the first implementation was re-derived from a description and
  came out "very basic". The header states live state honestly from the EventSource ("Live · connected" /
  "Reconnecting…" / "Run finished").
- **Strictly read-only**: the server never writes to a run directory, never touches `active.lock`, and
  never calls any decide/approve/amend/resume path. `run-snapshot.ts` wraps `cli/status-json.ts`'s
  `buildStatusJson` (the exact function `dagrun status --json` uses) so the CLI and the UI can never
  drift, and reads the awaiting gate's brief VERBATIM from the already-persisted `<gate>/gate.json` —
  it never calls `buildGateBrief`/`emitGateBrief` (which spawn git and write files). A companion-gates
  run before its first `gate show`/`gate open`/decide-propose has no `gate.json` yet; the UI then shows
  a lighter banner (reason/since only, no revision) with the same "run `dagrun gate show <run>`" hint —
  this mirrors the CLI's own staleness, not a UI bug.
- **Client-rendered** (reverses the v0.1.63 "progressive, no-JS-safe, server-rendered timeline"): the
  shell has empty mount points; the pure renderers (`client-core.ts` — view data in, HTML out, evaluated
  under `node:vm` in tests) and the DOM/network glue (`client-app.ts`) fill them from JSON. Why: live
  progress needs the page to re-render from snapshots, which a server-rendered `<details>` timeline
  cannot do; two render paths (server + client) would drift. Without JS the page shows only a `<noscript>`
  note pointing at `dagrun status <run> --json`. **Escape by default**: client templates use
  `T('…{x}…')` (escapes) vs `{{x}}` (pre-built HTML only); hrefs pass `safeHref` (http/https). Artifact
  content is the one thing rendered on the server (`render.ts`, the single escaping path for content:
  markdown subset incl. tables, syntax-coloured JSON, glyph-marked diffs) and fetched lazily from
  `GET /api/runs/:id/artifact?node=&name=` (allowlist + 500KB cap + confinement to the run dir) — content
  never rides in per-tick snapshots. There is no decide/approve control anywhere; the gate card says
  decisions happen in the companion conversation. A live re-render replaces only the pipeline steps whose
  HTML changed and preserves, keyed by node id, open nodes, selected tab/file, scroll positions, focus;
  the feed auto-follows only if the reader is at the live edge (top — newest first).
- **Real-data quirks handled in `run-snapshot.ts`** (the mockup author's findings): the gate card exists
  only when the raw run status is `paused` AND a node is awaiting-gate and the brief's `gateNodeId`
  matches (`gate.json` keeps `pendingDecision` after approval); `issueUrl` is stored with literal quotes
  (stripped; non-http dropped); a `skipped` node's reason (decision / optional / condition) comes from the
  deciding gate's `next-node-decision.json`; files are listed from disk (registered/extra, plus
  gate.json/burn.json/gate-context.md as bookkeeping chips); state-only legacy nodes (digest, expand, define, reproduce…) are
  appended to the pipeline; serializable node definitions (no `when` fn) feed row meta and "Round N of M".
- **SSE + live tail** (`sse.ts`, `feed.ts`, `transcript.ts`, `live.ts`): `events.jsonl` holds state
  transitions only — a running node's activity (assistant text, tool calls) exists only in
  `<node>/transcript.log` (one compact SDK message per line, each CUT at 8 KB with a trailing `…}`, so cut
  lines are not valid JSON). One generic file tailer (`tailLines`: complete lines only, byte offsets,
  shrink OR inode change → reset, never throws) serves both. Each poll (1 s, not `fs.watch`) re-reads
  state.json to learn which nodes are `running` NOW, tails their `transcript.log`, and gives a node that
  just stopped one final drain (offsets are fast-forwarded for every node at start and kept — an amend
  re-runs a node into the same transcript file, and its earlier rounds must stay history); archived `<node>-attempts/` are never tailed live. `assistant` `text`
  blocks and `tool_use` calls become feed items (thinking and other message types ignored); a cut
  assistant line has its surviving `text`/`tool_use` salvaged by regex (flagged truncated) or becomes one
  "(large message truncated)" note — never silently dropped. One item schema (`FeedItem`) for history and
  live, with stable ids (`e:<offset>` / `t:<node>:<inode>:<offset>:<i>`) so the client de-dupes across
  reconnects. Per run, one shared tailer + timer serves all clients (torn down with the last one); on
  every (re)connect the server sends the current `snapshot` then a `feed` history batch (all engine events
  + the newest ~150 transcript items), then `feed` deltas and a `snapshot` whenever the serialized view
  changes; `: ping` heartbeat when idle. The page also polls `/api/runs` every 5 s so a run started after
  load appears. Transcript lines carry a `timestamp` on `assistant`/`user` messages (after `message`, so a
  cut line loses it → previous line's ts, flagged approximate).
- **Discovery never hides a broken run** (`src/ui/discover.ts`): deliberately does NOT reuse
  `run-engine.ts`'s `listRuns`, which silently skips a run whose `state.json` fails to parse. The UI
  brief requires a corrupt run to render as an error card in the list, not vanish.
- **Artifact preview allowlist** (`src/ui/artifact.ts`): only recognized text extensions
  (`.md/.json/.diff/.patch/.txt/.log/.yaml/.yml`) under a 500KB cap are read and rendered; anything else
  (binary, oversized, vanished mid-request) degrades to a note, never a throw. Every `runId`/node/file name
  taken from a URL is validated against `^[A-Za-z0-9._-]+$` and the resolved real path must stay inside the
  run directory (symlinks pointing out are refused). The diff shown is the engine-written `changes.diff`
  (v0.1.62); the UI never computes one.

## 3h. Reviewer suggestion — pr node, report-only (v0.1.76)

After the pr node's backstop commit it runs ONE command, `dagrun reviewers --run-dir <runDir>`, which
suggests two reviewers from the Core Features Alpha GitHub team and writes `pr/reviewers.json` +
`pr/reviewers.md` (the node repeats the two lines in its final output). **Report-only**: nothing is ever
posted — no `--add-reviewer`, no comment, and reviewer names never enter `body.md`, which `gh pr create`
posts verbatim. (There is no PR yet while pr runs — `runPrPostProcess` creates it after the pre-PR gate —
so "after the PR is created" in the original ask became "before it is published": the author is the
`gh` login that will create it, the changed set is `merge-base..HEAD`, and Eddie sees the suggestion AT
the gate.)

- **Two slots, because one ranking can't serve both goals.** *Expert*: highest familiarity (distinct
  changed files the candidate committed to in 12 months), minus load penalties; requires familiarity > 0.
  *Stretch*: lowest familiarity among candidates strictly under the queue cap (3 pending review
  requests), boosted for "has not reviewed in 30 days" — knowledge sharing (the learning-stretch idea of
  the user's pr-review-companion, used conceptually only; nothing is read from that workspace). Always
  different people; with <2 eligible candidates the missing slot is reported missing, never padded.
- **Roster = GitHub team, BE/FE by changed files.** `orgs/<org>/teams/<slug>/members`: backend-only diff →
  `-be`, frontend-only → `-fe`, mixed or nothing matched → whole team. Neutral files (docs, CI yaml) are
  ignored when one side matched. The path→side mapping, org/team slugs, `away`/`exclude` handle lists and
  the numeric windows live in `config.json` under `reviewers` (`src/config/reviewers-config.ts`; absent =
  documented defaults, present-but-malformed = load error from `resolveConfig`). Hard filters: PR author,
  `away`, `exclude`.
- **Fail loud, no fallback roster.** A 404/auth/empty roster, a rate-limited search, an empty diff — any
  lookup failure exits 1, persists `status:"error"` in `reviewers.json`, and shows as a ✗ advisory at the
  pre-PR gate (as does an ABSENT file: a pr node that skipped the step must not look like one that ran
  it). It does not fail the PR: the suggestion is advisory and is deliberately not in `produces`.
- **Where the code lives and why.** Pure scoring/selection/rendering in `src/core/reviewers.ts`; the
  gh/git I/O behind an injected `Exec` in `src/runtime/reviewers-cli.ts` (fixture-tested offline); the
  node invokes the compiled `dagrun` binary through a narrow `Bash(dagrun reviewers *)` allow entry —
  `payload/` is copied raw into worktrees and is never typechecked or tested, and the CLI's own gh/git
  child processes are not subject to the tool allowlist. Because it needs the installed binary, a source
  change is only visible to nodes after `npm run build` (dist) — like every other dagrun subcommand.
- **Signals are batched.** Per-candidate `gh search prs` calls would trip the 30 req/min search limit on a
  ~15-person roster, so pending queue (DIRECT requests only — `user-review-requested:`; plain `review-requested:` also counts team-addressed requests and inflated every queue 1.5-2x in a live check), recent reviews and pair history (both directions) come from one
  GraphQL request of aliased `search` fields per ≤12 candidates; commit email → GitHub login parses the
  `ID+login@users.noreply.github.com` form locally and resolves other emails with one batched
  `object(oid) { author { user { login } } }` request. An unmappable email counts as zero and the reason
  says so. Windows are "PRs *updated* in the window that the user reviewed" — an approximation of "review
  done in the window" that over-counts old reviews on recently-touched PRs.
- **No DX integration in v1** — GitHub gives the same signals with no new integration; revisit if DX
  exposes an API.

---

## 3b. Validation — smoke:mock (per-plan gate) and smoke:live (occasional)

`npm run verify-baseline` = `npm ci && typecheck && unit tests && smoke:mock`. The standing gate: run on every plan change.

**smoke:mock** (`test/smoke/smoke-mock.ts`) drives both gated workflows in-process using the mock executor — zero API calls, deterministic. Asserts: gate pauses, produces-contract at every relevant node, state transitions (awaiting-gate → paused → done), night-mode auto-approvals. Since v0.1.64 every `startRun` call here against `featureWorkflow` passes `noCompanion: true` (the legacy fresh-session path, same as bugfix's run B already did) — `featureWorkflow` now has `companionGates: true` and requires an explicit `--companion-session`/`--no-companion` choice (DECISIONS.md § feature-companion-gates-parity); the `pr` mock scenario stays `"success"` (not `"gate-pause"`) so these runs still bypass `pr`'s own gate pause exactly as before — proving that path is `smoke-gates-feature.ts`'s job, not this file's. Runs: **A** (feature workflow, full happy path — `startRun` runs `implement` (RED proven: `red.json` confirmed + `red-evidence.md`) → `review` → pauses at the **fix gate, the FIRST pause**; reject re-pauses fix; approve → `pr` runs straight after `fix`, run done; asserts there is no `define`/`reproduce`/`verify` node/dir and no `fix/next-node-decision.json`); **B** (bugfix workflow, same shape and the same absences); **C** (night-mode, clean plan — the fix gate auto-approved, the run completes fully unattended with no park); **D** (night-mode, seeded concern RAISED BY `implement` — its `summary.md` carries the heading while `fix/summary.md` is clean → parked at the fix gate, proving the ancestor scan) and **D2** (the concern in the gate's own artifact still parks it); **E** (stale gate from a prior workflow version auto-skipped on resume; the stale run also carries legacy DONE `define` and `verify` nodes that the resume leaves untouched); **F** (`outcomeGate`, proven end-to-end through the real `startRun`/`runDag` path via a tiny custom two-node workflow: a non-`PASS` outcome fails the node and blocks its dependent, with `startRun`'s intentional `process.exit(1)` on a failed run temporarily intercepted so the in-process smoke script can inspect the resulting `state.json`); **F2** (the SHIPPED bugfix pipeline when RED is not proven — the mock `outcome-gate-fail` scenario writes a non-`confirmed` `red.json`: `implement` fails with the outcome-gate error, `review`/`fix`/`pr` never execute, run `failed`); **F3** (the recovery of that same F2 run through the real `rerunNode` + `resumeRun` path: `rerun implement` with RED now proven returns the blocked `review`/`fix`/`pr` to `pending`, the resume runs `review` and `fix`, and the run stops `paused` at the fix gate with `pr` still `pending` — never `done` with them skipped; unit coverage in `src/core/dag-blocked-dependents.test.ts` and `src/runtime/rerun-reenables-dependents.test.ts`, which also pin that `when`/optional skips stay skipped and that marker-less legacy state behaves as before); **G** (added by the structural-upgrades change — `noPlaceholders`: a custom gated node's `summary.md` contains an unresolved `TODO`, manually approved via `resumeRun`'s `--approve` path (which takes a test-only `workflow` seam for the custom workflow), and the mechanical scan fails the node on the gate-approve transition itself — not `runDag`'s done-branch, since a gated node never reaches `done` there — blocking its dependent and failing the run); **H** (the same `noPlaceholders` proof through the OTHER gate-approve site — `startRun`'s night-mode auto-approve loop, using a placeholder-laden `summary.md` with no "Concerns / plan challenges" heading so it auto-approves rather than parking; needed a new `startRunCapturingExit` smoke helper mirroring `resumeRunCapturingExit` since `startRun`'s own night-mode loop also calls `process.exit(1)` on a failed run; the custom gated node is named `fix` because night-mode only auto-approves agent-decidable ids). **I** (`rerunNode` archives a failed required node's attempt — a bugfix run whose `review` fails — to `review-attempts/attempt-1/` before wiping); **J** (`resumeRun` archives an interrupted node's partial artifacts before the retry); **K** (worktree adoption lifecycle). G and H together are the load-bearing proof that `checkNoPlaceholders` is wired at BOTH places a gated node's status actually flips to `done`, not just where the analogous `checkOutcomeGate` happens to already live (no shipped node uses it now — §3d). Does NOT assert model output quality or exact session IDs. `npm run smoke:mock` chains four scripts: `smoke-mock.ts` (above) `&& smoke-gates.ts` (companion-gate routing/authorization on bugfix, §3g; step 15: a run whose adopted worktree was removed — `resume`/`rerun`/`gate attach --reseed`/confirmed `gate decide`, with and without `--detach`, fail loud through the real CLI while read-only commands keep working, §4) `&& smoke-gates-feature.ts` (added v0.1.64: the same companion-gate path — the fix and pr gates (fix first), a plain fix-gate approve straight to the pre-PR gate, amend-at-pr-targets-fix, and the publication-timing proof that approving fix no longer auto-publishes — exercised end to end on `featureWorkflow`; a separate file from `smoke-gates.ts` because that one hardcodes `bugfixWorkflow` throughout, while the detach/session-recovery mechanics it also proves are workflow-agnostic and already generic; `smoke-gates.ts` also pins the RED-first failure: step 12b — `implement` fails with the outcome-gate error and `status --json`/`gate show` carry the reason) `&& smoke-ui.ts` (`dagrun ui`'s HTTP surface: drives two mock bugfix runs (one paused at the fix gate, one done) into a temp home, hits every JSON/SSE endpoint (gate card present only for the paused run, feed history, the initial `snapshot` + `feed` SSE frames) and the static page shell against the real server, and asserts neither run directory changed at all). The live-update behaviour itself is proven by `src/ui/server.test.ts` (SSE client connects, THEN transcript/events/state are appended) and, in a real browser, by the manual CDP pass recorded in DECISIONS.md § ui-mockup-port-and-live-tail.

**smoke:live** (`test/smoke/smoke.ts`) runs the real 6-step pipeline with the SDK (step 2: `implement` proves RED → `review` → `fix`, pausing at the fix gate — the longest step; step 5 approves it and lets `pr` compose). **Not run for the v0.1.82 change** (it rewrote `implement.md`/`review.md`/`pr.md`/`fix.md` prompts and deleted two, so a live pass is owed — Eddie decides when; the toy plan gained a `## Validation` line so RED can be proven on the plain-Node toy repo, unverified) — requires `ANTHROPIC_API_KEY`, ~35 min. Proves API auth, real session-resume, structured output from live model, worktree diff. Run when node prompts change (`payload/commands/*.md`) or when `sdk-runner.ts` changes. A bad prompt that passes mock but breaks model behaviour won't surface until the next smoke:live — that is the accepted tradeoff. **Reflection wiring (step 5):** smoke seeds a known `reflections.md` into `pr/` before the resume call so the SessionEnd hook has a deterministic file to capture — this proves hook wiring + env propagation in a real session without gating on spontaneous model output. The hook logic is separately proven by the unit test (`src/hooks/session-end.test.ts`).

**Executor-factory injection seam:** `startRun`, `resumeRun`, `rerunNode` all accept an optional `executorFactory` parameter (defaults to `makeSDKRunner`). This is the seam that lets smoke:mock swap in `createMockExecutor` without touching engine logic. See DECISIONS.md § split-smoke-mock-gate-live-occasional.

**Unit test coverage (co-located `*.test.ts`):**

- _Tier A (core)_: `dag.test.ts`, `state.test.ts`, `lock.test.ts`, `workflow.test.ts`, `settings-seed.test.ts` — DAG topology, state I/O, lock discipline, loadWorkflow, settings-seed merge rules.
- _Run-worktree guard_: `missing-worktree.test.ts` — `assertRunWorktreeExists` and its four entry points (`resumeRun`, `rerunNode`, `gateAttach --reseed`, confirmed `gateDecide`): throws before any side effect, path not re-created, read-only commands unaffected (§4 caveat (i)).
- _Tier B (exported helpers)_: `xdg.test.ts` (`computeHomePath`, `resolveHome`, `resolveConfig`, `initHome`), `preflight.test.ts` (`getAgentContext`, `formatAgentContext`, fixture-able `runPreflight` predicates), `hooks/session-end.test.ts` (invokes `.claude/hooks/session-end.sh` directly in a temp env — proves reflection capture, best-effort no-op on absent/empty file, run_id field, friction.jsonl write).
- _Golden_: `report.test.ts` (HTML output of `generateReport` → `report.golden.snap`); `settings-seed.test.ts` extension (`buildSeededSettings` JSON → `settings-seed.golden.json`); `preflight.test.ts` (`formatAgentContext` text → `preflight.golden.txt`). Stored in `.snap`/`.txt`/`.json` to avoid Prettier hook reformatting (`.html` is in scope, those are not). `UPDATE_SNAPSHOTS=1` regenerates — a deliberate act.
- _Workflow shape_: `bugfix-workflow.test.ts`/`feature-workflow.test.ts` pin implement as the sole root, fix and pr as the only gated nodes, the `red.json` outcome gate and the `produces` of `implement`; `dag.test.ts` runs the SHIPPED workflows through `runDag` for the unprovable-RED and confirmed-RED paths.
- _Schema-contract_: `feature-workflow.test.ts` — well-formedness of `CLASSIFY_SCHEMA`/`FINDINGS_SCHEMA`, conforming+nonconforming fixtures (hand-rolled validator, no ajv), `featureWorkflow` passes `loadWorkflow`.
- _Tier C (orchestration)_ owned by smoke (never unit-tested).

---

## 4. The spine

- **run-id = `<slug>-<timestamp>-<hex>`** (the built format; no issue-number injection). The three-segment id is `<plan-basename-slug>-<Date.now()>-<6-char random hex>`. The hex suffix closes the same-millisecond collision window (two starts of the same plan in the same ms produce distinct ids). `startRun` additionally asserts the target run-dir does not exist before writing into it — fail loud if it does. The run's branch is whatever branch is checked out in the adopted worktree (recorded in `state.branch`; dagrunner no longer names branches — `makeBranchName` is gone). `makeRunId(planPath, now, suffix?)` is exported from `src/runtime/run-engine.ts` for unit testing; the suffix is injectable for determinism in tests and defaults to `randomBytes(3).toString("hex")` in production.
- **state.json** per run: top-level (runId, workflow, status, worktreePath, branch, worktreeOrigin?, sourcePlanPath, costs) + per-node (status, timestamps, artifacts, model, iteration, gateHistory, interruptRetries?, skipReason?). `skipReason` is `"blocked-dependency"` only on a node `runDag`'s end-of-run sweep skipped because an upstream dependency never finished — the one skip `rerun` may undo (§3g); absent on every other skip and on state written before v0.1.84. `gateHistory` entries carry optional `mode: "night"` and `basis` fields when the decision was made by night-mode automation.
- Checkpoint-and-exit at gates; reconcile-on-resume: `reconcileRunningNodes` marks any `running` node `failed` (crash recovery), then `resetInterruptedNodes` resets interrupt-reconciled nodes to `pending` up to `MAX_INTERRUPT_RETRIES` (currently 2, i.e. 3 total attempts) before leaving them permanently `failed`. Rationale: a transient Ctrl+C shouldn't permanently fail a resumable run, but an unbounded retry would never settle a genuinely broken node — the cap bounds both risks. The retry counter (`interruptRetries` on NodeState) is distinct from the gate iteration counter; stale-lock release follows reconcile.
- One run at a time (global lockfile). Paused runs release the lock; resume re-acquires.
- Worktrees are ADOPTED, not created — see "Worktree adoption" below. Teardown of an adopted worktree belongs to whoever created it (workmux); `dagrun cleanup` only releases the run (never auto — manual test + PR-lifetime siblings need the worktree alive).
- Artifact channel: `~/.local/share/camunda/dagrunner/runs/<run-id>/<node>/` (survives teardown), passed to nodes as absolute path via env.
- `produces` contract: a node is `done` only if it wrote its declared artifact(s); missing => failed.
- XDG home: `~/.local/share/camunda/dagrunner/` (runs, inbox, store, config.json; `worktrees/` is legacy-only — it holds the worktrees of pre-adoption runs and is still created by `dagrun init`), `~/.cache/dagrunner/`, `~/.local/bin/dagrun`, override `DAGRUNNER_HOME` / `--home`, fail-loud no-cwd-fallback.
- **The home lives under `~/.local/share/camunda/` (v0.1.85).** WHY: Eddie keeps ONE workspace root, `~/.local/share/camunda/`, for everything his agents leave behind, and the tmux artifact picker searches only that root; dagrunner's old home (`~/.local/share/dagrunner`) was the odd one out. The default is defined once (`defaultHomePath()` in `src/config/xdg.ts`); `DAGRUNNER_HOME` and `--home` are unchanged and win over it. **No silent fallback:** with no override, if the new default is absent and the OLD default exists, every command that resolves the home (`resolveHome()`, and `dagrun ui` via `resolveUiHome()`) exits 1 with a message that says the home moved, names both paths and prints the exact command, `node <this install>/scripts/move-home.mjs` (also `--dry-run`); reading the old home silently would hide exactly the state the move must fix. `dagrun init` creates the NEW default and ignores a leftover old home. If both exist the new one wins silently in commands and `dagrun preflight` prints one stderr WARNING line naming the old home and its top-level entries (a warning, never a failure; not printed when an override is in play). Neither exists: the usual "run `dagrun init`" message, with the new path.
- **`scripts/move-home.mjs` is the ONE-TIME move, deliberately a standalone script rather than migration code in the CLI** (the CLI would carry dead code forever; this runs once). It refuses (exit 1, nothing changed) when: the source is missing (which also makes a second run a clean no-op); the destination exists and is non-empty; `worktrees/` holds anything (legacy worktrees must be removed first with `DAGRUNNER_HOME=<old home> dagrun cleanup --all` — the plain `dagrun cleanup --all` refuses while the home is un-moved, so both the refusal text and the moved-home message print the override form; a Finder `.DS_Store` does not count); `active.lock` names a live pid (the global lock pid is the only liveness mechanism, see `src/core/lock.ts`) or is corrupt; or source and destination are on different devices. A stale lock (dead pid) is reported, not a blocker. The move is ONE rename of the whole directory (never copy-then-delete), then the empty `worktrees/` and a stray `.DS_Store` are removed, then the old absolute prefix `<from>/` is rewritten to `<to>/` — text-level, so formatting survives — in `state.json`, `gate.json`, `pr-meta.json`, `seeded.json`, `pr-triage-state.json`, `triage-state.json`, `known-comments.json` (anywhere under the home) and a top-level `config.json`; paths under `<from>/worktrees/` are left as written; each file must parse before and after and is written tmp+rename; one that does not parse is skipped and reported. Logs, transcripts, markdown, reflections, `gate-context.md`, `report.html` and `driver.log` are history and are not touched (`dagrun report` regenerates the HTML). Runs that are not finished are listed with a caveat: `resumeRun` does not re-seed the worktree's `.claude/settings.json` or hooks (only `rerunNode` does), so a worktree seeded before the move still grants the OLD run dir and home.
- Hooks: SessionStart sync (private files), PostToolUse format (**TS/JS/CSS/HTML only** — Java/YAML excluded after a YAML-coercion incident), Stop friction/gates, SessionEnd cost.
- `dagrun rerun` re-seeds the worktree `.claude/` from `payload/` (runtime-only: the 6 pipeline commands in `payload/commands/` — implement, review, fix, pr, gate-review, gate-conclude — plus 7 reviewer agents). Hooks always come from `.claude/hooks/` (genuinely shared). `.claude/{commands,agents}` are build-harness-only and are never seeded into worktrees — this is the split that prevents build tools from polluting Camunda worktrees.
- `dagrun scaffold <node-id> [--worktree <path>] [--mocks <dir>]` creates a scaffold run in an ADOPTED worktree (same `--worktree` default and validation as `start`; there is no `--branch` any more — scaffold neither creates a branch nor a worktree, and `--branch` fails loud pointing at `--worktree`): state.json with all transitive deps pre-marked done and the target node pending. Lets a developer run a single node in isolation via `dagrun rerun` without executing the full pipeline. No lock acquired; no agent launched by scaffold itself. A scaffold run is written `paused` (non-terminal), so it keeps its worktree claimed — a later `dagrun start` there is refused until `dagrun abort <scaffold-run>`. Its base branch is `main` (a scaffold has no plan, hence no `base_branch`).
- Failure: 4-class taxonomy (transient->retry, contract->fail, convergence-exhaustion->gate, budget->checkpoint-exit). Node failure != run failure; isolate-and-continue.
- **CLI exit codes:** `dagrun start`/`resume` exit 0 on `done`/`paused`; exit 1 when the run ends `failed`. Callers (night queue, CI) must treat non-zero as a genuine failure — do not swallow it. The run engine owns the final status; the CLI layer propagates it.
- `dagrun report` static HTML (built, Phase 1).

### Worktree adoption (v0.1.80)

**Why.** The standing workflow is: a workmux window (`wm add <branch>`) creates the git worktree, and a Claude "driver" session (skill `dagrunner-driver`) runs INSIDE it and drives dagrunner, whose nodes execute in that same worktree. Two worktree creators on one branch would fight, so dagrunner stopped creating worktrees and adopts the one it is started in. dagrunner has NO dependency on workmux: no binary check, no config key, no call — worktree creation/removal for adopted runs is workmux's job, outside dagrunner; the only trace of it is a hint string printed by `cleanup`.

**Contract.**

- `dagrun start` and `dagrun scaffold` take `--worktree <path>`; default = `git rev-parse --show-toplevel` of the current directory, failing loud with a clear message outside a git repo. The CLI resolves it (`resolveWorktreeArg`) and hands `startRun`/`scaffoldRun` an explicit `worktreePath` — the engine itself keeps the no-cwd-fallback rule. `start --detach` resolves AND validates in the parent (a detached parent must not report success for a run that cannot start) and passes the resolved `--worktree` to the child explicitly.
- `validateAdoptedWorktree` (`src/runtime/worktree.ts`) is the single gate. It runs after the run lock is taken and before any other side effect; a refusal throws `WorktreeAdoptionError` (one distinct message per cause, printed without a stack trace) and the engine releases the lock. Checks: (a) the path is the root of a LINKED worktree of DEVHARNESS_SRC — same resolved `--git-common-dir`, `--git-dir` ≠ `--git-common-dir` (so the main checkout itself is refused); (b) HEAD is on a branch (detached refused) that differs from the run's base branch; (c) no tracked modifications or staged changes (`git status --porcelain --untracked-files=no` empty — untracked files are allowed because workmux may leave e.g. `.workmux/`); (d) the base branch resolves in DEVHARNESS_SRC; (e) no other run under `<home>/runs/*/state.json` in a NON-terminal status already uses the worktree (realpath compare). Terminal = `done` and `aborted`; `failed` is deliberately NOT terminal because a failed run is still recoverable in that worktree (`dagrun rerun`, `dagrun resume`), so it keeps the claim until finished or `dagrun abort`ed.
- `state.worktreePath` = the realpath of the adopted root; `state.branch` = the branch checked out there at adoption (`git symbolic-ref --short HEAD`); `state.worktreeOrigin = "adopted"`. An absent `worktreeOrigin` means a legacy, dagrunner-created run (six existed under `<home>/worktrees/` when adoption landed; the v0.1.85 home move refuses a non-empty `worktrees/`, so they are removed first with `DAGRUNNER_HOME=<old home> dagrun cleanup --all`); `readState` reads them unchanged.
- **Seeding is applied to an existing worktree, so every step is idempotent** (`seedRunWorktree`, pinned by `seed-run-worktree.test.ts`): the `.git/info/exclude` block is marker-guarded, `.tool-versions` entries are only added when absent (then `--skip-worktree`), node_modules symlinks are created only where nothing (not even a dangling link — `lstat`, not `existsSync`) is present, the `.claude/` payload is `cpSync`-overwritten with identical content, `settings.json` is rewritten for THIS run's runDir. Known limit: if DEVHARNESS_SRC tracks a file dagrunner seeds (e.g. `.claude/settings.json`), the seeded copy reads as a tracked modification and check (c) will refuse the NEXT adoption of that worktree until it is restored (`git checkout -- .claude`). Camunda keeps its `.claude/` private (untracked), so this does not bite there.
- `dagrun cleanup <run-id>`: adopted run → releases the lock only and prints `dagrun: run <id> released. The worktree is yours: remove it with: wm rm <basename>`; the worktree and branch are never touched. Legacy run → `git worktree remove --force` exactly as before. `dagrun cleanup --all` iterates `<home>/runs/*/state.json` (never a directory listing of a worktree root), applies the per-run rule, skips runs whose worktree no longer exists, and reports removed / released / skipped (/ failed) counts — a path no state.json records is never touched (`src/runtime/cleanup.ts`).
- Preflight check E is now "DEVHARNESS_SRC is the main checkout, not a linked worktree" (`--git-dir` = `--git-common-dir`); the old "not inside the worktree root" check and the `worktreeRoot` config key are gone (old config files that still carry the key keep loading — unknown keys are ignored). Preflight no longer requires `worktrees/`.

**Caveats (recorded, not engineered around).**

- (i) `wm rm --gone` / `wm rm --all` can remove an adopted run's worktree out from under its `state.json`; the run then points at a path that no longer exists. **v0.1.83 fails loud on it** (DECISIONS.md § missing-worktree-fails-loud): `resumeRun`, `rerunNode` and `gate attach --reseed` — plus a confirmed `gate decide` and the parent of `resume --detach`, so the refusal reaches the driver instead of a detached child's `driver.log` — call `assertRunWorktreeExists` (`src/runtime/worktree.ts`) BEFORE any side effect and throw `MissingWorktreeError` (a `WorktreeAdoptionError`, so the CLI prints the message with no stack trace and exits 1). The check matters because the seeding steps create parent directories: before it, a resume of such a run silently re-created the path as a bare `.claude/` dir and ran nodes there. "Exists" means a directory with a `.git` entry (a leftover plain directory is refused too). The message names the path and run, says the worktree was removed outside dagrunner (e.g. `wm rm`) and the run cannot continue, and offers exactly two ways out: recreate a worktree for the recorded branch at that same path (`git worktree prune` first if git still lists it, then `git worktree add <path> <branch>`; `wm rm` deletes the branch too unless given `-k`, so the message also says to recreate the branch first at the run's last commit — `origin/<branch>`, a gate brief's `worktreeHead`, or the reflog) and retry, or `dagrun abort <id>`. Legacy runs are checked the same way. Read-only commands (`status`, `report`, UI, `gate show`, a decide proposal) are deliberately unguarded and keep working — with the worktree HEAD reported as null, so the gate revision changes. dagrunner still does not create or restore worktrees; `cleanup --all` still just counts such runs as skipped.
- (ii) The Claude driver session is expected to run with `--setting-sources user` (verified 2026-11-08 in a scratch project: that flag stops the project's hooks, permission mode, commands and CLAUDE.md from loading), so the node settings dagrunner seeds into the worktree (Stop/SessionStart hooks, `acceptEdits`, deny rules) apply to node sessions only and not to the driver that happens to share the directory.
- (iii) Merging the feature and bugfix workflows was a SEPARATE later change from adoption. Its first half has since landed (v0.1.82, §3): define/reproduce are dropped and implement is TDD-style (RED first) in both. The two workflow names and their node lists still exist side by side; collapsing them into one is not done.

---

### 5. Worktree hygiene — structural scratch backstop

Node `cwd` is the worktree, so a relative write lands in the worktree and risks reaching a PR.
Two structural guards (prompt discipline is no longer the only line of defence):

- **Prevention:** at adoption (every run start; idempotent), seed the repo's common `.git/info/exclude` with the node
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

`dagrun preflight` runs before the graph: on expected base branch; git tree clean; DEVHARNESS_SRC resolves+is a repo AND is the main checkout, not a linked worktree (check E); seeded settings present; ANTHROPIC_API_KEY unset; CLAUDE_CONFIG_DIR=~/.claude-work; enterprise policy doesn't block; artifact path in additionalDirectories. (No sandbox/network-allowlist check — there is no sandbox to check; see §6.)

**Version banner (implemented):** `dagrun preflight` and a passing `dagrun start` both print dagrunner's own package version + build date/time before any node runs — `src/config/version.ts` (`getVersionInfo`), surfaced via `formatAgentContext` (preflight) and `formatVersionBanner` (start). Compiled binaries read the compile-instant timestamp from `dist/build-meta.json` (regenerated every `npm run build` by `scripts/write-build-meta.mjs`) and fail loud if it's missing; dev mode (`tsx`) prints `(dev, unbuilt)`. This makes drift between a rebuild and the running `~/.local/bin/dagrun` binary visible instead of assumed. Every dagrunner self-change bumps this version (enforced by `dr-build`, see `.claude/agents/dr-build.md`).

**Toolchain pin (NOT YET IMPLEMENTED):** the design calls for `claude` CLI to be pinned to an `EXPECTED_CLAUDE_CLI_VERSION` constant (planned home: `src/config/versions.ts` — note the plural, a distinct module from the version-banner's singular `src/config/version.ts` above) and checked via `claude --version` at preflight time, failing loud on mismatch (bypassable via `DAGRUN_SKIP_CLI_VERSION_CHECK=1`). **Neither the constant nor the check exists in the repo today** — this paragraph describes the intended design, not shipped behavior. Do not treat `claude --version` pinning as enforced until this is built. The Agent SDK dependency itself IS pinned exact (no `^` caret) in `package.json`; `npm ci` enforces it via the lockfile. **When this is eventually built:** bump `EXPECTED_CLAUDE_CLI_VERSION` + `package.json` SDK version together, run `npm install` to resync lockfile, run `smoke:live` once to confirm the new pair works, commit both in the same change.

---

## 8. classify — REMOVED; task-type routing designed fresh when needed

No classify node. Reviewer-selection moved into review's diff-triage step (reads the diff — better input than predicting from the plan). Former classify outputs relocated: needs*runtime -> human verify-election; recommend_pr_review -> human reads `dagrun status`; run_adversarial_verifier -> finding-count threshold; risk -> removed; touches*\* -> review diff-triage.

**Why classify is gone:** dormant code is drift risk — it reads as live, ages silently, and constrains future design. A future task-type router (feature/bug/tech-debt) earns a node only when it ROUTES the graph, not when it annotates. Change-AREA is diff-derivable; task-TYPE reshapes the graph upfront. That router will be designed fresh from current understanding when actually needed (Phase 5/6 or later) — not revived from stale scaffolding.

## 8b. reflect — hook-driven distributed capture

Each node optionally writes tips/gotchas to `$DAGRUN_ARTIFACTS/reflections.md`. The **SessionEnd hook** (`.claude/hooks/session-end.sh`) reads this file when the node finishes and appends one stamped JSONL entry to the durable store. The log outlives the run (stored in `~/.local/share/camunda/dagrunner/store/reflection-log.jsonl`, not in `runs/<id>/`). Capture is fail-soft — a hook failure never blocks a node.

- **Node contract:** nodes write `reflections.md` if they have useful tips; absence is fine. `fix` writes `reflections.md` whenever fixes were applied (fallback: "No non-obvious discoveries."). No node is required to write it for test coverage — the hook mechanism is proven deterministically (see Testing §14 and DECISIONS §deflake-reflection-capture-test).
- **Entry shape:** `{ ts, source, run_id?, body }` — that's it. There is no `kind` field. An earlier design reserved `kind` as a routing hint (`camunda-knowledge` | `dagrunner-harness`) settable via a manual `dagrun reflect --kind ...` flag, but a reflection-log audit found zero of 105 entries across 53 days carried it — 100% of real capture comes via the SessionEnd hook, which never had a kind to infer (its payload is `{session_id, transcript_path, cwd, hook_event_name, reason}`, no semantic signal), and the manual `--kind`-requiring CLI path was never actually invoked by any prompt (`grep`-verified: no file under `payload/` references `dagrun reflect` at all). The field was removed entirely — see DECISIONS.md § reflect-drop-kind.
- **Manual/sibling append:** `dagrun reflect --source <node> --body "<text>" [--run-id <id>]` exists as
  a CLI entry point. No file under `payload/` calls it — node prompts remain 100% hook-driven — but it
  is no longer dead code: since the digest-removal change (`DECISIONS.md §
digest-removed-folded-into-companion`), the companion gate conversation is its first real caller.
  The companion session (`claude --resume`, spawned in Eddie's own project cwd with his own settings)
  never gets the dagrunner-seeded SessionEnd hook or `$DAGRUN_*` env vars this hook depends on, so a
  bare CLI call is the only mechanism available to it — the same way it already runs `gate show`/`gate
decide`/`status`. This is deliberately NOT automatic: the companion only runs it on a rare, durably
  useful lesson and Eddie's explicit go-ahead (see §3g's lesson-promotion step), never on every gate
  finding.
- **Durability invariant:** `DAGRUN_STORE_DIR` is injected explicitly by the launcher (never derived via `../../` from the run dir). The store is outside the run dir and survives `dagrun cleanup`.
- **Harvest:** periodic human + architect process, with no runtime `kind` to route by — the harvester reads each entry's `source`/`body` and makes the camunda-knowledge-vs-dagrunner-harness call itself at harvest time. This is how routing has actually worked in practice (every harvest to date), not a placeholder for a mechanism that was never built.
- **Why hook-driven:** prompt-driven + fail-soft + bare-`dagrun` = three layers of "maybe" over an unowned PATH (the prior mechanism failed silently — see DECISIONS.md §hook-driven-reflection-capture). The SessionEnd hook is code we own, on a signal that already fires.

The old `reflect` + `apply-reflection` nodes are removed. `pr` is terminal; the former `digest`
node, once terminal-adjacent in parallel with `pr`, is itself removed — see §3f.

---

## 9. Cost & model tiering

Per-node tiering in the validated workflow-def (load-time model-string validation). implement sonnet (effort medium); review opus (diff-triage haiku); reviewers mixed (correctness/distributed-systems/performance unpinned; test-adequacy/api-stability/migration-safety sonnet); adversarial verifier strong tier; fix sonnet; verify sonnet; pr haiku. Budget: per-node `maxBudget` is passed to the SDK per session (`maxBudgetUsd`); the run-level `--max-budget-usd` CLI flag is parsed but NOT enforced anywhere today (nothing compares node costs against it). Cost capture: SDK `total_cost_usd` (cumulative per session — see below); `dagrun status` shows the per-node and total cost.

**Cost semantics (what `cost` means — and why it is not a running sum).** The SDK's `result.total_cost_usd` (and `modelUsage`) is CUMULATIVE for a session; a gate reject/amend resumes the SAME `sessionId` (`options.resume`), so each round reports a bigger total than the last (real run `51496-1`, `fix`: 3.82 → 6.49 → 12.14 → 13.23). `NodeState.cost` is therefore the sum, over DISTINCT sessions that executed the node, of each session's LATEST cumulative figure — `accrueSessionCost` (`core/state.ts`): an execution that resumed its own session (`result.sessionId === ctx.sessionId`) REPLACES that session's contribution, anything else (fresh start, `dagrun rerun`, an amend reset that dropped `sessionId`) ADDS. The only extra state is `NodeState.priorSessionsCost` (what the OTHER sessions contributed), so no history is replayed. `attempts[].cost` is the delta each attempt added, so `sum(attempts) == node.cost`. Every writer goes through this one function (`runDag` done + gate paths, `rerunNode`); consumers (`dagrun status`, report, `status --json`, the UI snapshot/discover totals, `node.finished` events) only ever sum `node.cost` across nodes. `friction.jsonl` `costUsd` is deliberately left as the raw per-session cumulative truth — never sum its entries; take the latest per `sessionId`. Legacy `state.json` (no `priorSessionsCost`) is not rewritten; on a resume it is treated as a single session (base 0), which corrects the inflated figure on the next round. Executions that end `failed` do not accrue (their spend is only in `friction.jsonl`). The run-level `--max-budget-usd` flag is parsed but not enforced anywhere (nothing reads node costs against it); per-node `maxBudget` is handed to the SDK per session.

**Node plugin policy (Java LSPs denied).** `buildSeededSettings` mirrors the Claude profile's `enabledPlugins` into every node's `.claude/settings.json` (needed because `settingSources: ["project"]` skips global settings), with one narrow exception: the exported `DENIED_NODE_PLUGINS` (`jdtls@claude-code-lsps`, `jdtls-lsp@claude-plugins-official`) are written explicitly as `false` when present, so the intent is visible in the seeded file. Why: with jdtls on, Eclipse JDT imported the worktree (`.classpath/.project/.settings` in ~126 module dirs) and compiled with ECJ into `target/classes`; a later `./mvnw install` packaged classes containing `Unresolved compilation problem` into installed jars, and the fix node failed with a misleading export timeout (run `51496-1`). Everything else (`vtsls`, `eng-kit`, ...) still mirrors. Because `resumeRun` does not re-seed settings, it applies the same denylist to an existing worktree's seeded settings (`denyPluginsInSeededSettings`: only denied `enabledPlugins` keys that are `true`, one log line). Code-nav LSP for nodes remains a deliberate future opportunity — see DECISIONS.md § review-51496-1-fixes `java-lsp-denylist`.

**Node prompt = command + run-environment block (v0.1.71).** `buildNodePrompt` (`sdk-runner.ts`) appends a fixed `<run-environment>` block to EVERY node prompt — first invocation (`/<cmd> <block>`, single space so the slash-command name still parses; the block arrives as the command's arguments) and the gate-resume prompt (`<reviewer-feedback>` first, then the revision instruction, then the block). It carries the LITERAL absolute `artifactsDir` (write here, Write tool or heredoc), read-only `runDir`, and `worktree` — paths only, never env values or secrets. Why: the engine knows these paths, yet the command prompts used to tell nodes they could not obtain a literal path and must never use the Write tool; run `51496-1` logged 46 `permission_denied` events across five nodes (mostly `simple_expansion` / `process_substitution` from probing `$DAGRUN_*`), the reproduce node had to discover the dir itself, and the pr node wrote its deliverables into the worktree (which fed the silent pr failure fixed in v0.1.69). The `$DAGRUN_*` env vars remain exported (env-propagation rule unchanged; hooks still need them), but the node command docs no longer use them in Bash snippets: transcripts of `51496-1` show the sandbox denying ordinary `cat "$DAGRUN_RUN_DIR/..."`, `mkdir -p "$DAGRUN_ARTIFACTS"` and heredoc writes ("Contains simple_expansion", 21 of the 46 denials), so the docs use `<artifactsDir>` / `<runDir>` / `<worktree>` / `<runId>` placeholders the node fills from the block, and each command interpolates `$ARGUMENTS` so the block lands in the prompt deterministically (Claude Code substitutes the placeholder; without it, it only appends trailing text). The prompts no longer claim the Write tool is unusable. Remaining expansions in the docs: `$DEVHARNESS_SRC` (verify) and the pr node's `DAGRUN_PR_TITLE_PREFIX` read (with a plan-derived fallback). Not changed: the one-shot-session rule. Sibling commands (`payload/siblings/commands`: pr-triage, ci-babysit, ...) are user-invoked, not engine nodes, and get no block.

**Declared deliverables + the pre-PR advisory (v0.1.72).** `pr` stages only paths in `implement/deliverables.txt` ∪ `fix/deliverables.txt` (§ worktree hygiene; never `git add -A`). `fix.md` now carries the same contract `implement.md` has — write/extend `fix/deliverables.txt` with every path added or changed (running union across gate rounds) and verify it against `git` before finishing — because an undeclared fix-added test file was silently left out of the first commit in run `51496-1` and cost an extra gate round. Mechanical backstop (`core/deliverables.ts`, wired into `buildGateBrief` for the `pr` gate only): the brief gains `validation` entries `pr/deliverables-unlisted` (changed paths not in the union — each named) and `pr/deliverables-unchanged` (manifest paths with no change), or one `pr/deliverables-manifest` ok entry. "Changed" is what `changes.diff` shows (diff vs the merge-base of the base branch + untracked non-ignored files; `target/` and `node_modules` excluded; skip-worktree `.tool-versions` is already invisible to `git diff <tree>`). It is an ADVISORY by design: validation entries never block a decision and are not in the revision hash, because unrelated pre-existing dirt can be legitimate. No manifests at all (legacy/mocked runs) → no entries; an uncomputable comparison (no base ref) is a visible failed entry, never a silent pass.

**Effort tuning (orthogonal to model tier):** `Node.effort?: EffortLevel` (`"low" | "medium" | "high" | "xhigh" | "max"`, `src/core/types.ts`) passes through to the SDK's `Options.effort`, validated at load time exactly like `model` (`workflow.ts`, same "typed at load" pattern — a bad value is a load error, never a silent runtime default). Omitted = the SDK's own model-specific default (on Sonnet 5 this is `"high"` with adaptive thinking on, per the SDK's `sdk.d.ts`). `implement` and `fix` in both `feature-workflow.ts` and `bugfix-workflow.ts` pin `effort: "medium"` — real burn-instrumentation evidence (run `54177-1`) showed these two `claude-sonnet-5` nodes as the run's dominant cost (`implement` $38.37, `fix` $5.82), and neither had ever deliberately set `thinking`/`effort`; per Sonnet 5's own migration documentation, `"medium"` is comparable in intelligence to the prior generation's `"high"`, making it a documented, low-risk step down rather than a guess. `review`/`pr` (and the since-removed `verify`/`define`/`reproduce`) were deliberately excluded from this first cut — see DECISIONS.md § effort-tuning-implement-fix for the full rationale and why full `thinking: disabled` was rejected. The per-node option mapping (model/allowedTools/maxBudget/outputSchema/effort) lives in the pure, unit-tested `applyNodeOptions` (`sdk-runner.ts`), extracted alongside `buildBaseQueryOptions` so it's testable without mocking the SDK's `query()`.

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

## 10. Phase 3 siblings — interactive Claude Code commands

All of these (pr-triage no longer, §10.3): Claude Code commands in the **Camunda monorepo's private `.claude/`** (alongside `/pr-review`, gitignored via `.git/info/exclude`), **copied into each worktree by dagrunner's seed/sync** and RUN inside the worktree (where the built code, PR branch, and cluster live). Edit the canonical copy in DEVHARNESS_SRC; the worktree copy is ephemeral. Interactive, human-driven — they need Docker, host ports, `gh`, broad network, none of which the autonomous DAG's fire-and-forget nodes are a good fit for; that's why they're commands, not nodes. Run under CLAUDE_CONFIG_DIR=~/.claude-work. Built one at a time, in order.

> DROPPED: the dedicated "/verify-demo environment creator" (DMS-based cluster + breakpoint placement). The **c8ctl dev plugin** spins up a configured local OC smoothly, making a separate cluster-creator command unnecessary. The **Debugger MCP Server (DMS)** is parked for a FUTURE bug-fix / issue-investigation workflow (where programmatic breakpoints aid an investigating agent) — it has no role in the feature-task workflow. **Since the verify-autonomy change (§3d), the pipeline's `verify` node no longer emits `seeding-spec.json`/`manual-test.md` at all** — that generation moved to the on-demand `/manual-smoke` sibling (§10.4). The code-trail the old `tour-spec.json` carried is folded into `manual-test.md`, and no automated breakpoint-placer consumes it.

### 10.1 seed-data (Sibling 1)

- Assumes the human has ALREADY spun up a local Orchestration Cluster via the **c8ctl dev plugin** (smooth, human-driven — this command does NOT create or tear down the cluster).
- Consumes `seeding-spec.json` — **this comes from `/manual-smoke` (§10.4), invoked on demand — no pipeline node writes it (the `verify` node that once did is gone, §3d)**. Seeds the running cluster via **c8ctl**: resolve abstract deployments to concrete BPMN (the spec gives descriptions, not files), deploy `deployments[]`, start `instances[]` with their variables, capture instance keys, and confirm `expected_observations[]` are reachable (ES doc present; REST call recorded but not asserted — the human observes the value).
- If no OC is reachable, fail loud telling the human to start one first.
- Named generically (`/seed-data`, not demo-specific) so it is reusable for manual testing, reproduction, and investigation — not only feature demos.

### 10.2 ci-babysit (Sibling 2)

Local: monitors CI on the open PR, rebases on base, fixes failing checks (scoped to making CI green — never a backdoor for feature changes), and re-verifies before pushing. Needs the local cluster (human-started via the c8ctl dev plugin) for runtime re-verification + private context (why it's local, not gh-aw). Uses `gh` and `git push` directly; rebase pushes use `--force-with-lease`, never blind `--force`.

**Human gate (never auto):** the **draft -> ready flip** is ci-babysit's defining gate — when CI is green and re-verification passes, it surfaces the readiness summary and the `gh pr ready` command but NEVER flips the PR itself. Readiness is not latched: new commits/failures reopen the work and re-present the gate.

**Poll/trigger machinery (built here, reused by pr-triage):** ci-babysit owns the Claude Code Desktop scheduled-task / poll loop and the crev-style `--since <prior-run-id>` incremental pattern (act only on new commits/failures since the last tick; checkpoint-and-exit per tick, state on disk). pr-triage (§10.3) imported this loop rather than building a second one, until it left dagrunner (v0.1.87).

Operates over the PR lifetime — in a dagrunner-managed worktree (`DAGRUN_RUN_ID` set) it must
persist (don't `cleanup` until the PR is closed; for an adopted worktree that is workmux's `wm rm`). Neither sibling requires a dagrunner worktree,
though: Phase 0 gates only on PR discoverability (`gh pr list`/`gh pr view` for the current
branch), not on branch naming or worktree origin — both run from any git checkout, on any branch,
as long as a PR exists for it. `RUN_ID` falls back to the sanitized current branch name
(`/` → `-`) when `DAGRUN_RUN_ID` is unset, so sequential runs on different branches out of the
same checkout don't collide on one state directory.

**Write lock (v0.1.88).** ci-babysit takes the per-worktree write lock before it rebases, fixes or pushes (`~/.claude/skills/_shared/git-lock.sh`, a directory in the worktree's git dir, shared with pr-triage), renews it at phase boundaries, and releases it in phase 6 and on every stop. A tick that is a no-op never takes it. Its lessons go to its own workspace, `~/.local/share/camunda/ci-babysit/lessons.md`, not into the reflection log.

### 10.3 pr-triage — left dagrunner in v0.1.87

pr-triage is no longer a dagrunner sibling: dagrunner does not seed it into worktrees any more
(`payload/siblings/commands/pr-triage.md` and `scripts/pr-triage/` are gone). It is a user-level skill,
`~/.claude/skills/pr-triage/` (symlinked into `~/.copilot/skills/`), usable from any agent, and started from the
PR's own worktree window by the launcher (`launcher.py triage`, tmux prefix + N). Its behaviour is documented in
that skill's `SKILL.md`; the reasons for the move are in `DECISIONS.md § sibling-pr-triage-leaves-dagrunner`.

What dagrunner still owes it: nothing, except that a branch triaged during a dagrunner run keeps its state under
`runs/<run-id>/pr-triage/`, and the skill continues from it (it finds the run by branch).

### 10.4 manual-smoke (Sibling 4 — originally relocated out of the old verify node, §3d)

`payload/siblings/commands/manual-smoke.md`. Generates a human-readable `manual-test.md` — plus
`seeding-spec.json`, only when a live cluster is actually needed — for a completed (or
gate-paused) run, replacing the fixed `seeding-spec.json` + `manual-test.md` pair the pipeline's
`verify` node used to write — relocated here rather than deleted, since the manual-walkthrough
value didn't disappear, only the reason to gate on it did (`DECISIONS.md §
verify-autonomy-remove-election`; the verify node itself was later removed entirely, §3d).

- **Invocation:** `/manual-smoke [run-id]`, run on demand against any completed (or gate-paused)
  run's existing artifacts — bootstrap logic (run/worktree/plan resolution) lives in
  `payload/siblings/scripts/manual-smoke/phase-0-bootstrap.sh`.
- **Read-only from the worktree, and never executes anything against a live cluster or locally** —
  never modifies worktree files, never runs Maven/Docker/`curl`/`zdb`/cluster commands itself, only
  writes into the run's own `manual-smoke/` artifact subdirectory (so it can be invoked repeatedly,
  including against a failed run, without disturbing pipeline state).
- **Gates nothing.** This sibling has no pipeline effect —
  it exists purely for a human who wants a walkthrough of a run.
- Reads the same input priority order the old verify-guide used: run artifacts (`plan/plan.md` — the plan
  is the guide since v0.1.82, `implement/summary.md`/`red-evidence.md`, `review` outputs) → git log → git diff →
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
| **3**  | Three interactive siblings, in order: (1) /seed-data [c8ctl, assumes human-started OC], (2) ci-babysit, (3) pr-triage (moved out in v0.1.87, §10.3). All local, human-driven.                                                                                                                                                                               | ✅ DONE            | —           |
| **5**  | Bug fix workflow (`dagrun start bugfix`). New `reproduce` node (Gate 1: confirms bug is real, validates root cause — removed in v0.1.82, `implement` proves RED now, §3e); shorter pipeline — no verify node (regression test runs in implement/fix). `base_branch` from plan YAML frontmatter (hotfix branch support). Severity-aware night-mode (critical/blocker always pauses). | ✅ DONE            | —           |
| **6**  | Live `dagrun ui` (Node-http + SSE + vanilla HTML, localhost-only, scrubbed)                                                                                                                                                                                                                                                   | shipped (§3g)      | —           |

Note: the phase rows above are history. Since v0.1.82 the pipeline is implement -> review -> fix (gate) -> pr (gate) in both workflows (§3); `expand`/`define`/`reproduce` and `verify` no longer exist.

Key insight: Phases 1, 2, 3, and 5 are complete. Phase 6 remains future work.

Open items: confirm Agent SDK credit pool covers volume; some preflight checks (network allowlist, additionalDirectories) + content-addressed cache may be partial in code. CLI/SDK versions now pinned (see §7 toolchain pin — CLI 2.1.181, SDK 0.3.170); the `-p` intermittent regression remains upstream/out-of-scope.

---

## 12. Operating reminders

- Every real-work `dagrun` runs with CLAUDE_CONFIG_DIR=~/.claude-work (alias `dagrun-work`); spawned sessions inherit config from the dagrun process. ANTHROPIC_API_KEY unset (subscription auth).
- Siblings: canonical in Camunda private `.claude/`, edit in DEVHARNESS_SRC. ci-babysit (pr-triage until v0.1.87)
  run from any git checkout on any branch with a discoverable PR — not restricted to a
  dagrunner-managed worktree. When `DAGRUN_RUN_ID` IS set (dagrunner-managed worktree), persist
  the worktree until the PR is done (adopted worktrees are removed by their owner, not dagrunner).
- `gh`/network mutations in the pipeline (the `pr` node) run via Node.js outside the agent's own session, not via an in-session `gh` call (see §6).
- Unattended pipeline runs: never auto-approve a gate **unless `--night` is active and no concern is flagged** (see §3 night-mode). The one-rule policy: agent-decidable gates (the fix gate and the pr gate) auto-approve when neither the gate's own artifact nor a done ancestor's (notably `implement/summary.md`) contains a "Concerns / plan challenges" heading. A clean night-mode run proceeds `fix` → `pr` fully unattended with no park anywhere (there is no verify election or hand-off step — §3d). Subagents never end a turn with a question.
- Schema is single-source-of-truth, owned by dagrunner, never duplicated.
- Each sibling plan front-loads a tool-introspection spike (c8ctl for /seed-data; the `gh` CI-status surface for ci-babysit; the `gh` review-comment surface for pr-triage) — verify the installed surface, don't assume from docs.
- ci-babysit and pr-triage share a worktree but have hard domain separation: ci-babysit owns git mutations (rebase, fix, commit, push); pr-triage (now the user-level skill, §10.3) owns the comment conversation; the one change it makes to the branch is an approved `needs-code-change` fix (edit, commit, push), taken under the worktree write lock.
- pr-triage bot detection: use `user.type == "Bot"` — do NOT rely on `[bot]` login suffix (Copilot inline has type=Bot but login="Copilot" with no suffix).
