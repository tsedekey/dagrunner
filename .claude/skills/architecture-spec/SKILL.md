---
name: architecture-spec
description: The complete locked design for dagrunner v1, chunked by theme (1-15 plus harness and UI decisions). Load only the slice a task block needs — engine-author reads Themes 3/6/10, hooks-author reads Theme 8, types-author reads Themes 3/9, test-author reads Theme 14. This is the single source of design truth; HANDOFF.md is the task plan.
---

# dagrunner v1 — Architecture Specification (locked)

This is the source of truth for WHAT to build and WHY. Each theme is independently addressable —
load only what your task block needs. All decisions below are LOCKED (agreed during the requirements
grill). Do not relitigate; if reality contradicts a decision, log it in DECISIONS.md and proceed with
the closest spec-aligned choice.

---

## Theme 0 — Foundations & decisions

- **Execution path:** Agent SDK (`@anthropic-ai/claude-agent-sdk`), not CLI shell-out. Hooks as typed
  callbacks, structured output, per-node/per-subagent model, worktree via `cwd`, session resume for gates.
- **Workflow format:** typed TS objects (not runtime YAML) — mistyped model / bad dependsOn / missing
  gate become load errors.
- **Scope of v1:** complete ENGINE, thin-slice CONTENT. Build the full DAG core; ship only
  `classify → expand-guide [review gate] → implement` as v1 workflow content. Remaining feature nodes
  are config additions on the proven engine.
- **One app, three workflow definitions, one binary** (`dagrun <workflow> …`). ci-babysit and
  review-triage are separate scheduled run-types — SPECCED here, BUILT in phase 2.
- SDK gotchas: since v0.1.0 the Claude Code system prompt is NOT loaded by default
  (`systemPrompt: { preset: "claude_code" }`); filesystem skills/hooks need `settingSources`.

## Theme 1 — Run lifecycle posture

- **State-persisted, checkpoint-and-exit at gates, one run at a time** (run-scoped paths from day one
  so multi-run later is a flag flip). True concurrency blocked by fixed verify-cluster ports — deferred.
- **Resumability is mandatory** (gates pause for hours/days): persist `state.json` from day one.
- **Pause model:** runner executes until a gate, writes state + the awaiting artifact, EXITS with a
  `resume with: dagrun resume <run-id>` message. No long-lived blocking process. Checkpoint only at
  gate boundaries; a single node's SDK call is one live process start-to-finish.
- **Unattended-to-first-gate falls out for free:** auto-run ready non-gate nodes, stop at first gate.

## Theme 2 — Run lifecycle details

- **run-id = `<issue>-<slug>`** (e.g. `4521-job-priority`), mirrors branch `feature/<issue>-<slug>`;
  re-run appends counter. Run dir = `~/.local/share/dagrunner/runs/<run-id>/`.
- **state.json shape:** top-level `runId, workflow, createdAt, updatedAt, status
(running|paused|done|failed), worktreePath, branch, sourcePlanPath`; per-node `status
(pending|running|done|skipped|failed|awaiting-gate), startedAt, endedAt, artifacts[], model,
iteration, sessionId, cost`, and for gates a `gateHistory[]` (decision + typed comment + timestamp).
- **CLI:** `start <workflow> --plan <file>|--issue <n>`, `resume <run-id>` (PRIMARY re-entry; prints
  awaiting artifact then prompts inline), `status [<run-id>]`, `list`, `abort <run-id>`,
  `cleanup <run-id>`, `report <run-id>`. Gate ergonomics: one ergonomic door on `resume` PLUS
  `--approve` / `--reject "comment"` flags for scheduled/non-interactive use.
- **Rejection feedback:** writes `<node>/feedback-<n>.md`; node reads prior output + feedback artifact
  and revises; gateHistory is the durable record.
- **Concurrency guard:** global `active.lock` with active run-id; `start` refuses if active (`--force`);
  same-run `resume` always allowed.

## Theme 3 — Typed workflow schema + reuse map

`Node` fields: `id; dependsOn?; when?(ctx)→bool; command (slash cmd/skill ref); model?('haiku'|'sonnet',
omit=unpinned); allowedTools?; outputSchema?; produces?/producesJson?; gate?; loop?; optional?;
joinRule?; maxRetries?; maxBudget?; hooks?{stop?}`.

- `GateConfig: { maxIterations? (~10); onReject?: 'revise-self'|'rerun:<id>' (default revise-self) }`.
- `LoopConfig: { maxIterations; until (shell gate); onExhausted?: 'fail'|'gate'|'continue' (default 'gate') }`.
- `Ctx` = artifact-only accessors: `ctx.json(node)`, `ctx.read(node,file)`, `ctx.dir(node)`. No in-memory upstream returns.
- **`when` = TS predicate; loop-exit/validation gates = shell command strings** (exit 0 = pass).
- Prompts are **native slash commands / skills** in the repo `.claude/`, referenced by `command`.
- Validate model strings + dependsOn + node ids + cycles at LOAD; fail loud.

