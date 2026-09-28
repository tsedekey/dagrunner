/**
 * run-snapshot.test.ts — the UI's read model: node order per workflow, total
 * cost, per-node gate history, and reading (never computing) the gate brief.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildRunSnapshot } from "./run-snapshot.js";
import type { RunState } from "../core/state.js";
import { bugfixWorkflow } from "../workflow/bugfix-workflow.js";
import { featureWorkflow } from "../workflow/feature-workflow.js";

function setup(workflow: "bugfix" | "feature", over: Partial<RunState> = {}) {
  const home = mkdtempSync(join(tmpdir(), "dr-ui-snap-"));
  const runDir = join(home, "runs", "9-1");
  mkdirSync(runDir, { recursive: true });
  const state: RunState = {
    runId: "9-1",
    workflow,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    status: "paused",
    worktreePath: "/w",
    branch: "b",
    sourcePlanPath: "/p",
    nodes: {
      reproduce: {
        status: "done",
        artifacts: [],
        iteration: 1,
        cost: 0.1,
        gateHistory: [],
      },
      implement: {
        status: "done",
        artifacts: [],
        iteration: 0,
        cost: 0.2,
        gateHistory: [],
      },
      review: {
        status: "done",
        artifacts: [],
        iteration: 0,
        cost: 0.05,
        gateHistory: [],
      },
      fix: {
        status: "awaiting-gate",
        artifacts: [],
        iteration: 0,
        cost: 0.3,
        gateHistory: [
          {
            decision: "hold",
            comment: "wait",
            timestamp: "2026-01-01T00:05:00.000Z",
          },
        ],
      },
    },
    ...over,
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
  return { home, runDir, state };
}

test("node order follows the workflow's own declared pipeline order (bugfix)", () => {
  const { home } = setup("bugfix");
  const snap = buildRunSnapshot(home, "9-1");
  assert.deepEqual(
    snap.nodeOrder,
    bugfixWorkflow.nodes.map((n) => n.id),
  );
});

test("node order follows the feature workflow when state.workflow is feature", () => {
  const { home } = setup("feature");
  const snap = buildRunSnapshot(home, "9-1");
  assert.deepEqual(
    snap.nodeOrder,
    featureWorkflow.nodes.map((n) => n.id),
  );
});

test("total cost sums every node's cost", () => {
  const { home } = setup("bugfix");
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.totalCost, 0.1 + 0.2 + 0.05 + 0.3);
});

test("per-node gateHistory is carried through, decisionId and all", () => {
  const { home } = setup("bugfix");
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.nodes["fix"]?.gateHistory.length, 1);
  assert.equal(snap.nodes["fix"]?.gateHistory[0]?.decision, "hold");
});

test("gateBrief is null when no gate.json has been written yet, even though a node awaits", () => {
  const { home } = setup("bugfix");
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.awaitingGate?.nodeId, "fix");
  assert.equal(snap.gateBrief, null);
});

test("gateBrief is read verbatim from <gate>/gate.json, never recomputed", () => {
  const { home, runDir } = setup("bugfix");
  const fakeBrief = {
    schema: 1,
    runId: "9-1",
    workflow: "bugfix",
    gateNodeId: "fix",
    revision: "abc.def",
  };
  mkdirSync(join(runDir, "fix"), { recursive: true });
  writeFileSync(join(runDir, "fix", "gate.json"), JSON.stringify(fakeBrief));
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.gateBrief?.revision, "abc.def");
});

test("a torn/garbled gate.json degrades to null instead of throwing", () => {
  const { home, runDir } = setup("bugfix");
  mkdirSync(join(runDir, "fix"), { recursive: true });
  writeFileSync(join(runDir, "fix", "gate.json"), "{ not json");
  const snap = buildRunSnapshot(home, "9-1");
  assert.equal(snap.gateBrief, null);
});

test("an unknown workflow name falls back to state.json's own node insertion order", () => {
  const { home } = setup("bugfix", { workflow: "mystery" });
  const snap = buildRunSnapshot(home, "9-1");
  assert.deepEqual(snap.nodeOrder, ["reproduce", "implement", "review", "fix"]);
});
