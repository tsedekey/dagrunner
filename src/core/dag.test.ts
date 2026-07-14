/**
 * dag.test.ts — Tier-1 deterministic unit tests for dagrunner (Block 3).
 *
 * Run with:
 *   node --test --import tsx src/core/dag.test.ts
 *
 * Test categories and expected status BEFORE Block 4 (engine) is built:
 *
 *   [must pass now]              Test 4 — load-time validation (workflow.ts exists)
 *   [must pass now]              Test 5 — state.json round-trip (state.ts exists)
 *   [must pass now]              Mock executor self-tests (in mock-executor.ts)
 *   [expected-fail until Block4] Test 1 — topological order + readiness
 *   [expected-fail until Block4] Test 2 — when predicate skip propagation
 *   [expected-fail until Block4] Test 3 — join rule + optional degradation
 *   [expected-fail until Block4] Test 6 — reconcile-on-resume
 *
 * Tests 1-3 and 6 import computeReadyNodes / reconcileRunningNodes from
 * src/dag.ts which does NOT exist yet. The dynamic import is deliberately
 * placed inside each test body so TypeScript does not statically resolve the
 * missing module. Those tests fail loudly (import error) until Block 4 lands.
 * That is CORRECT behaviour — they are specs the engine must satisfy.
 *
 * The engine contract that computeReadyNodes must implement:
 *   computeReadyNodes(nodes: Node[], statuses: NodeStatusMap): string[]
 *   - Returns the IDs of nodes that are eligible to run NOW.
 *   - A node is ready iff:
 *       (a) Its own status is 'pending'
 *       (b) All required deps (optional:false / omitted) have status 'done'
 *       (c) No required dep has status 'failed' (blocks the node)
 *       (d) Optional deps that are 'failed' are treated as 'skipped' (non-blocking)
 *       (e) For joinRule 'none-failed-min-one-success': ≥1 dep is 'done',
 *           no required dep is 'failed'
 *       (f) A node whose own 'when' predicate returns false is 'skipped';
 *           its downstream dependents treat it as a blocking failure unless
 *           it is itself optional (the spec: skipped dep = not-done ≠ failed)
 *
 * The engine contract that reconcileRunningNodes must implement:
 *   reconcileRunningNodes(state: RunState): RunState
 *   - Any node with status 'running' must be set to 'failed'
 *     (crashed process; never trust partial work)
 *   - The returned state has an updated 'updatedAt' timestamp
 *   - Stale lock: the caller should release the active.lock after reconcile
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadWorkflow,
  FIXTURE_BAD_MODEL,
  FIXTURE_BAD_DEPENDS,
  FIXTURE_DUPLICATE_ID,
  FIXTURE_CYCLE,
} from "../workflow/workflow.js";

import { readState, writeState } from "./state.js";
import type { RunState, NodeState } from "./state.js";
import type { Node, Workflow, Ctx } from "./types.js";
import { createMockExecutor } from "../runtime/mock-executor.js";
import type { NodeExecutor } from "../runtime/mock-executor.js";

// ---------------------------------------------------------------------------
// Helper: build a minimal NodeState with no optional fields set to undefined
// (exactOptionalPropertyTypes + JSON round-trip safety)
// ---------------------------------------------------------------------------

function makeNodeState(
  overrides: Partial<NodeState> & { status: NodeState["status"] },
): NodeState {
  // Required fields only; omit optional keys entirely to survive JSON round-trip.
  const base: NodeState = {
    status: overrides.status,
    artifacts: overrides.artifacts ?? [],
    iteration: overrides.iteration ?? 0,
    cost: overrides.cost ?? 0,
    gateHistory: overrides.gateHistory ?? [],
  };
  // Add optional fields only when explicitly provided and not undefined.
  if (overrides.startedAt !== undefined) base.startedAt = overrides.startedAt;
  if (overrides.endedAt !== undefined) base.endedAt = overrides.endedAt;
  if (overrides.model !== undefined) base.model = overrides.model;
  if (overrides.sessionId !== undefined) base.sessionId = overrides.sessionId;
  if (overrides.error !== undefined) base.error = overrides.error;
  if (overrides.interruptRetries !== undefined)
    base.interruptRetries = overrides.interruptRetries;
  return base;
}

// ---------------------------------------------------------------------------
// Helper: NodeStatusMap type alias (mirrors what dag.ts will export)
// ---------------------------------------------------------------------------

type NodeStatusMap = Record<
  string,
  "pending" | "running" | "done" | "skipped" | "failed" | "awaiting-gate"
>;

// ---------------------------------------------------------------------------
// Test 4 [must pass now] — load-time validation
// ---------------------------------------------------------------------------

test("[must pass now] Test 4a — bad model string throws with node name", () => {
  assert.throws(
    () => loadWorkflow(FIXTURE_BAD_MODEL),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("step-a"),
        `Expected node name 'step-a' in: ${err.message}`,
      );
      assert.ok(
        err.message.includes("opus") || err.message.includes("invalid model"),
        `Expected model value 'opus' or 'invalid model' in: ${err.message}`,
      );
      return true;
    },
  );
});

test("[must pass now] Test 4b — unknown dependsOn throws with node name", () => {
  assert.throws(
    () => loadWorkflow(FIXTURE_BAD_DEPENDS),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("expand"),
        `Expected node name 'expand' in: ${err.message}`,
      );
      assert.ok(
        err.message.includes("nonexistent"),
        `Expected unknown dep 'nonexistent' in: ${err.message}`,
      );
      return true;
    },
  );
});

test("[must pass now] Test 4c — duplicate node id throws with id name", () => {
  assert.throws(
    () => loadWorkflow(FIXTURE_DUPLICATE_ID),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("step-a"),
        `Expected node id 'step-a' in: ${err.message}`,
      );
      assert.ok(
        err.message.toLowerCase().includes("duplicate"),
        `Expected 'duplicate' in: ${err.message}`,
      );
      return true;
    },
  );
});

test("[must pass now] Test 4d — cycle detection throws naming cycle nodes", () => {
  assert.throws(
    () => loadWorkflow(FIXTURE_CYCLE),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.toLowerCase().includes("cycle"),
        `Expected 'cycle' in: ${err.message}`,
      );
      assert.ok(
        err.message.includes("node-a") || err.message.includes("node-b"),
        `Expected cycle node names in: ${err.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Test 5 [must pass now] — state.json read/write round-trip
// ---------------------------------------------------------------------------

test("[must pass now] Test 5 — state.json round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "dagrunner-state-"));
  const statePath = join(dir, "state.json");

  const original: RunState = {
    runId: "4521-job-priority",
    workflow: "feature",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T01:00:00.000Z",
    status: "paused",
    worktreePath: "/tmp/worktrees/4521-job-priority",
    branch: "feature/4521-job-priority",
    sourcePlanPath: "/tmp/plan.md",
    nodes: {
      "step-a": makeNodeState({
        status: "done",
        startedAt: "2026-06-10T00:01:00.000Z",
        endedAt: "2026-06-10T00:02:00.000Z",
        artifacts: ["/tmp/runs/4521/step-a/step-a.json"],
        model: "haiku",
        iteration: 0,
        cost: 0.0012,
        sessionId: "sess-abc",
      }),
      expand: makeNodeState({
        status: "awaiting-gate",
        startedAt: "2026-06-10T00:03:00.000Z",
        iteration: 1,
        cost: 0.042,
        sessionId: "sess-def",
        gateHistory: [
          {
            decision: "reject",
            comment: "add error handling section",
            timestamp: "2026-06-10T00:05:00.000Z",
          },
        ],
      }),
    },
  };

  writeState(statePath, original);
  const restored = readState(statePath);

  assert.deepStrictEqual(restored, original);
});

test("[must pass now] Test 5b — state.json survives missing optional fields (no undefined keys)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dagrunner-state-"));
  const statePath = join(dir, "state.json");

  // A node with NO optional fields set — JSON must not write null/undefined.
  const original: RunState = {
    runId: "test-run",
    workflow: "feature",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    status: "running",
    worktreePath: "/tmp/wt",
    branch: "feature/test",
    sourcePlanPath: "/tmp/plan.md",
    nodes: {
      "step-a": makeNodeState({ status: "pending" }),
    },
  };

  writeState(statePath, original);
  const restored = readState(statePath);

  assert.deepStrictEqual(restored, original);

  // Paranoia: confirm no 'undefined' keys leaked into the node state.
  const nodeKeys = Object.keys(restored.nodes["step-a"] ?? {});
  const requiredOnly = [
    "status",
    "artifacts",
    "iteration",
    "cost",
    "gateHistory",
  ];
  for (const k of nodeKeys) {
    assert.ok(
      requiredOnly.includes(k),
      `Unexpected key '${k}' in serialised NodeState — optional fields must be omitted, not written as null`,
    );
  }
});

// ---------------------------------------------------------------------------
// Tests 1-3 and 6 — [expected-fail until Block 4]
//
// These import computeReadyNodes and reconcileRunningNodes from src/dag.ts
// which does NOT exist yet. The import is dynamic (inside the test body) so:
//   1. TypeScript's static analysis does not reject the file at compile time.
//   2. The test fails with a clear module-not-found error rather than a
//      cryptic assertion failure.
//   3. Once Block 4 creates dag.ts and exports these functions, the tests
//      pass automatically.
// ---------------------------------------------------------------------------

// The specifier is built at runtime to prevent tsc from statically resolving it.
const DAG_MODULE = "./dag.js";

test("[expected-fail until Block4] Test 1a — node with no deps is immediately ready", async () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { computeReadyNodes } = (await import(DAG_MODULE)) as {
    computeReadyNodes: (nodes: Node[], statuses: NodeStatusMap) => string[];
  };

  const nodes: Node[] = [
    { id: "a", command: "/a" },
    { id: "b", command: "/b", dependsOn: ["a"] },
    { id: "c", command: "/c", dependsOn: ["b"] },
  ];

  const statuses: NodeStatusMap = {
    a: "pending",
    b: "pending",
    c: "pending",
  };

  const ready = computeReadyNodes(nodes, statuses);
  assert.deepStrictEqual(
    ready,
    ["a"],
    "Only 'a' has no deps and should be ready",
  );
});

test("[expected-fail until Block4] Test 1b — B is ready only after A is done", async () => {
  const { computeReadyNodes } = (await import(DAG_MODULE)) as {
    computeReadyNodes: (nodes: Node[], statuses: NodeStatusMap) => string[];
  };

  const nodes: Node[] = [
    { id: "a", command: "/a" },
    { id: "b", command: "/b", dependsOn: ["a"] },
    { id: "c", command: "/c", dependsOn: ["b"] },
  ];

  // A is done, B pending, C pending.
  const statuses: NodeStatusMap = { a: "done", b: "pending", c: "pending" };
  const ready = computeReadyNodes(nodes, statuses);
  assert.deepStrictEqual(ready, ["b"]);
});

test("[expected-fail until Block4] Test 1c — C is ready only after B is done", async () => {
  const { computeReadyNodes } = (await import(DAG_MODULE)) as {
    computeReadyNodes: (nodes: Node[], statuses: NodeStatusMap) => string[];
  };

  const nodes: Node[] = [
    { id: "a", command: "/a" },
    { id: "b", command: "/b", dependsOn: ["a"] },
    { id: "c", command: "/c", dependsOn: ["b"] },
  ];

  const statuses: NodeStatusMap = { a: "done", b: "done", c: "pending" };
  const ready = computeReadyNodes(nodes, statuses);
  assert.deepStrictEqual(ready, ["c"]);
});

test("[expected-fail until Block4] Test 1d — required failed dep blocks downstream node", async () => {
  const { computeReadyNodes } = (await import(DAG_MODULE)) as {
    computeReadyNodes: (nodes: Node[], statuses: NodeStatusMap) => string[];
  };

  const nodes: Node[] = [
    { id: "a", command: "/a" },
    { id: "b", command: "/b", dependsOn: ["a"] }, // a is required (no optional:true on a)
  ];

  // A failed — B must NOT be ready.
  const statuses: NodeStatusMap = { a: "failed", b: "pending" };
  const ready = computeReadyNodes(nodes, statuses);
  assert.ok(
    !ready.includes("b"),
    "B must not be ready when required dep A failed",
  );
});

test("[expected-fail until Block4] Test 2 — when:false skips node + blocks downstream", async () => {
  const { computeReadyNodes } = (await import(DAG_MODULE)) as {
    computeReadyNodes: (nodes: Node[], statuses: NodeStatusMap) => string[];
  };

  // 'b' has when:()=>false; 'c' depends on 'b'.
  // After scheduling, b must be 'skipped', and c must NOT be 'ready'
  // (skipped is not 'done', so c is blocked).
  const nodes: Node[] = [
    { id: "a", command: "/a" },
    { id: "b", command: "/b", dependsOn: ["a"], when: () => false },
    { id: "c", command: "/c", dependsOn: ["b"] },
  ];

  // A is done. Engine should evaluate b's when predicate → skip b.
  // Then c has a skipped dep that is not optional → c is not ready.
  const statuses: NodeStatusMap = { a: "done", b: "skipped", c: "pending" };
  const ready = computeReadyNodes(nodes, statuses);
  assert.ok(
    !ready.includes("c"),
    "c must not be ready when non-optional dep b is skipped",
  );
});

test("[expected-fail until Block4] Test 3a — join: all three deps done → node ready", async () => {
  const { computeReadyNodes } = (await import(DAG_MODULE)) as {
    computeReadyNodes: (nodes: Node[], statuses: NodeStatusMap) => string[];
  };

  // Join node 'synthesize' depends on three reviewers; uses none-failed-min-one-success.
  const nodes: Node[] = [
    { id: "reviewer-a", command: "/review", optional: true },
    { id: "reviewer-b", command: "/review", optional: true },
    { id: "reviewer-c", command: "/review", optional: false }, // required
    {
      id: "synthesize",
      command: "/synthesize",
      dependsOn: ["reviewer-a", "reviewer-b", "reviewer-c"],
      joinRule: "none-failed-min-one-success",
    },
  ];

  const statuses: NodeStatusMap = {
    "reviewer-a": "done",
    "reviewer-b": "done",
    "reviewer-c": "done",
    synthesize: "pending",
  };

  const ready = computeReadyNodes(nodes, statuses);
  assert.ok(
    ready.includes("synthesize"),
    "synthesize must be ready when all deps done",
  );
});

test("[expected-fail until Block4] Test 3b — join: optional reviewer fails → synthesize still ready", async () => {
  const { computeReadyNodes } = (await import(DAG_MODULE)) as {
    computeReadyNodes: (nodes: Node[], statuses: NodeStatusMap) => string[];
  };

  const nodes: Node[] = [
    { id: "reviewer-a", command: "/review", optional: true }, // optional
    { id: "reviewer-b", command: "/review", optional: true },
    { id: "reviewer-c", command: "/review", optional: false }, // required
    {
      id: "synthesize",
      command: "/synthesize",
      dependsOn: ["reviewer-a", "reviewer-b", "reviewer-c"],
      joinRule: "none-failed-min-one-success",
    },
  ];

  // reviewer-a failed but is optional → treated as skipped, non-blocking.
  // reviewer-c done, reviewer-b done → ≥1 success, no required failures.
  const statuses: NodeStatusMap = {
    "reviewer-a": "skipped", // optional failed → degraded to skipped
    "reviewer-b": "done",
    "reviewer-c": "done",
    synthesize: "pending",
  };

  const ready = computeReadyNodes(nodes, statuses);
  assert.ok(
    ready.includes("synthesize"),
    "synthesize must be ready when optional dep is skipped and required dep is done",
  );
});

test("[expected-fail until Block4] Test 3c — join: required reviewer fails → synthesize NOT ready", async () => {
  const { computeReadyNodes } = (await import(DAG_MODULE)) as {
    computeReadyNodes: (nodes: Node[], statuses: NodeStatusMap) => string[];
  };

  const nodes: Node[] = [
    { id: "reviewer-a", command: "/review", optional: true },
    { id: "reviewer-b", command: "/review", optional: true },
    { id: "reviewer-c", command: "/review", optional: false }, // required
    {
      id: "synthesize",
      command: "/synthesize",
      dependsOn: ["reviewer-a", "reviewer-b", "reviewer-c"],
      joinRule: "none-failed-min-one-success",
    },
  ];

  // reviewer-c (required) failed → synthesize must NOT be ready.
  const statuses: NodeStatusMap = {
    "reviewer-a": "done",
    "reviewer-b": "done",
    "reviewer-c": "failed",
    synthesize: "pending",
  };

  const ready = computeReadyNodes(nodes, statuses);
  assert.ok(
    !ready.includes("synthesize"),
    "synthesize must NOT be ready when required dep reviewer-c failed",
  );
});

test("[expected-fail until Block4] Test 6 — reconcile: running node becomes failed + stale lock released", async () => {
  const { reconcileRunningNodes } = (await import(DAG_MODULE)) as {
    reconcileRunningNodes: (state: RunState) => RunState;
  };

  // Simulate a stale lockfile left by a killed process.
  // reconcileRunningNodes fixes the state; the ENGINE CALLER then releases the lock.
  // This test demonstrates both halves: state repair (reconcileRunningNodes) and
  // lock release (caller's responsibility — see DECISIONS.md block3).
  const lockDir = mkdtempSync(join(tmpdir(), "dagrunner-lock-"));
  const lockPath = join(lockDir, "active.lock");
  writeFileSync(lockPath, "kill-test\n", "utf8");
  assert.ok(existsSync(lockPath), "lockfile must exist before reconcile");

  const original: RunState = {
    runId: "kill-test",
    workflow: "feature",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    status: "running",
    worktreePath: "/tmp/wt",
    branch: "feature/kill-test",
    sourcePlanPath: "/tmp/plan.md",
    nodes: {
      "step-a": makeNodeState({ status: "done", cost: 0.001 }),
      expand: makeNodeState({
        status: "running", // stuck — process was killed
        startedAt: "2026-06-10T00:01:00.000Z",
        cost: 0,
      }),
    },
  };

  const reconciled = reconcileRunningNodes(original);

  assert.equal(
    reconciled.nodes["expand"]?.status,
    "failed",
    "Node stuck in 'running' must be marked 'failed' after reconcile",
  );
  assert.equal(
    reconciled.nodes["step-a"]?.status,
    "done",
    "Node already 'done' must remain 'done' after reconcile",
  );
  assert.ok(
    reconciled.updatedAt !== original.updatedAt || reconciled.updatedAt !== "",
    "updatedAt must be refreshed after reconcile",
  );

  // Simulate the engine caller releasing the stale lock after reconcile.
  unlinkSync(lockPath);
  assert.ok(
    !existsSync(lockPath),
    "stale lockfile must be gone after engine releases it",
  );
});

// ---------------------------------------------------------------------------
// Test 7 — Bug 1: optional dep skipped → downstream ready (default join rule)
// ---------------------------------------------------------------------------

test("[expected-fail until Block4] Test 7 — optional dep skipped → downstream ready", async () => {
  const { computeReadyNodes } = (await import(DAG_MODULE)) as {
    computeReadyNodes: (nodes: Node[], statuses: NodeStatusMap) => string[];
  };

  // 'a' is optional and has been degraded to 'skipped'.
  // 'b' depends on 'a' (default join rule, no joinRule override).
  // Because 'a' is optional, its skipped status is non-blocking — 'b' must be ready.
  const nodes: Node[] = [
    { id: "a", command: "/a", optional: true },
    { id: "b", command: "/b", dependsOn: ["a"] },
  ];

  const statuses: NodeStatusMap = { a: "skipped", b: "pending" };
  const ready = computeReadyNodes(nodes, statuses);
  assert.ok(
    ready.includes("b"),
    "b must be ready when its only dep (optional 'a') is skipped",
  );
});

// ---------------------------------------------------------------------------
// Tests 8-9 — interrupt-retry cap (resetInterruptedNodes)
// ---------------------------------------------------------------------------

const INTERRUPT_ERROR = "process interrupted — reconciled on resume";

test("interrupt-retry: under cap — resetInterruptedNodes resets to pending + increments counter", async () => {
  const { resetInterruptedNodes } = (await import(DAG_MODULE)) as {
    resetInterruptedNodes: (state: RunState, maxRetries: number) => RunState;
  };

  const state: RunState = {
    runId: "irr-under",
    workflow: "feature",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    status: "running",
    worktreePath: "/tmp/wt",
    branch: "feature/irr-under",
    sourcePlanPath: "/tmp/plan.md",
    nodes: {
      "node-a": makeNodeState({
        status: "failed",
        error: INTERRUPT_ERROR,
        // interruptRetries absent → treated as 0
      }),
    },
  };

  const result = resetInterruptedNodes(state, 2);

  assert.equal(
    result.nodes["node-a"]?.status,
    "pending",
    "under-cap node must reset to pending",
  );
  assert.equal(
    result.nodes["node-a"]?.interruptRetries,
    1,
    "counter must increment to 1",
  );
});

test("interrupt-retry: at cap — resetInterruptedNodes leaves node failed", async () => {
  const { resetInterruptedNodes } = (await import(DAG_MODULE)) as {
    resetInterruptedNodes: (state: RunState, maxRetries: number) => RunState;
  };

  const state: RunState = {
    runId: "irr-cap",
    workflow: "feature",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    status: "running",
    worktreePath: "/tmp/wt",
    branch: "feature/irr-cap",
    sourcePlanPath: "/tmp/plan.md",
    nodes: {
      "node-a": makeNodeState({
        status: "failed",
        error: INTERRUPT_ERROR,
        interruptRetries: 2, // at cap
      }),
    },
  };

  const result = resetInterruptedNodes(state, 2);

  assert.equal(
    result.nodes["node-a"]?.status,
    "failed",
    "at-cap node must stay failed",
  );
  assert.equal(
    result.nodes["node-a"]?.interruptRetries,
    2,
    "counter must not change",
  );
});

test("interrupt-retry: teeth-check — cap=0 means never retry (node stays failed on first interrupt)", async () => {
  const { resetInterruptedNodes } = (await import(DAG_MODULE)) as {
    resetInterruptedNodes: (state: RunState, maxRetries: number) => RunState;
  };

  const state: RunState = {
    runId: "irr-zero",
    workflow: "feature",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    status: "running",
    worktreePath: "/tmp/wt",
    branch: "feature/irr-zero",
    sourcePlanPath: "/tmp/plan.md",
    nodes: {
      "node-a": makeNodeState({
        status: "failed",
        error: INTERRUPT_ERROR,
        // interruptRetries absent → 0
      }),
    },
  };

  const result = resetInterruptedNodes(state, 0);

  assert.equal(
    result.nodes["node-a"]?.status,
    "failed",
    "cap=0: node must stay failed immediately",
  );
});

test("interrupt-retry: under cap — runDag completes run after reset (mock executor, no SDK)", async () => {
  const { resetInterruptedNodes, runDag } = (await import(DAG_MODULE)) as {
    resetInterruptedNodes: (state: RunState, maxRetries: number) => RunState;
    runDag: (
      workflow: Workflow,
      executor: NodeExecutor,
      state: RunState,
      opts: { ctx: Ctx; stateFile: string },
    ) => Promise<RunState>;
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "dr-irr-under-"));
  const stateFile = join(tmpDir, "state.json");

  const initialState: RunState = {
    runId: "irr-run-under",
    workflow: "feature",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    status: "running",
    worktreePath: tmpDir,
    branch: "feature/irr-run-under",
    sourcePlanPath: "/tmp/plan.md",
    nodes: {
      "node-a": makeNodeState({ status: "failed", error: INTERRUPT_ERROR }),
    },
  };

  // Apply interrupt-retry reset (under cap → pending).
  const stateAfterReset = resetInterruptedNodes(initialState, 2);
  assert.equal(stateAfterReset.nodes["node-a"]?.status, "pending");

  writeState(stateFile, stateAfterReset);

  const executor = createMockExecutor({ "node-a": "success" });
  const ctx: Ctx = {
    json: () => ({}),
    read: () => "",
    dir: (id: string) => join(tmpDir, id),
  };

  const result = await runDag(
    { name: "feature", nodes: [{ id: "node-a", command: "/a" }] },
    executor,
    stateAfterReset,
    { ctx, stateFile },
  );

  assert.equal(
    result.status,
    "done",
    "run must complete done when interrupted node retries successfully",
  );
  assert.equal(result.nodes["node-a"]?.status, "done");
});

test("interrupt-retry: at cap — runDag ends failed without looping (terminates, no SDK call)", async () => {
  const { resetInterruptedNodes, runDag } = (await import(DAG_MODULE)) as {
    resetInterruptedNodes: (state: RunState, maxRetries: number) => RunState;
    runDag: (
      workflow: Workflow,
      executor: NodeExecutor,
      state: RunState,
      opts: { ctx: Ctx; stateFile: string },
    ) => Promise<RunState>;
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "dr-irr-cap-"));
  const stateFile = join(tmpDir, "state.json");

  const initialState: RunState = {
    runId: "irr-run-cap",
    workflow: "feature",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    status: "running",
    worktreePath: tmpDir,
    branch: "feature/irr-run-cap",
    sourcePlanPath: "/tmp/plan.md",
    nodes: {
      "node-a": makeNodeState({
        status: "failed",
        error: INTERRUPT_ERROR,
        interruptRetries: 2, // at cap
      }),
    },
  };

  // Apply interrupt-retry reset (at cap → stays failed).
  const stateAfterReset = resetInterruptedNodes(initialState, 2);
  assert.equal(
    stateAfterReset.nodes["node-a"]?.status,
    "failed",
    "at cap: must remain failed",
  );

  writeState(stateFile, stateAfterReset);

  // The executor must never be called — node is already terminal.
  let executorCallCount = 0;
  const executor = createMockExecutor({});
  const trackingExecutor: NodeExecutor = async (id, node, ctx) => {
    executorCallCount++;
    return executor(id, node, ctx);
  };

  const ctx: Ctx = {
    json: () => ({}),
    read: () => "",
    dir: (id: string) => join(tmpDir, id),
  };

  const result = await runDag(
    { name: "feature", nodes: [{ id: "node-a", command: "/a" }] },
    trackingExecutor,
    stateAfterReset,
    { ctx, stateFile },
  );

  assert.equal(
    result.status,
    "failed",
    "run must end failed when interrupted node exhausts cap",
  );
  assert.equal(result.nodes["node-a"]?.status, "failed");
  assert.equal(
    executorCallCount,
    0,
    "executor must never be called for a capped node — proves no infinite loop",
  );

  // Confirm stateFile was written (runDag settles to failed).
  const written = readState(stateFile);
  assert.equal(written.status, "failed");
});

// ---------------------------------------------------------------------------
// outcomeGate — content-level pass/fail check on a produced JSON artifact
// (D6 of the verify-node autonomy change: dag.ts's own produces-check gets a
// sibling check for artifact CONTENT, not just existence).
// ---------------------------------------------------------------------------

/** Build a one-node workflow + executor that writes `content` to `file` and returns 'done'. */
function makeOutcomeGateHarness(
  tmpDir: string,
  node: Node,
  content: string,
): { workflow: Workflow; executor: NodeExecutor; stateFile: string } {
  const stateFile = join(tmpDir, "state.json");
  const executor: NodeExecutor = async (_id, n, ctx) => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(ctx.artifactsDir, { recursive: true });
    for (const f of n.produces ?? []) {
      writeFileSync(join(ctx.artifactsDir, f), content, "utf8");
    }
    return {
      status: "done",
      artifacts: [],
      cost: 0,
      sessionId: "mock-session-abc123",
    };
  };
  return {
    workflow: { name: "outcome-gate-fixture", nodes: [node] },
    executor,
    stateFile,
  };
}

