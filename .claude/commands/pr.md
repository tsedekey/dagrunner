# /pr — Compose and Open Pull Request

Compose a PR body from the run artifacts and open the PR (or dry-run on fixture runs).

## Inputs (read from the run directory via $DAGRUN_RUN_DIR)

- `$DAGRUN_RUN_DIR/plan/plan.md` — the original feature plan
- `$DAGRUN_RUN_DIR/expand-guide/guide.md` — the implementation guide
- `$DAGRUN_RUN_DIR/implement/summary.md` — what was implemented
- `$DAGRUN_RUN_DIR/review/findings.json` — review findings
- `$DAGRUN_RUN_DIR/fix/summary.md` — what was fixed
- `$DAGRUN_RUN_DIR/verify-seed/manual-test.md` — (optional) runtime verification result

## Step 1 — Read all available artifacts

Read each artifact listed above. For optional files (verify-seed/manual-test.md), check if
the file exists before reading — if absent, note "Runtime verification: skipped".

Also gather the branch name and worktree path from env:

```bash
cd "$DAGRUN_WORKTREE" && git rev-parse --abbrev-ref HEAD
```

## Step 2 — Compose the PR body

Write `$DAGRUN_ARTIFACTS/body.md` with this structure:

```markdown
## Summary

<1-3 bullet points from guide.md and implement/summary.md>

## What Changed

<Key files changed from implement/summary.md>

## Review Findings

<Summary of findings.json: N reviewers ran, M findings (blockers/majors), adversarial verifier ran: yes/no>

## Fixes Applied

<From fix/summary.md — which findings were addressed>

## Runtime Verification

<If verify-seed ran: process key, instance key, test result>
<If skipped: "Runtime verification was skipped for this PR">

## Test Plan

- [ ] Review the implementation guide: guide.md
- [ ] Verify all blocker/major findings from review are addressed
- [ ] Run the existing test suite
      <Add any feature-specific steps from guide.md acceptance criteria>
```

## Step 3 — Write metadata

Write `$DAGRUN_ARTIFACTS/pr-meta.json`:

```json
{
  "runId": "<DAGRUN_RUN_ID>",
  "branch": "<branch-name>",
  "worktreePath": "<DAGRUN_WORKTREE>",
  "bodyPath": "<DAGRUN_ARTIFACTS>/body.md",
  "verifyRan": <true|false>,
  "createdAt": "<ISO timestamp>"
}
```

## Step 4 — Open the PR (gated by DAGRUN_NO_PR)

Check if the `DAGRUN_NO_PR` env var is set:

```bash
echo "${DAGRUN_NO_PR:-}"
```

If `DAGRUN_NO_PR` is set to any non-empty value, **do not open a real PR**. Print:

```
dagrun/pr: DAGRUN_NO_PR is set — skipping real PR creation. body.md written to $DAGRUN_ARTIFACTS/body.md
```

If `DAGRUN_NO_PR` is NOT set, push the feature branch and open the PR:

```bash
cd "$DAGRUN_WORKTREE"
git push origin HEAD
gh pr create \
  --title "<concise title from guide.md, ≤70 chars>" \
  --body-file "$DAGRUN_ARTIFACTS/body.md" \
  --base main
```

Capture the PR URL from `gh pr create` output and append it to `$DAGRUN_ARTIFACTS/pr-meta.json`
as `"prUrl": "<url>"`.

If `gh pr create` fails (e.g. no GitHub auth, wrong base branch), log the error to
`$DAGRUN_ARTIFACTS/pr-error.txt` and still exit successfully — the body.md is the deliverable,
the PR URL is a bonus.
