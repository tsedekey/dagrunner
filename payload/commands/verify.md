# /verify — Autonomous Acceptance-Test Author, Runner, and Judge

You are running the **verify node** of a dagrunner pipeline. Your job: author (or, on the bugfix
workflow, reuse) an `@MultiDbTest` acceptance test that proves the promised user flow works,
independently rerun the build and test suite, run the acceptance test, classify the result, and
write `$DAGRUN_ARTIFACTS/verify-report.json` — the artifact that gates `pr`. **No human reviews
this node. It runs to a terminal classification on its own.**

You have access to the following env vars:

- `$DEVHARNESS_SRC` — permanent camunda/camunda checkout
- `$DAGRUN_ARTIFACTS` — write `verify-plan.md` and `verify-report.json` here (nowhere else)
- `$DAGRUN_RUN_ID` — the current dagrunner run ID
- `$DAGRUN_WORKTREE` — the worktree path (your cwd) — the acceptance test itself is written HERE,
  under `qa/acceptance-tests`, because it is real, committed Camunda test code, not an artifact
- `$DAGRUN_RUN_DIR` — the run directory (parent of all node artifact dirs)

---

## Known environment constraints (read before starting)

These facts are pre-verified — do not re-investigate them:

- **Maven:** use `./mvnw <goal>` directly. Do NOT prefix with `JAVA_HOME=...` or any other env
  variable — that pattern is not allow-listed and will be blocked.
- **`.tool-versions` / Java version:** the worktree lives at
  `~/.local/share/dagrunner/worktrees/<run-id>/` — a separate directory tree from the main repo.
  If Maven fails with "No version is set for command java":
  ```bash
  grep '^java ' "$DEVHARNESS_SRC/.tool-versions" >> "$DAGRUN_WORKTREE/.tool-versions"
  ```
- **`qa/acceptance-tests` module isolation:** this module resolves `clients/java` from `~/.m2`,
  NOT from the source tree. Install the client snapshot before any compile/test run in this
  module:
  ```bash
  ./mvnw install -pl clients/java -Dquickly
  ```
  Skipping this step causes compile failures that look like missing classes but are really stale
  jars. Run this once per session before touching `qa/acceptance-tests`.
- **`docker *` is allow-listed.** Testcontainers itself talks to the Docker daemon directly from
  the JVM (not through the Bash tool) — this allowlist entry only covers the preflight/diagnostic
  commands below, not the actual acceptance-test execution.

---

## Step 0 — Docker daemon preflight (mandatory, first, fail loud)

`@MultiDbTest` provisions its own Elasticsearch testcontainer. If the Docker daemon is not
reachable, the acceptance-test run degrades into an opaque testcontainer stack trace ten minutes
in — check for this NOW, before doing any authoring work:

```bash
docker info > /dev/null 2>&1
echo "docker_reachable=$?"
```

If `docker_reachable` is not `0`:

- Do NOT attempt Step 4/5 (build/test/acceptance execution) — there is no point.
- Write `$DAGRUN_ARTIFACTS/verify-report.json` immediately with `"outcome": "ERROR_INFRA"` (see
  Step 6 for the exact schema) and a clear, actionable `stages.acceptance.detail` message: e.g.
  `"Docker daemon is not reachable from this worktree — start Docker Desktop (or the local Docker
daemon) and rerun this node with: dagrun rerun verify --branch <branch>"`. Never a raw
  testcontainer stack trace — the human resuming this run needs one sentence, not a Java trace.
- Skip straight to Step 7 (reflections, optional) and stop. Do not write a `verify-plan.md` — no
  authoring work happened.

If `docker_reachable` is `0`, continue to Step 1.

---

## Step 1 — Read the promised user flow

Check these paths in order and use the first one that exists — this is the **authoring source**
(the promised user flow/contract), not the diff:

1. `$DAGRUN_RUN_DIR/define/guide.md` (feature workflow)
2. `$DAGRUN_RUN_DIR/reproduce/guide.md` (bugfix workflow)