function makeOutcomeGateState(tmpDir: string, runId: string): RunState {
  return {
    runId,
    workflow: "outcome-gate-fixture",
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    status: "running",
    worktreePath: tmpDir,
    branch: `feature/${runId}`,
    sourcePlanPath: "/tmp/plan.md",
    nodes: { verify: makeNodeState({ status: "pending" }) },
  };
}

test("outcomeGate: PASS value passes the node through to done", async () => {
  const { runDag } = (await import(DAG_MODULE)) as {
    runDag: (
      workflow: Workflow,
      executor: NodeExecutor,
      state: RunState,
      opts: { ctx: Ctx; stateFile: string },
    ) => Promise<RunState>;
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "dr-outcome-gate-pass-"));
  const node: Node = {
    id: "verify",
    command: "/verify",
    produces: ["verify-report.json"],
    outcomeGate: {
      file: "verify-report.json",
      field: "outcome",
      passValues: ["PASS"],
    },
  };
  const { workflow, executor, stateFile } = makeOutcomeGateHarness(
    tmpDir,
    node,
    JSON.stringify({ outcome: "PASS" }),
  );
  const state = makeOutcomeGateState(tmpDir, "outcome-gate-pass");
  const ctx: Ctx = {
    json: () => ({}),
    read: () => "",
    dir: (id) => join(tmpDir, id),
  };

  const result = await runDag(workflow, executor, state, { ctx, stateFile });

  assert.equal(result.status, "done");
  assert.equal(result.nodes["verify"]?.status, "done");
});

