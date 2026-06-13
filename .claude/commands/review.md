You are running the **review node** of a dagrunner pipeline. Your job is to orchestrate a read-only multi-reviewer analysis of the changes in this worktree and produce a single schema-valid `findings.json` artifact.

**CRITICAL: Do NOT modify any files in the worktree. This node is read-only.**

---

## Step 1 — Read classify output

Read the classify artifact:

```
$DAGRUN_ARTIFACTS/../classify/classify.json
```

Determine which conditional reviewers to run based on the flags:

- `touches_public_api` → include `reviewer-api-stability`
- `touches_runtime` → include `reviewer-distributed-systems`
- `perf_sensitive` → include `reviewer-performance`
- `touches_schema_or_proto` → include `reviewer-migration-safety`

These two always run regardless of flags:

- `reviewer-correctness`
- `reviewer-test-adequacy`

---

## Step 2 — Dispatch reviewers as subagents

Use the **Agent tool** to dispatch each selected reviewer. Run them in parallel where possible (multiple Agent tool calls in a single turn).

Each reviewer returns a JSON array of finding objects. If a **non-correctness** reviewer fails (errors out or returns invalid JSON), degrade it: record it in `reviewers_skipped` with `{ "name": "<reviewer>", "reason": "<error>" }` and continue. If the **correctness** reviewer fails, fail the entire node by writing an error to stderr and exiting.

Collect all findings arrays from successful reviewers. Flatten them into a single array.

---

## Step 3 — Adversarial verifier (runtime threshold)

Count the total number of findings in the merged array.

**If `findings.length > 3`:**

- Use the **Agent tool** to dispatch `reviewer-adversarial-verifier`
- Pass it the merged findings array (all findings from Step 2) as JSON in the prompt: `"Here are the findings to verify:\n\n<findings JSON>"`
- The verifier returns the same array with `grounded: boolean` added to each item
- Replace the findings array with the verifier's output
- Set `adversarial_verifier_run: true`

**If `findings.length <= 3`:**

- Set `grounded: true` on all findings (small set — reviewer claims are taken at face value)
- Set `adversarial_verifier_run: false`

---

## Step 4 — Write findings.json

Write the following JSON object to `$DAGRUN_ARTIFACTS/findings.json`:

```json
{
  "run_id": "<value of $DAGRUN_RUN_ID env var>",
  "timestamp": "<ISO 8601 timestamp, e.g. new Date().toISOString()>",
  "reviewers_run": ["<names of reviewers that completed successfully>"],
  "reviewers_skipped": [{ "name": "...", "reason": "..." }],
  "adversarial_verifier_run": true/false,
  "findings": [
    {
      "reviewer_dimension": "correctness|test-adequacy|api-stability|distributed-systems|performance|migration-safety",
      "severity": "blocker|major|minor|nit",
      "confidence": "high|med|low",
      "file": "relative/path/to/file",
      "line": 42,
      "claim": "One sentence describing the issue.",
      "grounded": true/false
    }
  ]
}
```

The file must be valid JSON matching that schema exactly. Do not write any other files to the worktree.

---

## Constraints

- Read-only: do not edit, write to, or run commands that modify files in the worktree (only write to `$DAGRUN_ARTIFACTS/`).
- The findings.json must be written to `$DAGRUN_ARTIFACTS/findings.json` — NOT to the worktree.
- `reviewers_skipped` must be an array (empty `[]` if all reviewers ran successfully).
- Every finding must have all seven fields including `grounded`.
- An empty findings array `"findings": []` is valid and correct when no issues are found.
