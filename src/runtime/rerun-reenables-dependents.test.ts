/**
 * rerun-reenables-dependents.test.ts — `dagrun rerun <id> <node>` + `dagrun resume <id>`
 * must actually run the nodes that were only skipped BECAUSE the rerun node had not
 * finished. Before v0.1.84 they stayed `skipped` (terminal), and a rerun of a RED-failed
 * `implement` followed by a resume ended the run `done` with review/fix/pr skipped — a
 * false success (DECISIONS.md § rerun-reenables-blocked-dependents).
 *
 * Drives the REAL `runDag` -> `rerunNode` -> `resumeRun` path with the mock executor and
 * the shipped bugfix workflow (the F2 scenario: `outcome-gate-fail` on implement), plus a
 * tiny custom workflow for the legitimately-skipped siblings (`when`, optional).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runDag } from "../core/dag.js";
import { writeState } from "../core/state.js";
import type { NodeState, RunState } from "../core/state.js";
import type { Ctx, Workflow } from "../core/types.js";
import { bugfixWorkflow } from "../workflow/bugfix-workflow.js";
import { createMockExecutor } from "./mock-executor.js";
import type { NodeExecutor, NodeScenario } from "./mock-executor.js";
import { rerunNode, resumeRun } from "./run-engine.js";

const ctx: Ctx = { json: () => ({}), read: () => "", dir: (id) => id };
const RUN = "r-1";

type Fx = {
  home: string;
  runDir: string;
  wt: string;
  stateFile: string;
  config: { DEVHARNESS_SRC: string };
};

/** A pending run of `workflow` in a temp home whose worktree is a real (git init) directory. */
function fixture(workflow: Workflow): { fx: Fx; state: RunState } {
  const home = mkdtempSync(join(tmpdir(), "dr-rerun-reenable-"));
  const runDir = join(home, "runs", RUN);
  mkdirSync(runDir, { recursive: true });
  const wt = join(home, "worktrees", "wt");
  mkdirSync(wt, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: wt });
  const nodes: Record<string, NodeState> = {};
  for (const n of workflow.nodes)
    nodes[n.id] = {
      status: "pending",
      artifacts: [],
      iteration: 0,
      cost: 0,
      gateHistory: [],
    };
  const state: RunState = {
    runId: RUN,
    workflow: workflow.name,
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    status: "running",
    worktreePath: wt,
    branch: "fix/x",
    sourcePlanPath: "/p",
    nodes,
  };
  const stateFile = join(runDir, "state.json");
  writeState(stateFile, state);
  return {
    fx: { home, runDir, wt, stateFile, config: { DEVHARNESS_SRC: home } },
    state,
  };
}

const read = (fx: Fx): RunState =>
  JSON.parse(readFileSync(fx.stateFile, "utf8")) as RunState;
const statuses = (s: RunState): Record<string, string> =>
  Object.fromEntries(Object.entries(s.nodes).map(([k, v]) => [k, v.status]));

/** process.exit -> throw, stdout/stderr muted (a stray exit must be a failed assertion, not a dead runner). */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  const realExit = process.exit;
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.exit = ((c?: number) => {
    throw new Error(`process.exit(${String(c)}) was called`);
  }) as typeof process.exit;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.exit = realExit;
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/** Mock executor that records which nodes it was asked to run. */
function recording(
  scenarios: Record<string, NodeScenario>,
  log: string[],
): NodeExecutor {
  const base = createMockExecutor(scenarios);
  return async (id, node, c) => {
    log.push(id);
    return base(id, node, c);
  };
}

/** First run: the F2 scenario — implement fails its RED outcome gate. */
async function redFailedRun(): Promise<Fx> {
  const { fx, state } = fixture(bugfixWorkflow);
  await runDag(
    bugfixWorkflow,
    createMockExecutor({ implement: "outcome-gate-fail" }),
    state,
    { ctx, stateFile: fx.stateFile },
  );
  return fx;
}

// ---------------------------------------------------------------------------
// (1) the false-success hole, through the shipped bugfix pipeline
// ---------------------------------------------------------------------------

test("precondition (the measured state): implement fails the RED outcome gate -> run failed, review/fix/pr skipped", async () => {
  const fx = await redFailedRun();
  const s = read(fx);
  assert.equal(s.status, "failed");
  assert.deepEqual(statuses(s), {
    implement: "failed",
    review: "skipped",
    fix: "skipped",
    pr: "skipped",
  });
});

