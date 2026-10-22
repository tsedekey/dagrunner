---
name: review
description: Dagrunner review node. Orchestrates a read-only multi-reviewer analysis of the staged diff and produces a schema-valid findings.json. Invoked only by the dagrunner engine as /review.
disable-model-invocation: true
---

You are running the **review node** of a dagrunner pipeline. Your job is to orchestrate a read-only multi-reviewer analysis of the changes in this worktree and produce a single schema-valid `findings.json` artifact.

**CRITICAL: Do NOT modify any files in the worktree. This node is read-only.**

---

> **Runtime.** This skill is run by both dagrunner runtimes (Claude Code and GitHub Copilot) and is
> the single source for the `/review` node. "Dispatch a subagent" means the Agent tool in Claude Code
> and the `task` tool in Copilot; the reviewer agent files are the same for both.
>
> **Run environment.** The block directly below gives the **literal absolute** `artifactsDir`,
> `runDir`, `worktree` and `runId` for this session. Wherever this document writes `<artifactsDir>`,
> `<runDir>`, `<worktree>` or `<runId>`, substitute those literal values — type the real path, never a
> shell variable: the sandbox rejects Bash commands that contain a variable expansion
> (`simple_expansion`), which cost earlier runs dozens of denied calls.
>
> - **Read** upstream artifacts at `<runDir>/<node>/<file>` with the Read tool (or `cat` of the literal path).
> - **Write** your artifacts to `<artifactsDir>/<file>` with the Write tool using that exact absolute
>   path. `runDir` is read-only.
> - Never print or discover environment variables (`echo`, `printenv`, `env`).

Run environment (engine-provided):

$ARGUMENTS

## Step 0 — Deliverables cross-check

Read via `cat`:

```bash
cat "<runDir>/plan/plan.md"
cat "<runDir>/define/guide.md"
```

Extract every explicitly required deliverable: new files, new test classes, new modules, and any
item phrased as "must", "required", or listed under "Key implementation steps" or "Acceptance
criteria".

Get the full list of changed files from the staged diff:

```bash
git diff --cached --name-only origin/main
```

For each required deliverable that does NOT appear in the changed-files list, add a finding to
your final findings.json:

```json
{
  "reviewer_dimension": "test-adequacy",
  "severity": "blocker",
  "confidence": "high",
  "file": "<expected file path from the guide>",
  "line": 1,
  "claim": "Required deliverable '<name>' is absent from the diff — it was specified in the guide but no matching file was staged.",
  "grounded": true
}
```

This step runs BEFORE the diff-based reviewers. Its findings are merged into the final
findings.json alongside reviewer output in Step 4. Do not write a separate artifact.

---

## Step 1 — Diff-triage (haiku, internal step)

Get the diff of all changes introduced by this worktree branch relative to the base branch:

```bash
git diff --cached origin/main
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

Save all five triage booleans in memory — you will write them into findings.json in Step 4.

---

## Step 2 — Dispatch reviewers as subagents

Dispatch each selected reviewer as a **subagent** (the Agent tool in Claude Code, the `task` tool in Copilot), naming the agent exactly (e.g. `reviewer-correctness`). Run them in parallel where possible (multiple subagent calls in a single turn).

Each reviewer returns a JSON array of finding objects. If a **non-correctness** reviewer fails (errors out or returns invalid JSON), degrade it: record it in `reviewers_skipped` with `{ "name": "<reviewer>", "reason": "<error>" }` and continue. If the **correctness** reviewer fails, fail the entire node by writing an error to stderr and exiting.

**Do not review the diff yourself — dispatching the subagents IS the job.** Your own reading of the diff
is only for the triage booleans; every finding must come from a reviewer subagent, even for a tiny diff.
Every reviewer you list in `reviewers_run` must have been dispatched as a subagent in this session.
On Copilot the engine counts the subagents it observed and FAILS the node (it will be re-run) when
`reviewers_run` lists more reviewers than subagents that started.

- Claude Code: the Agent tool, `subagent_type` = the reviewer name.
- Copilot: the `task` tool, `agent_type` = the reviewer name (e.g. `reviewer-correctness`), and put the
  diff (or the exact command to obtain it) plus the acceptance criteria in `prompt`. Issue all the
  reviewer `task` calls in one turn so they run in parallel.

Collect all findings arrays from successful reviewers. Flatten them into a single array.

---

## Step 3 — Adversarial verifier (runtime threshold)

Count the total number of findings in the merged array.

**If `findings.length > 3`:**

- Dispatch `reviewer-adversarial-verifier` as a subagent
- Pass it the merged findings array (all findings from Step 2) as JSON in the prompt: `"Here are the findings to verify:\n\n<findings JSON>"`
- The verifier returns the same array with `grounded: boolean` added to each item
- Replace the findings array with the verifier's output
- Set `adversarial_verifier_run: true`

**If `findings.length <= 3`:**

- Set `grounded: true` on all findings (small set — reviewer claims are taken at face value)
- Set `adversarial_verifier_run: false`

---

## Step 4 — Write findings.json

Write the following JSON object to `<artifactsDir>/findings.json`. **Exception:** if the prompt ends with a
`<runtime-note>` saying your final reply is the findings document, do NOT write the file — make your
final reply exactly that JSON object (the engine writes the file from it):

```json
{
  "run_id": "<the runId from the run environment block>",
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

Optionally write `<artifactsDir>/reflections.md` if you observed anything that would help
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

- Read-only: do not edit, write to, or run commands that modify files in the worktree (only write to `<artifactsDir>/`).
- The findings.json must be written to `<artifactsDir>/findings.json` — NOT to the worktree.
- `reviewers_skipped` must be an array (empty `[]` if all reviewers ran successfully).
- Every finding must have all seven fields including `grounded`.
- An empty findings array `"findings": []` is valid and correct when no issues are found.
- `triage` must always be present with all five boolean fields (including `touches_ui`).

---
