#!/usr/bin/env node
/**
 * smoke-mock.ts — in-process smoke test for the gated feature + bugfix pipelines.
 *
 * Drives startRun / resumeRun directly (no subprocess, no SDK, no API key needed).
 * Uses createMockExecutor so every node returns a canned result in milliseconds.
 *
 * Run: node --import tsx ./test/smoke/smoke-mock.ts
 *
 * Runs exercised (verify-autonomy change — no more verify-election; verify is
 * a required, autonomous, outcomeGate-gated node on BOTH workflows):
 *   Run A — feature workflow, full happy path through verify (PASS) -> pr -> done.
 *   Run B — bugfix workflow, full happy path through verify (PASS) -> pr -> done.
 *   Run C — night-mode, clean plan: Gate 1 + Gate 2 auto-approved, verify runs
 *           autonomously (no park — the old verify-election park is gone),
 *           run completes fully unattended (done).
 *   Run D — night-mode, seeded concern: parked at Gate 1 (unchanged by this change).
 *   Run E — stale gate from a prior workflow version auto-skipped on resume.
 *   Run F — verify's outcomeGate: a non-PASS verify-report.json outcome fails
 *           verify and blocks pr (run ends failed) — the D6 engine mechanism,
 *           end-to-end through the real startRun/resumeRun/runDag path.
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
import { rerunNode } from "../../src/runtime/run-engine.js";
import { createMockExecutor } from "../../src/runtime/mock-executor.js";
import { featureWorkflow } from "../../src/workflow/feature-workflow.js";
import { bugfixWorkflow } from "../../src/workflow/bugfix-workflow.js";
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
// Mock executor factories — shared by all steps of the runs that use them
// ---------------------------------------------------------------------------

// Feature workflow: define -> implement -> review -> fix -> verify -> pr.
// verify now runs autonomously (no election) and writes a PASS outcome via
// mock-executor's producesFileContent special-case for outcomeGate.file.
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
    verify: "success", // writes verify-plan.md + verify-report.json (outcome: PASS)
    pr: "success", // writes body.md
  });

// Bugfix workflow: reproduce -> implement -> review -> fix -> verify -> pr.
// Same verify contract as feature — see bugfix-workflow.ts's module doc.
const bugfixMockFactory = (
  _config: DagrunnerConfig,
  _runId: string,
  _runDir: string,
  _worktreePath: string,
  _storeDir: string,
) =>
  createMockExecutor({
    reproduce: "gate-pause",
    implement: "success",
    review: "success",
    fix: "gate-pause",
    verify: "success",
    pr: "success",
  });

// ---------------------------------------------------------------------------
// State helper
// ---------------------------------------------------------------------------

type GateEntry = { decision: string; mode?: string; basis?: string };
type NodeSnap = { status: string; gateHistory?: GateEntry[] };

function readState(runDir: string): {
  status: string;
  nodes: Record<string, NodeSnap>;
} {
  return JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as {
    status: string;
    nodes: Record<string, NodeSnap>;
  };
}

// ---------------------------------------------------------------------------
// Base timestamp — used for HOME dirs and unique issue numbers per run
// ---------------------------------------------------------------------------

const BASE_TS = Date.now();

const config: DagrunnerConfig = { DEVHARNESS_SRC: TOY_REPO_PATH };

// ---------------------------------------------------------------------------
// RUN A — feature workflow, full happy path (no election — verify autonomous)
// ---------------------------------------------------------------------------

const HOME_A = `/tmp/dagrun-smoke-mock-a-${BASE_TS}`;
// acquireLock writes active.lock into homeDir — must exist before startRun.
// startRun also calls readdirSync on runs/ — create it too.
mkdirSync(join(HOME_A, "runs"), { recursive: true });
mkdirSync(join(HOME_A, "worktrees"), { recursive: true });

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
// Step A4 — resumeRun(approve Gate 2) -> verify runs autonomously (PASS) -> pr -> done
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
    state.nodes["fix"]?.status,
    "done",
    `A4: fix must be done after approval, got ${String(state.nodes["fix"]?.status)}`,
  );
  assert.strictEqual(
    state.nodes["verify"]?.status,
    "done",
    `A4: verify must run autonomously and be done (no election, no gate), got ${String(state.nodes["verify"]?.status)}`,
  );
  assert.ok(
    existsSync(join(runDirA, "verify", "verify-plan.md")),
    "A4: verify/verify-plan.md must exist",
  );
  const reportPath = join(runDirA, "verify", "verify-report.json");
  assert.ok(existsSync(reportPath), "A4: verify/verify-report.json must exist");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    outcome?: string;
  };
  assert.strictEqual(
    report.outcome,
    "PASS",
    `A4: verify-report.json outcome must be PASS, got ${String(report.outcome)}`,
  );
  assert.strictEqual(
    state.nodes["pr"]?.status,
    "done",
    `A4: pr must be done (verify's outcomeGate passed), got ${String(state.nodes["pr"]?.status)}`,
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
  "step A4 passed: approve Gate 2 -> verify runs autonomously (PASS) -> pr done -> run done. Run A complete (feature workflow)",
);

// ---------------------------------------------------------------------------
// RUN B — bugfix workflow, full happy path (verify is conditional-but-required
//          per the verify-autonomy amendment; mock executor models the "PASS"
//          branch regardless of whether an AT was authored or reused — that
//          branch is model judgment inside verify.md, not engine-visible).
// ---------------------------------------------------------------------------

const HOME_B = `/tmp/dagrun-smoke-mock-b-${BASE_TS + 1}`;
mkdirSync(join(HOME_B, "runs"), { recursive: true });
mkdirSync(join(HOME_B, "worktrees"), { recursive: true });
const PLAN_B = makePlanPath(HOME_B, BASE_TS + 1);

await startRun({
  workflow: bugfixWorkflow,
  planPath: PLAN_B,
  homeDir: HOME_B,
  config,
  executorFactory: bugfixMockFactory,
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
    state.nodes["reproduce"]?.status,
    "awaiting-gate",
    `B1: reproduce must be awaiting-gate, got ${String(state.nodes["reproduce"]?.status)}`,
  );
}
console.log("step B1 passed: startRun (bugfix) -> reproduce awaiting-gate");

await resumeRun({
  runId: RUN_ID_B,
  homeDir: HOME_B,
  config,
  approve: true,
  executorFactory: bugfixMockFactory,
});

{
  const state = readState(runDirB);
  assert.strictEqual(
    state.nodes["fix"]?.status,
    "awaiting-gate",
    `B2: fix must be awaiting-gate, got ${String(state.nodes["fix"]?.status)}`,
  );
}
console.log(
  "step B2 passed: approve Gate 1 (reproduce) -> implement -> review -> fix gate-pause",
);

await resumeRun({
  runId: RUN_ID_B,
  homeDir: HOME_B,
  config,
  approve: true,
  executorFactory: bugfixMockFactory,
});

{
  const state = readState(runDirB);
  assert.strictEqual(
    state.nodes["verify"]?.status,
    "done",
    `B3: verify must run autonomously and be done, got ${String(state.nodes["verify"]?.status)}`,
  );
  const reportPath = join(runDirB, "verify", "verify-report.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    outcome?: string;
  };
  assert.strictEqual(report.outcome, "PASS");
  assert.strictEqual(
    state.nodes["pr"]?.status,
    "done",
    `B3: pr must be done, got ${String(state.nodes["pr"]?.status)}`,
  );
  assert.strictEqual(
    state.status,
    "done",
    `B3: run must be done, got ${state.status}`,
  );
}
console.log(
  "step B3 passed: approve Gate 2 (fix) -> verify runs autonomously (PASS) -> pr done -> run done. Run B complete (bugfix workflow)",
);

// ---------------------------------------------------------------------------
// RUN C — night-mode, clean plan: auto-approve Gate 1 + Gate 2, verify runs
//          autonomously (no park — the old verify-election park is gone),
//          run completes fully unattended.
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
    "done",
    `C: night-mode clean plan must complete fully unattended (no more verify-election park), got ${state.status}`,
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
    "done",
    `C: verify must run autonomously to done (no human election in night-mode either), got ${String(state.nodes["verify"]?.status)}`,
  );
  assert.strictEqual(
    state.nodes["pr"]?.status,
    "done",
    `C: pr must be done, got ${String(state.nodes["pr"]?.status)}`,
  );
}
console.log(
  "step C passed: night-mode clean plan -> Gate 1 + Gate 2 auto-approved -> verify autonomous -> pr done -> run done (fully unattended)",
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
    verify: "success",
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
// RUN F — verify's outcomeGate: a non-PASS outcome fails verify and blocks pr
//          (D6 engine mechanism, end-to-end through startRun/resumeRun/runDag).
// ---------------------------------------------------------------------------

const HOME_F = `/tmp/dagrun-smoke-mock-f-${BASE_TS + 5}`;
mkdirSync(join(HOME_F, "runs"), { recursive: true });
mkdirSync(join(HOME_F, "worktrees"), { recursive: true });
const PLAN_F = makePlanPath(HOME_F, BASE_TS + 5);

const outcomeFailFactory = (
  _config: DagrunnerConfig,
  _runId: string,
  _runDir: string,
  _worktreePath: string,
  _storeDir: string,
) =>
  createMockExecutor({
    define: "gate-pause",
    implement: "success",
    review: "success",
    fix: "gate-pause",
    verify: "outcome-gate-fail", // writes verify-report.json with outcome: FAIL_ASSERTION
    pr: "success",
  });

/**
 * resumeRun calls process.exit(1) as its very last statement when a run ends
 * "failed" (the CLI-exit-code contract — see master doc §4). That is correct
 * CLI behaviour but would kill this in-process smoke script before Run F's
 * assertions run. Intercept process.exit for the duration of one call so the
 * script can inspect the resulting state.json instead of dying with it.
 * Safe here because process.exit(1) is unconditionally the last statement in
 * resumeRun's "else" branch — nothing runs after it that this no-op would skip.
 */