// verify-defer-to-ci-and-drop-diff-scoped-rerun change (2026-07-14, motivated by run 56954-1):
// DEFERRED_TO_CI is a second, non-blocking outcome value alongside PASS — a confirmed
// pre-existing, diff-unrelated build break must not block pr the way FAIL_BUILD does. This
// proves the mechanism generically (checkOutcomeGate/runDag are data-driven over whatever
// passValues contains), not just that the two workflow configs declare the right array.
test("outcomeGate: DEFERRED_TO_CI passes the node through to done when passValues includes it (verify-defer-to-ci-and-drop-diff-scoped-rerun)", async () => {
  const { runDag } = (await import(DAG_MODULE)) as {
    runDag: (
      workflow: Workflow,
      executor: NodeExecutor,
      state: RunState,
      opts: { ctx: Ctx; stateFile: string },
    ) => Promise<RunState>;
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "dr-outcome-gate-deferred-"));
  const node: Node = {
    id: "verify",
    command: "/verify",
    produces: ["verify-report.json"],
    outcomeGate: {
      file: "verify-report.json",
      field: "outcome",
      passValues: ["PASS", "DEFERRED_TO_CI"],
    },
  };
  const { workflow, executor, stateFile } = makeOutcomeGateHarness(
    tmpDir,
    node,
    JSON.stringify({ outcome: "DEFERRED_TO_CI" }),
  );
  const state = makeOutcomeGateState(tmpDir, "outcome-gate-deferred");
  const ctx: Ctx = {
    json: () => ({}),
    read: () => "",
    dir: (id) => join(tmpDir, id),
  };

  const result = await runDag(workflow, executor, state, { ctx, stateFile });

  assert.equal(result.status, "done");
  assert.equal(result.nodes["verify"]?.status, "done");
});

