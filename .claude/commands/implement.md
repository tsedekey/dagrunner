Read the implementation guide at $DAGRUN_ARTIFACTS/../expand-guide/guide.md.

Also check for any reviewer feedback files at $DAGRUN_ARTIFACTS/../expand-guide/feedback-\*.md.
If any feedback files exist, incorporate those instructions into the implementation — they represent
reviewer requests that were not fully addressed in the guide itself.

Write a brief implementation summary to $DAGRUN_ARTIFACTS/summary.md describing:

1. What was implemented
2. Files changed (can be hypothetical for smoke test purposes)

Keep it under 100 words. Write to $DAGRUN_ARTIFACTS/summary.md.

Optionally, if you discover non-obvious facts about the Camunda code area while implementing
(hidden coupling, module quirks, surprising invariants), write them to $DAGRUN_ARTIFACTS/notes.md.
Only write notes.md if there is something genuinely useful for future runs. Absence is fine.
