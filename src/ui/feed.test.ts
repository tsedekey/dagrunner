/**
 * feed.test.ts — the ONE activity-item schema used by both page-load history
 * and live SSE frames: events.jsonl events + transcript-derived agent items,
 * merged chronologically, de-dupable by a stable id.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildFeedHistory,
  buildNodeOutput,
  eventToItem,
  mergeFeed,
  shortenPaths,
  transcriptItems,
  type FeedItem,
} from "./feed.js";
import type { RunState } from "../core/state.js";

const asst = (ts: string | undefined, ...content: unknown[]): string =>
  JSON.stringify({ type: "assistant", message: { content }, ...(ts !== undefined ? { timestamp: ts } : {}) });

function tempRun(over: Partial<RunState> = {}) {
  const home = mkdtempSync(join(tmpdir(), "dr-ui-feed-"));
  const runDir = join(home, "runs", "9-1");
  mkdirSync(runDir, { recursive: true });
  const state: RunState = {
    runId: "9-1",
    workflow: "bugfix",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    worktreePath: "/wt/9-1",
    branch: "b",
    sourcePlanPath: "/p",
    nodes: {
      reproduce: { status: "done", artifacts: [], iteration: 0, cost: 0, gateHistory: [], startedAt: "2026-01-01T00:00:00.000Z" },
      implement: { status: "running", artifacts: [], iteration: 0, cost: 0, gateHistory: [], startedAt: "2026-01-01T00:05:00.000Z" },
    },
    ...over,
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
  return { home, runDir };
}

test("eventToItem: each engine event type maps to a readable item with a stable id derived from its byte offset", () => {
  const ev = (type: string, extra: object = {}) => eventToItem({ ts: "2026-01-01T00:00:00.000Z", type, ...extra }, 120);
  assert.equal(ev("run.started", { detail: { workflow: "bugfix" } }).id, "e:120");
  assert.equal(ev("run.started", { detail: { workflow: "bugfix" } }).kind, "run");
  assert.match(ev("node.started", { node: "fix", iteration: 2 }).text, /fix started.*iteration 2/);
  const fin = ev("node.finished", { node: "fix", detail: { status: "done", cost: 1.5, durationMs: 61000 } });
  assert.equal(fin.kind, "session");
  assert.match(fin.text, /fix done · \$1\.50 · 1m 01s/);
  const gate = ev("node.finished", { node: "fix", detail: { status: "awaiting-gate", cost: 0.25 } });
  assert.match(gate.text, /awaiting gate/);
  assert.equal(ev("node.finished", { node: "fix", detail: { status: "failed", error: "boom" } }).kind, "fail");
  assert.equal(ev("node.finished", { node: "implement", detail: { status: "skipped" } }).kind, "skip");
  assert.match(ev("gate.opened", { node: "fix", detail: { revision: "r.1" } }).text, /Paused at fix gate \(revision r\.1\)/);
  const dec = ev("gate.decision", { node: "fix", detail: { action: "approve", decisionId: "abc" } });
  assert.equal(dec.kind, "decision");
  assert.match(dec.text, /approve recorded at fix/i);
  assert.match(ev("run.status", { detail: { from: "running", to: "paused" } }).text, /running → paused/);
  assert.equal(ev("something.new").kind, "info"); // unknown future event types never crash or vanish
  assert.equal(ev("node.started", { node: "fix" }).source, "events");
});

test("transcriptItems: stable ids (node, inode, byte offset, block index), line ts else previous ts else fallback, truncated lines flagged approximate", () => {
  const lines = [
    { line: asst("2026-01-01T00:00:10.000Z", { type: "text", text: "Looking" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }), offset: 0 },
    { line: '{"type":"assistant","message":{"content":[{"type":"text","text":"cut here…}', offset: 500 },
    { line: asst(undefined, { type: "text", text: "no ts of its own" }), offset: 900 },
  ];
  const r = transcriptItems({ node: "implement", ino: 77, lines, lastTs: null, fallbackTs: "FALLBACK", shorten: (s) => s });
  assert.deepEqual(
    r.items.map((i) => [i.id, i.kind, i.ts, i.approx === true]),
    [
      ["t:implement:77:0:0", "text", "2026-01-01T00:00:10.000Z", false],
      ["t:implement:77:0:1", "tool", "2026-01-01T00:00:10.000Z", false],
      ["t:implement:77:500:0", "text", "2026-01-01T00:00:10.000Z", true], // cut line: prior ts, approx
      ["t:implement:77:900:0", "text", "2026-01-01T00:00:10.000Z", true],
    ],
  );
  assert.equal(r.items[1]?.tool, "Bash");
  assert.equal(r.items[1]?.text, "ls");
  assert.equal(r.lastTs, "2026-01-01T00:00:10.000Z");
  const first = transcriptItems({ node: "n", ino: 1, lines: [lines[2] as (typeof lines)[number]], lastTs: null, fallbackTs: "FALLBACK", shorten: (s) => s });
  assert.equal(first.items[0]?.ts, "FALLBACK");
  assert.equal(first.items[0]?.approx, true);
});

test("shortenPaths: run-dir paths become $RUN/, worktree paths become relative", () => {
  assert.equal(shortenPaths("cat /h/runs/9-1/plan/plan.md /wt/9-1/src/A.java", "/h/runs/9-1", "/wt/9-1"), "cat $RUN/plan/plan.md src/A.java");
  // a bare directory (no trailing slash), e.g. `cd <worktree> && git diff`
  assert.equal(shortenPaths("cd /wt/9-1 && ls /h/runs/9-1", "/h/runs/9-1", "/wt/9-1"), "cd $WORKTREE && ls $RUN");
});

test("mergeFeed: chronological, stable for equal ts, de-duplicated by id", () => {
  const mk = (id: string, ts: string): FeedItem => ({ id, ts, kind: "text", text: id, source: "transcript" });
  const merged = mergeFeed([mk("b", "2026-01-01T00:00:02.000Z"), mk("a", "2026-01-01T00:00:01.000Z"), mk("c", "2026-01-01T00:00:02.000Z"), mk("a", "2026-01-01T00:00:01.000Z")]);
  assert.deepEqual(merged.map((i) => i.id), ["a", "b", "c"]);
});

test("buildFeedHistory: merges events.jsonl and every node's transcript into one chronological feed (older runs without events.jsonl still show transcripts)", () => {
  const { home, runDir } = tempRun();
  writeFileSync(
    join(runDir, "events.jsonl"),
    [
      { ts: "2026-01-01T00:00:00.000Z", type: "run.started", detail: { workflow: "bugfix" } },
      { ts: "2026-01-01T00:00:00.001Z", type: "node.started", node: "reproduce", iteration: 0 },
      { ts: "2026-01-01T00:05:00.000Z", type: "node.started", node: "implement", iteration: 0 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  mkdirSync(join(runDir, "reproduce"), { recursive: true });
  mkdirSync(join(runDir, "implement"), { recursive: true });
  writeFileSync(join(runDir, "reproduce", "transcript.log"), asst("2026-01-01T00:02:00.000Z", { type: "text", text: "repro text" }) + "\n");
  writeFileSync(join(runDir, "implement", "transcript.log"), asst("2026-01-01T00:06:00.000Z", { type: "tool_use", name: "Edit", input: { file_path: "/wt/9-1/src/A.java" } }) + "\n");
  const h = buildFeedHistory(home, "9-1");
  assert.deepEqual(
    h.items.map((i) => `${i.source}:${i.kind}:${i.node ?? ""}`),
    ["events:run:", "events:start:reproduce", "transcript:text:reproduce", "events:start:implement", "transcript:tool:implement"],
  );
  assert.equal(h.items[4]?.text, "A.java"); // Edit shows file basename (like logProgress)
  assert.equal(h.total, 5);

  // No events.jsonl at all (legacy run): transcripts alone still render.
  const legacy = tempRun();
  mkdirSync(join(legacy.runDir, "implement"), { recursive: true });
  writeFileSync(join(legacy.runDir, "implement", "transcript.log"), asst("2026-01-01T00:06:00.000Z", { type: "text", text: "hi" }) + "\n");
  assert.equal(buildFeedHistory(legacy.home, "9-1").items.length, 1);
});

test("buildFeedHistory caps the transcript-derived items (newest kept) but never drops engine events", () => {
  const { home, runDir } = tempRun();
  writeFileSync(join(runDir, "events.jsonl"), JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "run.started" }) + "\n");
  mkdirSync(join(runDir, "implement"), { recursive: true });
  let lines = "";
  for (let i = 0; i < 30; i++) {
    lines += asst(`2026-01-01T00:10:${String(i).padStart(2, "0")}.000Z`, { type: "text", text: `msg ${i}` }) + "\n";
  }
  writeFileSync(join(runDir, "implement", "transcript.log"), lines);
  const h = buildFeedHistory(home, "9-1", { maxTranscript: 10 });
  assert.equal(h.items.filter((i) => i.source === "events").length, 1);
  const tr = h.items.filter((i) => i.source === "transcript");
  assert.equal(tr.length, 10);
  assert.equal(tr[0]?.text, "msg 20");
  assert.equal(tr.at(-1)?.text, "msg 29");
  assert.equal(h.total, 31);
});

test("buildNodeOutput: one node's agent output from its live transcript.log; missing file -> []", () => {
  const { home, runDir } = tempRun();
  assert.deepEqual(buildNodeOutput(home, "9-1", "implement", 100), []);
  mkdirSync(join(runDir, "implement"), { recursive: true });
  writeFileSync(join(runDir, "implement", "transcript.log"), asst("2026-01-01T00:06:00.000Z", { type: "text", text: "hi" }) + "\n");
  appendFileSync(join(runDir, "implement", "transcript.log"), asst("2026-01-01T00:06:01.000Z", { type: "text", text: "there" }) + "\n");
  assert.deepEqual(buildNodeOutput(home, "9-1", "implement", 1).map((i) => i.text), ["there"]);
  assert.equal(buildNodeOutput(home, "9-1", "../etc", 10).length, 0); // node id is never a path
});