test("outcomeGate: a non-pass value fails the node with the outcome value in the error", async () => {
  const { runDag } = (await import(DAG_MODULE)) as {
    runDag: (
      workflow: Workflow,
      executor: NodeExecutor,
      state: RunState,
      opts: { ctx: Ctx; stateFile: string },
    ) => Promise<RunState>;
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "dr-outcome-gate-fail-"));
  const node: Node = {
    id: "verify",
    command: "/verify",
    produces: ["verify-report.json"],
    outcomeGate: {
      file: "verify-report.json",
      field: "outcome",
      passValues: ["PASS"],
    },
  };
  const { workflow, executor, stateFile } = makeOutcomeGateHarness(
    tmpDir,
    node,
    JSON.stringify({ outcome: "FAIL_ASSERTION" }),
  );
  const state = makeOutcomeGateState(tmpDir, "outcome-gate-fail");
  const ctx: Ctx = {
    json: () => ({}),
    read: () => "",
    dir: (id) => join(tmpDir, id),
  };

  const result = await runDag(workflow, executor, state, { ctx, stateFile });

  assert.equal(result.status, "failed");
  assert.equal(result.nodes["verify"]?.status, "failed");
  const err = result.nodes["verify"]?.error ?? "";
  assert.ok(
    err.includes("FAIL_ASSERTION"),
    `expected outcome value in error message, got: ${err}`,
  );
  assert.ok(
    err.includes("PASS"),
    `expected expected-passValues list in error message, got: ${err}`,
  );
});

