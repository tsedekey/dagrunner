# /pr — Compose Pull Request Body

Compose a PR body and title from the run artifacts. dagrunner handles the
actual `git push` and `gh pr create` outside this session — your job is to
produce the artifacts.

## Step 0 — Confirm output directory

The engine appends a `<run-environment>` block to your prompt with the **literal absolute**
`artifactsDir`, `runDir` and `worktree` paths. `artifactsDir` (it ends with the node name, `pr/`) is
the **only** directory you may write to — put `body.md` and `pr-meta.json` there, nowhere else: not
the worktree, not a scratch dir (a `.dagrun-pr-output/` in the worktree is NOT picked up and fails the
run). `runDir` is read-only in this session — never write there.

```bash
mkdir -p "$DAGRUN_ARTIFACTS"
```

You may write with the Write tool using the literal `artifactsDir` path from the block, or with a
heredoc redirect (as in Step 2/3). `$DAGRUN_ARTIFACTS` holds the same path and the snippets below use
it, but prefer the literal path in Bash commands: the sandbox may reject a command that merely
contains a variable expansion (`simple_expansion`), and a bare `echo`/`printenv` of a variable is
always rejected. Never print or discover it.

## Step 1 — Read all available artifacts

Read each of these inputs from the literal `runDir` in your `<run-environment>` block (Read tool or
`cat`). `$DAGRUN_RUN_DIR` holds the same path and the snippet below uses it, but the literal path is
preferred (see Step 0):

```bash
cat "$DAGRUN_RUN_DIR/plan/plan.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/define/guide.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/reproduce/guide.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/implement/summary.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/review/findings.json" 2>/dev/null
cat "$DAGRUN_RUN_DIR/fix/summary.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/verify/verify-report.json" 2>/dev/null
cat "$DAGRUN_RUN_DIR/verify/manual-test.md" 2>/dev/null
```

- Guide: use `define/guide.md` if it printed something; otherwise use `reproduce/guide.md` (bugfix workflow).
- `verify/manual-test.md` is optional — absent is fine, skip it.
- `verify/` exists only when Eddie chose the optional runtime hand-off at the fix gate. verify only
  PROVISIONS a local environment for Eddie's manual testing and renders no verdict; his verdict is
  given at the pre-PR gate, AFTER this body is composed. If `verify/verify-report.json` is present
  with `outcome` `PROVISIONED`, do NOT claim anything was demonstrated or passed — at most note
  "manual verification pending / by Eddie" (the gate carries the verdict). If absent, say nothing
  about verify. Never claim CI-level acceptance-test coverage from it.

## Step 2 — Compose the PR body

Follow the Camunda PR template exactly:

```bash
# $DAGRUN_ARTIFACTS expands inline here — never write to $DAGRUN_RUN_DIR
cat > "$DAGRUN_ARTIFACTS/body.md" << 'BODY'
## Description

<2–4 sentences. What this PR does and why — goal and purpose only.
Draw from guide.md and implement/summary.md. No bullet lists, no sub-headers,
no review/fix recap. Do not describe verify results — Eddie's manual verification verdict comes at the gate, after this is written.>

## Checklist

<!--- Please delete options that are not relevant. -->

- [ ] Enable backports when necessary (fex. [for bug fixes](https://github.com/camunda/camunda/blob/main/CONTRIBUTING.md#backporting-changes), [for CI changes](https://camunda.github.io/camunda/ci/#when-to-backport-ci-changes), or [for documentation changes](https://camunda.github.io/camunda/ci/#documentation-specific-backporting-monorepo-docs-folders)).
- [ ] If this PR modifies the [C8 Orchestration Cluster E2E Test Suite](qa/c8-orchestration-cluster-e2e-test-suite), the relevant tests have been run via the [on-demand workflow](https://github.com/camunda/camunda/actions/workflows/c8-orchestration-cluster-e2e-tests-on-demand.yml) before requesting review. Any test failures are documented in the PR description and confirmed not to be regressions introduced by this PR.

## Related issues

closes #<issue number extracted from plan.md, or leave as "closes #" if not found>
BODY
```

**Writing rules:** Maximum 4 sentences. Plain prose only. No file lists, no finding counts, no cost figures.

## Step 3 — Write metadata

Write `pr-meta.json` into `artifactsDir` (Write tool with the literal path, or the heredoc below):

