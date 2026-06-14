# /verify-guide — Produce Verification Specs (Information-Only)

Read the feature diff and run artifacts to produce a seeding spec, a code-tour spec, and a
human-readable manual-test document for Gate 3. **No cluster, Docker, Maven, or network access.**
This node only reads context and writes artifacts — it cannot fail the way verify-seed did.

You have access to the following env vars:

- `$DEVHARNESS_SRC` — permanent camunda/camunda checkout
- `$DAGRUN_ARTIFACTS` — write all outputs here
- `$DAGRUN_RUN_ID` — the current dagrunner run ID
- `$DAGRUN_WORKTREE` — the worktree path (your cwd)
- `$DAGRUN_RUN_DIR` — the run directory (parent of all node artifact dirs)

---

## Step 1 — Read inputs

```bash
# Full feature diff (this is the source of truth for file:line breakpoints)
cd "$DAGRUN_WORKTREE" && git diff origin/main...HEAD

# Artifacts from earlier nodes (check existence before reading)
cat "$DAGRUN_RUN_DIR/plan/plan.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/expand-guide/guide.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/expand-guide/notes.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/implement/notes.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/review/findings.json" 2>/dev/null
cat "$DAGRUN_RUN_DIR/fix/summary.md" 2>/dev/null
```

---

## Step 2 — Produce `$DAGRUN_ARTIFACTS/seeding-spec.json`

Based on the diff and the plan, specify what data a human (or a future `/verify-demo` command)
should seed to demonstrate this feature end-to-end. The schema is:

```json
{
  "deployments": [
    {
      "description": "<what BPMN process or resource to deploy>",
      "why": "<why this deployment exercises the feature>"
    }
  ],
  "instances": [
    {
      "process_id": "<process definition ID>",
      "variables": { "<key>": "<value>" },
      "why": "<why this instance exercises the feature>"
    }
  ],
  "expected_observations": [
    {
      "where": "elasticsearch|operate|tasklist|rest-api|logs",
      "what": "<field or observable>",
      "expected_value": "<what to look for>"
    }
  ]
}
```

Rules:

- Derive everything from the diff — use the actual changed code paths to decide what to seed.
- `expected_observations` must reference the specific fields or behavior introduced by this PR
  (e.g. the exact Elasticsearch field, the REST API response field, the log message).
- Keep it minimal: the minimum seeding that proves the feature works, not a full test suite.
- Write valid JSON to `$DAGRUN_ARTIFACTS/seeding-spec.json`.

---

## Step 3 — Produce `$DAGRUN_ARTIFACTS/tour-spec.json`

Produce a guided code-trail of the change, with concrete file:line breakpoints resolved from
the diff. A human developer (or IDE debugger) should be able to follow this tour to observe
the feature executing.

```json
{
  "feature_summary": "<one-paragraph summary of what this PR does>",
  "breakpoints": [
    {
      "file": "<relative path from repo root>",
      "line": <integer — must be a real line in the post-change file>,
      "why": "<why this location matters for the feature>",
      "what_to_observe": "<what to look at / watch in the debugger at this point>"
    }
  ],
  "before_path": [
    {
      "file": "<relative path>",
      "line": <integer — pre-change line>,
      "note": "<what this line used to do, for contrast>"
    }
  ]
}
```

Rules:

- `breakpoints` are **ordered**: they form a tour — entry point first, then the key call sites,
  then the output/persistence point.
- All `file` + `line` values in `breakpoints` MUST resolve to real lines in the post-change
  worktree. Derive them from the diff: look at the `+` lines (additions) and the unchanged
  context around them.
- `before_path` shows removed or modified lines for contrast. For **pure additions** (new files
  or entirely new code blocks), `before_path` may be an empty array — that is correct, not an error.
- Minimum 2 breakpoints; maximum 8. Pick the highest-signal locations.
- Write valid JSON to `$DAGRUN_ARTIFACTS/tour-spec.json`.

**Verifying your line numbers:** After writing tour-spec.json, spot-check at least one breakpoint:

```bash
sed -n "<line>p" "$DAGRUN_WORKTREE/<file>"
```

Confirm the output matches your `what_to_observe` note. If it doesn't, correct the line number.

---

## Step 4 — Produce `$DAGRUN_ARTIFACTS/manual-test.md`

Render a human-readable test guide from the two specs above. This is what Gate 3 presents to
the reviewer. Structure:

```markdown
# Manual Verification Guide — <feature name from plan.md>

## Feature summary

<feature_summary from tour-spec.json>

## What to seed

### Deploy

<For each deployment in seeding-spec.json: what to deploy and why>

### Start instances

<For each instance: process ID, variables, why>

### Expected observations

| Where | What to look for | Expected value |
| ----- | ---------------- | -------------- |
| ...   | ...              | ...            |

## Code tour (breakpoints for the debugger)

Follow in order:

| #   | File | Line | Why | What to observe |
| --- | ---- | ---- | --- | --------------- |
| 1   | ...  | ...  | ... | ...             |

<If before_path is non-empty:>
### Before (contrast)
| File | Line | Note |
|------|------|------|
| ...  | ...  | ...  |

## Notes for the reviewer

<Any non-obvious interaction with the running system — e.g. timing, required feature flags,
known limitations of this approach. Leave empty if nothing to add.>
```

---

## Constraints

- **Read-only from the worktree.** Do not modify any file under `$DAGRUN_WORKTREE`.
- Write all three artifacts to `$DAGRUN_ARTIFACTS/` only.
- No Maven, Docker, `java`, `curl`, or any cluster command.
- All file:line values in tour-spec.json must be verified against the actual post-change files.
- seeding-spec.json and tour-spec.json must be valid JSON (no trailing commas, no comments).