**Reuse map (build vs reuse):** BUILD = DAG deps/topo, conditional skip, gate-surviving-process-exit,
worktree+artifacts (orchestrate git). REUSE = node execution (SDK `query()`), parallel reviewers
(subagents for intra-node fan-out), in-node convergence (deterministic Stop hook), per-node model,
structured output, format/friction/sync hooks, within-node revise (session resume), node prompts
(slash commands), read-only discipline (permission mode), scheduling (Desktop scheduled tasks, phase 2).

## Theme 4 — Node contract & artifacts

- Two filesystems: CODE in the worktree (node `cwd`); cross-node CHANNEL in run dir
  `runs/<run-id>/<node>/`, passed as absolute path via `DAGRUN_ARTIFACTS` (recomputed per node).
  Inbox plan copied into `runs/<run-id>/plan/` at start.
- Who writes: structured outputs (classify) captured by the runner from SDK `structured_output` →
  written deterministically. Free-form artifacts written by the node via Write tool to `$DAGRUN_ARTIFACTS`.
- **`produces` contract:** runner verifies declared files exist post-run → present=done, missing=failed.
- Naming: `<node>/<name>.md|json`; rejection feedback `<node>/feedback-<n>.md`; synthesized
  `synthesize/findings.json`.
- Revision: overwrite the primary artifact (downstream reads latest); preserve feedback-1/2/3 + gateHistory.

## Theme 5 — Conversation-led gates

- **Re-entry reuses the SAME Claude session** (`resume`/`forkSession`); your comment is the next user
  turn → node revises WITH memory of why it wrote the artifact. Persist per-node `sessionId` in state.json.
- **Two verbs only:** approve / reject(+comment). The NODE decides whether a comment is a question or a
  revision request; both re-pause. No separate "question" verb.
- **resume UX:** prints awaiting node, iteration n/max, artifact path, ~40-line preview, then inline
  `[a]pprove · [r]eject (opens $EDITOR) · [s]how full · [q]uit`. Non-interactive: `--approve`/`--reject`.
- **Bounded iterations = bounded auto-revisions, never auto-cancel.** At maxIterations (default ~10),
  pause with terminal choice (approve-as-is / abort / `--force` one more). Bound spend, not authority.
- Scheduled/unattended runs NEVER auto-approve a gate — checkpoint, exit, notify.
- Single-awaiting-gate invariant (checkpoint-and-exit at first gate) → `resume` unambiguous.

## Theme 6 — Loops, parallelism, joins

- **Reviewers = N runner-parallel DAG nodes**, not a subagent fan-out (their conditional gating /
  per-reviewer artifacts / model-tiering / retry ARE the runner primitives). Subagents stay for
  intra-node fan-out only.
- **`synthesize-and-fix` = one node** with `dependsOn: [all reviewers]`: read findings → dedup →
  ground citations against the diff → **skeptical verifier as a SUBAGENT (isolated context)** → fix
  high-confidence Blocker/Major → **in-session Stop-hook loop** until findings script exits clean or
  turn cap → `onExhausted: gate`. No runner re-spawn loop. `freshContext` is dropped as a concept.
- **Failure policy:** join default `none-failed-min-one-success`; `correctness` strict
  (`optional:false`), the other five `optional:true` (a flaky reviewer degrades to skipped; synthesize
  proceeds noting the gap).
- **`maxParallel` default 6** (covers full reviewer set); bounds concurrent SDK sessions.

## Theme 7 — Worktree lifecycle

- Create at start: `git worktree add <home>/worktrees/<run-id> -b feature/<issue>-<slug>` off default branch.
- **Private-file sync via SessionStart hook**, sourced from `DEVHARNESS_SRC` (the main checkout).
  `DEVHARNESS_SRC` + `DAGRUN_ARTIFACTS` must be exported by the LAUNCHER before spawn (hooks/children
  inherit only pre-spawn env). A prompt instruction won't reliably do this — must be the hook.
- **Teardown deferred to approval, never automatic** — separate `dagrun cleanup <run-id>` (worktree
  persists through gates, PR, and manual verification). Artifacts survive teardown regardless.
- Verify cluster binds to the worktree build with fixed ports (why one-run-at-a-time holds); cleanup
  also tears down any running cluster.
- Crash/orphan recovery: `list` reconciles state.json vs `git worktree list`; `--prune` removes
  orphaned worktrees of done/aborted runs.

## Theme 8 — Hooks

