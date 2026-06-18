# /verify — Produce Verification Specs (Information-Only)

Read the feature diff and run artifacts to produce a seeding spec and a human-readable
manual-test document for Gate 3. **No cluster, Docker, Maven, or network access.**
This node only reads context and writes artifacts — it never touches Docker, Maven, or the cluster.

You have access to the following env vars:

- `$DEVHARNESS_SRC` — permanent camunda/camunda checkout
- `$DAGRUN_ARTIFACTS` — write all outputs here
- `$DAGRUN_RUN_ID` — the current dagrunner run ID
- `$DAGRUN_WORKTREE` — the worktree path (your cwd)
- `$DAGRUN_RUN_DIR` — the run directory (parent of all node artifact dirs)

---

## Step 1 — Read inputs

```bash
# Full feature diff
cd "$DAGRUN_WORKTREE" && git diff origin/main...HEAD

# Artifacts from earlier nodes (check existence before reading)
cat "$DAGRUN_RUN_DIR/plan/plan.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/expand/guide.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/expand/reflections.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/implement/reflections.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/review/findings.json" 2>/dev/null
cat "$DAGRUN_RUN_DIR/fix/summary.md" 2>/dev/null
```

---

## Step 2 — Produce `$DAGRUN_ARTIFACTS/seeding-spec.json`

Based on the diff and the plan, specify what data a human (or `/seed-data`) should seed to
demonstrate this feature end-to-end. The schema is:

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
      "expected_value": "<what to look for>",
      "how": "<concrete steps to find it — e.g. 'open Operate, navigate to instance X, check field Y'>"
    }
  ]
}
```

Rules:

- Derive everything from the diff — use the actual changed code paths to decide what to seed.
- `expected_observations` must reference the specific fields or behavior introduced by this PR
  (e.g. the exact Elasticsearch field, the REST API response field, the log message).
- Each `how` must be a concrete, actionable step the human can follow without guessing.
- Keep it minimal: the minimum seeding that proves the feature works, not a full test suite.
- Write valid JSON to `$DAGRUN_ARTIFACTS/seeding-spec.json`.

---

## Step 3 — Produce `$DAGRUN_ARTIFACTS/manual-test.md`

Render a human-readable, step-by-step verification guide. The human verifier will:

1. Have an Orchestration Cluster already running (they set that up themselves).
2. Run `/seed-data` to seed the cluster from `seeding-spec.json`.
3. Follow this document to verify the feature works.

Structure:

```markdown
# Manual Verification Guide — <feature name from plan.md>

## Feature summary

<One paragraph describing what this PR does and what behavior it introduces.
Derived from the diff and plan — write it for a human who hasn't read the code.>

## Prerequisites

- A local Orchestration Cluster is running. Start one via `c8ctl dev` if not already up.
- You are in the feature worktree (the worktree path for this run).

## Step 1 — Seed the cluster

Run the `/seed-data` command. It reads `seeding-spec.json` and will:

**Deploy:**
<For each deployment: what it is and why it exercises the feature>

**Start instances:**
<For each instance: process ID, key variables, and why this instance is needed>

Wait for `/seed-data` to confirm all deployments and instances are active before continuing.

## Step 2 — Verify the feature

Follow these steps in order. Each step corresponds to an expected observation introduced by this PR.

<For each expected_observation in seeding-spec.json, produce a numbered step:>

### N. <short label for what is being verified>

**Where:** <the system to check — e.g. Operate, Elasticsearch, Tasklist, REST API, logs>

**What to do:** <the concrete how from seeding-spec.json — exactly what to navigate to or query>

**Expected result:** <the expected_value — what you should see if the feature is working>

<Repeat for each observation.>

## Notes for the reviewer

<Any non-obvious interactions with the running system — e.g. timing (wait N seconds for indexing),
required feature flags, known limitations of this approach, or edge cases to watch for.
Leave this section empty if there is nothing to add.>
```

---

## Constraints

- **Read-only from the worktree.** Do not modify any file under `$DAGRUN_WORKTREE`.
- Write both artifacts to `$DAGRUN_ARTIFACTS/` only.
- No Maven, Docker, `java`, `curl`, or any cluster command.
- `seeding-spec.json` must be valid JSON (no trailing commas, no comments).
- Every verification step in `manual-test.md` must be concrete and actionable — no vague instructions like "check the database".

## Reflections (optional, do this last)

After both artifacts are written, write any tips about the feature surface or
verification approach to $DAGRUN_ARTIFACTS/reflections.md. The SessionEnd hook
captures this automatically. Absence is fine.
