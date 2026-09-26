# /pr — Compose Pull Request Body

Compose a PR body and title from the run artifacts. dagrunner handles the
actual `git push` and `gh pr create` outside this session — your job is to
produce the artifacts.

## Step 0 — Confirm output directory

```bash
mkdir -p "$DAGRUN_ARTIFACTS"
```

The value of `$DAGRUN_ARTIFACTS` is the **only** directory you may write to.
It ends with the node name (`pr/`), not `artifacts/`.

**Do not try to print or discover the literal value of `$DAGRUN_ARTIFACTS`**
(e.g. via `echo "$DAGRUN_ARTIFACTS"`, `printenv`, or `env`) — this sandbox's
Bash tool blocks bare variable-expansion/introspection commands outright,
before any approval prompt. Using the variable inline inside a real command
(`mkdir -p "$DAGRUN_ARTIFACTS"`, or a heredoc redirect as in Step 2/3) works
fine — the shell expands it as part of that command's own side effect. It is
only _printing_ a variable's bare value that gets rejected. Because of this,
write every artifact via heredoc (see Step 2/3), never via the Write tool —
the Write tool needs a literal path string, and there is no reliable way to
obtain one in this sandbox.

All output files go to `$DAGRUN_ARTIFACTS/`.
`$DAGRUN_RUN_DIR` is read-only in this session — never write there.

## Step 1 — Read all available artifacts

**Do not try to print or discover the literal value of any `$DAGRUN_*` variable** (e.g. via `echo`,
`printenv`, or `env`) — this sandbox's Bash tool blocks bare variable-expansion/introspection
commands outright, before any approval prompt (same constraint as Step 0's `$DAGRUN_ARTIFACTS`
note). Read each of these inputs via `cat` in Bash (not the Read tool, which needs a literal path
you don't have) — a `$DAGRUN_*` variable used inline inside a real command like `cat` expands fine,
it is only a bare print that gets rejected:

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

Use a heredoc (not the Write tool — see Step 0) to write `$DAGRUN_ARTIFACTS/pr-meta.json`:

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

First, run this to get the branch name (a real command, not a bare variable print —
this one is not blocked):

```bash
cd "$DAGRUN_WORKTREE" && git rev-parse --abbrev-ref HEAD
```

Then write the heredoc yourself with that branch name and the other computed values
(`title`, `verifyRan`, `createdAt`) substituted in as literal text. Leave
`$DAGRUN_RUN_ID`/`$DAGRUN_WORKTREE`/`$DAGRUN_ARTIFACTS` as shell variables — the shell
expands those safely as part of the heredoc's own redirect, you don't need to know
their bare values:

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

If there are uncommitted changes, commit them using the same type prefix as the PR title:

```bash
git add -A
git commit -m "${DAGRUN_PR_TITLE_PREFIX:-feat} <short description> (dagrun: $DAGRUN_RUN_ID)"
```

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
