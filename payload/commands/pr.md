# /pr — Compose Pull Request Body

Compose a PR body and title from the run artifacts. dagrunner handles the
actual `git push` and `gh pr create` outside this session — your job is to
produce the artifacts.

## Step 0 — Confirm output directory

The block directly below gives the **literal absolute** `artifactsDir`, `runDir`,
`worktree` and `runId` for this session. Wherever this document writes `<artifactsDir>`, `<runDir>`,
`<worktree>` or `<runId>`, substitute those literal values — type the real path, never a shell
variable: the sandbox rejects Bash commands that contain a variable expansion (`simple_expansion`),
which cost earlier runs dozens of denied calls. Never print or discover environment variables
(`echo`, `printenv`, `env`).

`artifactsDir` (it ends with the node name, `pr/`) is the **only** directory you may write to — put
`body.md` and `pr-meta.json` there, nowhere else: not the worktree, not a scratch dir (a
`.dagrun-pr-output/` in the worktree is NOT picked up and fails the run). `runDir` is read-only in
this session — never write there. Prefer the Write tool with the literal `artifactsDir` path; a
heredoc redirect to that literal path also works (Step 2/3).

Run environment (engine-provided):

$ARGUMENTS

## Step 1 — Read all available artifacts

Read each of these inputs from the literal `runDir` (Read tool, or `cat` of the literal path;
substitute it for `<runDir>` below — see Step 0):

```bash
cat "<runDir>/plan/plan.md" 2>/dev/null
cat "<runDir>/define/guide.md" 2>/dev/null
cat "<runDir>/reproduce/guide.md" 2>/dev/null
cat "<runDir>/implement/summary.md" 2>/dev/null
cat "<runDir>/review/findings.json" 2>/dev/null
cat "<runDir>/fix/summary.md" 2>/dev/null
cat "<runDir>/verify/verify-report.json" 2>/dev/null
cat "<runDir>/verify/manual-test.md" 2>/dev/null
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
# <artifactsDir> expands inline here — never write to <runDir>
cat > "<artifactsDir>/body.md" << 'BODY'
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

- **type** — dagrunner sets `DAGRUN_PR_TITLE_PREFIX` in your environment to the correct type prefix
  for this workflow (e.g. `feat:`). Use it verbatim if you can read it; reading it needs a variable
  expansion the sandbox may reject, in which case derive the type from `plan.md` and
  `implement/summary.md` (a bugfix workflow is `fix:`, a feature workflow `feat:`).
- **short description** — lowercase, imperative mood, no period, ≤60 chars after the prefix.
  Example: `feat: add retry logic to job activation` ✓ `feat: Added Retry Logic` ✗

First, run this to get the branch name:

```bash
cd "<worktree>" && git rev-parse --abbrev-ref HEAD
```

Then write the file with the branch name, the literal paths and the other computed values (`title`,
`verifyRan`, `createdAt`) all substituted in as literal text (Write tool, or this heredoc):

```bash
cat > "<artifactsDir>/pr-meta.json" << 'META'
{
  "runId": "<runId>",
  "branch": "<branch name from the command above — literal text, not a variable>",
  "worktreePath": "<worktree>",
  "bodyPath": "<artifactsDir>/body.md",
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
ls -la "<artifactsDir>/"
```

## Step 4 — Backstop commit

Check for uncommitted changes in the worktree:

```bash
cd "<worktree>"
git status --short
```

If there are uncommitted changes, commit **only the declared deliverables** — never
`git add -A` / `git add .`. The worktree may hold unrelated dirty files (pre-existing
`package.json`/lockfile drift, `node_modules` symlinks created by a build) that must not ship
under the fix's authorship.

Build the expected-path list from the upstream artifacts (`implement/deliverables.txt`, plus
`fix/deliverables.txt` if the fix node wrote one):

```bash
cd "<worktree>"
cat "<runDir>/implement/deliverables.txt" "<runDir>/fix/deliverables.txt" 2>/dev/null \
  | grep -v '^$' | sort -u > "<artifactsDir>/deliverables.txt"
```

**If `deliverables.txt` is empty** (implement's step was skipped or predates this change): do not
fall back to `-A`. Run `git status --short`, then state in your own reasoning, path by path, what
you are about to add and why it belongs to the plan's change surface (`plan/plan.md`); exclude
anything else. Write only those paths, one per line, to `<artifactsDir>/deliverables.txt`.

Then stage exactly those paths, verify, and commit:

```bash
while IFS= read -r p; do [ -n "$p" ] && git add -- "$p"; done < "<artifactsDir>/deliverables.txt"

# Safety net: refuse to commit if anything staged is not on the list
unexpected=$(git diff --cached --name-only --no-renames | grep -vxF -f "<artifactsDir>/deliverables.txt")
if [ -n "$unexpected" ]; then
  echo "ERROR: staged paths not in deliverables.txt — refusing to commit:" >&2
  echo "$unexpected" >&2
  exit 1
fi
git commit -m "<type>: <short description> (dagrun: <runId>)"
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

## Step 5 — Suggest reviewers (report-only)

Run exactly this one command, with the literal `runDir` from the run-environment block above (no
variable, no pipe, no redirect):

```bash
dagrun reviewers --run-dir "<runDir>"
```

It reads the Core Features Alpha team roster, your committed diff and the review queues from GitHub,
writes `reviewers.json` and `reviewers.md` into `artifactsDir` itself, and prints two suggestions —
an **Expert** and a **Stretch** — each with a one-line reason and the real numbers behind it.

- Put the **Expert** and **Stretch** lines it printed into your final output, verbatim. Do not
  re-rank, re-word or add anyone.
- **Report-only.** Never run `gh pr edit --add-reviewer`, `gh pr comment`, `gh api` writes or any
  other command that posts to GitHub, and never put a reviewer name or `@handle` into `body.md` or
  `pr-meta.json` — `body.md` is posted to GitHub verbatim.
- If the command exits non-zero it has already recorded the failure in `reviewers.json`. State
  `REVIEWER SUGGESTION FAILED: <the message it printed>` in your final output. Do **not** invent,
  guess or look up reviewers another way, and do not retry with other commands. A failed suggestion
  does not fail the PR — carry on to the next step.

## Step 6 — Reflections (optional, do this last)

After all artifacts are confirmed, write any tips about the PR process or code
area to <artifactsDir>/reflections.md. The SessionEnd hook captures this
automatically. Absence is fine.

## Done

Your work ends here. dagrunner runs `git push origin HEAD` and
`gh pr create --draft` from outside the agent session after this exits.