async function resumeRunCapturingExit(
  opts: Parameters<typeof resumeRun>[0],
): Promise<void> {
  const realExit = process.exit.bind(process);
  (process as unknown as { exit: (code?: number) => void }).exit = () =>
    undefined;
  try {
    await resumeRun(opts);
  } finally {
    process.exit = realExit;
  }
}

/**
 * startRun's own night-mode auto-approve loop (and its attended-mode tail)
 * also calls process.exit(1) unconditionally when a run ends "failed" — same
 * CLI-exit-code contract, same problem for an in-process smoke script. Used
 * by Run H, whose whole point is a night-mode run that auto-approves into a
 * failure.
 */
async function startRunCapturingExit(
  opts: Parameters<typeof startRun>[0],
): Promise<void> {
  const realExit = process.exit.bind(process);
  (process as unknown as { exit: (code?: number) => void }).exit = () =>
    undefined;
  try {
    await startRun(opts);
  } finally {
    process.exit = realExit;
  }
}

await startRun({
  workflow: featureWorkflow,
  planPath: PLAN_F,
  homeDir: HOME_F,
  config,
  executorFactory: outcomeFailFactory,
});

const runsF = readdirSync(join(HOME_F, "runs")).filter((d) =>
  existsSync(join(HOME_F, "runs", d, "state.json")),
);
assert.ok(runsF.length > 0, "F: at least one run must exist");
const RUN_ID_F = runsF[0] as string;
const runDirF = join(HOME_F, "runs", RUN_ID_F);