The `title` field must follow [Conventional Commits](https://www.conventionalcommits.org/) format
as required by the Camunda monorepo:

```
<type>: <short description>
```

- **type** — read `$DAGRUN_PR_TITLE_PREFIX` from the environment first. It is set by dagrunner
  to the correct type prefix for this workflow (e.g. `feat:`). Use it verbatim. Only fall back to
  deriving the type from `plan.md` and `implement/summary.md` if the env var is empty or absent.
- **short description** — lowercase, imperative mood, no period, ≤60 chars after the prefix.
  Example: `feat: add retry logic to job activation` ✓ `feat: Added Retry Logic` ✗

First, run this to get the branch name:

```bash
cd "$DAGRUN_WORKTREE" && git rev-parse --abbrev-ref HEAD
```

Then write the file with that branch name and the other computed values (`title`, `verifyRan`,
`createdAt`) substituted in as literal text. With the heredoc form, `$DAGRUN_RUN_ID` /
`$DAGRUN_WORKTREE` / `$DAGRUN_ARTIFACTS` may stay shell variables (the shell expands them inside the
heredoc); with the Write tool use the literal paths from your `<run-environment>` block:

```bash
cat > "$DAGRUN_ARTIFACTS/pr-meta.json" << META
{
  "runId": "$DAGRUN_RUN_ID",
  "branch": "<branch name from the command above — literal text, not a variable>",
  "worktreePath": "$DAGRUN_WORKTREE",
  "bodyPath": "$DAGRUN_ARTIFACTS/body.md",
  "title": "<type>: <short description>",
  "verifyRan": <true|false>,
  "createdAt": "<ISO timestamp>"
}
META
```

Note: `prNumber` is NOT written here — dagrunner fills it after `gh pr create` returns. Leave
the field absent or `null` in this initial write; the `sibling-commands.md` script in Step 4b
handles the fallback.

Confirm both files exist:

```bash
ls -la "$DAGRUN_ARTIFACTS/"
```

## Step 4 — Backstop commit

Check for uncommitted changes in the worktree:

```bash
cd "$DAGRUN_WORKTREE"
git status --short
```

If there are uncommitted changes, commit **only the declared deliverables** — never
`git add -A` / `git add .`. The worktree may hold unrelated dirty files (pre-existing
`package.json`/lockfile drift, `node_modules` symlinks created by a build) that must not ship
under the fix's authorship.

Build the expected-path list from the upstream artifacts (`implement/deliverables.txt`, plus
`fix/deliverables.txt` if the fix node wrote one):

```bash
cd "$DAGRUN_WORKTREE"
cat "$DAGRUN_RUN_DIR/implement/deliverables.txt" "$DAGRUN_RUN_DIR/fix/deliverables.txt" 2>/dev/null \
  | grep -v '^$' | sort -u > "$DAGRUN_ARTIFACTS/deliverables.txt"
```

**If `deliverables.txt` is empty** (implement's step was skipped or predates this change): do not
fall back to `-A`. Run `git status --short`, then state in your own reasoning, path by path, what
you are about to add and why it belongs to the plan's change surface (`plan/plan.md`); exclude
anything else. Write only those paths, one per line, to `$DAGRUN_ARTIFACTS/deliverables.txt`.

Then stage exactly those paths, verify, and commit:

```bash
while IFS= read -r p; do [ -n "$p" ] && git add -- "$p"; done < "$DAGRUN_ARTIFACTS/deliverables.txt"

# Safety net: refuse to commit if anything staged is not on the list
unexpected=$(git diff --cached --name-only --no-renames | grep -vxF -f "$DAGRUN_ARTIFACTS/deliverables.txt")
if [ -n "$unexpected" ]; then
  echo "ERROR: staged paths not in deliverables.txt — refusing to commit:" >&2
  echo "$unexpected" >&2
  exit 1
fi
git commit -m "${DAGRUN_PR_TITLE_PREFIX:-feat} <short description> (dagrun: $DAGRUN_RUN_ID)"
```

If the safety net fires, stop and report the unexpected paths loudly in your final output; never
commit a partial set silently and never add the paths to the list just to get past the check
unless they are demonstrably part of the fix. Dirty files left out of the commit are expected —
list them in your final output.

Add a description (a second `-m`) only when it earns its place — it explains something the
subject can't: non-obvious code, a workaround, or context a reviewer would otherwise be missing.
Skip it when the subject already says enough; never restate the diff in prose. No trailers — no
Co-Authored-By, no other trailers.

Under normal flow `implement.md` commits first — this is a no-op if that happened.

## Step 5 — Reflections (optional, do this last)

After all artifacts are confirmed, write any tips about the PR process or code
area to $DAGRUN_ARTIFACTS/reflections.md. The SessionEnd hook captures this
automatically. Absence is fine.

## Done

Your work ends here. dagrunner runs `git push origin HEAD` and
`gh pr create --draft` from outside the agent session after this exits.
