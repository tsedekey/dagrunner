# /pr — Compose and Open Pull Request

Compose a PR body from the run artifacts and open the PR (or dry-run on fixture runs).

## Inputs (read from the run directory via $DAGRUN_RUN_DIR)

- `$DAGRUN_RUN_DIR/plan/plan.md` — the original feature plan
- `$DAGRUN_RUN_DIR/expand-guide/guide.md` — the implementation guide
- `$DAGRUN_RUN_DIR/implement/summary.md` — what was implemented
- `$DAGRUN_RUN_DIR/review/findings.json` — review findings
- `$DAGRUN_RUN_DIR/fix/summary.md` — what was fixed
- `$DAGRUN_RUN_DIR/verify-guide/manual-test.md` — (optional) verification guide result

## Step 1 — Read all available artifacts

Read each artifact listed above. For optional files (verify-guide/manual-test.md), check if
the file exists before reading — if absent, note "Verification guide: skipped".

Also gather the branch name and worktree path from env:

```bash
cd "$DAGRUN_WORKTREE" && git rev-parse --abbrev-ref HEAD
```

## Step 2 — Compose the PR body

Follow the Camunda PR template exactly. Write `$DAGRUN_ARTIFACTS/body.md`:

```markdown
## Description

<2–4 sentences. State what this PR does and why — goal and purpose only.
Draw from guide.md (what to implement, acceptance criteria) and
implement/summary.md (what was actually done). Be concise: no bullet lists,
no section headers, no review/fix recap. If verify-guide ran, add one sentence
noting that a verification guide (seeding spec + code tour) was produced.>

## Checklist

<!--- Please delete options that are not relevant. -->

- [ ] Enable backports when necessary (fex. [for bug fixes](https://github.com/camunda/camunda/blob/main/CONTRIBUTING.md#backporting-changes), [for CI changes](https://camunda.github.io/camunda/ci/#when-to-backport-ci-changes), or [for documentation changes](https://camunda.github.io/camunda/ci/#documentation-specific-backporting-monorepo-docs-folders)).
- [ ] If this PR modifies the [C8 Orchestration Cluster E2E Test Suite](qa/c8-orchestration-cluster-e2e-test-suite), the relevant tests have been run via the [on-demand workflow](https://github.com/camunda/camunda/actions/workflows/c8-orchestration-cluster-e2e-tests-on-demand.yml) before requesting review. Any test failures are documented in the PR description and confirmed not to be regressions introduced by this PR.

## Related issues

closes #<issue number extracted from plan.md, or leave as "closes #" if not found>
```

**Description writing rules:**

- Maximum 4 sentences. Prefer 2–3.
- Do not summarise the review or fix steps — reviewers will read the code.
- Do not include file lists, finding counts, or cost figures.
- Use plain prose, not bullet points or sub-headers.

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