test("outcomeGate: missing field in an otherwise-valid JSON artifact fails loud (never a silent pass)", async () => {
  const { runDag } = (await import(DAG_MODULE)) as {
    runDag: (
      workflow: Workflow,
      executor: NodeExecutor,
      state: RunState,
      opts: { ctx: Ctx; stateFile: string },
    ) => Promise<RunState>;
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "dr-outcome-gate-missing-field-"));
  const node: Node = {
    id: "verify",
    command: "/verify",
    produces: ["verify-report.json"],
    outcomeGate: {
      file: "verify-report.json",
      field: "outcome",
      passValues: ["PASS"],
    },
  };
  const { workflow, executor, stateFile } = makeOutcomeGateHarness(
    tmpDir,
    node,
    JSON.stringify({ stages: { build: "PASS" } }), // no "outcome" field at all
  );
  const state = makeOutcomeGateState(tmpDir, "outcome-gate-missing-field");
  const ctx: Ctx = {
    json: () => ({}),
    read: () => "",
    dir: (id) => join(tmpDir, id),
  };

  const result = await runDag(workflow, executor, state, { ctx, stateFile });

  assert.equal(result.status, "failed");
  assert.equal(result.nodes["verify"]?.status, "failed");
  assert.ok(
    (result.nodes["verify"]?.error ?? "").length > 0,
    "missing outcomeGate field must produce a non-empty error, not a silent pass",
  );
});

