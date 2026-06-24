# /pr — Compose Pull Request Body

Compose a PR body and title from the run artifacts. dagrunner handles the
actual `git push` and `gh pr create` outside this session — your job is to
produce the artifacts.

## Step 0 — Confirm output directory

Run this first so you know the exact path for every write in this session:

```bash
echo "ARTIFACTS : $DAGRUN_ARTIFACTS"
echo "RUN DIR   : $DAGRUN_RUN_DIR"
mkdir -p "$DAGRUN_ARTIFACTS"
```

All output files go to `$DAGRUN_ARTIFACTS/` (the value printed above).
`$DAGRUN_RUN_DIR` is read-only in this session — never write there.

## Step 1 — Read all available artifacts

Read each of these inputs:

- `$DAGRUN_RUN_DIR/plan/plan.md`
- `$DAGRUN_RUN_DIR/define/guide.md`
- `$DAGRUN_RUN_DIR/implement/summary.md`
- `$DAGRUN_RUN_DIR/review/findings.json`
- `$DAGRUN_RUN_DIR/fix/summary.md`
- `$DAGRUN_RUN_DIR/verify/manual-test.md` (optional — skip if absent)

## Step 2 — Compose the PR body

Follow the Camunda PR template exactly. Write to the path printed in Step 0:

```bash
# Use the resolved path — never write to $DAGRUN_RUN_DIR
cat > "$DAGRUN_ARTIFACTS/body.md" << 'BODY'
## Description

<2–4 sentences. What this PR does and why — goal and purpose only.
Draw from guide.md and implement/summary.md. No bullet lists, no sub-headers,
no review/fix recap. If verify ran, one sentence noting it was produced.>

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

Write to the resolved path from Step 0. Use the Write tool or a heredoc — your choice, but the file must land at `$DAGRUN_ARTIFACTS/pr-meta.json`:

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

```json
{
  "runId": "<DAGRUN_RUN_ID>",
  "branch": "<branch from: cd $DAGRUN_WORKTREE && git rev-parse --abbrev-ref HEAD>",
  "worktreePath": "<DAGRUN_WORKTREE>",
  "bodyPath": "<resolved DAGRUN_ARTIFACTS>/body.md",
  "title": "<type>: <short description>",
  "verifyRan": <true|false>,
  "createdAt": "<ISO timestamp>"
}
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

Under normal flow `implement.md` commits first — this is a no-op if that happened.

## Step 4b — Write sibling launch commands

Read the PR number from `pr-meta.json` if available, otherwise leave as a placeholder.

Write `$DAGRUN_ARTIFACTS/sibling-commands.md`:

```bash
PR_NUMBER=$(jq -r '.prNumber // "<PR_NUMBER>"' "$DAGRUN_ARTIFACTS/pr-meta.json" 2>/dev/null || echo "<PR_NUMBER>")
SPEC_PATH="$DAGRUN_RUN_DIR/verify-guide/seeding-spec.json"
ISSUE_NUM="${DAGRUN_RUN_ID%%-*}"

cat > "$DAGRUN_ARTIFACTS/sibling-commands.md" << SIBLINGS
# Sibling Commands

Open a Claude Code session in the worktree and run these commands.
Use the named \`claude -n\` invocations below so each session is easy to find by issue number.

## 1. Seed the cluster for live demo

\`\`\`
cd $DAGRUN_WORKTREE
claude -n "${ISSUE_NUM}-seed-data"
\`\`\`
Then run: \`/seed-data $SPEC_PATH\`

Requires: local Orchestration Cluster running (\`c8ctl start c8-cluster\`).
Artifacts will be written to: $DAGRUN_RUN_DIR/seed-data/

## 2. Babysit CI (after PR is created)

\`\`\`
cd $DAGRUN_WORKTREE
claude -n "${ISSUE_NUM}-ci-babysit"
\`\`\`
Then run: \`/ci-babysit --pr $PR_NUMBER\`

## 3. Triage PR review comments (after reviewers comment)

\`\`\`
cd $DAGRUN_WORKTREE
claude -n "${ISSUE_NUM}-pr-triage"
\`\`\`
Then run: \`/pr-triage --pr $PR_NUMBER\`
SIBLINGS
```

Confirm the file was written:

```bash
cat "$DAGRUN_ARTIFACTS/sibling-commands.md"
```

## Step 5 — Reflections (optional, do this last)

After all artifacts are confirmed, write any tips about the PR process or code
area to $DAGRUN_ARTIFACTS/reflections.md. The SessionEnd hook captures this
automatically. Absence is fine.

## Done

Your work ends here. dagrunner runs `git push origin HEAD` and
`gh pr create --draft` from outside the agent session after this exits.
