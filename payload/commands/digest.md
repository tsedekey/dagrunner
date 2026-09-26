# /digest — Review Notes (deferred findings + open questions)

You are running the **digest node** of a dagrunner pipeline. Your job is deliberately small: read the
run's own artifacts (guide, review, fix, verify) and the diff, and write
`$DAGRUN_ARTIFACTS/knowledge-map.md` — a short page of what the planning-companion gate conversations
do NOT persist: the findings that were deferred or left unresolved, and the open questions a PR
reviewer will likely ask. (Before v0.1.50 this node wrote a six-section bottom-up knowledge map; the
teaching now happens in those gate conversations, so that recap was dropped.)

**CRITICAL: Do NOT modify any files in the worktree. This node is read-only, exactly like `review`
— its whole contract is one artifact.** There is no gate on this node (informational only, same
read-only pattern as `review`) — you run to completion on your own, no human reviews this node.

**This node runs in parallel with `pr`** (both depend on `fix` and `verify`, nothing depends on
`digest`). Do not assume `pr`'s backstop commit (`payload/commands/pr.md` Step 4) has already run —
it may fire concurrently with this session, in the same worktree. Read the diff with a form that
does not depend on whether that commit has happened yet and does not touch the index yourself (see
Step 2 — never use `git add`/`git diff --cached` here, both race against `pr`'s concurrent
`git add -A`/`git commit`).

You have access to the following env vars:

- `$DEVHARNESS_SRC` — permanent camunda/camunda checkout
- `$DAGRUN_ARTIFACTS` — write `knowledge-map.md` here (nowhere else)
- `$DAGRUN_RUN_ID` — the current dagrunner run ID
- `$DAGRUN_WORKTREE` — the worktree path (your cwd) — read-only access, never write here
- `$DAGRUN_RUN_DIR` — the run directory (parent of all node artifact dirs) — this is where you read
  every upstream node's artifacts from

---

> **⚠️ Do not try to print or discover the literal value of any `$DAGRUN_*` variable** (e.g. via
> `echo`, `printenv`, `env`, or `node -e ...process.env`) — this sandbox's Bash tool blocks bare
> variable-expansion/introspection commands outright, before any approval prompt; and even where it
> doesn't, printing env vars requires human approval that never arrives in this unattended session.
> Using a `$DAGRUN_*` variable inline inside a real command works fine — the shell expands it as
> part of that command's own side effect:
>
> - **Read** a `$DAGRUN_RUN_DIR`-relative file via `cat` in Bash — not the Read tool, which needs a
>   literal path you don't have.
> - **Write** via a heredoc (`cat > "$DAGRUN_ARTIFACTS/x.md" << 'EOF' ... EOF`) — not the Write
>   tool, for the same reason.

## Step 0 — Confirm output directory

```bash
mkdir -p "$DAGRUN_ARTIFACTS"
```

The value of `$DAGRUN_ARTIFACTS` is the **only** directory you may write to. It ends with the node
name (`digest/`), not `artifacts/`.

## Step 1 — Locate the authoring source (workflow-tolerant)

Check both paths and use whichever prints — this is a config-only addition shared by both
workflows, exactly like `implement`/`pr`/`verify`:

```bash
cat "$DAGRUN_RUN_DIR/define/guide.md" 2>/dev/null || cat "$DAGRUN_RUN_DIR/reproduce/guide.md"
```

Whichever one printed is your **INTENT** source for Section 2 below — the problem/feature as
originally stated, not the implementation plan. If neither prints, stop and report it: a digest
with no authoring source has nothing to restate the intent from.

## Step 2 — Read the diff (read-only, index-independent)

**Do not run `git add` or `git diff --cached` here** — see the parallel-with-`pr` warning above.
Use a form that reads the working tree directly against the merge-base, so it is correct whether or
not `pr`'s backstop commit has landed yet (the same `git merge-base origin/main HEAD` idiom
`payload/commands/review.md` uses):

```bash
cd "$DAGRUN_WORKTREE"
git diff "$(git merge-base origin/main HEAD)"
```

This is the primary source for Section 3 — read it for actual file:line-groundable changes, not
just a file list. For an overview of which files changed, `git diff --stat` on the same range is
useful too:

```bash
git diff --stat "$(git merge-base origin/main HEAD)"
```