Whichever path exists tells you which workflow you are running under — remember this, it decides
whether Step 2 (search-existing-coverage) applies.

Also read, for context (not as an authoring source):

```bash
cat "$DAGRUN_RUN_DIR/implement/summary.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/fix/summary.md" 2>/dev/null
cat "$DAGRUN_RUN_DIR/review/findings.json" 2>/dev/null
```

---

## Step 2 — Bugfix workflow only: search for existing acceptance-test coverage

**Skip this entire step if `define/guide.md` exists (feature workflow) — go straight to Step 3.**

If `reproduce/guide.md` exists (bugfix workflow), the regression test already written during
`implement`/`fix` only proves the fix at the unit/integration layer — it does NOT prove the
user-facing flow is covered at the acceptance-test layer. Before authoring a new AT, check whether
one already exists:

1. Identify the user-facing flow the bug touches, grounded from `reproduce/guide.md` (not the
   diff — the guide is the authoritative description of the promised/expected behavior).
2. Search the worktree's acceptance-test module for an existing `@MultiDbTest` that already
   exercises that flow:
   ```bash
   grep -rl "@MultiDbTest" "$DAGRUN_WORKTREE/qa/acceptance-tests" --include="*.java"
   ```
   Read the candidates whose class/method names or comments suggest they touch the same area
   (process/resource type, REST endpoint, job type) as the bug.
3. **If an existing AT already covers the flow:** do NOT author a new one. Record which file was
   reused and why in `verify-plan.md` (Step 6b). Proceed directly to Step 4 (independent
   build+test rerun) using that existing AT as the one to execute in Step 5 — skip Step 3 (author)
   entirely, but do NOT skip Step 3b (D3 self-check) — the self-check still applies to a reused AT
   (see the D3 subagent's own note on this).
4. **If no existing AT covers the flow:** proceed to Step 3 exactly as the feature workflow does.

---

## Step 3 — Author the acceptance test (feature workflow, or bugfix with no existing coverage)

**Scope discipline: author ONE (or a small few) acceptance test(s) covering the WHOLE promised
user journey from the guide — not a re-run of unit/integration coverage.** That is `implement`'s
job, already done. You are proving the end-to-end user-facing contract, not re-testing internals.

1. Inspect existing conventions before writing anything:
   ```bash
   find "$DAGRUN_WORKTREE/qa/acceptance-tests" -name "*.java" | xargs grep -l "@MultiDbTest" | head -5
   ```
   Read 2-3 of these in full. Mirror their package structure, imports, `CamundaClient` injection
   pattern, and assertion/await style exactly. **Do not invent new structure.**
2. Identify the single (or few) end-to-end flow(s) the guide promises — e.g. "deploy a process
   with the new escalation boundary event, start an instance, confirm the escalation is observable
   via the REST API." Write the test to deploy/start/act/assert that flow using the existing
   `@MultiDbTest` framework primitives (`TestStandaloneBroker`/`TestSimpleCamundaApplication`
   started in-process, injected `CamundaClient`) — do not reimplement any part of that framework.
3. Use the framework's own await/poll semantics for timing-sensitive assertions (e.g. its existing
   `Awaitility`-style helpers, if the reference tests use one) — **no fixed `Thread.sleep`**.
4. Run the formatter after writing the file:
   ```bash
   ./mvnw spotless:apply --no-transfer-progress
   ```
5. Stage the new file (and anything else outstanding in the worktree) so it is visible to the
   D3 self-check's diff comparison and eventually reaches the PR:
   ```bash
   cd "$DAGRUN_WORKTREE" && git add -A && git status --short
   ```

---

## Step 3b — D3: isolated diff-grounding self-check (mandatory, before Step 4)

Dispatch the **`verify-diff-grounding-checker`** subagent via the Agent tool — this is a deliberate
isolated-context check, not a self-assessment, mirroring how `review`'s adversarial verifier
grounds findings independently rather than trusting the reviewer that raised them.

Pass it in the prompt:

1. The diff: `cd "$DAGRUN_WORKTREE" && git diff origin/main` (two-dot form against the base branch
   — this covers both staged and unstaged changes, i.e. everything `implement`/`fix`/you have
   changed so far; this is a self-check input ONLY, never an authoring input — you already
   authored from the guide in Step 1/3).
2. The full content of the acceptance test file (whether newly authored in Step 3, or the existing
   file identified as a reuse match in Step 2).
3. A one-paragraph description of the flow it's supposed to cover.

**If the subagent returns `grounded: false`:** do NOT proceed to Step 4/5. Write
`$DAGRUN_ARTIFACTS/verify-report.json` immediately with `"outcome": "FAIL_ASSERTION"` — this is
the same classification used for "feature behavior wrong" because an AT that cannot be confirmed
to exercise the diff means the pipeline cannot confirm the feature works, which is operationally
equivalent to a failed assertion. Include the subagent's `rationale` verbatim in
`stages.selfCheck.detail`. Skip straight to Step 7 (reflections) and stop.

**If `grounded: true`:** record the subagent's verdict in `verify-plan.md` (Step 6b) and proceed
to Step 4.

---

## Step 4 — Independent build + test rerun (fail-fast ladder)

`verify` does not trust `implement`/`fix`'s self-reported build/test status — it reruns both
independently. Stop at the first failing stage; do not run the (expensive) acceptance test after a
broken build or failing suite.

1. **Build:**
   ```bash
   ./mvnw install -pl clients/java -Dquickly
   ./mvnw compile -q
   ```
   If this fails: write `verify-report.json` with `"outcome": "FAIL_BUILD"`, `stages.build.status:
"FAIL"`, and a truncated (last ~40 lines) build-log tail in `stages.build.detail`. Skip to
   Step 7 and stop.
2. **Unit/integration test suite** (scope: the module(s) `implement`/`fix` touched — do not run
   the full monorepo suite; identify touched modules from `git diff --cached --name-only
origin/main`):
   ```bash
   ./mvnw test -pl <touched-module(s)> -q
   ```
   If this fails: write `verify-report.json` with `"outcome": "FAIL_TEST"`, `stages.test.status:
"FAIL"`, and a truncated failing-test-output tail in `stages.test.detail`. Skip to Step 7 and
   stop.
3. Both passing → `stages.build.status` and `stages.test.status` are `"PASS"`. Proceed to Step 5.

**Out of scope — do not add:** CI's dist/packaging/cross-storage matrix. This is acceptance-level
verification of THIS change, not a CI re-run.

---

## Step 5 — Run the acceptance test, classify the outcome

Run the specific AT class (the one authored in Step 3 or reused in Step 2):

```bash
./mvnw verify -pl qa/acceptance-tests -Dit.test=<AcceptanceTestClassName> -q
```

Classify the result into exactly ONE of:

