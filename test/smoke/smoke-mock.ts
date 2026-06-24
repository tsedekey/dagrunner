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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

/**
 * Copy toy-plan.md into homeDir with a unique issue-number prefix so each
 * smoke run produces a distinct branch name (feat/<issueNum>-toy).
 * makeRunId and makeBranchName derive the issue number from the filename.
 */
function makePlanPath(homeDir: string, issueNum: number): string {
  const dest = join(homeDir, `${issueNum}-toy-plan.md`);
  writeFileSync(dest, readFileSync(TOY_PLAN_PATH, "utf8"), "utf8");
  return dest;
}

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
  _storeDir: string,
) =>
  createMockExecutor({
    define: "gate-pause", // writes guide.md + returns awaiting-gate
    implement: "success", // writes summary.md
    review: "success", // writes findings.json
    fix: "gate-pause", // writes summary.md + returns awaiting-gate
    verify: "gate-pause", // writes seeding-spec.json + manual-test.md + awaiting-gate
    pr: "success", // writes body.md
  });

// ---------------------------------------------------------------------------
// State helper
// ---------------------------------------------------------------------------

type GateEntry = { decision: string; mode?: string; basis?: string };
type NodeSnap = { status: string; gateHistory?: GateEntry[] };

function readState(runDir: string): {
  status: string;
  verifyElection?: string;
  nodes: Record<string, NodeSnap>;
} {
  return JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as {
    status: string;
    verifyElection?: string;
    nodes: Record<string, NodeSnap>;
  };
}

// ---------------------------------------------------------------------------
// Base timestamp — used for HOME dirs and unique issue numbers per run
// ---------------------------------------------------------------------------

const BASE_TS = Date.now();

// ---------------------------------------------------------------------------
// RUN A — election=n
// ---------------------------------------------------------------------------

const HOME_A = `/tmp/dagrun-smoke-mock-a-${BASE_TS}`;
// acquireLock writes active.lock into homeDir — must exist before startRun.
// startRun also calls readdirSync on runs/ — create it too.
mkdirSync(join(HOME_A, "runs"), { recursive: true });
mkdirSync(join(HOME_A, "worktrees"), { recursive: true });

const config: DagrunnerConfig = { DEVHARNESS_SRC: TOY_REPO_PATH };
const PLAN_A = makePlanPath(HOME_A, BASE_TS);

// ---------------------------------------------------------------------------
// Step A1 — startRun -> define gate-pause -> awaiting-gate
// ---------------------------------------------------------------------------

await startRun({
  workflow: featureWorkflow,
  planPath: PLAN_A,
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
    state.nodes["define"]?.status,
    "awaiting-gate",
    `A1: define must be awaiting-gate, got ${String(state.nodes["define"]?.status)}`,
  );
  assert.ok(
    existsSync(join(runDirA, "define", "guide.md")),
    "A1: define/guide.md must exist (produces contract met)",
  );
}
console.log(
  "step A1 passed: startRun -> define awaiting-gate, guide.md written",
);