**Known limitation on hotfix bugfix runs:** `base_branch` (e.g. `release/1.x`, from the plan's YAML
frontmatter — see `docs/dagrunner-master-architecture.md` §3c) is consumed by engine TS code from
`state.json`, not exported as an env var to node prompts, so this command has no way to read it and
hardcodes `origin/main` here (matching `review.md`/`verify.md`'s existing `origin/main` usage). On a
run that actually branched from a release branch, this diff range will include the
release-branch/main divergence, not just this change — treat Section 3 with that in mind rather than
assuming every line in the diff belongs to this PR.

## Step 3 — Read the run's own artifacts

```bash
cat "$DAGRUN_RUN_DIR/implement/summary.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/fix/summary.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/review/findings.json" 2>/dev/null
cat "$DAGRUN_RUN_DIR/verify/verify-report.json" 2>/dev/null
cat "$DAGRUN_RUN_DIR/verify/demo.md" 2>/dev/null
```

- `implement/summary.md` and `fix/summary.md` record what changed and why — including design
  choices/tradeoffs made along the way. This is your primary source for the "notable design
  choices" callouts in Section 3, not something to re-derive from the diff alone.
- `review/findings.json` is the `FINDINGS_SCHEMA`-shaped array of everything the reviewers flagged
  (dimension/severity/confidence/file/line/claim/grounded) — your source for Section 4's "what was
  flagged" half.
- `fix/summary.md` records, per the existing `revisionInstruction` contract, which findings were
  addressed and which were explicitly deferred (with a reason) — your source for Section 4's "what
  was addressed vs. deferred" half. Do not treat an absent/empty findings array as a gap to explain
  — "no high-confidence blocker/major findings" is a legitimate, common outcome.
- `verify/verify-report.json`'s `outcome` field and `verify/demo.md` are your source for Section 5.
  `verify` is an OPTIONAL provision-and-hand-off chosen at the fix gate (it stands up a local
  environment for Eddie's manual testing and renders no verdict) — when `verify/` is absent it
  was skipped by decision, which is a normal outcome, not a gap.

## Step 4 — Write `$DAGRUN_ARTIFACTS/knowledge-map.md` (short — two sections only)

Understanding of what was built now happens in the planning-companion gate conversations, so this
node no longer re-teaches it. Record only what those conversations do not persist, for a reader about
to review the PR:

```bash
cat > "$DAGRUN_ARTIFACTS/knowledge-map.md" << 'EOF'
# Review notes — <feature/fix name from the guide>

## 1. Deferred findings and unresolved risks

<From review/findings.json and fix/summary.md: each finding that fix explicitly DEFERRED (or left
unresolved), with dimension/severity, the claim, and the reason given. Plain prose or a short table.
If nothing was deferred, say so in one line — that is a normal outcome.>

## 2. Open questions a reviewer will likely ask

<Design tradeoffs with a reasonable alternative, scope boundaries the guide drew, and one line on
verification: whether the optional verify hand-off ran (verify/ absent = skipped by the fix-gate
decision) and, if it did, its outcome (`PROVISIONED` only means an environment was handed to Eddie for manual testing — the verdict is Eddie's, not in the artifacts; not regression
coverage, not CI). Ground file/line claims in the diff from Step 2; otherwise stay at file/component
level.>
EOF
```

Keep it to roughly one page. Do not restate the background, the implementation walkthrough or the
review process — the diff, the guide and the gate discussions already carry those.

## Step 5 — Reflections (optional, do this last)

If you noticed anything non-obvious while synthesizing this run's artifacts (e.g. a summary that
didn't match the diff, a gap in what a node recorded), write it to
`$DAGRUN_ARTIFACTS/reflections.md`. The SessionEnd hook captures this automatically. Absence is
fine.

---

## Constraints

- Read-only: do not edit, write to, or run commands that modify files in the worktree (only write
  to `$DAGRUN_ARTIFACTS/`). No `git add`, no `git commit`, no `formatCommand`.
- `knowledge-map.md` must be written to `$DAGRUN_ARTIFACTS/knowledge-map.md` — NOT to the worktree.
- Two sections, in the order given in Step 4 — do not reorder, merge, or drop one, even when the
  underlying artifact is thin (e.g. an empty findings array still gets a Section 4 that says so).
- This node does not feed pr-triage or any other sibling — it is a standalone artifact for the
  human reviewing the run. Do not assume anything downstream reads it.
