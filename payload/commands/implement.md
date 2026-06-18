Read the implementation guide at $DAGRUN_ARTIFACTS/../expand/guide.md.

Also check for any reviewer feedback files at $DAGRUN_ARTIFACTS/../expand/feedback-\*.md.
If any feedback files exist, incorporate those instructions into the implementation — they represent
reviewer requests that were not fully addressed in the guide itself.

Write a brief implementation summary to $DAGRUN_ARTIFACTS/summary.md describing:

1. What was implemented
2. Files changed (can be hypothetical for smoke test purposes)

Keep it under 100 words. Write to $DAGRUN_ARTIFACTS/summary.md.

Optionally, if you discover non-obvious facts about the Camunda code area while implementing
(hidden coupling, module quirks, surprising invariants), write them to $DAGRUN_ARTIFACTS/notes.md.
Only write notes.md if there is something genuinely useful for future runs. Absence is fine.

## Final step — Commit implementation

After writing all artifacts, commit your code changes to the worktree:

```bash
cd "$DAGRUN_WORKTREE"
git add -A
git status --short
```

If the working tree is already clean (nothing to commit), note it in summary.md and skip the commit.

Otherwise commit with a title derived from the first heading in `$DAGRUN_ARTIFACTS/../expand/guide.md`:

```bash
git commit -m "feat: <concise title ≤70 chars from guide.md>"
```

Do not push — the pr node handles the push.

## Capture tips (best-effort, do this last)

After all artifacts are written and the commit is made, append any useful tips or
gotchas about this code area or the implementation process. Fail-soft — call last,
don't worry if it fails:

```bash
dagrun reflect-append \
  --source implement \
  --kind dagrunner-harness \
  --body "<one or two sentences: hidden coupling, build quirk, or pattern worth flagging>" \
  --run-id "$DAGRUN_RUN_ID" || true
```

Only call this if you discovered something non-obvious. Absence is fine.
