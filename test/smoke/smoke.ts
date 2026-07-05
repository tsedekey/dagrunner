#!/usr/bin/env node
/**
 * Block 9 — 7-step smoke test for dagrunner v1 (Phase 2a + 2b).
 *
 * Drives the real thin slice end-to-end using non-interactive flags.
 * Makes REAL SDK calls for steps 2-6 (verify — now autonomous, no election).
 * Step 7 uses a synthetic state (no API call) to test reconcile plumbing only.
 * verify-autonomy change: step 6 approves Gate 2 and lets verify run for
 * real; see the step-6 comment block for the toy-repo coverage gap this
 * leaves (verify's build/test/AT stages need a Maven+Docker-shaped worktree
 * that the toy repo fixture does not provide).
 *
 * Run: node --import tsx ./test/smoke/smoke.ts
 *
 * Requirements:
 *   ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN must be set in env.
 *
 * Advisory notes applied:
 *   1. cwd is always TOY_REPO_PATH so git worktree add operates on the toy repo.
 *   2. Auth guard is the first executable statement.
 *   3. toy-repo is provisioned at runtime (not committed); see .gitignore.
 */

import assert from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const CLI = join(PROJECT_ROOT, "src", "cli", "cli.ts");
const TOY_PLAN_PATH = join(__dirname, "fixtures", "toy-plan.md");
const TOY_REPO_PATH = join(__dirname, "fixtures", "toy-repo");

// ---------------------------------------------------------------------------
// Step 0 — auth guard (FIRST executable statement)
// ---------------------------------------------------------------------------

// Accept API key, auth token, or claude.ai subscription auth (claude binary has its own credentials)
const hasApiKey =
  !!process.env["ANTHROPIC_API_KEY"] || !!process.env["ANTHROPIC_AUTH_TOKEN"];