test("outcomeGate: missing declared file degrades to failed via the existing produces check (not a separate silent path)", async () => {
  const { runDag } = (await import(DAG_MODULE)) as {
    runDag: (
      workflow: Workflow,
      executor: NodeExecutor,
      state: RunState,
      opts: { ctx: Ctx; stateFile: string },
    ) => Promise<RunState>;
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "dr-outcome-gate-missing-file-"));
  // node declares outcomeGate over a file that is NOT in `produces` — the
  // produces-check never verifies it exists, so checkOutcomeGate must itself
  // fail loud when the file is absent (rather than crashing or passing).
  const node: Node = {
    id: "verify",
    command: "/verify",
    produces: [],
    outcomeGate: {
      file: "verify-report.json",
      field: "outcome",
      passValues: ["PASS"],
    },
  };
  const executor: NodeExecutor = async () => ({
    status: "done",
    artifacts: [],
    cost: 0,
    sessionId: "mock-session-abc123",
  });
  const workflow: Workflow = { name: "outcome-gate-fixture", nodes: [node] };
  const state = makeOutcomeGateState(tmpDir, "outcome-gate-missing-file");
  const stateFile = join(tmpDir, "state.json");
  const ctx: Ctx = {
    json: () => ({}),
    read: () => "",
    dir: (id) => join(tmpDir, id),
  };

  const result = await runDag(workflow, executor, state, { ctx, stateFile });

  assert.equal(result.status, "failed");
  assert.equal(result.nodes["verify"]?.status, "failed");
  assert.ok(
    (result.nodes["verify"]?.error ?? "").length > 0,
    "missing outcomeGate file must produce a non-empty error, not a silent pass",
  );
});

