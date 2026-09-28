/**
 * page.test.ts — pure HTML rendering: no-JS-fallback structure (native
 * <details>), status icon+label pairing (never colour alone), the read-only
 * gate banner, and safe escaping of run/gate data that flows into the page.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderPage, type NodeView, type PageData } from "./page.js";
import type { RunSnapshot } from "./run-snapshot.js";
import type { RunListEntry } from "./discover.js";

function fixtureRun(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "9-1",
    workflow: "bugfix",
    status: "running",
    stale: false,
    currentNodes: ["implement"],
    awaitingGate: null,
    nodes: {},
    companion: null,
    lastEventAt: "2026-01-01T00:10:00.000Z",
    driver: null,
    nodeOrder: ["reproduce", "implement", "fix"],
    createdAt: "2026-01-01T00:00:00.000Z",
    totalCost: 0.42,
    gateBrief: null,
    ...over,
  } as RunSnapshot;
}

function fixtureNode(over: Partial<NodeView> = {}): NodeView {
  return {
    id: "reproduce",
    status: "done",
    iteration: 1,
    durationMs: 12345,
    cost: 0.1,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:12.000Z",
    artifacts: [],
    gateHistory: [],
    ...over,
  };
}

function basePageData(over: Partial<PageData> = {}): PageData {
  return {
    runs: [],
    selectedRunId: null,
    selectedError: null,
    run: null,
    nodeViews: [],
    ...over,
  };
}

test("no run selected: shows the empty-state prompt, not a crash", () => {
  const html = renderPage(basePageData());
  assert.match(html, /Select a run from the list/);
});

test("a failed run load shows an error message instead of throwing", () => {
  const html = renderPage(
    basePageData({ selectedRunId: "bogus", selectedError: "run not found" }),
  );
  assert.match(html, /Could not load run "bogus"/);
  assert.match(html, /run not found/);
});

test("run list renders workflow/status/updatedAt and marks the selected run", () => {
  const runs: RunListEntry[] = [
    {
      runId: "9-1",
      workflow: "bugfix",
      status: "running",
      updatedAt: "2026-01-01T00:10:00.000Z",
    },
    { runId: "9-0", error: "corrupt state.json" },
  ];
  const html = renderPage(basePageData({ runs, selectedRunId: "9-1" }));
  assert.match(html, /class="run-entry selected"/);
  assert.match(html, /corrupt state\.json/);
});

test("the per-node no-JS live-output fallback names the RUN id, not the node id, in the poll command", () => {
  const run = fixtureRun({ runId: "9-1" });
  const nodeViews = [fixtureNode({ id: "reproduce" })];
  const html = renderPage(basePageData({ run, nodeViews }));
  assert.match(html, /dagrun status 9-1 --json/);
  assert.doesNotMatch(html, /dagrun status reproduce --json/);
});

test("every node row is a native <details> — expandable with no JS required", () => {
  const run = fixtureRun();
  const nodeViews = [
    fixtureNode({ id: "reproduce" }),
    fixtureNode({ id: "implement", status: "running" }),
  ];
  const html = renderPage(basePageData({ run, nodeViews }));
  assert.match(
    html,
    /<details class="node-row status-done"[^>]*data-node="reproduce">/,
  );
  assert.match(
    html,
    /<details class="node-row status-running" open data-node="implement">/,
  );
});

test("status is paired with an icon AND a text label, never colour alone", () => {
  const run = fixtureRun();
  const nodeViews = [fixtureNode({ id: "fix", status: "failed" })];
  const html = renderPage(basePageData({ run, nodeViews }));
  assert.match(html, /<span class="status-icon"[^>]*>✗<\/span>/);
  assert.match(html, /<span class="status-label">failed<\/span>/);
});

test("KPI strip shows run id, workflow, status, cost, current node", () => {
  const run = fixtureRun({ totalCost: 1.2345 });
  const html = renderPage(basePageData({ run, nodeViews: [] }));
  assert.match(html, /<span class="kpi-value">9-1<\/span>/);
  assert.match(html, /<span class="kpi-value">bugfix<\/span>/);
  assert.match(html, /\$1\.2345/);
  assert.match(html, /implement/); // current node
});

test("gate banner appears only when a node is awaiting a gate, and is read-only", () => {
  const noGate = renderPage(
    basePageData({ run: fixtureRun({ awaitingGate: null }), nodeViews: [] }),
  );
  assert.doesNotMatch(noGate, /<section class="gate-banner"/);

  const withGate = renderPage(
    basePageData({
      run: fixtureRun({
        awaitingGate: {
          nodeId: "fix",
          revision: null,
          since: "2026-01-01T00:05:00.000Z",
          reason: "awaiting companion decision",
        },
      }),
      nodeViews: [],
    }),
  );
  assert.match(withGate, /<section class="gate-banner"/);
  assert.match(withGate, /Awaiting decision — gate "fix"/);
  assert.match(withGate, /READ-ONLY|read-only/i);
  assert.doesNotMatch(withGate, /<button[^>]*>\s*Approve/i);
  assert.match(withGate, /dagrun gate show 9-1/);
});

test("gate banner shows revision/companion/history from a persisted gate brief when present", () => {
  const run = fixtureRun({
    awaitingGate: {
      nodeId: "fix",
      revision: "abc.def",
      since: "2026-01-01T00:05:00.000Z",
      reason: "awaiting companion decision",
    },
    gateBrief: {
      schema: 1,
      runId: "9-1",
      workflow: "bugfix",
      gateNodeId: "fix",
      iteration: 0,
      revision: "abc.def",
      openedAt: "2026-01-01T00:05:00.000Z",
      planSha256: null,
      worktreeHead: null,
      gateArtifacts: [],
      upstreamArtifacts: [],
      validation: [],
      companion: {
        sessionId: "sess-123",
        reconstructed: false,
        status: "ok",
        resumeHint: "claude --resume sess-123",
      },
      pendingDecision: {
        actions: ["approve", "amend", "hold"],
        amendTargets: ["fix"],
        approveContinuesTo: ["pr"],
      },
    },
    nodes: {
      fix: {
        status: "awaiting-gate",
        iteration: 0,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        cost: 0,
        artifacts: [],
        attempts: [],
        gateHistory: [
          {
            decision: "hold",
            comment: "wait",
            timestamp: "2026-01-01T00:06:00.000Z",
          },
        ],
      },
    },
  });
  const html = renderPage(basePageData({ run, nodeViews: [] }));
  assert.match(html, /<code>abc\.def<\/code>/);
  assert.match(html, /sess-123/);
  assert.match(html, /claude --resume sess-123/);
  assert.match(html, /wait/);
});

test("artifact HTML is inserted as-is (already sanitized by render.ts) but surrounding data is escaped", () => {
  const run = fixtureRun();
  const nodeViews = [
    fixtureNode({
      id: "fix",
      artifacts: [
        {
          path: "/x/fix/summary.md",
          name: "<script>evil</script>.md",
          registered: true,
          size: 10,
          mtime: null,
          html: "<p>safe</p>",
        },
      ],
    }),
  ];
  const html = renderPage(basePageData({ run, nodeViews }));
  assert.match(html, /<p>safe<\/p>/);
  assert.doesNotMatch(html, /<script>evil<\/script>/);
  assert.match(html, /&lt;script&gt;evil&lt;\/script&gt;\.md/);
});

test("a <noscript> fallback is present so a no-JS load never shows a blank page", () => {
  const html = renderPage(basePageData());
  assert.match(html, /<noscript>/);
});
