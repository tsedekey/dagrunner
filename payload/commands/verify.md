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

Read in this priority order:

1. **Artifacts from earlier nodes** — these are the definitive record of what changed and what was built; use them as the primary source for deciding what to seed and test.
2. **Git log** — commit summaries confirm scope and intent.
3. **Git diff** — use to identify specific changed code paths and REST endpoint signatures.
4. **OpenAPI spec** — required to ground any `rest-api` observations in Step 2 with the correct HTTP method, path, and request schema.

```bash
# 1. Artifacts from earlier nodes (check existence before reading)
cat "$DAGRUN_RUN_DIR/plan/plan.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/define/guide.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/define/reflections.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/implement/reflections.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/review/findings.json" 2>/dev/null
cat "$DAGRUN_RUN_DIR/fix/summary.md" 2>/dev/null

# 2. Recent commits on this branch
cd "$DAGRUN_WORKTREE" && git log origin/main..HEAD --oneline

# 3. Full feature diff
cd "$DAGRUN_WORKTREE" && git diff origin/main...HEAD

# 4. Locate the Camunda REST API OpenAPI spec (used in Step 2 to verify REST endpoints)
find "$DAGRUN_WORKTREE" \( -name "openapi.yaml" -o -name "openapi.json" \) \
  ! -path "*/target/*" ! -path "*/node_modules/*" ! -path "*/.git/*" | head -5
```

For each REST endpoint you identify from the diff, grep the spec for that path before writing
any `expected_observations` entry — do not read the full spec file.

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
      "where": "rest-api",
      "what": "<field or observable>",
      "expected_value": "<what to look for>",
      "how": "<concrete steps to find it — e.g. 'open Operate, navigate to instance X, check field Y'>"
    }
  ]
}
```

Rules:

- Derive everything from the artifacts and diff — the implement reflections and fix summary are the
  primary record of what changed; the diff confirms specific code paths.
- `expected_observations` must reference the specific REST API behavior introduced by this PR
  (e.g. the correct response status, response body fields, or error shape).
- Each `how` must be a concrete, actionable Postman call the human can follow without guessing.
- Keep it minimal: the minimum seeding that proves the feature works, not a full test suite.
- `expected_observations` must only use `where: "rest-api"` — verification is done via the user's own Postman collection. No Elasticsearch queries, no curl commands, no UI steps.
- **REST observations must be spec-grounded**: for every `where: "rest-api"` observation, grep
  the OpenAPI spec for the relevant endpoint path _before_ writing the `how` field. Copy the
  exact HTTP method, path parameters, and required requestBody fields from the spec. Never guess
  the HTTP method — a wrong method (e.g. POST instead of PATCH) produces an unusable spec.
- For `bpmn_resource`: only reference a file if a suitable `.bpmn` already exists in the worktree (search `$DAGRUN_WORKTREE` for a file whose `process id` matches). If none exists, **omit `bpmn_resource` entirely** — do not create BPMN files. seed-data generates what it needs at seeding time.
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
- Your Postman collection (linked to the Camunda REST API spec) is open and its base URL points to your local cluster.
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

**Where:** REST API — use your Postman collection

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