await resumeRun({
  runId: RUN_ID_F,
  homeDir: HOME_F,
  config,
  approve: true, // Gate 1 (define)
  executorFactory: outcomeFailFactory,
});
await resumeRunCapturingExit({
  runId: RUN_ID_F,
  homeDir: HOME_F,
  config,
  approve: true, // Gate 2 (fix) -> verify runs, outcome FAIL_ASSERTION -> run ends failed
  executorFactory: outcomeFailFactory,
});

{
  const state = readState(runDirF);
  const reportPath = join(runDirF, "verify", "verify-report.json");
  assert.ok(
    existsSync(reportPath),
    "F: verify-report.json must exist even on a non-PASS outcome",
  );
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    outcome?: string;
  };
  assert.strictEqual(report.outcome, "FAIL_ASSERTION");
  assert.strictEqual(
    state.nodes["verify"]?.status,
    "failed",
    `F: verify must be failed (outcomeGate rejected FAIL_ASSERTION), got ${String(state.nodes["verify"]?.status)}`,
  );
  assert.strictEqual(
    state.nodes["pr"]?.status,
    "skipped",
    `F: pr must never run — its required dep (verify) failed, got ${String(state.nodes["pr"]?.status)}`,
  );
  assert.strictEqual(
    state.status,
    "failed",
    `F: run must end failed (same halt semantics as a produces violation), got ${state.status}`,
  );
}
console.log(
  "step F passed: verify outcomeGate rejects FAIL_ASSERTION -> verify failed -> pr blocked -> run failed",
);

