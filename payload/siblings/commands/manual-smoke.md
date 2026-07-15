---
description: Generate a human-readable manual verification guide (+ seeding spec, when a live cluster is actually needed) on demand from a completed (or past-Gate-1) dagrunner run's artifacts — the old read-only verify-guide behavior, relocated out of the autonomous pipeline. Analyzes what the diff actually touches to pick the right verification method (REST API, secondary-storage query, zdb, or an existing automated test) instead of assuming REST/Postman is always reachable. Gates nothing.
argument-hint: [run-id]
---

# /manual-smoke — On-Demand Manual Verification Guide

**Input**: $ARGUMENTS

Produces a human-readable `manual-test.md` (plus `seeding-spec.json`, only when the chosen
verification method actually needs a seeded cluster) from a run's existing artifacts (diff,
`guide.md`, `summary.md`, review findings, OpenAPI grounding). `verify` is now a fully autonomous
acceptance-test author/runner/judge/gate and no longer produces these human-facing documents (see
`docs/dagrunner-master-architecture.md` §3 and DECISIONS.md § verify-autonomy-remove-election) —
this sibling exists so a human can still get that value, on demand, for any run. **It is NOT part
of the autonomous pipeline and gates nothing** — invoke it whenever you want a manual-smoke-test
walkthrough for a run, regardless of that run's `verify` outcome.

**Do not assume REST API + Postman is always the right verification surface.** Some diffs never
touch the REST gateway or any secondary-storage export path at all (e.g. a change confined to a
module like Optimize, or an internal broker/engine change with no externally observable REST/ES/OS
contract). Step 2 below exists specifically to analyze the diff and pick a verification method
grounded in what actually changed, not to default to REST/Postman by convention.

**Read-only from the worktree, and never executes anything against a live cluster.** This command
never modifies worktree files and never runs Maven/Docker/`curl`/cluster commands itself — it only
analyzes and writes into the run's own `manual-smoke/` artifact subdirectory. Even for the
existing-test verification method (Step 2), this command names the exact command a human should run
locally — it does not run it.

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

Read in this priority order (paths relative to the resolved `run_dir` / `worktree` from Phase 0) —
this is the analysis substrate for Step 2's method decision, not just background:

1. **Artifacts from the run** — the definitive record of what changed and what was built; the
   primary source for what to seed/test and for identifying which existing test coverage (if any)
   already exercises this change.
2. **Git log** — commit summaries confirm scope and intent.
3. **Git diff** — the ground truth for exactly which files/modules changed; Step 2 reasons
   directly from this, not from a description of it.
4. **OpenAPI spec** — only needed if Step 2 concludes the REST API is a relevant surface; grounds
   any `rest-api` observation with the correct HTTP method, path, and request schema.

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

# 4. Locate the Camunda REST API OpenAPI spec — only actually read if Step 2 selects rest-api
find "<worktree>" \( -name "openapi.yaml" -o -name "openapi.json" \) \
  ! -path "*/target/*" ! -path "*/node_modules/*" ! -path "*/.git/*" | head -5