test("rerun implement with a passing RED, then resume: review/fix/pr RUN and the run stops at the fix gate (paused) — it does NOT end done", async () => {
  const fx = await redFailedRun();

  await guarded(() =>
    rerunNode({
      runId: RUN,
      nodeId: "implement",
      homeDir: fx.home,
      config: fx.config,
      executorFactory: () => createMockExecutor({ implement: "success" }),
    }),
  );
  const afterRerun = read(fx);
  assert.equal(afterRerun.nodes["implement"]?.status, "done");
  for (const id of ["review", "fix", "pr"]) {
    assert.equal(
      afterRerun.nodes[id]?.status,
      "pending",
      `${id} was only skipped because implement had not finished: back to pending`,
    );
    assert.equal(
      "endedAt" in (afterRerun.nodes[id] as NodeState),
      false,
      `${id}: stale endedAt cleared`,
    );
    assert.equal(
      "skipReason" in (afterRerun.nodes[id] as NodeState),
      false,
      `${id}: marker cleared`,
    );
  }

  const ran: string[] = [];
  await guarded(() =>
    resumeRun({
      runId: RUN,
      homeDir: fx.home,
      config: fx.config,
      executorFactory: () =>
        recording(
          {
            implement: "success",
            review: "success",
            fix: "gate-pause",
            pr: "success",
          },
          ran,
        ),
    }),
  );
  const s = read(fx);
  assert.deepEqual(
    ran,
    ["review", "fix"],
    "review and fix executed on resume; implement was not re-run; pr waits behind the fix gate",
  );
  assert.equal(s.status, "paused", "the run reached the fix gate — not done");
  assert.deepEqual(statuses(s), {
    implement: "done",
    review: "done",
    fix: "awaiting-gate",
    pr: "pending",
  });
});

test("rerun that FAILS again leaves the blocked dependents skipped (still accurately blocked) and the marker intact", async () => {
  const fx = await redFailedRun();
  await guarded(() =>
    rerunNode({
      runId: RUN,
      nodeId: "implement",
      homeDir: fx.home,
      config: fx.config,
      executorFactory: () =>
        createMockExecutor({ implement: "outcome-gate-fail" }),
    }),
  );
  const s = read(fx);
  assert.deepEqual(statuses(s), {
    implement: "failed",
    review: "skipped",
    fix: "skipped",
    pr: "skipped",
  });
  assert.equal(s.nodes["review"]?.skipReason, "blocked-dependency");
});

test("rerunning a swept node DIRECTLY drops its own stale skipReason (the rerun node carries no 'skipped because' marker once it has run)", async () => {
  const fx = await redFailedRun();
  assert.equal(read(fx).nodes["review"]?.skipReason, "blocked-dependency", "precondition");
  await guarded(() =>
    rerunNode({ runId: RUN, nodeId: "review", homeDir: fx.home, config: fx.config, executorFactory: () => createMockExecutor({ review: "success" }) }),
  );
  const review = read(fx).nodes["review"] as NodeState;
  assert.equal(review.status, "done");
  assert.equal("skipReason" in review, false, "no stale marker on a node that has now run");
  // its own blocked descendants are re-enabled by the same rule
  assert.equal(read(fx).nodes["fix"]?.status, "pending");
});

test("a re-enabled node's leftover artifacts are ARCHIVED to <node>-attempts/, never deleted", async () => {
  const fx = await redFailedRun();
  mkdirSync(join(fx.runDir, "review"), { recursive: true });
  writeFileSync(
    join(fx.runDir, "review", "stray.txt"),
    "left by an earlier attempt\n",
  );
  await guarded(() =>
    rerunNode({
      runId: RUN,
      nodeId: "implement",
      homeDir: fx.home,
      config: fx.config,
      executorFactory: () => createMockExecutor({ implement: "success" }),
    }),
  );
  assert.equal(
    readFileSync(
      join(fx.runDir, "review-attempts", "attempt-1", "stray.txt"),
      "utf8",
    ),
    "left by an earlier attempt\n",
  );
  assert.equal(
    existsSync(join(fx.runDir, "review", "stray.txt")),
    false,
    "the live dir starts clean for the re-run",
  );
});

