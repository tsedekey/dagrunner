---
description: Generate a human-readable manual verification guide + seeding spec on demand from a completed (or past-Gate-1) dagrunner run's artifacts — the old read-only verify-guide behavior, relocated out of the autonomous pipeline. Gates nothing.
argument-hint: [run-id]
---

# /manual-smoke — On-Demand Manual Verification Guide

**Input**: $ARGUMENTS

Produces the same `seeding-spec.json` + `manual-test.md` pair the pipeline's `verify` node used
to write before the verify-autonomy change (see `docs/dagrunner-master-architecture.md` §3 and
DECISIONS.md § verify-autonomy-remove-election). `verify` is now a fully autonomous
acceptance-test author/runner/judge/gate and no longer produces these human-facing documents —
this sibling exists so a human can still get that value, on demand, from a run's existing
artifacts (diff, `guide.md`, `summary.md`, OpenAPI grounding). **It is NOT part of the autonomous
pipeline and gates nothing** — invoke it whenever you want a manual-smoke-test walkthrough for a
run, regardless of that run's `verify` outcome.

**Read-only from the worktree.** This command never modifies worktree files — only writes into
the run's own `manual-smoke/` artifact subdirectory.

**Scripts:** bootstrap logic lives in `.claude/scripts/manual-smoke/`. The MD calls it; edit the
script for run/worktree-resolution logic changes.

---

## Phase 0 — Resolve the run, worktree, and guide

```bash
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/scripts/manual-smoke"
zsh "$SCRIPT_DIR/phase-0-bootstrap.sh" "$ARGUMENTS"
```

**PHASE_0_CHECKPOINT:**

- [ ] `manual-smoke-state.json` written under the run's `manual-smoke/` artifact dir with
      `run_id`, `run_dir`, `worktree`, `guide_path`, `artifacts`
- [ ] Read the printed `State:` path and use its `artifacts` value as your output directory for
      the rest of this command, and its `worktree`/`run_dir`/`guide_path` values in place of
      `$DAGRUN_WORKTREE`/`$DAGRUN_RUN_DIR` below

---

## Step 1 — Read inputs

Read in this priority order (paths relative to the resolved `run_dir` / `worktree` from Phase 0):

1. **Artifacts from the run** — these are the definitive record of what changed and what was
   built; use them as the primary source for deciding what to seed and test.
2. **Git log** — commit summaries confirm scope and intent.
3. **Git diff** — use to identify specific changed code paths and REST endpoint signatures.
4. **OpenAPI spec** — required to ground any `rest-api` observations in Step 2 with the correct
   HTTP method, path, and request schema.

```bash
# 1. Artifacts from the run (check existence before reading)
cat "<run_dir>/plan/plan.md" 2>/dev/null
cat "<guide_path>" 2>/dev/null   # define/guide.md or reproduce/guide.md, per Phase 0
cat "<run_dir>/implement/reflections.md" 2>/dev/null
cat "<run_dir>/review/findings.json" 2>/dev/null
cat "<run_dir>/fix/summary.md" 2>/dev/null
cat "<run_dir>/verify/verify-plan.md" 2>/dev/null    # optional — verify's own acceptance-test plan, if present

# 2. Recent commits on this branch
cd "<worktree>" && git log origin/main..HEAD --oneline

# 3. Full feature diff
cd "<worktree>" && git diff origin/main...HEAD

# 4. Locate the Camunda REST API OpenAPI spec (used in Step 2 to verify REST endpoints)
find "<worktree>" \( -name "openapi.yaml" -o -name "openapi.json" \) \
  ! -path "*/target/*" ! -path "*/node_modules/*" ! -path "*/.git/*" | head -5
```

For each REST endpoint you identify from the diff, grep the spec for that path before writing any
`expected_observations` entry — do not read the full spec file.

---

## Step 2 — Produce `<artifacts>/seeding-spec.json`

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

- Derive everything from the artifacts and diff — the implement reflections and fix summary are
  the primary record of what changed; the diff confirms specific code paths.
- `expected_observations` must reference the specific REST API behavior introduced by this change
  (e.g. the correct response status, response body fields, or error shape).
- Each `how` must be a concrete, actionable Postman call the human can follow without guessing.
- Keep it minimal: the minimum seeding that proves the feature works, not a full test suite.
- `expected_observations` must only use `where: "rest-api"` — verification is done via the user's
  own Postman collection. No Elasticsearch queries, no curl commands, no UI steps.
- **REST observations must be spec-grounded**: for every `where: "rest-api"` observation, grep the
  OpenAPI spec for the relevant endpoint path _before_ writing the `how` field. Copy the exact HTTP
  method, path parameters, and required requestBody fields from the spec. Never guess the HTTP
  method — a wrong method (e.g. POST instead of PATCH) produces an unusable spec.
- For `bpmn_resource`: only reference a file if a suitable `.bpmn` already exists in the worktree
  (search `<worktree>` for a file whose `process id` matches). If none exists, **omit
  `bpmn_resource` entirely** — do not create BPMN files. `/seed-data` generates what it needs at
  seeding time.
- Write valid JSON to `<artifacts>/seeding-spec.json`.

---

## Step 3 — Produce `<artifacts>/manual-test.md`

Render a human-readable, step-by-step verification guide. The human verifier will:

1. Have an Orchestration Cluster already running (they set that up themselves).
2. Run `/seed-data` to seed the cluster from `seeding-spec.json`.
3. Follow this document to verify the feature works.

Structure:

```markdown
# Manual Verification Guide — <feature/fix name from plan.md or the guide>

## Feature summary

<One paragraph describing what this change does and what behavior it introduces.
Derived from the diff and plan — write it for a human who hasn't read the code.>

## Prerequisites

- A local Orchestration Cluster is running. Start one via `c8ctl dev` if not already up.
- Your Postman collection (linked to the Camunda REST API spec) is open and its base URL points to your local cluster.
- You are in the run's worktree (printed by Phase 0).

## Step 1 — Seed the cluster

Run the `/seed-data` command. It reads `seeding-spec.json` and will:

**Deploy:**
<For each deployment: what it is and why it exercises the feature>

**Start instances:**
<For each instance: process ID, key variables, and why this instance is needed>

Wait for `/seed-data` to confirm all deployments and instances are active before continuing.

## Step 2 — Verify the feature

Follow these steps in order. Each step corresponds to an expected observation introduced by this change.

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

- **Read-only from the worktree.** Do not modify any file under the resolved worktree.
- Write both artifacts to the resolved `<artifacts>` directory (the run's `manual-smoke/`
  subdirectory) only — never into `$DAGRUN_ARTIFACTS` (this command does not run inside a pipeline
  node) and never into the worktree.
- No Maven, Docker, `java`, `curl`, or any cluster command — this command only reads context and
  writes the two guide artifacts, exactly like the old pipeline `verify` node did.
- `seeding-spec.json` must be valid JSON (no trailing commas, no comments).
- Every verification step in `manual-test.md` must be concrete and actionable — no vague
  instructions like "check the database".

## Reflections

If this run encountered anything unexpected, append one JSON line to
`~/.local/share/dagrunner/store/reflection-log.jsonl`:

```json
{
  "ts": "<ISO-8601-UTC>",
  "source": "manual-smoke",
  "run_id": "<run_id from Phase 0, or empty string>",
  "body": "## YYYY-MM-DD\n\n**Symptom:** ...\n**Root cause:** ...\n**Resolution:** ...\n**Watch for:** ..."
}
```

Only log something if it adds knowledge that would prevent wasted time on a future invocation.
Routine "guide was incomplete" outcomes do not need an entry.