```

---

## Step 2 — Determine the verification method(s)

**Do this before writing anything.** Analyze what the diff actually changed — not what verification
approach is most familiar — and pick the smallest set of methods that actually proves the change
works. Ground every choice in evidence from Step 1's diff/artifacts, not assumption.

Available methods:

- **`rest-api`** — verify via the Camunda REST API surface (a Postman/curl call), grounded in the
  OpenAPI spec. Applicable when the diff touches a REST controller/handler, or the guide/summary
  describes a REST-facing contract change.
- **`secondary-storage`** — verify by querying the secondary-storage backend directly with a
  database client (Elasticsearch/OpenSearch index query, or a RDBMS SQL query — whichever backend
  the diff's exporter/reader actually targets). Applicable when the diff touches an exporter, index
  mapping, RDBMS schema/migration, or a query/reader class.
- **`zdb`** — verify using the `zdb` Zeebe debugging tool to inspect the embedded broker's RocksDB
  state and/or log stream directly. Applicable when the diff touches broker/engine/stream-processor
  internals whose effect is not fully observable via REST or secondary storage alone (e.g.
  snapshotting, log compaction, stream-processing/backpressure behavior) — this is the fallback
  when REST/secondary-storage can't prove the specific thing that changed, not a default choice.
- **`existing-test`** — no live-cluster surface is reachable or relevant for this diff (e.g. a
  change confined to a module with no external REST/ES/OS/RocksDB-observable contract, an internal
  refactor, or a module like Optimize where an E2E suite is the actual verification surface CI
  already relies on). Identify the SPECIFIC existing automated test suite that already exercises
  the changed behavior — name the real class/suite, not a generic "run the tests."

Procedure:

1. List the distinct top-level module paths the diff touches:
   ```bash
   cd "<worktree>" && git diff --name-only origin/main...HEAD | cut -d/ -f1-2 | sort -u
   ```
2. For each candidate method above, look for concrete evidence in the diff and Step 1's artifacts
   (a REST controller annotation, an exporter/index-mapping/schema file, broker/engine/stream-
   processor code, or the guide/summary's own description of the user-facing contract) — do not
   guess module boundaries from memory of the Camunda repo; ground the decision in what Step 1
   actually surfaced.
3. Multiple methods can apply together — e.g. `rest-api` + `secondary-storage` is the common combo
   for a REST-triggered, ES-materialized feature. Pick the smallest sufficient set; don't pad with
   a method that adds no additional proof over the others already selected.
4. **If evidence points to `existing-test`** (no live-cluster surface applies): search for the
   specific pre-existing test suite that already covers this behavior — the diff's own module,
   `*Test`/`*IT`/`*E2E*` classes referenced in `implement`/`fix`/`review` artifacts, or a CI-run
   E2E suite for the touched module (e.g. an Optimize E2E suite). Confirm the class/suite actually
   exists in the worktree before naming it:
   ```bash
   find "<worktree>" -path "*/target/*" -prune -o -type f \( -name "*Test.java" -o -name "*IT.java" -o -name "*E2E*.java" -o -name "*.spec.ts" \) -print | xargs grep -l "<relevant symbol from the diff>" 2>/dev/null
   ```
   If no existing suite plausibly covers it either, say so explicitly in the rationale below rather
   than inventing one — this is a real, reportable gap, not a failure of this command.
5. **If `zdb` is selected**, do not assume its CLI shape from memory. Locate it and its actual
   usage in the worktree before writing any step that references it:
   ```bash
   find "<worktree>" -iname "*zdb*" ! -path "*/target/*" ! -path "*/.git/*" | head -20
   ```
   Read whatever launcher/README/`--help` text you find and ground `manual-test.md`'s zdb steps in
   that, not in assumed flags.
6. Write a short rationale (2-4 sentences) stating the chosen method(s) and the evidence for each —
   this is carried verbatim into `manual-test.md`'s "Verification method" section (Step 4) so the
   human isn't left guessing why, say, REST/Postman isn't the answer for this particular run.

---

## Step 3 — Produce `<artifacts>/seeding-spec.json`

**Skip this step entirely if Step 2's chosen method is `existing-test` alone** — there is no live
cluster to seed. Proceed directly to Step 4's existing-test branch.

Otherwise, based on the diff, the plan, and Step 2's chosen method(s), specify what data a human
(or `/seed-data`) should seed to demonstrate this feature end-to-end. The schema is:

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
      "where": "rest-api | elasticsearch | opensearch | rdbms | zdb",
      "what": "<field or observable>",
      "expected_value": "<what to look for>",
      "how": "<concrete steps to find it — e.g. 'open Postman, call GET /v2/...' or 'run zdb state --partition 1 ...' or 'SELECT ... FROM ...'>"
    }
  ]
}
```

Rules:

- Derive everything from the artifacts and diff — the implement reflections and fix summary are
  the primary record of what changed; the diff confirms specific code paths.
- `expected_observations` must only use `where` values that match a method Step 2 actually chose
  (e.g. don't emit a `zdb` observation if Step 2 didn't select `zdb`). Each observation must
  reference the specific behavior introduced by this change (the correct response/field, the
  correct RocksDB/log-stream state, the correct exported document/row).
- Each `how` must be a concrete, actionable step the human can follow without guessing:
  - `rest-api` — an exact Postman/curl call, grounded in the OpenAPI spec (method, path, body).
  - `elasticsearch`/`opensearch` — an exact query (index pattern, query DSL) against the secondary
    storage backend, runnable via a database client (e.g. ElasticVue/OpenSearch Dashboards) or
    `curl`.
  - `rdbms` — an exact SQL query against the relevant table(s).
  - `zdb` — an exact `zdb` invocation, grounded in what the Step 2 procedure's step 5 actually
    found in the worktree — never an assumed/invented flag.
- **REST observations must be spec-grounded**: for every `where: "rest-api"` observation, grep the
  OpenAPI spec for the relevant endpoint path _before_ writing the `how` field. Copy the exact HTTP
  method, path parameters, and required requestBody fields from the spec. Never guess the HTTP
  method — a wrong method (e.g. POST instead of PATCH) produces an unusable spec.
