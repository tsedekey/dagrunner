# Proposed addition to `bug-fix-companion` — DagRunner companion gates

**Status: proposal, not applied.** Written in the dagrunner repo (v0.1.51) for Eddie to review. The
installed skill (`~/.claude/skills/bug-fix-companion/`) has NOT been modified. Suggested placement: replace
the "verify runner compatibility / do not invent flags" hedging in `references/handoffs.md` (lane D) and
`references/execution-gates.md`, or add this as a new `references/dagrunner-gates.md` linked from both.

The commands below exist in dagrunner v0.1.51 and are exercised by `test/smoke/smoke-gates.ts` (mock
executor). Real `claude --resume` re-entry and the runtime tools (docker / C8 Run / c8ctl) are NOT yet
demonstrated — keep them labelled unverified until they are.

---

## Handoff (lane D)

Start the run so its gates return to THIS conversation:

```
dagrun start bugfix --plan <approved fix-plan file> --companion-session "$CLAUDE_CODE_SESSION_ID"
```

- `$CLAUDE_CODE_SESSION_ID` is this conversation's own id. Do not paste another session's id.
- `--no-companion` opts into the old fresh-session gates; use it only if Eddie asks.
- Launching remains a separately authorized action (approval of the plan document is not launch approval).
- Run it in the background; the run stops by itself at the first gate. Report the run id, the gate it
  paused at, and that nothing has advanced past it.

## At a gate

(If this conversation was just resumed by `dagrun gate open`, its opening message already says which run is paused — start here.)

1. Confirm the run and gate: `dagrun gate show <run-id>` prints a JSON brief — run, gate, `revision`,
   gate artifacts and upstream artifact hashes, mechanical validation results, `pendingDecision`
   (allowed actions, amend targets, what approving continues to, and whether approving also decides
   `verify`), and `companion.status`.
2. If `companion.status` is `blocked`, stop and explain why and the recovery choices (below). Do not
   decide anything.
3. Read the actual artifacts (paths are in the brief) and the fix/review/verify evidence. Do not rely on
   node names or on a phase having "succeeded".
4. Explain one meaningful finding at a time, with code-level examples and focused HTML where useful, as
   in the existing loop. Wait for Eddie's understanding before the next increment.
5. "I understand", "continue explaining", "looks good", or opening the gate view is NOT a decision.

## Deciding — always propose, then wait, then confirm

1. When Eddie's direction is clear, run `decide` WITHOUT `--confirm`. It changes nothing and prints the
   exact statement and a decision id:
   ```
   dagrun gate decide <run-id> --gate <gate> --revision <revision-from-show> --action approve|amend|hold [...]
   ```
   - `approve` — continue. At the `fix` gate add `--run-next yes|no` (see below).
   - `amend --target <node> --comment "<specific feedback>"` — revise the gate node (or, at the pre-PR gate,
     `--target fix`) with the feedback; downstream results are invalidated and re-run.
   - `hold --comment "<reason / evidence wanted>"` — record it, stay paused.
2. Show Eddie the printed statement verbatim (action, scope, what runs next, what is NOT authorized:
   merge, reviewer requests, marking ready, backport labels). Ask for an explicit go-ahead that names it.
3. Only after that, re-run the identical command with `--confirm <decision-id>`. A repeated confirm is
   a harmless no-op. If it reports `stale-revision`, the evidence changed: re-run `show`, re-explain,
   re-propose — old understanding and old approval do not carry over.
4. Never call `decide --confirm` in the same step as the proposal, and never on ambiguous wording.
   `--confirm` runs the next phase(s) in the foreground until the next pause: run it in the background
   and report the new pause.
5. Persist in the case checkpoint: gate, revision, the exact decision and scope, decision id, and the
   resume point the run printed. Reference the run's own artifacts rather than copying them.

## The three gates (bugfix)

- **`reproduce`** — reproduction guide. Review: is the bug real, is the root cause the agreed one, does the
  change surface / regression test match the plan? Amend = re-run reproduce with feedback.
