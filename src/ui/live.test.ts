/**
 * live.test.ts — the per-run live tailer: events.jsonl plus the transcript.log
 * of every node whose state.json status is `running`, re-evaluated each poll.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createRunTailer } from "./live.js";
import { buildFeedHistory } from "./feed.js";

const asst = (ts: string, text: string): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] }, timestamp: ts }) + "\n";

function setup(nodeStatus: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "dr-ui-live-"));
  const runDir = join(home, "runs", "9-1");
  mkdirSync(runDir, { recursive: true });
  const write = (st: Record<string, string>) =>
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        runId: "9-1", workflow: "bugfix", createdAt: "t", updatedAt: "t", status: "running", worktreePath: "/wt", branch: "b", sourcePlanPath: "/p",
        nodes: Object.fromEntries(Object.entries(st).map(([id, status]) => [id, { status, artifacts: [], iteration: 0, cost: 0, gateHistory: [], startedAt: "2026-01-01T00:00:00.000Z" }])),
      }),
    );
  write(nodeStatus);
  return { home, runDir, write };
}

test("a line appended to a RUNNING node's transcript after the tailer started comes out as an item; history is fast-forwarded past", () => {
  const { home, runDir } = setup({ implement: "running" });
  mkdirSync(join(runDir, "implement"));
  writeFileSync(join(runDir, "implement", "transcript.log"), asst("2026-01-01T00:00:01.000Z", "old line"));
  const t = createRunTailer(home, "9-1");
  assert.deepEqual(t.poll(), [], "pre-existing lines are history, not deltas");
  appendFileSync(join(runDir, "implement", "transcript.log"), asst("2026-01-01T00:00:02.000Z", "fresh"));
  const got = t.poll();
  assert.deepEqual(got.map((i) => [i.node, i.kind, i.text]), [["implement", "text", "fresh"]]);
  // The id matches what the history endpoint would call the same line — the client de-dupes on it.
  const hist = buildFeedHistory(home, "9-1").items.find((i) => i.text === "fresh");
  assert.equal(got[0]?.id, hist?.id);
  assert.deepEqual(t.poll(), []);
});

test("a node that starts running AFTER the tailer began is picked up from byte 0 of its (newly created) transcript", () => {
  const { home, runDir, write } = setup({ implement: "pending" });
  const t = createRunTailer(home, "9-1");
  assert.deepEqual(t.poll(), []);
  mkdirSync(join(runDir, "implement"));
  writeFileSync(join(runDir, "implement", "transcript.log"), asst("2026-01-01T00:00:01.000Z", "first words"));
  assert.deepEqual(t.poll(), [], "still pending in state.json: not tailed");
  write({ implement: "running" });
  assert.deepEqual(t.poll().map((i) => i.text), ["first words"]);
});

test("once a node stops running, its final lines are drained one more time and then it is no longer tailed", () => {
  const { home, runDir, write } = setup({ implement: "running" });
  mkdirSync(join(runDir, "implement"));
  const f = join(runDir, "implement", "transcript.log");
  writeFileSync(f, "");
  const t = createRunTailer(home, "9-1");
  appendFileSync(f, asst("2026-01-01T00:00:02.000Z", "last words"));
  write({ implement: "done" });
  assert.deepEqual(t.poll().map((i) => i.text), ["last words"]);
  appendFileSync(f, asst("2026-01-01T00:00:03.000Z", "after done"));
  assert.deepEqual(t.poll(), [], "no longer tailed");
});

test("events.jsonl appends are tailed with the same item schema", () => {
  const { home, runDir } = setup({ implement: "pending" });
  const t = createRunTailer(home, "9-1");
  writeFileSync(join(runDir, "events.jsonl"), JSON.stringify({ ts: "2026-01-01T00:00:05.000Z", type: "node.started", node: "implement", iteration: 0 }) + "\n");
  const got = t.poll();
  assert.equal(got.length, 1);
  assert.equal(got[0]?.source, "events");
  assert.equal(got[0]?.kind, "start");
});

test("a rerun archives the transcript and starts a fresh file: the new file is read from the start, with distinct ids", () => {
  const { home, runDir } = setup({ implement: "running" });
  mkdirSync(join(runDir, "implement"));
  const f = join(runDir, "implement", "transcript.log");
  writeFileSync(f, asst("2026-01-01T00:00:01.000Z", "attempt one is a longer line to outgrow the offset"));
  const t = createRunTailer(home, "9-1");
  const histBefore = buildFeedHistory(home, "9-1").items.map((i) => i.id);
  renameSync(f, join(runDir, "implement", "transcript-old.log"));
  writeFileSync(f, asst("2026-01-01T00:00:09.000Z", "attempt two") + asst("2026-01-01T00:00:10.000Z", "attempt two b") + asst("2026-01-01T00:00:11.000Z", "attempt two c"));
  const got = t.poll();
  assert.deepEqual(got.map((i) => i.text), ["attempt two", "attempt two b", "attempt two c"]);
  assert.ok(!got.some((i) => histBefore.includes(i.id)), "ids must not collide with the archived attempt's");
});

test("a torn state.json read or a missing run dir never throws", () => {
  const { home, runDir } = setup({ implement: "running" });
  const t = createRunTailer(home, "9-1");
  writeFileSync(join(runDir, "state.json"), "{ torn");
  assert.doesNotThrow(() => t.poll());
  const gone = createRunTailer(home, "no-such-run");
  assert.deepEqual(gone.poll(), []);
});

test("an AMEND re-runs a node into the SAME transcript.log: the old lines are history, only new lines are live deltas", () => {
  const { home, runDir } = setup({ fix: "awaiting-gate" });
  mkdirSync(join(runDir, "fix"));
  const f = join(runDir, "fix", "transcript.log");
  writeFileSync(f, asst("2026-01-01T00:00:01.000Z", "round one a") + asst("2026-01-01T00:00:02.000Z", "round one b") + asst("2026-01-01T00:00:03.000Z", "round one c"));
  const t = createRunTailer(home, "9-1");
  assert.deepEqual(t.poll(), []);
  // amend -> node runs again (new startedAt), appending to the same file
  const st = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  st.nodes.fix = { ...st.nodes.fix, status: "running", startedAt: "2026-01-01T01:00:00.000Z" };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(st));
  appendFileSync(f, asst("2026-01-01T01:00:05.000Z", "round two first"));
  assert.deepEqual(t.poll().map((i) => i.text), ["round two first"], "must not replay round one");
});

test("a node that runs, stops, and runs again within one tailer's lifetime never replays", () => {
  const { home, runDir, write } = setup({ implement: "running" });
  mkdirSync(join(runDir, "implement"));
  const f = join(runDir, "implement", "transcript.log");
  writeFileSync(f, "");
  const t = createRunTailer(home, "9-1");
  appendFileSync(f, asst("2026-01-01T00:00:01.000Z", "one"));
  assert.deepEqual(t.poll().map((i) => i.text), ["one"]);
  write({ implement: "awaiting-gate" });
  assert.deepEqual(t.poll(), []);
  write({ implement: "running" });
  appendFileSync(f, asst("2026-01-01T00:00:09.000Z", "two"));
  assert.deepEqual(t.poll().map((i) => i.text), ["two"]);
});