- Keep it minimal: the minimum seeding that proves the feature works, not a full test suite.
- For `bpmn_resource`: only reference a file if a suitable `.bpmn` already exists in the worktree
  (search `<worktree>` for a file whose `process id` matches). If none exists, **omit
  `bpmn_resource` entirely** — do not create BPMN files. `/seed-data` generates what it needs at
  seeding time.
- Write valid JSON to `<artifacts>/seeding-spec.json`.
- `/seed-data` (§10.1) automates confirmation for `rest-api` and `elasticsearch` observations only;
  `opensearch`/`rdbms`/`zdb` observations are recorded as `NOT_CHECKED` by its script and left for
  the human to confirm via `manual-test.md`'s own steps — this is expected, not a gap to work
  around here.

---

## Step 4 — Produce `<artifacts>/manual-test.md`

Render a human-readable, step-by-step verification guide. Its shape depends on Step 2's chosen
method(s).

### If Step 2 chose `rest-api` / `secondary-storage` / `zdb` (one or more)

The human verifier will:

1. Have an Orchestration Cluster already running (they set that up themselves).
2. Run `/seed-data` to seed the cluster from `seeding-spec.json`.
3. Follow this document to verify the feature works.

Structure:

```markdown
# Manual Verification Guide — <feature/fix name from plan.md or the guide>

## Feature summary

<One paragraph describing what this change does and what behavior it introduces.
Derived from the diff and plan — write it for a human who hasn't read the code.>

## Verification method

<Step 2's rationale, verbatim: which method(s) were chosen and the evidence for each — so the
human understands why this run uses zdb/secondary-storage instead of (or alongside) REST/Postman.>

## Prerequisites

- A local Orchestration Cluster is running. Start one via `c8ctl dev` if not already up.
- <Only if `rest-api` was chosen:> Your Postman collection (linked to the Camunda REST API spec)
  is open and its base URL points to your local cluster.
- <Only if `secondary-storage` was chosen:> A database client for the relevant backend is
  available (e.g. ElasticVue/OpenSearch Dashboards for ES/OS, or a SQL client for RDBMS).
- <Only if `zdb` was chosen:> The `zdb` tool is available, along with the broker's data directory
  path — both located during the Step 2 procedure's step 5.
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

**Where:** <REST API — Postman | Elasticsearch/OpenSearch — database client | RDBMS — SQL client | zdb — RocksDB/log stream>

**What to do:** <the concrete how from seeding-spec.json — exactly what to call, query, or run>

**Expected result:** <the expected_value — what you should see if the feature is working>

<Repeat for each observation.>

## Notes for the reviewer

<Any non-obvious interactions with the running system — e.g. timing (wait N seconds for indexing),
required feature flags, known limitations of this approach, or edge cases to watch for.
Leave this section empty if there is nothing to add.>
```

### If Step 2 chose `existing-test` (alone — no live cluster needed)

````markdown
# Manual Verification Guide — <feature/fix name from plan.md or the guide>

## Feature summary

<One paragraph describing what this change does and what behavior it introduces.>

## Verification method

<Step 2's rationale, verbatim: why no live-cluster surface applies to this diff, and which
existing test suite was identified as already covering the changed behavior.>

## Step 1 — Run the existing test suite locally

<Name the exact test class/suite found in the Step 2 procedure's step 4, and the exact command to
run it, e.g.:>

```bash
cd "<worktree>" && ./mvnw test -pl <module> -Dtest=<ClassName>
```

**Expected result:** <what passing looks like — e.g. "BUILD SUCCESS, 0 failures"> — this test
already exercises <the specific behavior this diff changed>, so a pass here is the verification
signal for this run.

## Notes for the reviewer

<Any non-obvious detail — e.g. why no live-cluster method applied to this diff, or a known gap if
no existing suite was found to cover the change (see the Step 2 procedure's step 4).>
````

---

## Constraints

- **Read-only from the worktree, and never executes anything against a live cluster or runs a
  local test itself.** Do not modify any file under the resolved worktree. Even for
  `existing-test`, this command only names the command the human should run — it never invokes
  Maven/Docker/`curl`/`zdb`/cluster commands itself.
- Write both artifacts to the resolved `<artifacts>` directory (the run's `manual-smoke/`
  subdirectory) only — never into `$DAGRUN_ARTIFACTS` (this command does not run inside a pipeline
  node) and never into the worktree.
- `seeding-spec.json` must be valid JSON (no trailing commas, no comments) when written — and must
  be omitted entirely (not written) when Step 2 chose `existing-test` alone.
- Every verification step in `manual-test.md` must be concrete and actionable — no vague
  instructions like "check the database", and never an assumed `zdb` flag that wasn't confirmed
  against the actual tool in the worktree.
- Step 2's method choice must be evidence-grounded (diff/artifacts), never a default to
  `rest-api` out of habit.

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
