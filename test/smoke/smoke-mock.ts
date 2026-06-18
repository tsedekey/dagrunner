#!/usr/bin/env node
/**
 * smoke-mock.ts — in-process smoke test for the full feature-workflow gated pipeline.
 *
 * Drives startRun / resumeRun directly (no subprocess, no SDK, no API key needed).
 * Uses createMockExecutor so every node returns a canned result in milliseconds.
 *
 * Run: node --import tsx ./test/smoke/smoke-mock.ts
 *
 * Two complete runs are exercised:
 *   Run A — election=n (4 steps): reject Gate 1, re-approve, run through, skip verify, pr → done.
 *   Run B — election=y (4 steps): straight approve, run verify (gate-pause), approve Gate 3, pr → done.
 *
 * Note: mock gate-pause returns iteration:1, so a reject after the first pause writes
 * feedback-2.md (not feedback-1.md). This differs from the real SDK runner which
 * returns iteration:0 on first pause. See coordinator log for deviation note.
 */

import assert from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startRun } from "../../src/runtime/run-engine.js";
import { resumeRun } from "../../src/runtime/run-engine.js";
import { createMockExecutor } from "../../src/runtime/mock-executor.js";
import { featureWorkflow } from "../../src/workflow/feature-workflow.js";
import type { DagrunnerConfig } from "../../src/config/xdg.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const TOY_PLAN_PATH = join(__dirname, "fixtures", "toy-plan.md");
const TOY_REPO_PATH = join(__dirname, "fixtures", "toy-repo");

// Keep PROJECT_ROOT reference to satisfy "noUnusedLocals" lint in the
// calling tsconfig — this file is run with tsx which does not enforce it,
// but we keep it tidy for future.
void PROJECT_ROOT;

// ---------------------------------------------------------------------------
// Provision toy git repo (idempotent — same fixture as smoke.ts uses)
// ---------------------------------------------------------------------------

if (!existsSync(join(TOY_REPO_PATH, ".git"))) {
  mkdirSync(TOY_REPO_PATH, { recursive: true });
  execSync(
    'git init && echo "# toy repo" > README.md && git add README.md && git commit -m "init"',
    { cwd: TOY_REPO_PATH, stdio: "inherit" },
  );
}

// ---------------------------------------------------------------------------
// Mock executor factory — shared by all steps of both runs
// ---------------------------------------------------------------------------

const mockFactory = (
  _config: DagrunnerConfig,
  _runId: string,
  _runDir: string,
  _worktreePath: string,
) =>
  createMockExecutor({
    expand: "gate-pause", // writes guide.md + returns awaiting-gate
    implement: "success", // writes summary.md
    review: "success", // writes findings.json
    fix: "gate-pause", // writes summary.md + returns awaiting-gate
    verify: "gate-pause", // writes seeding-spec.json + manual-test.md + awaiting-gate
    pr: "success", // writes body.md
  });

// ---------------------------------------------------------------------------
// State helper
// ---------------------------------------------------------------------------

function readState(runDir: string): {
  status: string;
  verifyElection?: string;
  nodes: Record<string, { status: string }>;
} {
  return JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as {
    status: string;
    verifyElection?: string;
    nodes: Record<string, { status: string }>;
  };
}

// ---------------------------------------------------------------------------
// RUN A — election=n
// ---------------------------------------------------------------------------

const HOME_A = `/tmp/dagrun-smoke-mock-a-${Date.now()}`;
// acquireLock writes active.lock into homeDir — must exist before startRun.
// startRun also calls readdirSync on runs/ — create it too.
mkdirSync(join(HOME_A, "runs"), { recursive: true });
mkdirSync(join(HOME_A, "worktrees"), { recursive: true });

const config: DagrunnerConfig = { DEVHARNESS_SRC: TOY_REPO_PATH };

// ---------------------------------------------------------------------------
// Step A1 — startRun -> expand gate-pause -> awaiting-gate
// ---------------------------------------------------------------------------

await startRun({
  workflow: featureWorkflow,
  planPath: TOY_PLAN_PATH,
  homeDir: HOME_A,
  config,
  executorFactory: mockFactory,
});

const runsA = readdirSync(join(HOME_A, "runs")).filter((d) =>
  existsSync(join(HOME_A, "runs", d, "state.json")),
);
assert.ok(
  runsA.length > 0,
  "at least one run directory must exist after startRun A",
);
const RUN_ID_A = runsA[0] as string;
const runDirA = join(HOME_A, "runs", RUN_ID_A);

{
  const state = readState(runDirA);
  assert.strictEqual(
    state.status,
    "paused",
    `A1: expected paused, got ${state.status}`,
  );
  assert.strictEqual(
    state.nodes["expand"]?.status,
    "awaiting-gate",
    `A1: expand must be awaiting-gate, got ${String(state.nodes["expand"]?.status)}`,
  );
  assert.ok(
    existsSync(join(runDirA, "expand", "guide.md")),
    "A1: expand/guide.md must exist (produces contract met)",
  );
}
console.log(
  "step A1 passed: startRun -> expand awaiting-gate, guide.md written",
);

