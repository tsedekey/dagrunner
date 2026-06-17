You are running the **fix node** of a dagrunner pipeline. Your job is to apply targeted code fixes for high-confidence review findings, self-verify the result, and write a summary artifact.

---

## Step 1 — Read findings

Read the review artifact:

```
$DAGRUN_ARTIFACTS/../review/findings.json
```

Filter to the **actionable findings**: those with `confidence: "high"` AND `severity` of `"blocker"` or `"major"`.

If there are no actionable findings (the list is empty after filtering), write a summary at `$DAGRUN_ARTIFACTS/summary.md` stating "No high-confidence blocker/major findings to fix." and exit. The gate will still pause for human review.

---

## Step 2 — Apply fixes

For each actionable finding in order:

1. Read the cited file at the cited line to understand the context.
2. Apply the minimal correct fix — only the code needed to address the finding. Do not refactor beyond the scope of the issue.
3. After each fix, verify the file still compiles / parses (run `npx tsc --noEmit` for TypeScript files in the `ts/` directory; run `cd java && ./mvnw compile -q` for Java files if a `java/pom.xml` is present).

---

## Step 3 — Self-verification

After all fixes are applied, run this checklist:

**a) Addressed-each-finding checklist:**
For each actionable finding you targeted, confirm:

- The cited (file, line) has been changed
- The specific issue described in `claim` is resolved

Write the checklist to `$DAGRUN_ARTIFACTS/addressed-checklist.md`:

```markdown
# Addressed findings checklist

| Finding              | File    | Line | Addressed? | Notes        |
| -------------------- | ------- | ---- | ---------- | ------------ |
| correctness: <claim> | file.ts | 42   | YES/NO     | <brief note> |
```

**b) Build/test post-condition:**
Run the project's tests to confirm nothing is broken:

- If a `ts/package.json` is present: `npm --prefix ts test`
- If a `java/pom.xml` is present: `cd java && ./mvnw test -q` (this pattern is allow-listed)
- If a root `package.json` is present with a `test` script: `npm test`
- For any other project type: run the standard test command from the README

If tests fail, attempt one fix per failing test. If tests still fail after the fix attempt, note it in the summary — do NOT silently skip.

---

## Step 4 — Write summary

Write `$DAGRUN_ARTIFACTS/summary.md`:

```markdown
# Fix summary

## Changes made

- <file>: <what was changed and why>
- ...

## Findings addressed

| Dimension   | Severity | File               | Claim | Status |
| ----------- | -------- | ------------------ | ----- | ------ |
| correctness | major    | ts/src/discount.ts | ...   | FIXED  |

## Findings deferred (low confidence or nit)

| Dimension | Severity | File | Claim | Reason deferred |
| --------- | -------- | ---- | ----- | --------------- |

## Build/test result

<PASSED / FAILED — include the test output tail if FAILED>
```

---

## Step 5 — Write notes.md

Write `$DAGRUN_ARTIFACTS/notes.md`. This file is **required** whenever fixes were applied.

If there is nothing non-obvious to report, write a single line: `No non-obvious discoveries.`

Otherwise document any of the following:

- Hidden coupling that forced you to touch files beyond the directly cited location.
- A deferred finding that looks systemic (the same root cause likely exists in other places
  in this module — worth flagging to future runs).
- A build or test quirk that surprised you (flaky test, undocumented compile dependency,
  classpath issue).
- A root-cause pattern behind multiple findings (e.g. "three blockers trace back to the same
  missing transaction boundary in the service layer").
- Any automatic reformatting (e.g. a formatter hook changed additional files beyond your edits).

Do not recap the summary — that is already in summary.md.

---

## Constraints

- Fix ONLY findings with `confidence: "high"` AND `severity` of `"blocker"` or `"major"`. Defer everything else.
- Do not make speculative improvements beyond what the findings require.
- Do not modify `$DAGRUN_ARTIFACTS/../review/findings.json` — it is the read-only input.
- Write all artifacts to `$DAGRUN_ARTIFACTS/` (summary.md, addressed-checklist.md, notes.md).
- If a build or test step is unavailable (no build tool found), note it in the summary and continue.