Full set: SessionStart (global, private-file sync), PostToolUse Edit/Write (global, format),
Stop convergence (per-node, run verifier, block until exit 0 / turn cap), Stop schema (classify,
validate structured output), Stop friction (global, append friction.jsonl), SessionEnd (global,
capture sessionId+cost). Global declared once at workflow level; per-node declared on the node and
merged at spawn. Wired as typed `options.hooks` callbacks that shell out to committed `.claude/hooks/`
scripts (logic iterable, wiring typed). Failure policy: SessionStart fail → node doesn't start (hard);
PostToolUse fail → warn+continue; Stop verifier crash → FAIL node (broken verifier ≠ success). Friction
entry: `{ ts, node, sessionId, event, detail }`.

## Theme 9 — Model tiering & cost

Tiers: `haiku` (mechanical), `sonnet` (default reasoning), omit (unpinned → opusplan reaches Opus).
Assignments: classify=haiku; expand-guide=unpinned; reviewers test-adequacy/api-stability/migration-
safety=sonnet, correctness/distributed-systems/performance=unpinned; synthesize-and-fix=unpinned;
verify-seed=haiku; pr=haiku; reflect=sonnet; apply-reflection=sonnet. Validate model strings at load.
Budget: per-run `--max-budget-usd` (hard ceiling, works on subscription auth) PLUS optional per-node
`maxBudget` for unpinned/Opus-eligible nodes. On run-cap hit → checkpoint-and-exit, resume at higher
cap. SessionEnd writes per-node cost into state.json; status shows total vs cap; reflect flags
disproportionate cost. `--model-override <node>=<model>` for one-off experiments; def is the default.

## Theme 10 — Error handling & observability

Four failure classes: (1) **infra/transient** (529/timeout/rate-limit/cluster) → auto-retry w/
backoff up to maxRetries (default 2) then fail; (2) **contract failure** (missing produces, malformed
classify.json, broken verifier) → fail immediately, no retry; (3) **convergence exhaustion** →
onExhausted:gate, never auto-fail; (4) **budget exceeded** → checkpoint-and-exit, resume-at-higher-cap.
Node failure ≠ run failure: failed node marked, completed nodes stay done w/ artifacts; run halts,
exits with resume cmd; resume recomputes ready set, re-runs failed + downstream. Optional-reviewer
degradation is VISIBLE (`degraded:true` + reason; synthesize told which reviewers are missing).
`dagrun status` = node table (node·status·model·iterations·cost·artifacts·last-error) + run total/cap +
worktree + awaiting-gate marker; `logs <run-id> <node>` dumps friction slice + transcript pointer.
Crash recovery: on start/resume, reconcile state.json vs `git worktree list` + lockfile; `running` →
`failed` (never trust partial), release stale lock. Logging: terse console default + `runs/<run-id>/run.log`.

## Theme 11 — The feature pipeline (full topology)

