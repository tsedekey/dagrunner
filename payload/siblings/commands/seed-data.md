---
description: Seed a live local Orchestration Cluster from a dagrunner verify-guide seeding-spec.json via c8ctl. All output written to run artifacts dir.
argument-hint: [path/to/seeding-spec.json] [--profile <c8ctl-profile-name>]
---

# /seed-data — Seed Live Cluster from seeding-spec.json

**Input**: $ARGUMENTS

Seeds a running local Orchestration Cluster so a feature can be demonstrated or manually tested.
Reads a `seeding-spec.json` produced by the dagrunner `verify-guide` node, resolves abstract BPMN
descriptions to concrete deployable resources, deploys them, starts process instances, and confirms
that expected observations (Elasticsearch document present; REST call recorded) are reachable.

**Design note:** The architecture dropped a dedicated environment-creator sibling — c8ctl's `dev`
plugin covers cluster spin-up. This command targets the cluster by c8ctl profile rather than
`environment.json`. **Start the OC before invoking this command.**

**Field paths verified against c8ctl v3.1.0 dry-run output and the Camunda v2 REST API spec;
a live end-to-end run against a running cluster is required to confirm all of the following.
If any of these come back wrong, run with `--verbose` and adjust:**

- **deploy response**: `.key`, `.deployments[0].process.processDefinitionKey`
- **create-pi response**: `.processInstanceKey`
- **ES index name**: `operate-list-view*` — real clusters may add a leading prefix; if the 90s
  timeout fires without confirming, check the UNCONFIRMED warning output for actual index names.
- **ES query field**: `term.key` (using the processInstanceKey as ES doc `key` field)
- **c8ctl profile fields**: `.Name`, `.URL` (from `c8ctl list profiles --json`)
- **c8ctl create pi**: use `--id <bpmn-process-id-string>`, NOT `--processDefinitionId` (wrong flag) and NOT the numeric key;
  do NOT use `--awaitCompletion` unless the process has no service tasks (it will hang)
- **c8ctl topology error shape**: `{"status":"error","message":"..."}`

**Scripts:** bash logic lives in `.claude/scripts/seed-data/`. The MD calls them; edit the
scripts for logic changes.

---

## Phase 0 — Resolve arguments and locate seeding-spec.json

Parse `$ARGUMENTS`. Write resolved state to `$TMPDIR/seed-data-state.json` for later phases.

```bash
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/scripts/seed-data"
zsh "$SCRIPT_DIR/phase-0-bootstrap.sh" "$ARGUMENTS"
```

**PHASE_0_CHECKPOINT:**

- [ ] `$TMPDIR/seed-data-state.json` written with `spec_path`, `profile`, `run_dir`, `seed_scratch`
- [ ] `$SEED_SCRATCH/generated/` directory created (`<run-dir>/seed-data/generated/`)

---

## Phase 1 — Cluster reachability check

```bash
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/scripts/seed-data"
zsh "$SCRIPT_DIR/phase-1-cluster-check.sh"
```

**PHASE_1_CHECKPOINT:**

- [ ] `c8ctl get topology` returned without error — cluster is reachable

---

## Phase 2 — Resolve deployments, start instances, confirm observations, write seeded.json

This is one contiguous script — all deployment/instance state lives in shell variables across the
full loop. Do not split it.

```bash
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/scripts/seed-data"
zsh "$SCRIPT_DIR/phase-2-deploy-and-seed.sh"
```

**PHASE_2_CHECKPOINT:**

- [ ] All deployments resolved and deployed (process_definition_key captured or `unknown`)
- [ ] All instances started (instance_key captured or `unknown` with warning)
- [ ] ES observations confirmed or loudly warned
- [ ] REST observations recorded (see postman-collection.json)
- [ ] `operate` observations skipped with explicit message
- [ ] `$SEED_SCRATCH/seeded.json` written and valid JSON

---

## Phase 2b — Generate Postman collection

Read the seeded.json, the original seeding-spec.json, and the OpenAPI spec from the worktree
to produce an accurate, import-ready Postman collection. No scripts for this phase — the agent
does this directly.

```bash
STATE_FILE="${TMPDIR%/}/seed-data-state.json"
SEED_SCRATCH=$(jq -r .seed_scratch "$STATE_FILE")
SPEC_PATH=$(jq -r .spec_path "$STATE_FILE")
WORKTREE="$(git rev-parse --show-toplevel)"

cat "$SEED_SCRATCH/seeded.json"
cat "$SPEC_PATH"

# Locate the Camunda REST API OpenAPI spec
find "$WORKTREE" \( -name "openapi.yaml" -o -name "openapi.json" \) \
  ! -path "*/target/*" ! -path "*/node_modules/*" ! -path "*/.git/*"
```