// ---------------------------------------------------------------------------
// Step A2 — resumeRun(rejectComment) -> expand re-pauses
// ---------------------------------------------------------------------------

await resumeRun({
  runId: RUN_ID_A,
  homeDir: HOME_A,
  config,
  rejectComment: "add error handling section",
  executorFactory: mockFactory,
});

{
  // mock gate-pause returns iteration:1, so reject computes n = iteration+1 = 2.
  // Coordinator note: this differs from smoke.ts which asserts feedback-1.md because
  // the real SDK runner returns iteration:0 on first pause.
  assert.ok(
    readdirSync(join(runDirA, "expand")).some((f) =>
      /^feedback-\d+\.md$/.test(f),
    ),
    "A2: a feedback-N.md must be written in expand/",
  );
  const state = readState(runDirA);
  assert.strictEqual(
    state.status,
    "paused",
    `A2: expected paused, got ${state.status}`,
  );
  assert.strictEqual(
    state.nodes["expand"]?.status,
    "awaiting-gate",
    `A2: expand must still be awaiting-gate after reject, got ${String(state.nodes["expand"]?.status)}`,
  );
}
console.log(
  "step A2 passed: rejectComment -> feedback-N.md written -> expand re-paused",
);

// ---------------------------------------------------------------------------
// Step A3 — resumeRun(approve Gate 1) -> implement -> review -> fix gate-pause
// ---------------------------------------------------------------------------

await resumeRun({
  runId: RUN_ID_A,
  homeDir: HOME_A,
  config,
  approve: true,
  executorFactory: mockFactory,
});

{
  const state = readState(runDirA);
  assert.strictEqual(
    state.nodes["expand"]?.status,
    "done",
    `A3: expand must be done after approval, got ${String(state.nodes["expand"]?.status)}`,
  );
  assert.strictEqual(
    state.nodes["implement"]?.status,
    "done",
    `A3: implement must be done, got ${String(state.nodes["implement"]?.status)}`,
  );
  assert.ok(
    existsSync(join(runDirA, "implement", "summary.md")),
    "A3: implement/summary.md must exist",
  );
  assert.strictEqual(
    state.nodes["review"]?.status,
    "done",
    `A3: review must be done, got ${String(state.nodes["review"]?.status)}`,
  );
  assert.ok(
    existsSync(join(runDirA, "review", "findings.json")),
    "A3: review/findings.json must exist",
  );
  assert.strictEqual(
    state.nodes["fix"]?.status,
    "awaiting-gate",
    `A3: fix must be awaiting-gate, got ${String(state.nodes["fix"]?.status)}`,
  );
  assert.ok(
    existsSync(join(runDirA, "fix", "summary.md")),
    "A3: fix/summary.md must exist",
  );
  assert.strictEqual(
    state.status,
    "paused",
    `A3: run must be paused, got ${state.status}`,
  );
}
console.log(
  "step A3 passed: approve Gate 1 -> implement -> review -> fix gate-pause",
);

// ---------------------------------------------------------------------------
// Step A4 — resumeRun(approve Gate 2 + verify=n) -> verify skipped -> pr -> done
// ---------------------------------------------------------------------------

await resumeRun({
  runId: RUN_ID_A,
  homeDir: HOME_A,
  config,
  approve: true,
  verify: "n",
  executorFactory: mockFactory,
});

{
  const state = readState(runDirA);
  assert.strictEqual(
    state.verifyElection,
    "n",
    `A4: verifyElection must be "n", got ${String(state.verifyElection)}`,
  );
  assert.strictEqual(
    state.nodes["fix"]?.status,
    "done",
    `A4: fix must be done after approval, got ${String(state.nodes["fix"]?.status)}`,
  );
  assert.strictEqual(
    state.nodes["verify"]?.status,
    "skipped",
    `A4: verify must be skipped (election=n), got ${String(state.nodes["verify"]?.status)}`,
  );
  assert.strictEqual(
    state.nodes["pr"]?.status,
    "done",
    `A4: pr must be done, got ${String(state.nodes["pr"]?.status)}`,
  );
  assert.ok(
    existsSync(join(runDirA, "pr", "body.md")),
    "A4: pr/body.md must exist",
  );
  assert.strictEqual(
    state.status,
    "done",
    `A4: run must be done (pr is terminal), got ${state.status}`,
  );
}
console.log(
  "step A4 passed: approve Gate 2 + election=n -> verify skipped -> pr done -> run done. Run A complete (election=n)",
);

// ---------------------------------------------------------------------------
// RUN B — election=y
// ---------------------------------------------------------------------------

const HOME_B = `/tmp/dagrun-smoke-mock-b-${Date.now() + 1}`;
mkdirSync(join(HOME_B, "runs"), { recursive: true });
mkdirSync(join(HOME_B, "worktrees"), { recursive: true });

// ---------------------------------------------------------------------------
// Step B1 — startRun -> expand gate-pause -> awaiting-gate
// ---------------------------------------------------------------------------