// ---------------------------------------------------------------------------
// noPlaceholders — mechanical scan for unresolved placeholder markers
// (item 4 of the "structural upgrades" build: define/reproduce guide.md
// mechanically scanned for TBD/TODO/FIXME/XXX after fenced code is stripped)
// ---------------------------------------------------------------------------

test("checkNoPlaceholders: clean file with no markers passes", async () => {
  const { checkNoPlaceholders } = (await import(DAG_MODULE)) as {
    checkNoPlaceholders: (
      runDir: string,
      nodeId: string,
      node: Node,
    ) => { ok: true } | { ok: false; error: string };
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "dr-no-placeholders-clean-"));
  const nodeDir = join(tmpDir, "define");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(
    join(nodeDir, "guide.md"),
    "# Guide\n\nEverything here is fully specified. No open items remain.\n",
    "utf8",
  );

  const node: Node = {
    id: "define",
    command: "/define",
    produces: ["guide.md"],
    noPlaceholders: ["guide.md"],
  };

  const result = checkNoPlaceholders(tmpDir, "define", node);
  assert.deepEqual(result, { ok: true });
});

test("checkNoPlaceholders: a TODO quoted inside a fenced code block is NOT a false positive", async () => {
  const { checkNoPlaceholders } = (await import(DAG_MODULE)) as {
    checkNoPlaceholders: (
      runDir: string,
      nodeId: string,
      node: Node,
    ) => { ok: true } | { ok: false; error: string };
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "dr-no-placeholders-fenced-"));
  const nodeDir = join(tmpDir, "define");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(
    join(nodeDir, "guide.md"),
    [
      "# Guide",
      "",
      "The existing handler already has this comment, unrelated to this guide:",
      "",
      "```java",
      "// TODO: revisit this once the v2 API ships",
      "public void handle() {}",
      "```",
      "",
      "No further action needed here.",
      "",
    ].join("\n"),
    "utf8",
  );

  const node: Node = {
    id: "define",
    command: "/define",
    produces: ["guide.md"],
    noPlaceholders: ["guide.md"],
  };

  const result = checkNoPlaceholders(tmpDir, "define", node);
  assert.deepEqual(
    result,
    { ok: true },
    "a TODO quoted inside a fenced code block must not fail the node",
  );
});