// ---------------------------------------------------------------------------
// RUN I — rerunNode archives the failed attempt's artifacts (transcript.log/
//          reflections.md/burn.json/verify-report.json/etc) to
//          <runDir>/<nodeId>-attempts/attempt-1/ BEFORE wiping the live dir,
//          instead of deleting them outright. Reuses Run F's already-failed
//          run (verify/verify-report.json holds a FAIL_ASSERTION outcome) —
//          this is exactly the manual-recovery path a human takes after a
//          verify failure (`dagrun rerun <run-id> verify`), and the ONLY
//          place a node's artifactsDir is ever wiped between separate CLI
//          invocations. See DECISIONS.md § rerun-artifact-archiving.
// ---------------------------------------------------------------------------

const verifyReportBeforeRerun = readFileSync(
  join(runDirF, "verify", "verify-report.json"),
  "utf8",
);

const rerunSuccessFactory = (
  _config: DagrunnerConfig,
  _runId: string,
  _runDir: string,
  _worktreePath: string,
  _storeDir: string,
) =>
  createMockExecutor({
    verify: "success", // writes a fresh verify-report.json with outcome: PASS
  });

await rerunNode({
  runId: RUN_ID_F,
  nodeId: "verify",
  homeDir: HOME_F,
  config,
  executorFactory: rerunSuccessFactory,
});

{
  const archivedReport = readFileSync(
    join(runDirF, "verify-attempts", "attempt-1", "verify-report.json"),
    "utf8",
  );
  assert.strictEqual(
    archivedReport,
    verifyReportBeforeRerun,
    "I: verify-attempts/attempt-1/verify-report.json must match Run F's original FAIL_ASSERTION content, not be lost",
  );

  const newReport = JSON.parse(
    readFileSync(join(runDirF, "verify", "verify-report.json"), "utf8"),
  ) as { outcome?: string };
  assert.strictEqual(
    newReport.outcome,
    "PASS",
    `I: rerun must land a fresh, passing verify-report.json in the live dir, got ${String(newReport.outcome)}`,
  );

  const state = readState(runDirF);
  assert.strictEqual(
    state.nodes["verify"]?.status,
    "done",
    `I: state.json must reflect the rerun's outcome, got ${String(state.nodes["verify"]?.status)}`,
  );
}
console.log(
  "step I passed: rerunNode archives the FAIL_ASSERTION attempt to verify-attempts/attempt-1/ before wiping, rerun writes a fresh PASS",
);

// ---------------------------------------------------------------------------
// RUN G — noPlaceholders: a placeholder left in define/guide.md fails the
//          node on the GATE-APPROVE transition, not runDag's own done-branch
//          (define always returns awaiting-gate from the executor — see
//          sdk-runner.ts — so the approve path in resumeRun is the only place
//          this check is reachable for a gated node; see DECISIONS.md
//          § no-placeholders-gate-approve-wiring).
// ---------------------------------------------------------------------------

const HOME_G = `/tmp/dagrun-smoke-mock-g-${BASE_TS + 6}`;
mkdirSync(join(HOME_G, "runs"), { recursive: true });
mkdirSync(join(HOME_G, "worktrees"), { recursive: true });
const PLAN_G = makePlanPath(HOME_G, BASE_TS + 6);

const placeholderFactory = (
  _config: DagrunnerConfig,
  _runId: string,
  _runDir: string,
  _worktreePath: string,
  _storeDir: string,
) =>
  createMockExecutor({
    define: "gate-pause-with-placeholder", // guide.md contains an unresolved TODO
    implement: "success",
    review: "success",
    fix: "gate-pause",
    verify: "success",
    pr: "success",
  });

await startRun({
  workflow: featureWorkflow,
  planPath: PLAN_G,
  homeDir: HOME_G,
  config,
  executorFactory: placeholderFactory,
});

const runsG = readdirSync(join(HOME_G, "runs")).filter((d) =>
  existsSync(join(HOME_G, "runs", d, "state.json")),
);
assert.ok(runsG.length > 0, "G: at least one run must exist");
const RUN_ID_G = runsG[0] as string;
const runDirG = join(HOME_G, "runs", RUN_ID_G);

{
  const state = readState(runDirG);
  assert.strictEqual(
    state.nodes["define"]?.status,
    "awaiting-gate",
    `G1: define must be awaiting-gate, got ${String(state.nodes["define"]?.status)}`,
  );
}
console.log(
  "step G1 passed: startRun -> define awaiting-gate, guide.md written with a placeholder",
);

await resumeRunCapturingExit({
  runId: RUN_ID_G,
  homeDir: HOME_G,
  config,
  approve: true, // Gate 1 (define) — noPlaceholders must fail define here, not silently pass
  executorFactory: placeholderFactory,
});