// ---------------------------------------------------------------------------
// Step A2 — resumeRun(rejectComment) -> define re-pauses
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
    readdirSync(join(runDirA, "define")).some((f) =>
      /^feedback-\d+\.md$/.test(f),
    ),
    "A2: a feedback-N.md must be written in define/",
  );
  const state = readState(runDirA);
  assert.strictEqual(
    state.status,
    "paused",
    `A2: expected paused, got ${state.status}`,
  );
  assert.strictEqual(
    state.nodes["define"]?.status,
    "awaiting-gate",
    `A2: define must still be awaiting-gate after reject, got ${String(state.nodes["define"]?.status)}`,
  );
}
console.log(
  "step A2 passed: rejectComment -> feedback-N.md written -> define re-paused",
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
    state.nodes["define"]?.status,
    "done",
    `A3: define must be done after approval, got ${String(state.nodes["define"]?.status)}`,
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

const HOME_B = `/tmp/dagrun-smoke-mock-b-${BASE_TS + 1}`;
mkdirSync(join(HOME_B, "runs"), { recursive: true });
mkdirSync(join(HOME_B, "worktrees"), { recursive: true });
const PLAN_B = makePlanPath(HOME_B, BASE_TS + 1);

// ---------------------------------------------------------------------------
// Step B1 — startRun -> define gate-pause -> awaiting-gate
// ---------------------------------------------------------------------------

await startRun({
  workflow: featureWorkflow,
  planPath: PLAN_B,
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
    state.nodes["define"]?.status,
    "awaiting-gate",
    `B1: define must be awaiting-gate, got ${String(state.nodes["define"]?.status)}`,
  );
  assert.ok(
    existsSync(join(runDirB, "define", "guide.md")),
    "B1: define/guide.md must exist",
  );
}
console.log("step B1 passed: startRun -> define awaiting-gate");

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
// RUN C — night-mode, clean plan: auto-approve Gate 1 + Gate 2, park at
//          verify-election.  Uses the shared mockFactory (gate-pause writes
//          clean artifacts with no concerns heading).
// ---------------------------------------------------------------------------

const HOME_C = `/tmp/dagrun-smoke-mock-c-${BASE_TS + 2}`;
mkdirSync(join(HOME_C, "runs"), { recursive: true });
mkdirSync(join(HOME_C, "worktrees"), { recursive: true });
const PLAN_C = makePlanPath(HOME_C, BASE_TS + 2);

await startRun({
  workflow: featureWorkflow,
  planPath: PLAN_C,
  homeDir: HOME_C,
  config,
  executorFactory: mockFactory,
  nightMode: true,
});

const runsC = readdirSync(join(HOME_C, "runs")).filter((d) =>
  existsSync(join(HOME_C, "runs", d, "state.json")),
);
assert.ok(runsC.length > 0, "C: at least one run must exist");
const RUN_ID_C = runsC[0] as string;
const runDirC = join(HOME_C, "runs", RUN_ID_C);

{
  const state = readState(runDirC);
  assert.strictEqual(
    state.status,
    "paused",
    `C: expected paused at verify-election, got ${state.status}`,
  );
  assert.strictEqual(
    state.verifyElection,
    undefined,
    `C: verifyElection must be unset (human has not decided yet)`,
  );
  assert.strictEqual(
    state.nodes["define"]?.status,
    "done",
    `C: define must be auto-approved (done), got ${String(state.nodes["define"]?.status)}`,
  );
  const defineGate = state.nodes["define"]?.gateHistory?.at(-1);
  assert.strictEqual(
    defineGate?.mode,
    "night",
    `C: define gateHistory last entry must have mode=night`,
  );
  assert.strictEqual(
    defineGate?.basis,
    "no concerns flagged",
    `C: define gateHistory last entry must have correct basis`,
  );
  assert.strictEqual(
    state.nodes["fix"]?.status,
    "done",
    `C: fix must be auto-approved (done), got ${String(state.nodes["fix"]?.status)}`,
  );
  const fixGate = state.nodes["fix"]?.gateHistory?.at(-1);
  assert.strictEqual(
    fixGate?.mode,
    "night",
    `C: fix gateHistory last entry must have mode=night`,
  );
  assert.strictEqual(
    fixGate?.basis,
    "no concerns flagged",
    `C: fix gateHistory last entry must have correct basis`,
  );
  assert.strictEqual(
    state.nodes["verify"]?.status,
    "pending",
    `C: verify must be pending (parked before it ran), got ${String(state.nodes["verify"]?.status)}`,
  );
}
console.log(
  "step C passed: night-mode clean plan -> Gate 1 + Gate 2 auto-approved -> parked at verify-election",
);

// ---------------------------------------------------------------------------
// RUN D — night-mode, seeded concern: park at Gate 1 (define artifact has
//          the "Concerns / plan challenges" heading).
// ---------------------------------------------------------------------------

const HOME_D = `/tmp/dagrun-smoke-mock-d-${BASE_TS + 3}`;
mkdirSync(join(HOME_D, "runs"), { recursive: true });
mkdirSync(join(HOME_D, "worktrees"), { recursive: true });
const PLAN_D = makePlanPath(HOME_D, BASE_TS + 3);

const concernsFactory = (
  _config: DagrunnerConfig,
  _runId: string,
  _runDir: string,
  _worktreePath: string,
  _storeDir: string,
) =>
  createMockExecutor({
    define: "gate-pause-with-concerns", // guide.md contains concerns section
    implement: "success",
    review: "success",
    fix: "gate-pause",
    verify: "gate-pause",
    pr: "success",
  });

await startRun({
  workflow: featureWorkflow,
  planPath: PLAN_D,
  homeDir: HOME_D,
  config,
  executorFactory: concernsFactory,
  nightMode: true,
});

const runsD = readdirSync(join(HOME_D, "runs")).filter((d) =>
  existsSync(join(HOME_D, "runs", d, "state.json")),
);
assert.ok(runsD.length > 0, "D: at least one run must exist");
const RUN_ID_D = runsD[0] as string;
const runDirD = join(HOME_D, "runs", RUN_ID_D);

{
  const state = readState(runDirD);
  assert.strictEqual(
    state.status,
    "paused",
    `D: expected paused at Gate 1 (concerns), got ${state.status}`,
  );
  assert.strictEqual(
    state.nodes["define"]?.status,
    "awaiting-gate",
    `D: define must remain awaiting-gate (night-mode parked due to concerns), got ${String(state.nodes["define"]?.status)}`,
  );
  assert.strictEqual(
    state.nodes["implement"]?.status,
    "pending",
    `D: implement must be pending (did not run), got ${String(state.nodes["implement"]?.status)}`,
  );
  // Confirm the artifact actually contains the concerns heading.
  const guideContent = readFileSync(
    join(runDirD, "define", "guide.md"),
    "utf8",
  );
  assert.ok(
    /## Concerns \/ plan challenges/i.test(guideContent),
    `D: guide.md must contain the concerns heading`,
  );
}
console.log(
  "step D passed: night-mode seeded concern -> parked at Gate 1 (define awaiting-gate)",
);

// ---------------------------------------------------------------------------
// RUN E — stale gate from prior workflow version is auto-skipped on resume
// ---------------------------------------------------------------------------
// Simulates a run created before reflect/apply-reflection were removed.
// State has all current workflow nodes done/skipped, plus reflect=awaiting-gate
// and apply-reflection=pending left over from the old workflow. resumeRun must
// auto-skip the stale gate without requiring user input and resolve the run done.

const HOME_E = `/tmp/dagrun-smoke-mock-e-${BASE_TS + 4}`;
mkdirSync(join(HOME_E, "runs"), { recursive: true });
mkdirSync(join(HOME_E, "worktrees"), { recursive: true });
mkdirSync(join(HOME_E, "store"), { recursive: true });

const STALE_RUN_ID = "old-plan-1700000000000-aaaaaa";
const staleRunDir = join(HOME_E, "runs", STALE_RUN_ID);
mkdirSync(staleRunDir, { recursive: true });

// Hand-craft state as if it came from the old workflow (reflect + apply-reflection existed).
const staleState = {
  runId: STALE_RUN_ID,
  workflow: "feature",
  createdAt: "2026-06-17T00:00:00.000Z",
  updatedAt: "2026-06-17T01:00:00.000Z",
  status: "paused",
  worktreePath: TOY_REPO_PATH,
  branch: "feat/stale-test-aaa",
  sourcePlanPath: TOY_PLAN_PATH,
  verifyElection: "y",
  nodes: {
    expand: {
      status: "done",
      artifacts: [],
      iteration: 0,
      cost: 0,
      gateHistory: [],
    },
    implement: {
      status: "done",
      artifacts: [],
      iteration: 0,
      cost: 0,
      gateHistory: [],
    },
    review: {
      status: "done",
      artifacts: [],
      iteration: 0,
      cost: 0,
      gateHistory: [],
    },
    fix: {
      status: "done",
      artifacts: [],
      iteration: 0,
      cost: 0,
      gateHistory: [],
    },
    verify: {
      status: "done",
      artifacts: [],
      iteration: 0,
      cost: 0,
      gateHistory: [],
    },
    pr: {
      status: "done",
      artifacts: [],
      iteration: 0,
      cost: 0,
      gateHistory: [],
    },
    // Stale nodes from the old workflow.
    reflect: {
      status: "awaiting-gate",
      artifacts: [],
      iteration: 0,
      cost: 0,
      gateHistory: [],
    },
    "apply-reflection": {
      status: "pending",
      artifacts: [],
      iteration: 0,
      cost: 0,
      gateHistory: [],
    },
  },
};
writeFileSync(
  join(staleRunDir, "state.json"),
  JSON.stringify(staleState, null, 2),
  "utf8",
);

await resumeRun({
  runId: STALE_RUN_ID,
  homeDir: HOME_E,
  config,
  executorFactory: mockFactory,
});

{
  const state = readState(staleRunDir);
  assert.strictEqual(
    state.status,
    "done",
    `E: run must be done after stale gate auto-skip, got ${state.status}`,
  );
  assert.strictEqual(
    state.nodes["reflect"]?.status,
    "skipped",
    `E: stale reflect gate must be skipped, got ${String(state.nodes["reflect"]?.status)}`,
  );
  assert.strictEqual(
    state.nodes["apply-reflection"]?.status,
    "skipped",
    `E: stale apply-reflection must be skipped, got ${String(state.nodes["apply-reflection"]?.status)}`,
  );
  // All current workflow nodes must remain done.
  for (const id of ["expand", "implement", "review", "fix", "verify", "pr"]) {
    assert.strictEqual(
      state.nodes[id]?.status,
      "done",
      `E: node ${id} must still be done, got ${String(state.nodes[id]?.status)}`,
    );
  }
}
console.log(
  "step E passed: stale gate (reflect awaiting-gate) auto-skipped on resume -> run done",
);

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log(
  "\nall smoke-mock steps passed (Run A: election=n, Run B: election=y, Run C: night clean, Run D: night flagged, Run E: stale gate auto-skip)",
);
