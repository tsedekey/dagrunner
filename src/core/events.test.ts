/**
 * events.test.ts — the append-only run event log (<runDir>/events.jsonl) is
 * DERIVED from state transitions at the single writeState choke point; state.json
 * stays authoritative.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveEvents, readEvents, appendEvent, lastEventAt } from "./events.js";
import { writeState } from "./state.js";
import type { NodeState, RunState } from "./state.js";

const node = (o: Partial<NodeState> = {}): NodeState => ({
  status: "pending",
  artifacts: [],
  iteration: 0,
  cost: 0,
  gateHistory: [],
  ...o,
});
const run = (nodes: Record<string, NodeState>, status: RunState["status"] = "running"): RunState => ({
  runId: "r1",
  workflow: "bugfix",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  status,
  worktreePath: "/w",
  branch: "b",
  sourcePlanPath: "/p",
  nodes,
});

test("deriveEvents: first write is run.started", () => {
  const ev = deriveEvents(null, run({ a: node() }), "T");
  assert.deepEqual(ev.map((e) => e.type), ["run.started"]);
});

test("deriveEvents: node start / finish carry status, duration and cost", () => {
  const p = run({ a: node() });
  const started = run({ a: node({ status: "running", startedAt: "2026-01-01T00:00:00.000Z" }) });
  assert.deepEqual(deriveEvents(p, started, "T").map((e) => [e.type, e.node]), [["node.started", "a"]]);
  const done = run({
    a: node({ status: "done", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:05.000Z", cost: 0.5 }),
  });
  const [fin] = deriveEvents(started, done, "T");
  assert.equal(fin?.type, "node.finished");
  assert.deepEqual(fin?.detail, { status: "done", durationMs: 5000, cost: 0.5 });
});

test("deriveEvents: run status change, gate decision, invalidation", () => {
  const gated = run({ g: node({ status: "awaiting-gate", iteration: 1 }), d: node({ status: "done" }) }, "paused");
  const after = run(
    {
      g: node({
        status: "pending",
        iteration: 2,
        gateHistory: [
          { decision: "reject", action: "amend", target: "g", decisionId: "abc", revision: "r.v", timestamp: "T", invalidated: ["d"] },
        ],
      }),
      d: node({ status: "pending" }),
    },
    "running",
  );
  const types = deriveEvents(gated, after, "T").map((e) => `${e.type}:${e.node ?? ""}`);
  assert.ok(types.includes("run.status:"), types.join());
  assert.ok(types.includes("gate.decision:g"), types.join());
  assert.ok(types.includes("node.invalidated:g"), types.join());
  assert.ok(types.includes("node.invalidated:d"), types.join());
  const dec = deriveEvents(gated, after, "T").find((e) => e.type === "gate.decision");
  assert.deepEqual(dec?.detail, { action: "amend", decisionId: "abc", target: "g", revision: "r.v", invalidated: ["d"] });
});

test("deriveEvents: running -> pending is a retry, not an invalidation; no change = no events", () => {
  const a = run({ a: node({ status: "running" }) });
  const b = run({ a: node({ status: "pending" }) });
  assert.deepEqual(deriveEvents(a, b, "T").map((e) => e.type), ["node.retry"]);
  assert.deepEqual(deriveEvents(a, a, "T"), []);
});

test("writeState appends events for a state.json; other filenames stay silent", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-ev-"));
  const f = join(dir, "state.json");
  writeState(f, run({ a: node() }));
  writeState(f, run({ a: node({ status: "running", startedAt: "T0" }) }));
  const evs = readEvents(dir);
  assert.deepEqual(evs.map((e) => e.type), ["run.started", "node.started"]);
  assert.match(evs[0]?.ts ?? "", /^\d{4}-\d\d-\d\dT/);
  writeState(join(dir, "other.json"), run({ a: node() }));
  assert.equal(readEvents(dir).length, 2);
  assert.equal(lastEventAt(dir), evs[1]?.ts);
});

test("a failing events write warns but never fails the state write", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-ev-"));
  // events.jsonl is a directory -> appendFileSync throws EISDIR.
  mkdirSync(join(dir, "events.jsonl"));
  const errs: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => { errs.push(String(s)); return true; }) as typeof process.stderr.write;
  try {
    writeState(join(dir, "state.json"), run({ a: node() }));
  } finally {
    process.stderr.write = real;
  }
  assert.match(readFileSync(join(dir, "state.json"), "utf8"), /"runId": "r1"/);
  assert.match(errs.join(""), /events\.jsonl/);
});

test("appendEvent: one JSON object per line", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-ev-"));
  appendEvent(dir, { ts: "T", type: "x" });
  appendEvent(dir, { ts: "T2", type: "y", node: "n", iteration: 1, detail: { k: 1 } });
  const lines = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[1] as string), { ts: "T2", type: "y", node: "n", iteration: 1, detail: { k: 1 } });
});
