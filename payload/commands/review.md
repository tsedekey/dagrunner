You are running the **review node** of a dagrunner pipeline. Your job is to orchestrate a read-only multi-reviewer analysis of the changes in this worktree and produce a single schema-valid `findings.json` artifact.

**CRITICAL: Do NOT modify any files in the worktree. This node is read-only.**

---

## Step 1 — Diff-triage (haiku, internal step)

Get the diff of all changes introduced by this worktree branch relative to the base branch:

```bash
git diff origin/main...HEAD
```

Read the diff and set these five booleans:

- `touches_public_api`: does the diff add or change a public API endpoint, public method signature, or exported interface?
- `touches_runtime`: does it change runtime/async/distributed behavior, job workers, or concurrency logic?
- `touches_schema_or_proto`: does it add or change a DB schema, proto definition, Avro schema, or migration file?
- `performance_sensitive`: could it affect hot-path latency, throughput, or memory use?
- `touches_ui`: does the diff add or change UI components, templates, CSS, routing, or user-facing strings in a frontend?

Use **only the diff** as input (not the plan). This triage is an internal step — do not write it as a separate artifact.

Determine which reviewers to run:

**Always run:**

- `reviewer-correctness`
- `reviewer-test-adequacy`

**Conditionally run:**

- `reviewer-api-stability` — if `touches_public_api`
- `reviewer-distributed-systems` — if `touches_runtime`
- `reviewer-migration-safety` — if `touches_schema_or_proto`
- `reviewer-performance` — if `performance_sensitive`

Save all five triage booleans in memory — you will write them into findings.json in Step 4, including `manual_test_recommendation` (computed from `touches_public_api` and `touches_ui`).

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
  "timestamp": "<ISO 8601 timestamp>",
  "triage": {
    "touches_public_api": true/false,
    "touches_runtime": true/false,
    "touches_schema_or_proto": true/false,
    "performance_sensitive": true/false,
    "touches_ui": true/false
  },
  "reviewers_run": ["<names of reviewers that completed successfully>"],
  "reviewers_skipped": [{ "name": "...", "reason": "..." }],
  "adversarial_verifier_run": true/false,
  "manual_test_recommendation": {
    "recommended": "<true if touches_public_api OR touches_ui, else false>",
    "surface": "<'ui' if touches_ui; 'api' if touches_public_api and not touches_ui; 'none' otherwise>",
    "rationale": "<one sentence: why a manual test is or is not worthwhile for this change>"
  },
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

## Step 5 — Optional reflections (write only if substantive)

Optionally write `$DAGRUN_ARTIFACTS/reflections.md` if you observed anything that would help
future implementations in this code area avoid the same class of issue. Good candidates:

- A recurring anti-pattern across multiple findings (e.g. "every public method in this module
  omits null-check on the entity arg — callers must guard upstream").
- A module invariant that was violated and is easy to miss.
- A finding dimension (e.g. migration-safety) that fired here but would not be obvious from
  reading the code — worth flagging to future define and implement runs.

**Absence is fine.** Only write reflections.md if there is something genuinely non-obvious that
reduces friction for future runs in this code area. Do not summarise the findings themselves —
those are already in findings.json. The SessionEnd hook captures this file automatically.

---

## Constraints

- Read-only: do not edit, write to, or run commands that modify files in the worktree (only write to `$DAGRUN_ARTIFACTS/`).
- The findings.json must be written to `$DAGRUN_ARTIFACTS/findings.json` — NOT to the worktree.
- `reviewers_skipped` must be an array (empty `[]` if all reviewers ran successfully).
- Every finding must have all seven fields including `grounded`.
- An empty findings array `"findings": []` is valid and correct when no issues are found.
- `triage` must always be present with all five boolean fields (including `touches_ui`).

---
