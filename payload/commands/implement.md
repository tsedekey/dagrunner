## Known environment constraints (read before starting)

These facts are pre-verified — do not re-investigate them:

- **Maven:** use `./mvnw <goal>` directly. The bare `./mvnw *` pattern is allow-listed.
  Do NOT prefix with `JAVA_HOME=...` or any other env variable — that pattern is not
  allow-listed and will be blocked. If Maven fails with a permission error, the cause is
  the env prefix, not the command itself.
- **Format hook:** the PostToolUse formatter covers frontend files only (TypeScript, JS, CSS).
  Java and Kotlin files do not need a manual format call after editing.
- **`.tool-versions` / Java version:** the worktree does not have its own `.tool-versions`.
  Java is declared in the main repo root (`$DEVHARNESS_SRC/.tool-versions`). `asdf` resolves
  it from the parent directory automatically — no action needed.

---

Read the implementation guide. Check these paths in order and use the first one that exists:

1. `$DAGRUN_ARTIFACTS/../define/guide.md` (feature workflow)
2. `$DAGRUN_ARTIFACTS/../reproduce/guide.md` (bugfix workflow)

Also check for any reviewer feedback files at the same directory as the guide (`feedback-\*.md`).
If any feedback files exist, incorporate those instructions into the implementation — they represent
reviewer requests that were not fully addressed in the guide itself.

Write a brief implementation summary to $DAGRUN_ARTIFACTS/summary.md describing:

1. What was implemented
2. Files changed (can be hypothetical for smoke test purposes)

Keep it under 100 words. Write to $DAGRUN_ARTIFACTS/summary.md.

Optionally, if you discover non-obvious facts about the Camunda code area while implementing
(hidden coupling, module quirks, surprising invariants), write them to $DAGRUN_ARTIFACTS/reflections.md.
Only write reflections.md if there is something genuinely useful for future runs. Absence is fine.

## Final step — Commit implementation

After writing all artifacts, commit your code changes to the worktree:

```bash
cd "$DAGRUN_WORKTREE"
git add -A
git status --short
```

If the working tree is already clean (nothing to commit), note it in summary.md and skip the commit.

Otherwise commit with a title derived from the first heading in the guide.md you read in Step 1:

```bash
git commit -m "${DAGRUN_PR_TITLE_PREFIX:-feat} <concise title ≤70 chars from guide.md>"
```

Do not push — the pr node handles the push.

## Reflections (optional, do this last)

After all artifacts are written and the commit is made, write any high-signal tips
to $DAGRUN_ARTIFACTS/reflections.md — hidden couplings, build quirks, patterns worth
flagging for future runs. The SessionEnd hook captures this automatically.
Absence is fine — only write if you discovered something non-obvious.