Read the relevant OpenAPI spec file(s) found above. For each `rest-api` observation in
seeding-spec.json:

1. **Identify the endpoint** — extract the HTTP method and path from the `how` field
   (e.g. `POST /v2/jobs/{jobKey}/update`).
2. **Look it up in the OpenAPI spec** — find the exact path + method entry.
3. **Extract from the spec:**
   - Path parameters (names, types)
   - Query parameters (names, types, required/optional)
   - Request body schema (required fields and their types/formats)
4. **Build the Postman request** using the spec — not guesswork. Every field name,
   parameter name, and body shape must match the spec exactly.

Substitute actual keys from seeded.json (instance keys). Job keys are not known at
seeding time since jobs are created by the service task once a worker activates — use a
Postman variable (`{{jobKey_N}}`) and add a note in the request description explaining
where to find it (e.g. "Activate a job first via POST /v2/jobs/activate, then copy the
returned key here").

**Write `$SEED_SCRATCH/postman-collection.json`** as Postman Collection v2.1:

```json
{
  "info": {
    "name": "seed-data — <feature from seeding-spec>",
    "_postman_id": "seed-data-<run-id>",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "variable": [
    { "key": "baseUrl", "value": "<profile URL without trailing /v2>" },
    {
      "key": "instanceKey_0",
      "value": "<seeded.json instances[0].instance_key>"
    },
    {
      "key": "instanceKey_1",
      "value": "<seeded.json instances[1].instance_key, if present>"
    },
    {
      "key": "jobKey_0",
      "value": "FILL_IN — activate job from instance 0 to get this"
    }
  ],
  "item": [
    {
      "name": "<observation.what>",
      "request": {
        "method": "<method from OpenAPI spec>",
        "header": [{ "key": "Content-Type", "value": "application/json" }],
        "url": {
          "raw": "{{baseUrl}}/v2/<path from spec with {{variables}} for path params>",
          "host": ["{{baseUrl}}"],
          "path": ["v2", "<path segments>"]
        },
        "body": {
          "mode": "raw",
          "raw": "<JSON body matching the spec requestBody schema exactly>"
        },
        "description": "<observation.how — full text>"
      }
    }
  ]
}
```

**PHASE_2B_CHECKPOINT:**

- [ ] `$SEED_SCRATCH/postman-collection.json` written and valid JSON
- [ ] Every request body matches the OpenAPI spec schema — no invented field names

---

## Phase 3 — Summary

Prints a summary, artifact paths, and a numbered testing checklist derived from the observations.

```bash
SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/scripts/seed-data"
zsh "$SCRIPT_DIR/phase-3-summary.sh"
```

---

## Re-run behavior

Re-running `/seed-data` on the same spec is **safe and additive**:

- **Deploy**: creates a new process-definition version each run (version 1, 2, ...). All versions
  remain in the cluster. This is fine for demonstration purposes.
- **Create instance**: starts a new instance each run. Multiple instances appear in Operate.
- **seeded.json**: overwritten on each run. Written to `<run-dir>/seed-data/seeded.json` — never inside the repo working tree.

To reset: cancel instances and delete process definitions in Operate UI, or recreate the cluster.

---

## Acceptance criteria (sibling spec §6)

1. Abstract `simpleProcess` deployment resolved to a concrete no-service-task BPMN, deployed,
   instance started, key captured in `verify-demo/seeded.json`.
2. ES observation confirmed reachable (operate-list-view document present within 90s); REST
   observation recorded as a ready-to-run call, not asserted.
3. Re-running is safe and documented (additive by design).
4. Failures (deploy error, export lag > 90s) exit non-zero with a loud warning — never silent.

---

## Learnings

If this run encountered anything unexpected that is **not already documented** in
`~/.local/share/dagrunner/store/learnings/seed-data.md`, append a new entry now using this
format — keep it brief, one or two lines per field:

```markdown
## YYYY-MM-DD

**Symptom:** <what went wrong or behaved unexpectedly>
**Root cause:** <why it happened>
**Resolution:** <what fixed it>
**Watch for:** <how to spot this early on the next run>
```

Only log something if it adds knowledge that would prevent wasted time on a future run.
Good candidates: c8ctl field shape mismatches, ES index name surprises, cluster profile
discovery edge cases, or BPMN resolution failures that weren't covered by the spec.
Routine "spec was incomplete" outcomes do not need an entry.
