/**
 * status-json.test.ts — `dagrun status --json`: machine-readable, derived from
 * state.json + the run lock + events.jsonl, and strictly read-only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildStatusJson } from "./status-json.js";
import type { RunState } from "../core/state.js";

function setup(over: Partial<RunState> = {}) {
  const home = mkdtempSync(join(tmpdir(), "dr-sj-"));
  const runDir = join(home, "runs", "9-1");
  mkdirSync(runDir, { recursive: true });
  const state: RunState = {
    runId: "9-1", workflow: "bugfix", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:10:00.000Z",
    status: "running", worktreePath: "/w", branch: "b", sourcePlanPath: "/p",
    nodes: {
      reproduce: { status: "done", artifacts: ["/a/r.md"], iteration: 1, cost: 0.25, gateHistory: [], startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:30.000Z" },
      implement: { status: "running", artifacts: [], iteration: 0, cost: 0, gateHistory: [], startedAt: "2026-01-01T00:02:00.000Z" },
      fix: { status: "pending", artifacts: [], iteration: 0, cost: 0, gateHistory: [] },
    },
    ...over,
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
  return { home, runDir, state };
}
const lock = (home: string, pid: number) =>
  writeFileSync(join(home, "active.lock"), JSON.stringify({ runId: "9-1", pid, startedAt: "2026-01-01T00:00:00.000Z" }));
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", "0"]).pid;
}

test("running run with a live driver: stale=false, currentNodes, per-node timing", () => {
  const { home } = setup();
  lock(home, process.ppid);
  const j = buildStatusJson(home, "9-1");
  assert.equal(j.status, "running");
  assert.equal(j.stale, false);
  assert.deepEqual(j.currentNodes, ["implement"]);
  assert.equal(j.awaitingGate, null);
  assert.equal(j.companion, null);
  assert.equal(j.nodes["reproduce"]?.durationMs, 90000);
  assert.equal(j.nodes["reproduce"]?.cost, 0.25);
  assert.deepEqual(j.nodes["reproduce"]?.artifacts, ["/a/r.md"]);
  assert.equal(j.nodes["implement"]?.durationMs, null);
  assert.equal(j.lastEventAt, "2026-01-01T00:10:00.000Z", "no events.jsonl: falls back to updatedAt");
  assert.equal(j.driver?.pid, process.ppid);
});

test("running run whose lock holder is dead (or missing) is stale", () => {
  const { home } = setup();
  lock(home, deadPid());
  assert.equal(buildStatusJson(home, "9-1").stale, true);
  const b = setup();
  assert.equal(buildStatusJson(b.home, "9-1").stale, true, "no lock at all while running = stale");
});

test("paused run is not stale; awaiting-gate reports node, revision, since from events", () => {
  const { home, runDir, state } = setup({ status: "paused", companion: { sessionId: "S1", associatedAt: "T", source: "handoff", reconstructed: false } });
  state.nodes["implement"] = { status: "awaiting-gate", artifacts: [], iteration: 1, cost: 0, gateHistory: [], endedAt: "2026-01-01T00:05:00.000Z" };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
  writeFileSync(
    join(runDir, "events.jsonl"),
    JSON.stringify({ ts: "2026-01-01T00:05:01.000Z", type: "gate.opened", node: "implement", detail: { revision: "abc.def" } }) + "\n",
  );
  const j = buildStatusJson(home, "9-1");
  assert.equal(j.status, "awaiting-gate");
  assert.equal(j.stale, false);
  assert.deepEqual(j.awaitingGate && { nodeId: j.awaitingGate.nodeId, revision: j.awaitingGate.revision, since: j.awaitingGate.since }, {
    nodeId: "implement", revision: "abc.def", since: "2026-01-01T00:05:01.000Z",
  });
  assert.ok(typeof j.awaitingGate?.reason === "string" && j.awaitingGate.reason.length > 0);
  assert.deepEqual(j.companion, { sessionId: "S1" });
  assert.equal(j.lastEventAt, "2026-01-01T00:05:01.000Z");
});

test("done / failed / aborted pass through; unknown run and driver.log-only dir fail loud", () => {
  assert.equal(buildStatusJson(setup({ status: "done" }).home, "9-1").status, "done");
  assert.equal(buildStatusJson(setup({ status: "failed" }).home, "9-1").status, "failed");
  assert.equal(buildStatusJson(setup({ status: "aborted" }).home, "9-1").status, "aborted");
  const h = mkdtempSync(join(tmpdir(), "dr-sj-"));
  assert.throws(() => buildStatusJson(h, "nope"), /not found/);
  mkdirSync(join(h, "runs", "5-1"), { recursive: true });
  writeFileSync(join(h, "runs", "5-1", "driver.log"), "boot\n");
  assert.throws(() => buildStatusJson(h, "5-1"), /driver\.log/);
});

test("status --json never writes to the run dir or the lock", () => {
  const { home, runDir } = setup();
  lock(home, process.ppid);
  const snap = (d: string) => readdirSync(d).map((f) => `${f}:${statSync(join(d, f)).mtimeMs}:${statSync(join(d, f)).size}`).sort().join("|");
  const before = [snap(runDir), snap(home)];
  buildStatusJson(home, "9-1");
  assert.deepEqual([snap(runDir), snap(home)], before);
});