- **`PASS`** — the AT ran and all assertions passed.
- **`FAIL_ASSERTION`** — the AT ran but an assertion failed (the feature's behavior is wrong).
- **`ERROR_INFRA`** — the AT could not even start/run due to an environment problem (testcontainer
  failed to provision, ES never became healthy, port conflict, etc.) — **never** read this as a
  green pass. Docker being reachable at Step 0 does not guarantee the ES container itself starts
  cleanly; distinguish "my container never came up" (ERROR_INFRA) from "my container came up and
  the assertion failed" (FAIL_ASSERTION) by reading the actual failure — a testcontainer
  provisioning exception looks very different from a JUnit assertion failure.
- (`FAIL_BUILD`/`FAIL_TEST` were already handled in Step 4 — you only reach this step once those
  passed.)

Use the framework's own await/poll helpers for any timing-sensitive read in your own manual
inspection of the result — do not add fixed sleeps to work around a flaky-looking read.

---

## Step 6 — Write the evidence artifacts

### 6a — `$DAGRUN_ARTIFACTS/verify-report.json`

Always write this file, on every path through this command (Step 0's early exit, Step 3b's
self-check failure, Step 4's build/test failure, and Step 5's classification all converge here).
Schema:

```json
{
  "run_id": "<$DAGRUN_RUN_ID>",
  "timestamp": "<ISO 8601>",
  "outcome": "PASS | FAIL_ASSERTION | FAIL_BUILD | FAIL_TEST | ERROR_INFRA",
  "acceptanceTest": {
    "path": "<qa/acceptance-tests/.../ClassName.java, or null if never reached>",
    "source": "authored | reused-existing | not-reached"
  },
  "stages": {
    "dockerPreflight": { "status": "PASS | FAIL", "detail": "<one sentence>" },
    "selfCheck": {
      "status": "PASS | FAIL | SKIPPED",
      "detail": "<subagent rationale or reason skipped>"
    },
    "build": {
      "status": "PASS | FAIL | SKIPPED",
      "detail": "<truncated log tail or reason skipped>"
    },
    "test": {
      "status": "PASS | FAIL | SKIPPED",
      "detail": "<truncated log tail or reason skipped>"
    },
    "acceptance": {
      "status": "PASS | FAIL | SKIPPED",
      "detail": "<truncated log tail or reason skipped>"
    }
  },
  "diagnostics": "<optional: incident/variable diagnostics the framework exposed on failure — omit key entirely if PASS>"
}
```

Rules:

- `outcome` is the single field the pipeline's engine-level gate reads (`checkOutcomeGate` in
  `dag.ts`) — it must be exactly one of the five values above, nothing else.
- Truncate any log/output text to roughly the last 40 lines (or ~4 KB) — never paste a full raw
  dump. The goal is enough context for a human resuming the run to understand what broke, not a
  complete transcript.
- Every stage field must be present even when `SKIPPED` (e.g. `acceptance` is `SKIPPED` when
  Step 0/3b/4 already stopped the run) — never omit a stage key.
- Valid JSON, no trailing commas.

### 6b — `$DAGRUN_ARTIFACTS/verify-plan.md`

Skip this file entirely if Step 0 exited early (no authoring work happened). Otherwise:

```markdown
# Verify plan — <feature/fix name from the guide>

## Flow covered

<One paragraph: the user-facing flow this acceptance test proves, drawn from the guide.>

## Acceptance test

- **File:** `qa/acceptance-tests/.../ClassName.java`
- **Source:** authored new | reused existing (bugfix workflow only — name the flow match reason)

## D3 self-check verdict

<The verify-diff-grounding-checker subagent's grounded/rationale verdict, verbatim.>

## Independent build + test rerun

- Build: PASS/FAIL
- Test suite (`<module(s)>`): PASS/FAIL

## Outcome

<PASS | FAIL_ASSERTION | FAIL_BUILD | FAIL_TEST | ERROR_INFRA — one line, matches verify-report.json>
```

---

## Step 7 — Reflections (optional, do this last)

Write `$DAGRUN_ARTIFACTS/reflections.md` if you discovered anything non-obvious about the
acceptance-test surface, the build/test rerun, or the framework's own quirks (e.g. an
`@MultiDbTest` await pattern that isn't obvious from the reference tests, a testcontainer
provisioning gotcha). Absence is fine. The SessionEnd hook captures this automatically.

---

## Constraints

- The acceptance test file is real, committed Camunda test code — it belongs in
  `$DAGRUN_WORKTREE/qa/acceptance-tests`, NOT in `$DAGRUN_ARTIFACTS`.
- `verify-plan.md` and `verify-report.json` are the ONLY files written to `$DAGRUN_ARTIFACTS`.
- Never let a testcontainer/infra failure read as `PASS` — when in doubt between `ERROR_INFRA` and
  `FAIL_ASSERTION`, prefer `ERROR_INFRA` only when the failure is clearly provisioning-level (the
  test body itself never ran); otherwise it's a real assertion failure.
- Do not add any CI-style dist/packaging/cross-storage matrix coverage — out of scope.
- Do not skip the D3 self-check for a reused existing AT (bugfix path) — reuse still needs
  grounding confirmation.
