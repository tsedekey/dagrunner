/**
 * dag-blocked-dependents.test.ts — the persisted marker for "skipped because an upstream
 * dependency never finished" (`skipReason: "blocked-dependency"`) and the pure
 * `reenableBlockedDependents` that undoes exactly those skips when a node is rerun.
 *
 * Why it exists: an outcome-gate / produces failure does NOT short-circuit runDag, so
 * the end-of-run sweep marks every still-pending dependent `skipped`. A later `rerun` +
 * `resume` used to leave them skipped and end the run `done` — a false success
 * (DECISIONS.md § rerun-reenables-blocked-dependents). A `when`-skipped or optional-failed
 * node is skipped by its OWN rule and must stay skipped, so state has to tell them apart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { reenableBlockedDependents, runDag } from "./dag.js";
import { readState, writeState } from "./state.js";
import type { NodeState, RunState } from "./state.js";
import type { Ctx, Workflow } from "./types.js";
import { createMockExecutor } from "../runtime/mock-executor.js";

const ctx: Ctx = { json: () => ({}), read: () => "", dir: (id) => id };

const node = (
  status: NodeState["status"],
  extra: Partial<NodeState> = {},
): NodeState => ({
  status,
  artifacts: [],
  iteration: 0,
  cost: 0,
  gateHistory: [],
  ...extra,
});

/** check (outcome-gated) -> after (required) / gated (when:false); opt is an optional root. */
const wf: Workflow = {
  name: "bugfix",
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
    { id: "opt", command: "/opt", optional: true },
    { id: "gated", dependsOn: ["check"], command: "/gated", when: () => false },
    {
      id: "after",
      dependsOn: ["check"],
      command: "/after",
      produces: ["after.md"],
    },
    {
      id: "last",
      dependsOn: ["after"],
      command: "/last",
      produces: ["last.md"],
    },
  ],
};

function freshState(dir: string): RunState {
  const nodes: Record<string, NodeState> = {};
  for (const n of wf.nodes) nodes[n.id] = node("pending");
  return {
    runId: "r",
    workflow: "bugfix",
    createdAt: "T",
    updatedAt: "T",
    status: "running",
    worktreePath: dir,
    branch: "b",
    sourcePlanPath: "/p",
    nodes,
  };
}

/** Run the DAG once with check failing its outcome gate and opt failing (optional). */
async function failedRun(): Promise<RunState> {
  const dir = mkdtempSync(join(tmpdir(), "dr-blocked-"));
  const stateFile = join(dir, "state.json");
  const s0 = freshState(dir);
  writeState(stateFile, s0);
  const executor = createMockExecutor({
    check: "outcome-gate-fail",
    opt: "reviewer-fail",
  });
  await runDag(wf, executor, s0, { ctx, stateFile });
  return readState(stateFile);
}

// ---------------------------------------------------------------------------
// the marker: written by the sweep, and ONLY by the sweep
// ---------------------------------------------------------------------------

test("sweep: a pending node blocked by a failed dependency is persisted skipped with skipReason blocked-dependency", async () => {
  const s = await failedRun();
  assert.equal(s.status, "failed");
  assert.equal(s.nodes["check"]?.status, "failed");
  for (const id of ["after", "last"]) {
    assert.equal(
      s.nodes[id]?.status,
      "skipped",
      `${id} is skipped by the sweep`,
    );
    assert.equal(
      s.nodes[id]?.skipReason,
      "blocked-dependency",
      `${id} carries the marker (transitive: last waits on after)`,
    );
  }
});

test("sweep: a `when`-skipped node and an optional node that failed are skipped WITHOUT the marker", async () => {
  const s = await failedRun();
  assert.equal(s.nodes["gated"]?.status, "skipped");
  assert.equal(
    s.nodes["gated"]?.skipReason,
    undefined,
    "skipped by its own `when` rule, not by a blocked dependency",
  );
  assert.equal(s.nodes["opt"]?.status, "skipped");
  assert.equal(
    s.nodes["opt"]?.skipReason,
    undefined,
    "an optional failure degrading to skipped is a legitimate skip",
  );
  assert.ok(
    s.nodes["opt"]?.error !== undefined,
    "and it keeps its failure error",
  );
});

// ---------------------------------------------------------------------------
// reenableBlockedDependents (pure)
// ---------------------------------------------------------------------------