Nodes (each reviewer is a real node): 1 classify(haiku)→ 2 expand-guide(unpinned, **review gate**,
revise-self, produces guide.md)→ 3 implement(unpinned, worktree diff + summary.md)→ reviewers
4 correctness(unpinned, always, optional:false) 5 test-adequacy(sonnet, always, optional:false)
6 api-stability(sonnet, when touches_public_api, optional) 7 distributed-systems(unpinned, when
touches_runtime, optional) 8 performance(unpinned, when perf_sensitive, optional) 9 migration-safety
(sonnet, when touches_schema_or_proto, optional)→ 10 synthesize-and-fix(unpinned, Stop-hook
convergence)→ 11 verify-seed(haiku, when needs_runtime, **verify gate** rerun:verify-seed)→ 12 pr
(haiku, body+PR URL)→ 13 reflect(sonnet, **reflect gate**, revise-self)→ 14 apply-reflection(sonnet,
edits worktree .claude/** only). Three gates, sequential, never concurrent. classify.json flags
`{touches_public_api, touches_runtime, perf_sensitive, touches_schema_or_proto, needs_runtime: bool;
risk: low|med|high}` drive all conditional reviewers + verify-seed.
**v1 cut line = nodes 1→2→3 + the review gate.\*\* Nodes 4-14 are phase-2 config additions.
apply-reflection targets worktree-private gitignored files only — never a Camunda PR.

## Theme 12 — Self-improving loop

`reflect` consumes friction.jsonl FIRST (gate rejects, loop-iteration counts, tool errors, per-node
cost), cross-refs artifacts to ground each observation — never reconstructed memory. Proposals are
TYPED: `{ target (exact .claude/** file), change-type (prompt-edit|add-skill|tune-when|model-retier),
rationale (which friction signal), diff (concrete before/after) }` — no proposal without target+diff.
Reflect gate shows proposals as a reviewable changeset, approve/reject PER PROPOSAL. apply-reflection
guardrails: (1) allowlist `.claude/commands|skills|agents/**` + nested CLAUDE.local.md only — anything
else refused; (2) worktree-private only, synced via DEVHARNESS_SRC, never a PR; (3) apply ONLY the
exact approved diffs (mechanical applier, no re-reasoning); (4) snapshot `.claude/**` to
`runs/<run-id>/reflect/backup/` before edit → `dagrun revert-reflection <run-id>`. Reflect runs AFTER
pr (never blocks shipping), is skippable (run still completes done). v1 = per-run reflection only;
cross-run `store/` learning deferred to phase 2 with `--since`.

## Theme 13 — Config, secrets & launcher

Config in three layers: engine/workflow (typed TS, in app, compile-validated); machine
(`~/.local/share/dagrunner/config.json` — `DEVHARNESS_SRC`, default max-budget, maxParallel, worktree
root; no secrets); secrets (env/keychain only, never in run tree, never logged). Launcher order BEFORE
spawn: resolve DAGRUNNER_HOME (fail loud) → load machine config, assert DEVHARNESS_SRC exists+is-git
(fail loud) → resolve secrets (assert auth) → compute per-node DAGRUN_ARTIFACTS + DAGRUN_RUN_ID +
DAGRUN_WORKTREE → EXPORT all into process env → spawn SDK query() with `settingSources:["project"]`.
Binary: npm `bin` symlinked to `~/.local/bin/dagrun`; thin shell wrapper may pre-resolve keychain
creds. config.json resolution: `--config` › DAGRUNNER_HOME/config.json › XDG default; no cwd fallback;
DEVHARNESS_SRC mandatory-explicit, operational knobs have safe defaults. `dagrun init` creates XDG
tree + config template (idempotent). Secrets scrubbed from run.log / friction / state; status/logs
never echo them.

## Theme 14 — Acceptance & testing

Three tiers: (1) **deterministic unit** (no Claude) via a **mock node executor** — topo/readiness/
when-skip/join/optional-degradation/model-validation/state-IO/reconcile; runs in seconds. (2)
**integration** (real SDK, trivial nodes) on a throwaway toy repo — env-propagation, SessionStart
sync, format, artifact passing, structured-output capture, checkpoint-and-exit + resume-same-session.
(3) **human acceptance** — gate UX, revise quality, manual verify. The **mock executor is a
first-class v1 artifact** (a `--dry-run`/mock mode emitting canned artifacts + chosen exit status;
can simulate reviewer-fail/gate-reject/loop-exhaust/missing-produces) — it is what makes engine
correctness PROVABLE and is the permanent fast feedback loop. **v1-done gate = the 6-step smoke test**
(init → start→awaiting-gate → status → reject→revise-same-session → approve→implement→done → kill→
reconcile→resume). NOT tested in v1: model output QUALITY (human judgment), load/concurrency,
live 6-way reviewer run. Mirror crev's ajv-style schema tests. Deliver acceptance as a RUNNABLE script

- captured transcript, not prose.

## Theme 15 — Handover format & decomposition

Handoff is a repo scaffold (this package), not a prose brief: CLAUDE.md + theme-chunked spec skill +
6 tool-restricted subagents + HANDOFF.md (task plan only). Spec chunked by theme so a worker pulls
only its slice. Task blocks map 1:1 onto subagents, sequenced by dependency; **test-author before
engine-author** (test-first). Each block ends with a deterministic acceptance gate; fresh-model verify
on DAG core + launcher. Coordinator loop: load slice → dispatch → verify gate → commit → next; the
coordinator NEVER writes implementation code. HANDOFF.md opens with the v1-done gate (target-first).

## Harness & autonomy decisions (Phase 0)

Build harness: Sonnet coordinator (Opus advisory) delegating to 6 tool-restricted subagents (two
researchers kept separate); short CLAUDE.md; 3 skills (spec/testing/crev-patterns); build-time hooks
(format + secret deny-guard); one MCP (Context7); TS LSP on. Avoid Agent Teams (token-heavy),
semantic search, plugin packaging, extra MCP. Unattended posture: `permissionMode: "bypassPermissions"`

- `settingSources: ["project"]`, guarded by fail-closed PreToolUse deny hook + `disallowedTools`;
  settings.json written in Phase 0 pre-sleep (writing it mid-run would prompt+hang); per-block git
  commits; continue-on-ambiguity (log to DECISIONS.md, never wait); **isolate-and-continue** on failure
  (retry once → mark blocked → commit safe → next independent block); run-level budget cap; morning
  BUILD-REPORT.md. Scoped working dir + deny hook = blast-radius control (no Docker).

## UI decision

v1: zero-dep static `dagrun report <run-id>` (HTML snapshot from state.json, no server). Phase 2:
live `dagrun ui` (Node-http + SSE + vanilla HTML, localhost-only, scrubbed files). Reject
React/Vite/Tailwind/build-step.