{
  const state = readState(runDirG);
  assert.strictEqual(
    state.nodes["define"]?.status,
    "failed",
    `G2: define must be failed by the noPlaceholders check on approval, got ${String(state.nodes["define"]?.status)}`,
  );
  const defineGate = state.nodes["define"]?.gateHistory?.at(-1) as
    { decision?: string } | undefined;
  assert.strictEqual(
    defineGate?.decision,
    "approve",
    "G2: the human decision (approve) is still recorded in gateHistory even though the engine failed the node afterward",
  );
  assert.strictEqual(
    state.nodes["implement"]?.status,
    "skipped",
    `G2: implement must never run — its required dep (define) failed, got ${String(state.nodes["implement"]?.status)}`,
  );
  assert.strictEqual(
    state.status,
    "failed",
    `G2: run must end failed (noPlaceholders halt semantics match a produces violation), got ${state.status}`,
  );
}
console.log(
  "step G2 passed: approve -> noPlaceholders check fails define (unresolved TODO) -> implement blocked -> run failed",
);

// ---------------------------------------------------------------------------
// RUN H — noPlaceholders on the NIGHT-MODE auto-approve path (startRun's own
//          auto-approve loop, distinct from resumeRun's manual --approve
//          branch Run G exercises). A placeholder-laden guide.md with no
//          "Concerns / plan challenges" heading auto-approves (hasConcerns
//          returns false) and must still be caught by checkNoPlaceholders on
//          THIS code path too — this is the other of the two gate-approve
//          sites named in DECISIONS.md § no-placeholders-gate-approve-wiring,
//          and the highest-risk one to leave unexercised (night-mode runs
//          fully unattended, no human eyes on the artifact at all).
// ---------------------------------------------------------------------------

const HOME_H = `/tmp/dagrun-smoke-mock-h-${BASE_TS + 7}`;
mkdirSync(join(HOME_H, "runs"), { recursive: true });
mkdirSync(join(HOME_H, "worktrees"), { recursive: true });
const PLAN_H = makePlanPath(HOME_H, BASE_TS + 7);

await startRunCapturingExit({
  workflow: featureWorkflow,
  planPath: PLAN_H,
  homeDir: HOME_H,
  config,
  executorFactory: placeholderFactory,
  nightMode: true,
});

const runsH = readdirSync(join(HOME_H, "runs")).filter((d) =>
  existsSync(join(HOME_H, "runs", d, "state.json")),
);
assert.ok(runsH.length > 0, "H: at least one run must exist");
const RUN_ID_H = runsH[0] as string;
const runDirH = join(HOME_H, "runs", RUN_ID_H);

{
  const state = readState(runDirH);
  assert.strictEqual(
    state.nodes["define"]?.status,
    "failed",
    `H: define must be failed by the noPlaceholders check on the night-mode auto-approve path (no concerns heading, so it auto-approved rather than parking), got ${String(state.nodes["define"]?.status)}`,
  );
  const defineGate = state.nodes["define"]?.gateHistory?.at(-1) as
    { decision?: string; mode?: string; basis?: string } | undefined;
  assert.strictEqual(
    defineGate?.decision,
    "approve",
    "H: the night-mode auto-approval decision is still recorded in gateHistory even though the engine failed the node afterward",
  );
  assert.strictEqual(
    defineGate?.mode,
    "night",
    "H: gateHistory entry must still carry mode=night on this path",
  );
  assert.strictEqual(
    defineGate?.basis,
    "no concerns flagged",
    "H: gateHistory entry must still carry the night-mode basis on this path",
  );
  assert.strictEqual(
    state.nodes["implement"]?.status,
    "skipped",
    `H: implement must never run — its required dep (define) failed, got ${String(state.nodes["implement"]?.status)}`,
  );
  assert.strictEqual(
    state.status,
    "failed",
    `H: run must end failed, got ${state.status}`,
  );
}
console.log(
  "step H passed: night-mode auto-approve -> noPlaceholders check fails define (unresolved TODO, no concerns heading) -> implement blocked -> run failed",
);

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log(
  "\nall smoke-mock steps passed (Run A: feature happy path, Run B: bugfix happy path, " +
    "Run C: night clean unattended, Run D: night flagged, Run E: stale gate auto-skip, " +
    "Run F: outcomeGate blocks pr on non-PASS, Run G: noPlaceholders blocks a manually-approved " +
    "gate, Run H: noPlaceholders blocks a night-mode auto-approved gate, Run I: rerunNode archives " +
    "the prior failed attempt before wiping)",
);