test("reenableBlockedDependents: returns exactly the blocked-dependency nodes downstream of the rerun node to pending, clearing endedAt/error/skipReason", async () => {
  const before = await failedRun();
  const snapshot = JSON.stringify(before);
  const { state, reset } = reenableBlockedDependents(wf, before, "check");

  assert.deepEqual(
    [...reset].sort(),
    ["after", "last"],
    "both the direct and the transitive dependent",
  );
  for (const id of reset) {
    const ns = state.nodes[id] as NodeState;
    assert.equal(ns.status, "pending");
    assert.equal(
      "endedAt" in ns,
      false,
      "stale endedAt cleared (no explicit undefined: exactOptionalPropertyTypes)",
    );
    assert.equal("error" in ns, false);
    assert.equal("skipReason" in ns, false);
  }
  assert.equal(
    JSON.stringify(before),
    snapshot,
    "the input state is not mutated",
  );
});

test("reenableBlockedDependents: legitimately skipped nodes stay skipped, untouched (when-skipped, optional-failed); the rerun node itself is not touched", async () => {
  const before = await failedRun();
  const { state } = reenableBlockedDependents(wf, before, "check");
  assert.deepEqual(
    state.nodes["gated"],
    before.nodes["gated"],
    "when-skipped node unchanged",
  );
  assert.deepEqual(
    state.nodes["opt"],
    before.nodes["opt"],
    "optional-failed skip unchanged",
  );
  assert.deepEqual(
    state.nodes["check"],
    before.nodes["check"],
    "the helper never touches the rerun node (rerunNode owns it)",
  );
});

test("reenableBlockedDependents: keeps cost, attempts, gateHistory and model of a re-enabled node", () => {
  const attempts = [
    {
      iteration: 0,
      status: "done" as const,
      startedAt: "a",
      endedAt: "b",
      durationMs: 1,
      cost: 0.5,
    },
  ];
  const gh = [{ decision: "hold" as const, timestamp: "t" }];
  const state: RunState = {
    ...freshState("/x"),
    nodes: {
      ...freshState("/x").nodes,
      check: node("done"),
      after: node("skipped", {
        skipReason: "blocked-dependency",
        endedAt: "E",
        error: "stale",
        cost: 0.5,
        attempts,
        gateHistory: gh,
        model: "sonnet",
      }),
    },
  };
  const out = reenableBlockedDependents(wf, state, "check").state.nodes[
    "after"
  ] as NodeState;
  assert.equal(out.status, "pending");
  assert.equal(out.cost, 0.5);
  assert.deepEqual(out.attempts, attempts);
  assert.deepEqual(out.gateHistory, gh);
  assert.equal(out.model, "sonnet");
});

test("reenableBlockedDependents: a downstream node that is `done` (or anything but a marked skip) is returned untouched — rerunNode's existing behaviour for it is not changed", () => {
  const base = freshState("/x");
  const state: RunState = {
    ...base,
    nodes: {
      ...base.nodes,
      check: node("done"),
      after: node("done", { endedAt: "E" }),
      last: node("awaiting-gate"),
    },
  };
  const { state: out, reset } = reenableBlockedDependents(wf, state, "check");
  assert.deepEqual(reset, []);
  assert.equal(
    out,
    state,
    "nothing to change -> the very same state object back",
  );
});

test("reenableBlockedDependents: a marked node that is NOT downstream of the rerun node is left alone", () => {
  const base = freshState("/x");
  const state: RunState = {
    ...base,
    nodes: {
      ...base.nodes,
      check: node("done"),
      opt: node("failed"),
      after: node("skipped", { skipReason: "blocked-dependency" }),
    },
  };
  // `after` depends on check, not on opt: rerunning opt must not revive it.
  const { state: out, reset } = reenableBlockedDependents(wf, state, "opt");
  assert.deepEqual(reset, []);
  assert.equal(out.nodes["after"]?.status, "skipped");
});

test("reenableBlockedDependents: LEGACY state (skipped nodes, no skipReason marker) is returned unchanged — absent marker = old behaviour", async () => {
  const s = await failedRun();
  const legacy: RunState = { ...s, nodes: { ...s.nodes } };
  for (const id of Object.keys(legacy.nodes)) {
    const { skipReason: _drop, ...rest } = legacy.nodes[id] as NodeState;
    legacy.nodes[id] = rest;
  }
  const { state, reset } = reenableBlockedDependents(wf, legacy, "check");
  assert.deepEqual(reset, []);
  assert.equal(state, legacy);
  assert.equal(state.nodes["after"]?.status, "skipped");
});

test("reenableBlockedDependents: a node that is not in the workflow is a no-op (never throws)", async () => {
  const s = await failedRun();
  const { state, reset } = reenableBlockedDependents(wf, s, "nope");
  assert.deepEqual(reset, []);
  assert.equal(state, s);
});