await startRun({
  workflow: featureWorkflow,
  planPath: TOY_PLAN_PATH,
  homeDir: HOME_B,
  config,
  executorFactory: mockFactory,
});

const runsB = readdirSync(join(HOME_B, "runs")).filter((d) =>
  existsSync(join(HOME_B, "runs", d, "state.json")),
);
assert.ok(
  runsB.length > 0,
  "at least one run directory must exist after startRun B",
);
const RUN_ID_B = runsB[0] as string;
const runDirB = join(HOME_B, "runs", RUN_ID_B);

{
  const state = readState(runDirB);
  assert.strictEqual(
    state.status,
    "paused",
    `B1: expected paused, got ${state.status}`,
  );
  assert.strictEqual(
    state.nodes["expand"]?.status,
    "awaiting-gate",
    `B1: expand must be awaiting-gate, got ${String(state.nodes["expand"]?.status)}`,
  );
  assert.ok(
    existsSync(join(runDirB, "expand", "guide.md")),
    "B1: expand/guide.md must exist",
  );
}
console.log("step B1 passed: startRun -> expand awaiting-gate");

// ---------------------------------------------------------------------------
// Step B2 — resumeRun(approve Gate 1) -> implement -> review -> fix gate-pause
// ---------------------------------------------------------------------------

await resumeRun({
  runId: RUN_ID_B,
  homeDir: HOME_B,
  config,
  approve: true,
  executorFactory: mockFactory,
});

{
  const state = readState(runDirB);
  assert.strictEqual(
    state.nodes["implement"]?.status,
    "done",
    `B2: implement must be done, got ${String(state.nodes["implement"]?.status)}`,
  );
  assert.ok(
    existsSync(join(runDirB, "implement", "summary.md")),
    "B2: implement/summary.md must exist",
  );
  assert.ok(
    existsSync(join(runDirB, "review", "findings.json")),
    "B2: review/findings.json must exist",
  );
  assert.strictEqual(
    state.nodes["fix"]?.status,
    "awaiting-gate",
    `B2: fix must be awaiting-gate, got ${String(state.nodes["fix"]?.status)}`,
  );
  assert.strictEqual(
    state.status,
    "paused",
    `B2: run must be paused, got ${state.status}`,
  );
}
console.log(
  "step B2 passed: approve Gate 1 -> implement -> review -> fix gate-pause",
);

// ---------------------------------------------------------------------------
// Step B3 — resumeRun(approve Gate 2 + verify=y) -> verify gate-pause
// ---------------------------------------------------------------------------

await resumeRun({
  runId: RUN_ID_B,
  homeDir: HOME_B,
  config,
  approve: true,
  verify: "y",
  executorFactory: mockFactory,
});

{
  const state = readState(runDirB);
  assert.strictEqual(
    state.verifyElection,
    "y",
    `B3: verifyElection must be "y", got ${String(state.verifyElection)}`,
  );
  assert.strictEqual(
    state.nodes["fix"]?.status,
    "done",
    `B3: fix must be done after approval, got ${String(state.nodes["fix"]?.status)}`,
  );
  assert.strictEqual(
    state.nodes["verify"]?.status,
    "awaiting-gate",
    `B3: verify must be awaiting-gate (election=y), got ${String(state.nodes["verify"]?.status)}`,
  );
  assert.ok(
    existsSync(join(runDirB, "verify", "seeding-spec.json")),
    "B3: verify/seeding-spec.json must exist",
  );
  assert.ok(
    existsSync(join(runDirB, "verify", "manual-test.md")),
    "B3: verify/manual-test.md must exist",
  );
  assert.strictEqual(
    state.status,
    "paused",
    `B3: run must be paused, got ${state.status}`,
  );
}
console.log("step B3 passed: approve Gate 2 + election=y -> verify gate-pause");

// ---------------------------------------------------------------------------
// Step B4 — resumeRun(approve Gate 3) -> pr -> done
// ---------------------------------------------------------------------------

await resumeRun({
  runId: RUN_ID_B,
  homeDir: HOME_B,
  config,
  approve: true,
  executorFactory: mockFactory,
});

{
  const state = readState(runDirB);
  assert.strictEqual(
    state.nodes["verify"]?.status,
    "done",
    `B4: verify must be done after approval, got ${String(state.nodes["verify"]?.status)}`,
  );
  assert.strictEqual(
    state.nodes["pr"]?.status,
    "done",
    `B4: pr must be done, got ${String(state.nodes["pr"]?.status)}`,
  );
  assert.ok(
    existsSync(join(runDirB, "pr", "body.md")),
    "B4: pr/body.md must exist",
  );
  assert.strictEqual(
    state.status,
    "done",
    `B4: run must be done (pr is terminal), got ${state.status}`,
  );
}
console.log(
  "step B4 passed: approve Gate 3 -> verify done -> pr done -> run done. Run B complete (election=y)",
);

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log(
  "\nall smoke-mock steps passed (Run A: election=n, Run B: election=y)",
);