// ---------------------------------------------------------------------------
// (2) legitimately skipped nodes stay skipped
// ---------------------------------------------------------------------------

const siblingWorkflow: Workflow = {
  name: "bugfix", // a known workflow name; the `workflow` seam supplies the nodes
  nodes: [
    {
      id: "check",
      command: "/check",
      produces: ["check-report.json"],
      outcomeGate: {
        file: "check-report.json",
        field: "outcome",
        passValues: ["PASS"],
      },
    },
    { id: "opt", command: "/opt", optional: true }, // fails -> degrades to skipped (its own rule)
    { id: "gated", dependsOn: ["check"], command: "/gated", when: () => false }, // skipped by `when`
    {
      id: "after",
      dependsOn: ["check"],
      command: "/after",
      produces: ["after.md"],
    }, // blocked-dependency
  ],
};

test("a `when`-skipped sibling and an optional-failed sibling stay skipped across rerun + resume; only the blocked node runs", async () => {
  const { fx, state } = fixture(siblingWorkflow);
  await runDag(
    siblingWorkflow,
    createMockExecutor({ check: "outcome-gate-fail", opt: "reviewer-fail" }),
    state,
    { ctx, stateFile: fx.stateFile },
  );
  const first = read(fx);
  assert.deepEqual(
    statuses(first),
    { check: "failed", opt: "skipped", gated: "skipped", after: "skipped" },
    "precondition",
  );
  const optBefore = first.nodes["opt"];

  await guarded(() =>
    rerunNode({
      runId: RUN,
      nodeId: "check",
      homeDir: fx.home,
      config: fx.config,
      workflow: siblingWorkflow,
      executorFactory: () => createMockExecutor({ check: "success" }),
    }),
  );
  const mid = read(fx);
  assert.deepEqual(statuses(mid), {
    check: "done",
    opt: "skipped",
    gated: "skipped",
    after: "pending",
  });

  const ran: string[] = [];
  await guarded(() =>
    resumeRun({
      runId: RUN,
      homeDir: fx.home,
      config: fx.config,
      workflow: siblingWorkflow,
      executorFactory: () =>
        recording({ after: "success", opt: "success" }, ran),
    }),
  );
  const s = read(fx);
  assert.deepEqual(
    ran,
    ["after"],
    "neither the when-skipped nor the optional-failed node was run",
  );
  assert.deepEqual(statuses(s), {
    check: "done",
    opt: "skipped",
    gated: "skipped",
    after: "done",
  });
  assert.deepEqual(
    s.nodes["opt"],
    optBefore,
    "the optional failure is left exactly as it was, error included",
  );
  assert.equal(s.status, "done");
});

// ---------------------------------------------------------------------------
// (3) legacy state (written before v0.1.84: no marker) behaves as before
// ---------------------------------------------------------------------------

test("LEGACY run (skipped nodes carry no skipReason): state.json still loads and rerun + resume behave exactly as before — dependents stay skipped, run ends done", async () => {
  const fx = await redFailedRun();
  const legacy = read(fx);
  for (const id of Object.keys(legacy.nodes))
    delete (legacy.nodes[id] as { skipReason?: unknown }).skipReason; // what v0.1.83 wrote
  writeFileSync(fx.stateFile, JSON.stringify(legacy, null, 2));

  await guarded(() =>
    rerunNode({
      runId: RUN,
      nodeId: "implement",
      homeDir: fx.home,
      config: fx.config,
      executorFactory: () => createMockExecutor({ implement: "success" }),
    }),
  );
  assert.deepEqual(
    statuses(read(fx)),
    { implement: "done", review: "skipped", fix: "skipped", pr: "skipped" },
    "legacy skips are not guessed at",
  );

  const ran: string[] = [];
  await guarded(() =>
    resumeRun({
      runId: RUN,
      homeDir: fx.home,
      config: fx.config,
      executorFactory: () =>
        recording({ review: "success", fix: "gate-pause", pr: "success" }, ran),
    }),
  );
  assert.deepEqual(ran, [], "nothing was re-enabled");
  const s = read(fx);
  assert.equal(
    s.status,
    "done",
    "the legacy hole is documented, not silently changed: recovery for such a run is a new run",
  );
  assert.deepEqual(statuses(s), {
    implement: "done",
    review: "skipped",
    fix: "skipped",
    pr: "skipped",
  });
});