const hasClaudeAuth = (() => {
  try {
    const out = execSync(
      "claude auth status --json 2>/dev/null || claude auth status",
      { encoding: "utf8", timeout: 5000 },
    );
    return out.includes('"loggedIn": true') || out.includes('"loggedIn":true');
  } catch {
    return false;
  }
})();
if (!hasApiKey && !hasClaudeAuth) {
  process.stderr.write(
    "smoke test requires ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or claude.ai subscription login\n",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Provision toy git repo (idempotent; not committed — see .gitignore)
// ---------------------------------------------------------------------------

if (!existsSync(join(TOY_REPO_PATH, ".git"))) {
  mkdirSync(TOY_REPO_PATH, { recursive: true });
  execSync(
    'git init && echo "# toy repo" > README.md && git add README.md && git commit -m "init"',
    { cwd: TOY_REPO_PATH, stdio: "inherit" },
  );
} else {
  // Reset to committed baseline each run — prevents cross-run dirty accumulation
  execSync("git reset --hard HEAD && git clean -fd", {
    cwd: TOY_REPO_PATH,
    stdio: "inherit",
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Run the CLI via spawnSync with cwd=TOY_REPO_PATH so git worktree works. */
function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 30_000,
) {
  return spawnSync("node", ["--import", "tsx", CLI, ...args], {
    cwd: TOY_REPO_PATH,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

const HOME = `/tmp/dagrun-smoke-${Date.now()}`;
const HOME_ENV = { DAGRUNNER_HOME: HOME };
let RUN_ID = "";

// ---------------------------------------------------------------------------
// Step 1 — dagrun init
// ---------------------------------------------------------------------------

{
  const result = runCli(["init", "--home", HOME], {});
  assert.strictEqual(result.status, 0, `init failed: ${result.stderr}`);
  assert.ok(existsSync(join(HOME, "runs")), "runs dir must exist after init");
  assert.ok(
    existsSync(join(HOME, "worktrees")),
    "worktrees dir must exist after init",
  );
  console.log("step 1 passed: init");
}

// ---------------------------------------------------------------------------
// Step 2 — dagrun start feature --plan toy-plan.md
//          expand (Gate 1) → awaiting-gate → exits
// ---------------------------------------------------------------------------

{
  // Write config with DEVHARNESS_SRC pointing to the toy repo.
  writeFileSync(
    join(HOME, "config.json"),
    JSON.stringify({ DEVHARNESS_SRC: TOY_REPO_PATH }, null, 2),
    "utf8",
  );

  const result = runCli(
    ["start", "feature", "--plan", TOY_PLAN_PATH],
    HOME_ENV,
    180_000, // 3 minutes for one real API call (expand)
  );

  assert.strictEqual(
    result.status,
    0,
    `start failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.ok(
    result.stdout.includes("checkpointed") ||
      result.stdout.includes("awaiting"),
    `expected gate checkpoint in output:\n${result.stdout}`,
  );

  const runs = readdirSync(join(HOME, "runs")).filter((d) =>
    existsSync(join(HOME, "runs", d, "state.json")),
  );
  assert.ok(runs.length > 0, "at least one run directory must exist");

  RUN_ID = runs[0] as string;
  const runDir = join(HOME, "runs", RUN_ID);

  // Confirm guide.md was produced by expand.
  const guidePath = join(runDir, "expand", "guide.md");
  assert.ok(existsSync(guidePath), `guide.md must exist at ${guidePath}`);

  console.log(`step 2 passed: start -> expand -> gate (run: ${RUN_ID})`);
}

// ---------------------------------------------------------------------------
// Step 3 — dagrun status shows awaiting-gate + cost
// ---------------------------------------------------------------------------

{
  const result = runCli(["status"], HOME_ENV);
  assert.strictEqual(result.status, 0, `status failed: ${result.stderr}`);
  assert.ok(
    result.stdout.includes("awaiting-gate") ||
      result.stdout.includes("awaiting"),
    `status must show awaiting-gate:\n${result.stdout}`,
  );
  // Cost is shown as "$0.XXXX" — confirm a dollar-sign cost figure appears.
  assert.ok(
    result.stdout.includes("$"),
    `status must include cost figure:\n${result.stdout}`,
  );
  console.log("step 3 passed: status shows awaiting-gate + cost");
}

// ---------------------------------------------------------------------------
// Step 4 — dagrun resume --reject "add error handling section"
// ---------------------------------------------------------------------------

{
  const result = runCli(
    ["resume", RUN_ID, "--reject", "add error handling section"],
    HOME_ENV,
    180_000, // 3 minutes for a revise call
  );
  assert.strictEqual(
    result.status,
    0,
    `reject failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );

  const runDir = join(HOME, "runs", RUN_ID);
  const feedback1 = join(runDir, "expand", "feedback-1.md");
  assert.ok(existsSync(feedback1), `feedback-1.md must exist at ${feedback1}`);
  // Run must be paused again after revise.
  assert.ok(
    result.stdout.includes("re-paused") || result.stdout.includes("awaiting"),
    `must re-pause at gate after reject:\n${result.stdout}`,
  );
  console.log("step 4 passed: reject -> feedback-1.md written -> re-paused");
}

// ---------------------------------------------------------------------------
// Step 5 — dagrun resume --approve (Gate 1) -> implement -> review -> fix -> Gate 2
// ---------------------------------------------------------------------------

{
  const result = runCli(
    ["resume", RUN_ID, "--approve"],
    HOME_ENV,
    600_000, // 10 minutes: implement + review (multi-subagent fan-out) + fix
  );
  assert.strictEqual(
    result.status,
    0,
    `approve Gate 1 failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );

  const runDir = join(HOME, "runs", RUN_ID);
  const stateRaw = JSON.parse(
    readFileSync(join(runDir, "state.json"), "utf8"),
  ) as { status: string; nodes: Record<string, { status: string }> };

  // After Gate 1 approve: implement runs, review runs, fix hits Gate 2 and pauses.
  assert.ok(
    stateRaw.status === "paused" || stateRaw.status === "running",
    `run must be paused at Gate 2 or running, got: ${stateRaw.status}`,
  );
  assert.ok(
    existsSync(join(runDir, "implement", "summary.md")),
    "implement/summary.md must exist",
  );
  assert.ok(
    existsSync(join(runDir, "review", "findings.json")),
    "review/findings.json must exist after review node",
  );
  // findings.json must be valid JSON with required top-level keys
  const findingsRaw = JSON.parse(
    readFileSync(join(runDir, "review", "findings.json"), "utf8"),
  ) as Record<string, unknown>;
  for (const key of [
    "run_id",
    "timestamp",
    "reviewers_run",
    "reviewers_skipped",
    "adversarial_verifier_run",
    "findings",
  ]) {
    assert.ok(key in findingsRaw, `findings.json must have key "${key}"`);
  }
  assert.ok(
    Array.isArray(findingsRaw["findings"]),
    "findings.json findings must be an array",
  );
  assert.ok(
    existsSync(join(runDir, "fix", "summary.md")),
    "fix/summary.md must exist after fix node",
  );
  console.log(
    "step 5 passed: approve Gate 1 -> implement -> review -> fix -> Gate 2 pause",
  );
}

// ---------------------------------------------------------------------------
// Step 6 — dagrun resume --approve (Gate 2) -> verify runs autonomously
//
// verify-autonomy change: there is no more election/--verify flag. Gate 2
// approval now runs verify directly (required, blocking, no human gate).
//
// KNOWN SMOKE:LIVE GAP (see DECISIONS.md § verify-autonomy-smoke-live-gap):
// the toy repo fixture (test/smoke/fixtures/toy-repo) is a bare git init with
// only README.md — no pom.xml, no Maven wrapper, no qa/acceptance-tests
// module, no Docker/testcontainers scaffolding. verify's D4 (independent
// build+test rerun) and D5 (run the authored @MultiDbTest) CANNOT pass
// against this fixture — that is verify doing its job correctly (fail loud
// on a broken/absent build), not a smoke-test bug. This step therefore does
// NOT assert a PASS outcome or that pr ran; it asserts that verify's real SDK
// session starts, completes (any terminal status), and that the SessionEnd
// hook fires during that session — the same deterministic-hook-wiring proof
// step 6 has always carried, just re-anchored to verify's session instead of
// pr's now that pr no longer unconditionally runs. A full green verify run
// requires smoke:live against a real Camunda-shaped worktree (Maven+Docker+
// qa/acceptance-tests) — out of scope for this build; deferred to Eddie.
//
// Reflection wiring check (option b — deterministic):
//   Seed a known reflections.md into the verify artifact dir BEFORE resume so
//   the SessionEnd hook has a file to capture regardless of what the model
//   writes, and regardless of whether verify's own outcome is PASS or not.
// ---------------------------------------------------------------------------

{
  // Seed verify/reflections.md BEFORE the resume call so the SessionEnd hook
  // captures it deterministically. The sdk-runner uses mkdir -p (not rm+mkdir)
  // so the file survives into the session.
  const verifyArtifactsDir = join(HOME, "runs", RUN_ID, "verify");
  mkdirSync(verifyArtifactsDir, { recursive: true });
  writeFileSync(
    join(verifyArtifactsDir, "reflections.md"),
    "smoke:live seeded reflection — deterministic hook wiring check",
    "utf8",
  );

  const result = runCli(
    ["resume", RUN_ID, "--approve"],
    // DAGRUN_NO_PR prevents real gh pr create if pr does end up running.
    { ...HOME_ENV, DAGRUN_NO_PR: "1" },
    600_000, // 10 minutes: verify (build/test rerun + AT authoring/execution attempt)
  );
  assert.strictEqual(
    result.status,
    0,
    `Gate 2 approve failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );

  const runDir = join(HOME, "runs", RUN_ID);
  const stateRaw = JSON.parse(
    readFileSync(join(runDir, "state.json"), "utf8"),
  ) as {
    status: string;
    nodes: Record<string, { status: string }>;
  };

  // verify must have run (no longer "pending") — its own session decides the
  // terminal status; a toy repo with no build tooling cannot legitimately PASS.
  assert.notStrictEqual(
    stateRaw.nodes["verify"]?.status,
    "pending",
    `verify must have run, got: ${String(stateRaw.nodes["verify"]?.status)}`,
  );
  assert.ok(
    ["done", "failed"].includes(stateRaw.status),
    `run must reach a terminal status after verify's session ends, got: ${stateRaw.status}`,
  );
  // Assert the seeded reflections.md was captured by the SessionEnd hook.
  // Deterministic: this entry was pre-written by smoke, not by the model.
  // Proves hook fires + env (DAGRUN_STORE_DIR, DAGRUN_ARTIFACTS) propagates correctly.
  const reflectionLog = join(HOME, "store", "reflection-log.jsonl");
  assert.ok(
    existsSync(reflectionLog),
    `reflection-log.jsonl must exist at ${reflectionLog} — SessionEnd hook wiring required`,
  );
  const lines = readFileSync(reflectionLog, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  // Find the seeded entry (may be among other entries if model also reflected).
  const seededEntry = lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find(
      (e) =>
        typeof e["body"] === "string" &&
        (e["body"] as string).includes("smoke:live seeded reflection"),
    );
  assert.ok(
    seededEntry !== undefined,
    "seeded reflection must appear in reflection-log.jsonl — SessionEnd hook did not capture it",
  );
  assert.ok(
    typeof seededEntry["ts"] === "string",
    "seeded entry must have ts field",
  );
  assert.ok(
    typeof seededEntry["source"] === "string",
    "seeded entry must have source field",
  );
  console.log(
    `  reflection-log has ${lines.length} entries — hook-driven capture verified (seeded entry found)`,
  );
  console.log(
    "step 6 passed: Gate 2 approve -> verify ran autonomously (real SDK session, hook wiring proven)",
  );
}

// ---------------------------------------------------------------------------
// Step 7 — reconcile: running node -> failed (synthetic, no API call)
// ---------------------------------------------------------------------------

{
  const runDir = join(HOME, "runs", RUN_ID);
  const finalState = JSON.parse(
    readFileSync(join(runDir, "state.json"), "utf8"),
  ) as {
    runId: string;
    workflow: string;
    createdAt: string;
    updatedAt: string;
    status: string;
    worktreePath: string;
    branch: string;
    sourcePlanPath: string;
    nodes: Record<
      string,
      {
        status: string;
        artifacts: string[];
        iteration: number;
        cost: number;
        gateHistory: unknown[];
        sessionId?: string;
      }
    >;
  };

  // Build a synthetic run state with implement stuck in 'running'
  // (simulate a process that was killed mid-implement).
  const killedRunId = `${RUN_ID}-kill-test`;
  const killedRunDir = join(HOME, "runs", killedRunId);
  mkdirSync(killedRunDir, { recursive: true });

  // Copy the implement artifacts dir so the node dir exists.
  const implementNode = finalState.nodes["implement"];
  assert.ok(implementNode, "implement node must be present in final state");

  const killedState = {
    ...finalState,
    runId: killedRunId,
    status: "running",
    nodes: {
      ...finalState.nodes,
      implement: {
        ...implementNode,
        status: "running",
        // Set interruptRetries well above the cap so resetInterruptedNodes
        // leaves it failed immediately — no SDK call fires, test is deterministic.
        interruptRetries: 99,
        // Drop sessionId so there is no resume attempt
        sessionId: undefined,
      },
    },
  };

  // Remove undefined sessionId so JSON.stringify does not emit null.
  if (killedState.nodes["implement"]) {
    const impl = killedState.nodes["implement"] as Record<string, unknown>;
    delete impl["sessionId"];
  }

  writeFileSync(
    join(killedRunDir, "state.json"),
    JSON.stringify(killedState, null, 2),
    "utf8",
  );

  // Write a stale active.lock pointing to the killed run (pid that does not exist).
  writeFileSync(
    join(HOME, "active.lock"),
    JSON.stringify({
      runId: killedRunId,
      pid: 99999,
      startedAt: new Date().toISOString(),
    }),
    "utf8",
  );

  // Resume with --approve. Flow:
  //   reconcileRunningNodes: implement running → failed (interrupt error, interruptRetries:99)
  //   resetInterruptedNodes: 99 >= cap (2) → leaves failed, no SDK call fires
  //   runDag: all nodes terminal → returns failed immediately
  // No real API call; deterministic exit code 1.
  const result = runCli(["resume", killedRunId, "--approve"], HOME_ENV, 10_000);

  // Run must exit 1 (failed terminal state — no retry fired because cap was hit).
  assert.strictEqual(
    result.status,
    1,
    `resume must exit 1 (cap-exceeded run ends failed), got: ${String(result.status)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );

  const reconciledRaw = JSON.parse(
    readFileSync(join(killedRunDir, "state.json"), "utf8"),
  ) as { nodes: Record<string, { status: string }> };

  // Interrupt-retry cap was hit — implement must be 'failed' (not reset to pending).
  const implementStatus = reconciledRaw.nodes["implement"]?.status;
  assert.strictEqual(
    implementStatus,
    "failed",
    `interrupt-retry cap must leave implement failed; got: ${String(implementStatus)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );

  console.log(
    `step 7 passed: interrupt-retry cap hit — implement stayed failed, no SDK call fired`,
  );
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log("\nall 7 smoke test steps passed");