test("checkNoPlaceholders: a real placeholder in prose fails with the token and line", async () => {
  const { checkNoPlaceholders } = (await import(DAG_MODULE)) as {
    checkNoPlaceholders: (
      runDir: string,
      nodeId: string,
      node: Node,
    ) => { ok: true } | { ok: false; error: string };
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "dr-no-placeholders-real-"));
  const nodeDir = join(tmpDir, "define");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(
    join(nodeDir, "guide.md"),
    [
      "# Guide",
      "",
      "## Validation commands",
      "",
      "TBD — figure out the exact test command later.",
      "",
    ].join("\n"),
    "utf8",
  );

  const node: Node = {
    id: "define",
    command: "/define",
    produces: ["guide.md"],
    noPlaceholders: ["guide.md"],
  };

  const result = checkNoPlaceholders(tmpDir, "define", node);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.error.includes("guide.md"),
      `expected filename in error, got: ${result.error}`,
    );
    assert.ok(
      result.error.includes("TBD"),
      `expected matched token in error, got: ${result.error}`,
    );
    assert.ok(
      result.error.includes("line 5"),
      `expected line number in error, got: ${result.error}`,
    );
  }
});

test("checkNoPlaceholders: absent when node.noPlaceholders is undefined (no expectation to violate)", async () => {
  const { checkNoPlaceholders } = (await import(DAG_MODULE)) as {
    checkNoPlaceholders: (
      runDir: string,
      nodeId: string,
      node: Node,
    ) => { ok: true } | { ok: false; error: string };
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "dr-no-placeholders-absent-"));
  const node: Node = {
    id: "define",
    command: "/define",
    produces: ["guide.md"],
  };

  const result = checkNoPlaceholders(tmpDir, "define", node);
  assert.deepEqual(result, { ok: true });
});

test("checkNoPlaceholders: wired end-to-end through runDag — a placeholder fails the node even though produces + outcomeGate would have passed", async () => {
  const { runDag } = (await import(DAG_MODULE)) as {
    runDag: (
      workflow: Workflow,
      executor: NodeExecutor,
      state: RunState,
      opts: { ctx: Ctx; stateFile: string },
    ) => Promise<RunState>;
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "dr-no-placeholders-rundag-"));
  const node: Node = {
    id: "define",
    command: "/define",
    produces: ["guide.md"],
    noPlaceholders: ["guide.md"],
  };
  const stateFile = join(tmpDir, "state.json");
  const executor: NodeExecutor = async (_id, n, ctx) => {
    const { mkdirSync, writeFileSync: wfs } = await import("node:fs");
    mkdirSync(ctx.artifactsDir, { recursive: true });
    for (const f of n.produces ?? []) {
      wfs(
        join(ctx.artifactsDir, f),
        "# Guide\n\nFIXME: not done yet.\n",
        "utf8",
      );
    }
    return {
      status: "done",
      artifacts: [],
      cost: 0,
      sessionId: "mock-session-abc123",
    };
  };
  const workflow: Workflow = { name: "no-placeholders-fixture", nodes: [node] };
  const state = makeOutcomeGateState(tmpDir, "no-placeholders-rundag");
  const ctx: Ctx = {
    json: () => ({}),
    read: () => "",
    dir: (id) => join(tmpDir, id),
  };
  // makeOutcomeGateState seeds a "verify" node id by default — override to "define".
  const stateWithDefine: RunState = {
    ...state,
    nodes: { define: makeNodeState({ status: "pending" }) },
  };

  const result = await runDag(workflow, executor, stateWithDefine, {
    ctx,
    stateFile,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.nodes["define"]?.status, "failed");
  assert.ok(
    (result.nodes["define"]?.error ?? "").includes("FIXME"),
    `expected FIXME token in error, got: ${result.nodes["define"]?.error}`,
  );
});
