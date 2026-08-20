# /digest — Bottom-Up Knowledge Map

You are running the **digest node** of a dagrunner pipeline. Your job is to read the run's own
artifacts (guide, implementation, review, fix, verify) and the diff itself, and synthesize a single
**bottom-up knowledge map** — `$DAGRUN_ARTIFACTS/knowledge-map.md` — so a human reviewer has the
full context of what was actually built (and why) in their head *before* they open the PR diff or
read pr-triage's drafted replies.

This mirrors what an external task-intake tool (Glean) gives at the *start* of a run — a
problem-first knowledge map before any planning happens. digest gives the equivalent *after*
implementation: grounded in what actually got built (the diff, the review findings, what fix
addressed vs. deferred, what verify proved), not what was originally planned. Bottom-up means:
establish the terrain (Background) before the diff, not the diff before the terrain.

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
`payload/commands/verify.md`'s deferred-to-CI check already establishes):

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

## Step 3 — Read the run's own artifacts

```bash
cat "$DAGRUN_RUN_DIR/implement/summary.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/fix/summary.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/review/findings.json" 2>/dev/null
cat "$DAGRUN_RUN_DIR/verify/verify-report.json" 2>/dev/null
cat "$DAGRUN_RUN_DIR/verify/verify-plan.md" 2>/dev/null
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
- `verify/verify-report.json`'s `outcome` field and `verify/verify-plan.md` (when present — it is
  conditionally written, absent is fine, see `payload/commands/verify.md`) are your source for
  Section 5.

## Step 4 — Write `$DAGRUN_ARTIFACTS/knowledge-map.md`

Write exactly these six sections, in this order. This is a knowledge map for a human about to
review the PR — write for a reader who has NOT yet looked at the diff, not a recap for someone who
already has.

```bash
cat > "$DAGRUN_ARTIFACTS/knowledge-map.md" << 'EOF'
# Knowledge map — <feature/fix name from the guide>

## 1. Background

<The subsystem/area of the codebase this change touches, and whatever context a reader needs
before the diff will make sense — module boundaries, key existing types/classes the diff builds
on, relevant invariants. Bottom-up: establish the terrain BEFORE describing the diff.>

## 2. The problem / feature

<Restate the INTENT from guide.md — what was broken or requested, and WHY. This is the problem
statement, not the implementation plan. If guide.md's plan diverged from this restated intent
during implementation, note that here too — it's exactly the kind of thing a reviewer asks about.>

## 3. What was implemented

<Walk through the actual diff, grounded in file:line citations, organized BY CONCERN/COMPONENT —
not a mechanical file-by-file dump. Call out notable design choices or tradeoffs made during
implement/fix, drawn from implement/summary.md and fix/summary.md, not invented from the diff
alone.>

## 4. Review & fix

<What review flagged (review/findings.json) — dimension, severity, and the claim, in prose, not
a raw JSON dump. What fix addressed, and what was explicitly deferred and why, per fix/summary.md.
If findings.json was empty, say so plainly rather than treating it as a gap.>

## 5. How it was verified

<The acceptance test that was authored or reused (verify/verify-plan.md's "Flow covered" and
"Acceptance test" sections, when present), and what verify's outcome does and does not prove. Be
precise: PASS means the acceptance test ran and passed. DEFERRED_TO_CI means the independent
build rerun hit a confirmed pre-existing, diff-unrelated trunk issue — acceptance-test confirmation
itself was deferred to CI, NOT that it passed at that layer. Name which one this run got.>

## 6. Open questions

<Things a PR reviewer is likely to ask, so the human is ready for them going into review/pr-triage
— e.g. an explicitly deferred finding, a design tradeoff that has a reasonable alternative, a
scope boundary the guide drew that a reviewer might push on.>
EOF
```

Ground Section 3's citations in the actual `git diff` output from Step 2 — do not fabricate line
numbers. If a claim can't be grounded to a specific file:line, describe it at the file/component
level instead of inventing precision that isn't there.

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
- Six sections, in the order given in Step 4 — do not reorder, merge, or drop one, even when the
  underlying artifact is thin (e.g. an empty findings array still gets a Section 4 that says so).
- This node does not feed pr-triage or any other sibling — it is a standalone artifact for the
  human reviewing the run. Do not assume anything downstream reads it.
