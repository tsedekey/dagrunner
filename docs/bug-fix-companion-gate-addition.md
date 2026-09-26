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
  - `verify` is not a CI duplicate: it builds the candidate from the worktree, runs it on a local
    disposable target and produces `verify/demo.md` (manual replay steps) for Eddie.
- **`pr`** — pre-PR gate. Review the PR body, the diff, and (if it ran) `verify/verify-report.json` +
  `demo.md`. Approve = the branch is pushed and a DRAFT PR opens. Amend `--target fix` sends the code
  back; nothing has been published yet. Approval never implies merge, reviewers, ready-for-review, or
  backport labels.

## Verify evidence — how to read it

`DEMONSTRATED` = one scenario shown on a candidate built from this worktree, on a loopback disposable
target. The engine checks consistency (revision, dirty files, candidate observation, cleanup), not truth:
read `demo.md` and the observations yourself. It is not regression coverage and not CI. `NOT_DEMONSTRATED`
(behaviour did not match) and `BLOCKED_RUNTIME` (no runtime evidence obtained) fail the run; explain which
and why. Do not describe a skipped or blocked verify as passed.

## Recovery

- **Original conversation unavailable** (`companion.status: blocked`): pause and explain. Choices: locate
  the original session; `dagrun gate attach <run-id> --session <id>`; a reconstructed session built from the
  saved checkpoint via `... --reconstructed` ONLY with Eddie's explicit agreement (it is recorded as a
  fallback, not as continuity); or stay paused.
- **Resume this conversation from a terminal:** the brief's `companion.resumeHint`
  (`CLAUDE_CONFIG_DIR=<dir> claude --resume <id>`). Unverified that a resumed session keeps the same id; if
  `decide` reports `session-mismatch`, use `gate attach --replace` with Eddie's agreement.
- **A run created before v0.1.50** (no companion recorded): `dagrun gate attach <run-id> --session
"$CLAUDE_CODE_SESSION_ID" --reseed` (refreshes the worktree's prompts; touches only the run's untracked
  `.claude/`). Do this only with Eddie's explicit approval; never resume such a run with a bare
  `dagrun resume`.

## Do not

- Do not use `dagrun resume --approve/--reject` on a companion run (it is refused).
- Do not edit run state, artifacts or the worktree to force an outcome.
- Do not treat model advice or a recommendation as authorization.
