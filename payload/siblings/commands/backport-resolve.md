---
description: Resolve a failed backport PR — analyze conflict, apply the fix to the stable branch, build, and push. Run with the backport branch checked out locally.
argument-hint: [--pr <number>] [--repo owner/repo]
---

# /backport-resolve — Backport Conflict Resolution

**Input**: $ARGUMENTS

One-shot resolution of a failed backport PR. The backport-action creates a draft PR with committed
conflict markers (`BACKPORT-CONFLICT` commit) when it cannot auto-apply a cherry-pick. This command
analyzes the conflict, applies the original fix to the stable branch, builds, formats, commits, and
pushes.

**Prerequisite:** check out the backport branch locally before running this command.

---

## Hard rules

1. **Never push to `main` or `stable/*` directly.** Only push to the `backport-*` branch.
2. **Never drop the original fix.** Apply the fix's intent to the stable branch — do not hollow it out.
3. **Build must pass before committing.** Compile errors are worse than conflict markers.
4. **Format before committing.** `license:format spotless:apply` is mandatory — CI will reject without it.
5. **Conflict markers are committed, not staged.** The backport-action committed them as-is; `git diff`
   shows nothing unstaged. Read the files directly.

---

## Step 1 — Infer context from the current branch

```bash
git branch --show-current
```

Expected pattern: `backport-<ORIGINAL_PR>-to-stable/<X.Y>`.

If `$ARGUMENTS` contains `--pr <number>`, use that PR number directly. If `--repo` is given, use
that repo; otherwise default to `camunda/camunda`.

Find the backport PR:

```bash
gh pr list --repo camunda/camunda --head "$(git branch --show-current)" \
  --json number,title,body,isDraft,state --limit 1
```

If `isDraft: false` — the backport applied cleanly; there is nothing to resolve. Tell the user and stop.

Extract the original PR number from the PR body. The backport-action always includes:

```
⤵️ Backport of #<N> → `stable/<X.Y>`
```

---

## Step 2 — Fetch original PR diff and understand intent

```bash
gh pr view <ORIGINAL_PR> --repo camunda/camunda --json title,body
gh pr diff <ORIGINAL_PR> --repo camunda/camunda
```

Identify:

- **What changed** — files, classes, methods.
- **Why** — from the PR title and body.
- **The minimal net-new logic** — strip out changes already present on the stable branch; keep only
  what the fix actually introduces.

---

## Step 3 — Find files with conflict markers

```bash
grep -rl "<<<<<<< HEAD" . \
  --include="*.java" --include="*.xml" --include="*.ts" --include="*.tsx" \
  --include="*.json" --include="*.yaml" --include="*.yml" \
  --exclude-dir=target --exclude-dir=node_modules --exclude-dir=dist
```

This finds **Type A** conflicts (committed markers). Types B and C apply cleanly with no markers and
only surface as compile errors in Step 5 — **Step 5 is mandatory even if this grep finds nothing.**

---

## Step 4 — Classify and resolve each conflict

Read each conflicted file fully. Classify and resolve:

### Type A — Git conflict markers

`<<<<<<< HEAD` … `=======` … `>>>>>>> <sha> (<message>)` present in the committed file.

- `HEAD` side = stable branch state before the cherry-pick.
- `>>>>>>>` side = what the cherry-pick tried to introduce (may include fields/symbols that only
  exist on `main`, not on the stable branch).

Resolution:

1. Compare the `>>>>>>>` block against the original PR diff (Step 2) to separate the genuine fix
   from incidental `main`-only code.
2. Edit the file: keep the `HEAD` side intact, apply only the genuine fix portions, discard `main`-only
   additions, remove all conflict markers.

### Type B — Clean apply, missing symbol at compile time

The cherry-pick applied without markers but references a symbol that exists on `main` but not on the
stable branch. Surfaces only in Step 5 as a compile error.

Resolution: identify the missing symbol, read the stable branch version of the surrounding class,
and adapt the fix to use the equivalent symbol available on that branch.

### Type C — Missing infrastructure

The fix depends on a class or concept absent from the stable branch entirely.

Resolution: read the stable branch equivalent file, re-implement the fix from first principles using
stable-branch conventions. If the missing infrastructure is non-trivial, note it in the commit message
and surface it to the user — do not silently skip.

### Editing guidelines

- Use LSP (`GoToDefinition`, `FindReferences`) to navigate the stable branch's class structure —
  not grep.
- Resulting file must be syntactically and semantically valid after editing.
- Do not introduce fields, methods, or imports that belong only to `main`.
- Do not add explanatory comments about the backport.
- Add `@Nullable`/`@NullMarked` where the surrounding class already uses them.

---

## Step 5 — Build and test (mandatory, even with no markers)

### Identify upstream/downstream module split