- **`fix`** — the diff after review. Review: exact diff, tests actually run, before/after regression
  evidence, review findings and their handling, deviations from the plan. This gate ALSO decides whether
  the optional runtime demonstration (`verify`) runs:
  - Read `fix/summary.md` § _Verify recommendation_ (the agent's advice) and give Eddie your own view.
  - Ask explicitly: run verify, or skip? Then `--run-next yes|no`. Eddie may add a `--comment` naming
    what he wants demonstrated; verify reads it as its focus.
  - `verify` is not a CI duplicate: it builds the candidate from the worktree, starts it on a local
    disposable target, produces `verify/demo.md` (manual steps) for Eddie, and leaves it running for
    his hands-on testing (torn down after his verdict at the `pr` gate).
- **`pr`** — pre-PR gate. Review the PR body, the diff, and (if it ran) `verify/verify-report.json` +
  `demo.md`. Approve = the branch is pushed and a DRAFT PR opens. Amend `--target fix` sends the code
  back; nothing has been published yet. Approval never implies merge, reviewers, ready-for-review, or
  backport labels.

## Verify evidence — how to read it

`verify` does not test the candidate and renders no verdict. It builds the candidate from this worktree,
starts it on a loopback disposable target, writes `demo.md` (what to hit, what to expect) and STOPS, leaving
the environment running. Outcomes: `PROVISIONED` (environment up and reachable; Eddie's manual testing is
pending) or `BLOCKED_RUNTIME` (no environment obtained; fails the run — explain why). A source-only
`PROVISIONED` (`capability: source`, with a `sourceRationale`) means there was no runtime surface and no
environment exists. The engine checks consistency (revision, dirty files, readiness probe, owned resources),
not truth: `PROVISIONED` says the environment is up, not that the change works.

The verdict is Eddie's. Point him at `demo.md` and the host:port in the gate brief's `verifyEnvironment`
block, let him test at his own pace, and take his verdict as the `pr` gate decision (approve / amend / hold).
Any of those tears the environment down as a side effect (proposal text says so); tell him before he
confirms. Never describe a skipped, blocked or still-pending verify as passed.

## Which command when (`resume` vs `gate …`)

They are ONE engine. `dagrun resume` (`resumeRun`) is the shared execution engine; `gate decide --confirm`
validates your decision and then calls that same engine. "Direct-decision flags" (`resume --approve/--reject`)
is just the old calling convention: no proposal step, no statement shown to Eddie first — so it is refused on
companion runs. Pick by run state:

| Run state                                                                                                            | Use                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Paused at a gate (a node is `awaiting-gate`)                                                                         | `gate show`, then `gate decide` (propose, wait, `--confirm`). `gate open` / bare `dagrun resume <run>` in a real terminal re-enters the companion conversation; from a non-terminal, bare `resume` only prints the pause and decides nothing. `gate attach` only while paused. |
| No gate pending (`gate show` says "not paused at a gate"; `gate open`/`attach`/`decide` error `not-awaiting`)        | `dagrun resume <run>` (no flags) is the only command that works: it reconciles crashed nodes and runs whatever is still `pending`.                                                                                                                                             |
| Top-level `failed` but the nodes are `done`, after a node was completed out-of-band with `dagrun rerun <run> <node>` | `dagrun resume <run>` (no flags). It makes no decision; it just continues from current state and recomputes the run status. `rerun` never updates the top-level status and never retries/unskips other nodes.                                                                  |
| Crashed (status `running`, node stuck `running`, no process)                                                         | `dagrun resume <run>` (no flags): stuck nodes are reset to `pending` (up to a retry cap) and re-run.                                                                                                                                                                           |

Teardown: only a `gate decide --confirm` at a gate downstream of `verify` tears down the provisioned verify
environment. If a gate was bypassed with `rerun`, or the run was resumed without a decision, clean up with
`dagrun verify cleanup <run>`; `dagrun rerun <run> verify` tears down a still-provisioned environment first.

## Running in the background (`--detach`)

`start` and `gate decide --confirm` normally run phases in the foreground until the next pause — minutes
in which you cannot answer Eddie. Add `--detach` to either (and to `resume`, where it continues execution):
dagrun spawns the same command as a detached child (output in `<run>/driver.log`), prints the run id, pid and
log path, and exits 0 at once. The child is the only process that drives the run and takes the run lock.

- Start: `dagrun start bugfix --plan <file> --companion-session "$CLAUDE_CODE_SESSION_ID" --detach`.
  `status` may say "no state.json yet" for a few seconds while the worktree is created — retry, or read `driver.log`.
- Confirm a decision: `dagrun gate decide … --confirm <id> --detach` (`--detach` without `--confirm` is refused;
  a proposal changes nothing and returns immediately anyway).
- Poll: `dagrun status <run> --json` (read-only). Read `status` — `running` | `awaiting-gate` | `done` |
  `failed` | `paused` | `aborted`; `currentNodes`; `awaitingGate {nodeId, revision, since, reason}`; per-node
  `attempts` (timing/cost per iteration); `lastEventAt`. `stale: true` means status `running` with no live
  process holding the run lock (the driver crashed): recover with `dagrun resume <run>` (add `--detach`).
  `driver.pid` is the live lock holder, if any. The timeline is `<run>/events.jsonl` (append-only, derived).
- A second driver on a run whose lock has a live holder is refused ("already being driven by pid N"). Do not
  work around it; poll instead.
- After ANY compaction or a resumed conversation, re-run `dagrun gate show <run>` before deciding: the
  revision in your memory may be stale, and `status --json` deliberately does not rewrite the brief.
- Legacy (non-companion) gates that need an interactive terminal refuse `--detach`.

## Recovery

- **Original conversation unavailable** (`companion.status: blocked`): pause and explain. Choices: locate
  the original session; `dagrun gate attach <run-id> --session <id>`; a reconstructed session built from the
  saved checkpoint via `... --reconstructed` ONLY with Eddie's explicit agreement (it is recorded as a
  fallback, not as continuity); or stay paused.
- **Resume this conversation from a terminal:** `dagrun resume <run-id>` with no flags (in a terminal) or `dagrun gate open <run-id>` (or the brief's
  `companion.resumeHint`) re-enters it from its original directory with an opening message saying a gate is
  waiting. A bare `claude --resume <id>` reopens the chat with NO gate context — if that is how you were
  resumed, run `dagrun gate show <run-id>` first and treat it as a gate session. Unverified that a resumed session keeps the same id; if
  `decide` reports `session-mismatch`, use `gate attach --replace` with Eddie's agreement.
- **A run created before v0.1.50** (no companion recorded): `dagrun gate attach <run-id> --session
"$CLAUDE_CODE_SESSION_ID" --reseed` (refreshes the worktree's prompts; touches only the run's untracked
  `.claude/`). Do this only with Eddie's explicit approval; never resume such a run with a bare
  `dagrun resume`.

## Do not

- Do not use `dagrun resume --approve/--reject` on a companion run (it is refused).
- Do not edit run state, artifacts or the worktree to force an outcome.
- Do not treat model advice or a recommendation as authorization.
