#!/usr/bin/env node
/**
 * Block 9 — 6-step smoke test for dagrunner v1.
 *
 * Drives the real thin slice end-to-end using non-interactive flags.
 * Makes REAL SDK calls for steps 2-5. Step 6 uses a synthetic state
 * (no API call) to test reconcile plumbing only.
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
const CLI = join(PROJECT_ROOT, "src", "cli.ts");
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
//          classify (haiku) → expand-guide → awaiting-gate → exits
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
    180_000, // 3 minutes for two real API calls
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

  // Confirm classify.json is valid JSON matching ClassifyOutput schema.
  const runs = readdirSync(join(HOME, "runs")).filter((d) =>
    existsSync(join(HOME, "runs", d, "state.json")),
  );
  assert.ok(runs.length > 0, "at least one run directory must exist");

  RUN_ID = runs[0] as string;
  const runDir = join(HOME, "runs", RUN_ID);
  const classifyPath = join(runDir, "classify", "classify.json");
  assert.ok(
    existsSync(classifyPath),
    `classify.json must exist at ${classifyPath}`,
  );

  const classifyRaw = JSON.parse(readFileSync(classifyPath, "utf8")) as unknown;
  assert.ok(
    classifyRaw !== null && typeof classifyRaw === "object",
    "classify.json must be a JSON object",
  );
  const classify = classifyRaw as Record<string, unknown>;
  for (const field of [
    "touches_public_api",
    "touches_runtime",
    "perf_sensitive",
    "touches_schema_or_proto",
    "needs_runtime",
    "run_adversarial_verifier",
    "recommend_pr_review",
  ]) {
    assert.strictEqual(
      typeof classify[field],
      "boolean",
      `classify.json field "${field}" must be boolean`,
    );
  }
  assert.ok(
    classify["risk"] === "low" ||
      classify["risk"] === "med" ||
      classify["risk"] === "high",
    `classify.json risk must be low|med|high, got: ${String(classify["risk"])}`,
  );

  // Confirm guide.md was produced.
  const guidePath = join(runDir, "expand-guide", "guide.md");
  assert.ok(existsSync(guidePath), `guide.md must exist at ${guidePath}`);

  console.log(
    `step 2 passed: start -> classify -> expand-guide -> gate (run: ${RUN_ID})`,
  );
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
  const feedback1 = join(runDir, "expand-guide", "feedback-1.md");
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
// Step 6 — dagrun resume --approve (Gate 2) -> done
// ---------------------------------------------------------------------------

{
  const result = runCli(
    ["resume", RUN_ID, "--approve"],
    HOME_ENV,
    60_000, // Gate 2 approve: no API call needed, just state transition
  );
  assert.strictEqual(
    result.status,
    0,
    `approve Gate 2 failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );

  const runDir = join(HOME, "runs", RUN_ID);
  const stateRaw = JSON.parse(
    readFileSync(join(runDir, "state.json"), "utf8"),
  ) as { status: string; nodes: Record<string, { status: string }> };

  assert.strictEqual(
    stateRaw.status,
    "done",
    `run must reach done status after Gate 2 approve, got: ${stateRaw.status}`,
  );
  console.log("step 6 passed: approve Gate 2 -> done");
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

  // Resume with --approve. Since all prior nodes are already 'done' and
  // 'implement' was just set to 'running', reconcile will mark it 'failed'.
  // The DAG will then try to re-run implement — but all other nodes are done
  // and implement is failed (non-optional), so the run ends as 'failed'.
  // We assert only the reconcile behaviour (running->failed), not re-run quality.
  const result = runCli(["resume", killedRunId, "--approve"], HOME_ENV, 60_000);

  // Resume may exit 0 (run completes as failed is OK) or 0 after re-run.
  // The key assertion is that the state file shows implement was reconciled.
  const reconciledRaw = JSON.parse(
    readFileSync(join(killedRunDir, "state.json"), "utf8"),
  ) as { nodes: Record<string, { status: string }> };

  // After reconcile, implement must be 'failed' — reconcileRunningNodes sets
  // running→failed, and runDag finds all nodes terminal, never re-queues.
  const implementStatus = reconciledRaw.nodes["implement"]?.status;
  assert.strictEqual(
    implementStatus,
    "failed",
    `reconcile must mark running->failed, got: ${String(implementStatus)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );

  console.log(
    `step 7 passed: reconcile running->failed (status after reconcile: ${String(implementStatus)})`,
  );
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log("\nall 7 smoke test steps passed");
