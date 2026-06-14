# Sibling Implementation Plan #2 — `/verify-demo` Seed-Data Creator (c8ctl)

Status: Build brief for a local implementing agent. Self-contained. Canonical context: `dagrunner-master-architecture.md` §7c, §9.2. Build AFTER Sibling #1 (environment creator).
Scope: the SECOND half of `/verify-demo` — seed the running cluster so the feature is demonstrable. Standing up the cluster + placing breakpoints is Sibling #1 and is OUT OF SCOPE here.

---

## 0. What this is & where it lives

A Claude Code command (extends `/verify-demo`), living in the **Camunda monorepo's private `.claude/`** (alongside `/pr-review`, gitignored via `.git/info/exclude`), copied into each dagrunner worktree by the existing seed/sync mechanism, and RUN inside the worktree. Interactive, human-driven, NOT sandboxed (it needs network access to the running cluster + Docker). Edit the canonical copy in DEVHARNESS_SRC; the worktree copy is ephemeral.

Its job: take the `seeding-spec.json` that the verify-guide node produced and the `environment.json` that Sibling #1 produced, and put real actors on the live cluster via **c8ctl** — deploy the process(es), start the instance(s) — so the human can then exercise the feature (and walk the breakpoint tour Sibling #1 placed).

## 1. Inputs it consumes

- `seeding-spec.json` (from verify-guide; schema confirmed). Fields:
  - `deployments[]` — each `{ description, why }` (and optionally a concrete `bpmn_resource` when present). NOTE: the reference spec gives a `description` only ("A minimal BPMN process with a single task") — see §3 on resolving abstract deployments.
  - `instances[]` — each `{ process_id, variables, why }`.
  - `expected_observations[]` — each `{ where: 'rest-api'|'elasticsearch'|..., what, expected_value }`.
- `environment.json` (from Sibling #1) — gateway address, ES URL. This is where c8ctl points.

## 2. Deliverable 1 (FIRST) — c8ctl introspection spike

Before building, confirm c8ctl's ACTUAL surface on this machine (do not assume from the GitHub README — verify the installed version). Determine and record to `verify-demo/c8ctl-capabilities.md`:
- How c8ctl authenticates/targets a cluster (gateway address, auth flags) — must accept the endpoint from `environment.json`.
- The exact commands to **deploy a BPMN resource** and **create/start a process instance with variables**.
- Whether it can deploy a process given only an abstract description, or requires a concrete `.bpmn` file (it will require a file — see §3).
- How it reports success/IDs (so we can capture the process-instance key for the observation step).

## 3. Deliverable 2 — Resolve & deploy

- **Abstract-deployment resolution:** `seeding-spec.json` deployments may be described abstractly ("a minimal BPMN process with a single task") rather than as a file path. The seed creator must turn that into a concrete deployable resource:
  - Prefer an existing minimal test BPMN in the worktree if one matches `process_id` (e.g. `simpleProcess`).
  - Otherwise generate a minimal valid BPMN satisfying the spec (the `process_id` from `instances[]` must match the deployed process's id) and write it to `verify-demo/generated/<process_id>.bpmn` for transparency.
- Deploy each resolved resource via c8ctl against the `environment.json` gateway. Fail loud on deploy error.

## 4. Deliverable 3 — Start instances & confirm seeding

- For each `instances[]` entry, start a process instance with its `variables` via c8ctl, targeting the matching `process_id`. Capture the returned process-instance key.
- Write `verify-demo/seeded.json` recording what was created (process ids, instance keys) — the human (and the tour) need these to know what to inspect.
- **Confirm reachability of `expected_observations[]`** (don't fully validate the feature — that's the human's job at the tour, but prove the seed landed):
  - For `where: elasticsearch` — confirm the instance's document is present in the named index at the ES URL (the data has exported).
  - For `where: rest-api` — note the endpoint + what to call, but do NOT assert the feature value (the whole point of the human tour is to observe it). Record the ready-to-run call in `seeded.json`.
- If an observation isn't reachable within a timeout (e.g. ES export lag), warn loudly with the wait elapsed — never silently pass.

## 5. Out of scope (do not build)

- Standing up the cluster / ES / breakpoints — Sibling #1.
- Driving the human through the breakpoint tour / narration — later demo-execution layer.
- The before/after comparison using the Glean companion guide — later.
- Asserting the feature is correct — that is the human's call at Gate-3-style verification; this sibling only proves the demo data exists and has propagated.

## 6. Acceptance

1. c8ctl capability spike recorded; commands confirmed against the installed version.
2. On the reference `position` feature, with Sibling #1's environment up: the seed creator resolves the abstract `simpleProcess` deployment to a concrete BPMN, deploys it, starts one instance, and captures the instance key to `seeded.json`.
3. The ES observation is confirmed reachable (the instance's operate-list-view document exists); the REST observation is recorded as a ready-to-run call, not asserted.
4. Re-running is safe (idempotent or clearly additive — starting a second instance is fine; document the behavior).
5. Failures (deploy error, export lag beyond timeout) warn loudly and do not pretend success.

## 7. Constraints & reminders

- Canonical home: Camunda monorepo private `.claude/` (gitignored); runs in the worktree; edit in DEVHARNESS_SRC.
- Runs under `CLAUDE_CONFIG_DIR=~/.claude-work`; ANTHROPIC_API_KEY unset.
- NOT sandboxed (needs cluster network + Docker). Human-driven; assume a human is present.
- Points at the cluster via `environment.json` — never hardcode endpoints.
- Fail loud, no silent fallback.
