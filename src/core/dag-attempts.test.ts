/**
 * dag-attempts.test.ts — per-iteration timing survives re-runs (attempts[]),
 * and runDag's transitions land in events.jsonl.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runDag } from "./dag.js";
import { readState, writeState } from "./state.js";
import { readEvents } from "./events.js";
import type { RunState } from "./state.js";
import type { Ctx, Workflow } from "./types.js";
import { createMockExecutor } from "../runtime/mock-executor.js";

const wf: Workflow = { name: "feature", nodes: [{ id: "g", command: "/g", produces: ["awaiting-review.md"], gate: {} }] };
const ctx: Ctx = { json: () => ({}), read: () => "", dir: (id) => id };

function fresh(dir: string): RunState {
  return {
    runId: "r", workflow: "feature", createdAt: "T", updatedAt: "T", status: "running",
    worktreePath: dir, branch: "b", sourcePlanPath: "/p",
    nodes: { g: { status: "pending", artifacts: [], iteration: 0, cost: 0, gateHistory: [] } },
  };
}

test("attempts: each execution is recorded and a re-run does not overwrite the earlier one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-att-"));
  const stateFile = join(dir, "state.json");
  const s0 = fresh(dir);
  writeState(stateFile, s0);
  const ex = createMockExecutor({ g: "gate-pause" });
  const r1 = await runDag(wf, ex, s0, { ctx, stateFile });
  assert.equal(r1.status, "paused");
  const a1 = readState(stateFile).nodes["g"]?.attempts ?? [];
  assert.equal(a1.length, 1);
  assert.equal(a1[0]?.status, "awaiting-gate");
  assert.equal(a1[0]?.iteration, readState(stateFile).nodes["g"]?.iteration);
  assert.ok((a1[0]?.durationMs ?? -1) >= 0);
  assert.ok((a1[0]?.cost ?? 0) > 0);

  // Gate revise, as resumeRun does it: same node object spread, pending, iteration+1.
  const cur = readState(stateFile);
  const g = cur.nodes["g"]!;
  const s1: RunState = { ...cur, status: "running", nodes: { g: { ...g, status: "pending", iteration: 1 } } };
  writeState(stateFile, s1);
  await runDag(wf, ex, s1, { ctx, stateFile });
  const a2 = readState(stateFile).nodes["g"]?.attempts ?? [];
  assert.equal(a2.length, 2, "earlier iteration must be preserved");
  assert.deepEqual(a2[0], a1[0]);
  assert.equal(a2[1]?.iteration, readState(stateFile).nodes["g"]?.iteration);
});

test("events: runDag transitions produce started / finished / status events in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-att-"));
  const stateFile = join(dir, "state.json");
  const s0 = fresh(dir);
  writeState(stateFile, s0);
  await runDag(wf, createMockExecutor({ g: "gate-pause" }), s0, { ctx, stateFile });
  const types = readEvents(dir).map((e) => `${e.type}${e.node ? ":" + e.node : ""}`);
  assert.deepEqual(types.slice(0, 4), ["run.started", "node.started:g", "node.finished:g", "run.status"]);
  const fin = readEvents(dir).find((e) => e.type === "node.finished");
  assert.equal((fin?.detail as { status: string }).status, "awaiting-gate");
});
