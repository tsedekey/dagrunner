/**
 * node-views.test.ts — artifact preview dispatch: text extensions render, a
 * size-capped or unrecognized file degrades to a note, a vanished file
 * degrades to a note, node order/status pass through untouched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildNodeViews, MAX_PREVIEW_BYTES } from "./node-views.js";
import type { RunSnapshot } from "./run-snapshot.js";

function fixtureSnapshot(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "9-1",
    workflow: "bugfix",
    status: "running",
    stale: false,
    currentNodes: [],
    awaitingGate: null,
    nodes: {},
    companion: null,
    lastEventAt: null,
    driver: null,
    nodeOrder: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    totalCost: 0,
    gateBrief: null,
    ...over,
  } as RunSnapshot;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "dr-ui-nodeviews-"));
}

test("a markdown artifact renders through renderArtifact", () => {
  const dir = tempDir();
  const p = join(dir, "summary.md");
  writeFileSync(p, "# Title\n\nhello");
  const snap = fixtureSnapshot({
    nodeOrder: ["fix"],
    nodes: {
      fix: {
        status: "done",
        iteration: 0,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        cost: 0.1,
        artifacts: [{ path: p, registered: true, size: 15, mtime: null }],
        attempts: [],
        gateHistory: [],
      },
    },
  });
  const views = buildNodeViews(snap);
  assert.equal(views.length, 1);
  assert.equal(views[0]?.id, "fix");
  assert.match(views[0]?.artifacts[0]?.html ?? "", /<h1>Title<\/h1>/);
  assert.equal(views[0]?.artifacts[0]?.name, "summary.md");
});

test("a file over the preview cap degrades to a note instead of reading it", () => {
  const dir = tempDir();
  const p = join(dir, "huge.log");
  writeFileSync(p, "x");
  const snap = fixtureSnapshot({
    nodeOrder: ["fix"],
    nodes: {
      fix: {
        status: "done",
        iteration: 0,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        cost: 0,
        artifacts: [
          {
            path: p,
            registered: false,
            size: MAX_PREVIEW_BYTES + 1,
            mtime: null,
          },
        ],
        attempts: [],
        gateHistory: [],
      },
    },
  });
  const html = buildNodeViews(snap)[0]?.artifacts[0]?.html ?? "";
  assert.match(html, /Not previewed/);
  assert.match(html, /preview cap/);
});

test("an unrecognized extension is not previewed", () => {
  const dir = tempDir();
  const p = join(dir, "binary.dat");
  writeFileSync(p, "\x00\x01");
  const snap = fixtureSnapshot({
    nodeOrder: ["fix"],
    nodes: {
      fix: {
        status: "done",
        iteration: 0,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        cost: 0,
        artifacts: [{ path: p, registered: false, size: 2, mtime: null }],
        attempts: [],
        gateHistory: [],
      },
    },
  });
  const html = buildNodeViews(snap)[0]?.artifacts[0]?.html ?? "";
  assert.match(html, /Not previewed/);
  assert.match(html, /recognized text artifact/);
});

test("a listed file that no longer exists degrades to a note, not a throw", () => {
  const snap = fixtureSnapshot({
    nodeOrder: ["fix"],
    nodes: {
      fix: {
        status: "done",
        iteration: 0,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        cost: 0,
        artifacts: [
          {
            path: "/nonexistent/path/summary.md",
            registered: true,
            size: 10,
            mtime: null,
          },
        ],
        attempts: [],
        gateHistory: [],
      },
    },
  });
  const html = buildNodeViews(snap)[0]?.artifacts[0]?.html ?? "";
  assert.match(html, /Could not read file/);
});

test("a node absent from state.json (stale workflow) renders as untouched pending, not a throw", () => {
  const snap = fixtureSnapshot({
    nodeOrder: ["reproduce", "new-node"],
    nodes: {
      reproduce: {
        status: "done",
        iteration: 0,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        cost: 0,
        artifacts: [],
        attempts: [],
        gateHistory: [],
      },
    },
  });
  const views = buildNodeViews(snap);
  assert.equal(views.length, 2);
  assert.equal(views[1]?.id, "new-node");
  assert.equal(views[1]?.status, "pending");
  assert.deepEqual(views[1]?.artifacts, []);
});

test("node order in the output follows nodeOrder, not object key order", () => {
  const dir = tempDir();
  const snap = fixtureSnapshot({
    nodeOrder: ["b", "a"],
    nodes: {
      a: {
        status: "done",
        iteration: 0,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        cost: 0,
        artifacts: [],
        attempts: [],
        gateHistory: [],
      },
      b: {
        status: "done",
        iteration: 0,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        cost: 0,
        artifacts: [],
        attempts: [],
        gateHistory: [],
      },
    },
  });
  void dir;
  const views = buildNodeViews(snap);
  assert.deepEqual(
    views.map((v) => v.id),
    ["b", "a"],
  );
});
