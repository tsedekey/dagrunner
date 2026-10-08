/**
 * dag-cost.test.ts — node cost is the sum over DISTINCT sessions of each
 * session's latest CUMULATIVE cost. A resumed session (gate reject/amend,
 * same sessionId) REPLACES its own earlier contribution; a new session adds.
 *
 * Regression for run 51496-1: the fix node's SDK `total_cost_usd` was
 * cumulative for one resumed session (3.82 → 6.49 → 12.14 → 13.23) but
 * state.json recorded the SUM (35.675) because every gate round re-added it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runDag } from "./dag.js";
import { accrueSessionCost, readState, writeState } from "./state.js";
import type { NodeState, RunState } from "./state.js";
import type { Ctx, Workflow } from "./types.js";
import { createMockExecutor } from "../runtime/mock-executor.js";
import type { NodeExecutor } from "../runtime/mock-executor.js";

const ctx: Ctx = { json: () => ({}), read: () => "", dir: (id) => id };
const wf: Workflow = {
  name: "feature",
  nodes: [
    { id: "g", command: "/g", produces: ["awaiting-review.md"], gate: {} },
  ],
};

function fresh(dir: string): RunState {
  return {
    runId: "r",
    workflow: "feature",
    createdAt: "T",
    updatedAt: "T",
    status: "running",
    worktreePath: dir,
    branch: "b",
    sourcePlanPath: "/p",
    nodes: {
      g: {
        status: "pending",
        artifacts: [],
        iteration: 0,
        cost: 0,
        gateHistory: [],
      },
    },
  };
}

/**
 * Wraps the mock gate-pause executor and reports the SDK's real shape: the
 * session id is stable across a resume and `cost` is the session's running
 * total. `cumulative` lists the figures successive executions report; a fresh
 * session (no ctx.sessionId) gets `newSessionId` and starts from `fresh`.
 */
function sdkLikeExecutor(
  cumulative: number[],
  opts: { newSessionId?: string } = {},
): NodeExecutor {
  const inner = createMockExecutor({ g: "gate-pause" });
  let call = 0;
  return async (id, node, c) => {
    const res = await inner(id, node, c);
    if (res.status !== "awaiting-gate") return res;
    const cost = cumulative[call++];
    if (cost === undefined)
      throw new Error("sdkLikeExecutor: ran out of scripted figures");
    const sessionId = c.sessionId ?? opts.newSessionId ?? res.sessionId;
    return { ...res, sessionId, cost };
  };
}

/** Gate revise as resumeRun does it: same node object spread, back to pending. */
function revise(stateFile: string, iteration: number): RunState {
  const cur = readState(stateFile);
  const g = cur.nodes["g"]!;
  const next: RunState = {
    ...cur,
    status: "running",
    nodes: { g: { ...g, status: "pending", iteration } },
  };
  writeState(stateFile, next);
  return next;
}

test("resumed gate rounds: node cost is the final cumulative figure, not the sum of rounds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-cost-"));
  const stateFile = join(dir, "state.json");
  const s0 = fresh(dir);
  writeState(stateFile, s0);
  // Real figures from run 51496-1 (fix node, one session, four executions).
  const ex = sdkLikeExecutor([3.82, 6.49, 12.14, 13.23]);
  await runDag(wf, ex, s0, { ctx, stateFile });
  for (const n of [1, 2, 3])
    await runDag(wf, ex, revise(stateFile, n), { ctx, stateFile });

  const g = readState(stateFile).nodes["g"]!;
  assert.equal(g.cost, 13.23);
  const attempts = g.attempts ?? [];
  assert.equal(attempts.length, 4);
  assert.deepEqual(
    attempts.map((a) => Number(a.cost.toFixed(2))),
    [3.82, 2.67, 5.65, 1.09],
  );
  assert.ok(
    Math.abs(attempts.reduce((s, a) => s + a.cost, 0) - g.cost) < 1e-9,
    "attempts sum to node cost",
  );
});

test("a new session (rerun / recovery mints a new id) ADDS to the node cost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-cost-"));
  const stateFile = join(dir, "state.json");
  const s0 = fresh(dir);
  writeState(stateFile, s0);
  const ex = sdkLikeExecutor([2, 3, 1.5, 4], { newSessionId: "sess-2" });
  await runDag(wf, ex, s0, { ctx, stateFile }); // sess "mock-session-abc123": 2
  await runDag(wf, ex, revise(stateFile, 1), { ctx, stateFile }); // same session: 3
  assert.equal(readState(stateFile).nodes["g"]!.cost, 3);

  // Invalidate (amend downstream reset / dagrun rerun): sessionId dropped, cost kept.
  const cur = readState(stateFile);
  const { sessionId: _s, ...rest } = cur.nodes["g"]!;
  const reset: RunState = {
    ...cur,
    status: "running",
    nodes: { g: { ...rest, status: "pending", iteration: 0 } },
  };
  writeState(stateFile, reset);
  await runDag(wf, ex, reset, { ctx, stateFile }); // NEW session sess-2: 1.5 → 3 + 1.5
  assert.equal(readState(stateFile).nodes["g"]!.cost, 4.5);
  await runDag(wf, ex, revise(stateFile, 1), { ctx, stateFile }); // sess-2 resumed: 4 → 3 + 4
  const g = readState(stateFile).nodes["g"]!;
  assert.equal(g.cost, 7);
  assert.ok(
    Math.abs((g.attempts ?? []).reduce((s, a) => s + a.cost, 0) - g.cost) <
      1e-9,
  );
});

test("a non-gated done node that is re-run in a new session adds, never replaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-cost-"));
  const stateFile = join(dir, "state.json");
  const wf2: Workflow = {
    name: "feature",
    nodes: [{ id: "g", command: "/g", produces: ["a.md"] }],
  };
  const s0 = fresh(dir);
  s0.nodes["g"] = { ...s0.nodes["g"]!, cost: 5 }; // earlier invalidated execution's cost, no sessionId
  writeState(stateFile, s0);
  await runDag(wf2, createMockExecutor({ g: "success" }), s0, {
    ctx,
    stateFile,
  });
  const g = readState(stateFile).nodes["g"]!;
  assert.equal(g.status, "done");
  assert.ok(
    Math.abs(g.cost - 5.0001) < 1e-9,
    `expected 5 + mock cost, got ${g.cost}`,
  );
});

test("accrueSessionCost: legacy node (no priorSessionsCost) resumed → assumes a single session", () => {
  const legacy: Pick<NodeState, "cost" | "sessionId"> = {
    cost: 35.675,
    sessionId: "S",
  };
  const r = accrueSessionCost(legacy, "S", { sessionId: "S", cost: 13.23 });
  assert.equal(r.cost, 13.23);
  assert.equal(r.priorSessionsCost, 0);
  assert.ok(Math.abs(r.delta - (13.23 - 35.675)) < 1e-9);
});

test("accrueSessionCost: resumedFrom undefined is always a new session even if the id repeats", () => {
  const r = accrueSessionCost(
    { cost: 2, sessionId: "S", priorSessionsCost: 0 },
    undefined,
    { sessionId: "S", cost: 1 },
  );
  assert.equal(r.cost, 3);
  assert.equal(r.priorSessionsCost, 2);
  assert.equal(r.delta, 1);
});