Map each changed file to its Maven module (directory containing `pom.xml`). If an upstream module
is depended on by a downstream changed module, install the upstream first — otherwise the downstream
compiles against a stale jar and gives a false result.

Example: `webapps-schema` (upstream, contains `TaskEntity`) → `zeebe/exporters/camunda-exporter`
(downstream, imports `TaskEntity`).

```bash
# Install upstream module so the downstream sees your edit
PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH" \
  ./mvnw install -pl <upstream-module> -Dquickly -T1C 2>&1 | tail -10

# Compile downstream
PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH" \
  ./mvnw compile -pl <downstream-module> -Dquickly -T1C 2>&1 | tail -20

# Run tests in the downstream module
PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH" \
  ./mvnw verify -pl <downstream-module> -DskipTests=false -Dquickly -T1C 2>&1 | tail -30
```

If all changes are in a single module, skip the install step and go straight to compile + verify.

- Compile fails on missing symbol → return to Step 4, Type B.
- Tests fail → diagnose with `ci-fix-failure` conventions; fix before proceeding.

---

## Step 6 — Format

```bash
PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH" \
  ./mvnw license:format spotless:apply -T1C 2>&1 | tail -10
```

Re-read reformatted files to confirm intent survived. Repeat if a subsequent edit is needed.

---

## Step 7 — Reword the placeholder, then commit

### 7.1 Reword the `BACKPORT-CONFLICT` commit (do this BEFORE staging anything)

The backport tool leaves a placeholder commit whose message is a bare, leading-space
` BACKPORT-CONFLICT` with no conventional-commit type. Left alone it **always** fails
Lint/Commitlint with `header must not start with whitespace [header-trim]` and
`type may not be empty`, and the `ci:ignore-commitlint` label does **not** suppress it — that label
is documentation only. Fix the message here rather than leaving it for ci-babysit to discover via a
red check.

The commit itself stays in history — you are changing only its **message**, not squashing it and not
altering its diff.

Nothing is staged yet at this point, so if the placeholder is still `HEAD` a plain amend rewords it
without touching content:

```bash
git log -1 --pretty=%s                      # confirm it is the ` BACKPORT-CONFLICT` placeholder
git commit --amend -m "fix: <same subject as the original PR>"
```

**If the placeholder is NOT `HEAD`** (e.g. a resumed session already committed on top), `--amend`
cannot reach it and `git rebase -i` is unavailable in this environment (it needs interactive input).
Use the non-interactive reword instead — replay the same diff under a new message, then replay the
rest of the branch on top:

```bash
git branch tmp-reword <placeholder_sha>^
git checkout tmp-reword
git cherry-pick --no-commit <placeholder_sha>
git commit -m "fix: <same subject as the original PR>"
git rebase --onto tmp-reword <placeholder_sha> <feature_branch>
git checkout <feature_branch>
git diff origin/<feature_branch> <feature_branch>   # MUST be empty: history rewritten, content identical
git branch -D tmp-reword
```

If that `git diff` is not empty, stop and report — the replay changed content, which it must not.
A rewritten history needs `--force-with-lease` in Step 8.

### 7.2 Commit the resolution

Stage only the edited files (no artifacts, no `target/`):

```bash
git add <file1> <file2> ...
git commit -m "fix: <same subject as the original PR>"
```

Conventional commit, subject max 120 chars, no trailer. Add a description (a second `-m`) only
when it earns its place — it explains something the subject can't: non-obvious code, a
workaround, or context a reviewer would otherwise be missing (e.g. why the conflict resolution
took this shape). Skip it when the subject already says enough; never restate the diff in prose.
Still no trailers — no Co-Authored-By, no other trailers. This is a new resolution commit on top of
the (now properly worded) original.

---

## Step 8 — Push and mark ready

```bash
git push origin HEAD
```

Step 7.1 rewrote the placeholder commit's message, so the remote's history no longer matches and a
plain push is rejected. Use a lease-guarded force — never a bare `--force`:

```bash
git push --force-with-lease origin HEAD
```

Then tell the user:

> "Push complete. About to mark PR #<N> as ready for review — this notifies CODEOWNERS and starts CI."

Wait for confirmation if the user is present, then:

```bash
gh pr ready <PR_NUMBER> --repo camunda/camunda
```

---

## Step 9 — Report

```
Resolved backport PR #<N> → stable/<X.Y>

Files edited:
- <file> (Type A|B|C): <one-sentence description of the resolution>
- ...

Build: <module> — <N> tests passed, 0 failures.
PR: https://github.com/camunda/camunda/pull/<N> — marked ready for review.
```

---

## Compose with

- `/ci-babysit` — if CI is red after the push.
- `ci-fix-failure` skill — if the module build fails and the root cause isn't obvious.
- `engine-expert` skill — if the backport touches Zeebe engine code and the conflict is deep.
